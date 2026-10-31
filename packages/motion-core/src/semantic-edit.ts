import {Euler,Quaternion,Vector3} from 'three';
import type {HumanRig} from './rig';
import type {WorkshopDoc} from './document';
import {contactStartKey,frameAt,isReleaseKey,keyAt,sortedKeys} from './document';
import {rotateArmAbout,rotateHandFrame,rotateLegAbout,solveEffectiveFrame} from './solver';
import {handFrame} from './hand-frame';
import {DEG,angleAt,WRIST_BEND_LIMIT_DEG,LIMITS} from './kinematics';
import {footDepth,footGeometry,footLowestY,type Side} from './foot';

/** Whitelisted semantic pose commands (issue #23 PR-B). Each motion has an
 * anatomical positive direction; `degrees` is signed along it. A command is
 * encoded into the existing WorkshopDoc fields (hand target/pole/frame or the
 * trunk angles) — no schema change — and read back from the solved rig. */
export type SemanticPart='shoulder'|'elbow'|'forearm'|'wrist'|'trunk'|'hip'|'legs'|'knee'|'ankle';
export type SemanticMotion='flexion'|'abduction'|'pronation'|'deviation'|'lean'|'rotation'|'sideBend'|'spread';
/** Parts that act on both sides at once (no side selector). */
export const SIDELESS_PARTS:readonly SemanticPart[]=['trunk','legs'];
export interface SemanticEdit{part:SemanticPart;side?:Side;motion:SemanticMotion;degrees:number}
export interface SemanticMotionInfo{motion:SemanticMotion;label:string;positive:string;negative:string}
export const SEMANTIC_MOTIONS:Record<SemanticPart,SemanticMotionInfo[]>={
 shoulder:[{motion:'flexion',label:'前屈 / 后伸',positive:'前屈',negative:'后伸'},{motion:'abduction',label:'外展 / 内收',positive:'外展',negative:'内收'}],
 elbow:[{motion:'flexion',label:'屈曲 / 伸展',positive:'屈曲',negative:'伸展'}],
 forearm:[{motion:'pronation',label:'旋前 / 旋后',positive:'旋前',negative:'旋后'}],
 wrist:[{motion:'flexion',label:'掌屈 / 背伸',positive:'掌屈',negative:'背伸'},{motion:'deviation',label:'尺偏 / 桡偏',positive:'尺偏',negative:'桡偏'}],
 hip:[{motion:'flexion',label:'大腿向前 / 向后',positive:'向前（屈髋）',negative:'向后（伸髋）'},{motion:'abduction',label:'大腿向外 / 向内',positive:'向外（外展）',negative:'向内（内收）'}],
 legs:[{motion:'spread',label:'两腿分开 / 并拢',positive:'分开',negative:'并拢'}],
 knee:[{motion:'flexion',label:'屈曲 / 伸展',positive:'屈曲',negative:'伸展'}],
 ankle:[{motion:'flexion',label:'背屈 / 跖屈',positive:'背屈',negative:'跖屈'},{motion:'abduction',label:'足尖外展 / 内收',positive:'足尖外展',negative:'足尖内收'}],
 trunk:[{motion:'lean',label:'前倾 / 后仰',positive:'前倾',negative:'后仰'},{motion:'rotation',label:'左转 / 右转',positive:'向左转',negative:'向右转'},{motion:'sideBend',label:'右侧弯 / 左侧弯',positive:'向右侧弯',negative:'向左侧弯'}],
};
export const SEMANTIC_PART_LABELS:Record<SemanticPart,string>={shoulder:'肩 / 大臂',elbow:'肘',forearm:'前臂',wrist:'手腕',hip:'髋 / 大腿',legs:'双腿',knee:'膝 / 小腿',ankle:'踝 / 足',trunk:'躯干'};
export const SEMANTIC_CARRIES:Record<SemanticPart,string>={
 shoulder:'绕肩关节转动整条手臂：肘、前臂、手刚性随动，肘角、腕角与手的相对朝向不变',
 elbow:'绕肘铰链转动前臂与手，大臂不动，腕角与手的相对朝向不变',
 forearm:'手掌绕前臂轴旋转（桡尺关节），肘与手腕位置不动',
 wrist:'只转动手部朝向，手腕位置不动',
 hip:'绕髋关节转动整条腿：膝、小腿、足刚性随动，膝角与踝角不变',
 legs:'两侧大腿各外展 / 内收一半，读回两大腿在骨盆冠状面的夹角（左外展 + 右外展）；膝角与踝角不变',
 knee:'绕膝铰链转动小腿与足，大腿不动，踝角不变',
 ankle:'只转动足部朝向，小腿与踝位置不动',
 trunk:'脊柱五节平均分配；双手 IK 目标与支撑脚保持世界位置',
};
export const SEMANTIC_KEEPS='只写入选中关键帧的姿态字段；其他关键帧、支撑锁定与接触事件不变';
export interface SemanticReport{
 requested:number;actual:number;residual:number;ok:boolean;unit:'°';
 /** Present when actual ≠ requested beyond tolerance: why the solver did not deliver. */
 reason?:string;carries:string;keeps:string;
 /** Largest anchored-foot ankle displacement caused by the edit (mm). */
 footDriftMm:number;
 /** Arm edits: solved wrist distance from the stored IK target (mm). */
 targetResidualMm?:number;
}
export const SEMANTIC_TOLERANCE_DEG=.5;
/** Joint angles a part's edit must leave unchanged: only the commanded joint
 * moves, everything distal keeps its angle (rigid FK below the pivot). */
/** Distal angles held by FK edits. A knee edit with an anchored foot is the
 * exception: the foot frame stays locked while the pelvis moves, so ankle
 * flexion necessarily changes with the shank. */
const CHILD_JOINTS:Partial<Record<SemanticPart,[SemanticPart,SemanticMotion][]>>={
 shoulder:[['elbow','flexion'],['wrist','flexion'],['wrist','deviation']],
 elbow:[['wrist','flexion'],['wrist','deviation']],
 hip:[['knee','flexion'],['ankle','flexion']],
 legs:[['knee','flexion'],['ankle','flexion']],
 knee:[['ankle','flexion']],
};
/** Foot roll is not stored (yaw·pitch only), so a large abduction can tilt the ankle reading slightly. */
const CHILD_TOLERANCE_DEG=1.5;

const q=new Quaternion();
const world=(rig:HumanRig,bone:string)=>rig.bone(bone).getWorldQuaternion(new Quaternion());
const signedAbout=(a:Vector3,b:Vector3,axis:Vector3)=>Math.atan2(new Vector3().crossVectors(a,b).dot(axis),a.dot(b))/DEG;
function solvedHand(rig:HumanRig,side:Side){
 const rest=handFrame(rig.rest,side),w=world(rig,`wrist_${side}`);
 return {f:rest.forward.clone().applyQuaternion(w),n:rest.normal.clone().applyQuaternion(w)};
}
/** Palm direction toward the thumb (index MCP minus little-finger MCP) on the solved rig. */
const radial=(rig:HumanRig,side:Side)=>rig.point(`finger2-1_${side}`).sub(rig.point(`finger5-1_${side}`)).normalize();
const forearmAxis=(rig:HumanRig,side:Side)=>rig.point(`wrist_${side}`).sub(rig.point(`lowerarm01_${side}`)).normalize();
/** +1 when rotateHandFrame's positive 'dev' moves the fingers toward the little finger. */
function ulnarSign(rig:HumanRig,side:Side){
 const r=handFrame(rig.rest,side),R=rig.rest.get(`finger2-1_${side}`)!.clone().sub(rig.rest.get(`finger5-1_${side}`)!);
 return r.flexionAxis.dot(R)>0?1:-1;
}

/** Read the semantic angle (degrees) on the CURRENTLY SOLVED rig. Only
 * differences of this value are meaningful; the zero is the neutral of each
 * definition (hanging arm, straight elbow, neutral wrist, upright trunk). */
export function measureSemantic(rig:HumanRig,part:SemanticPart,motion:SemanticMotion,side:Side='R'):number{
 if(part==='trunk'){
  // Same YXZ order the solver writes per spine segment (x=lean, y=chest,
  // z=side), read on the composed pelvis→thorax rotation.
  const rel=world(rig,'root').invert().multiply(world(rig,'spine01'));
  const e=new Euler().setFromQuaternion(rel,'YXZ');
  return (motion==='lean'?e.x:motion==='rotation'?e.y:e.z)/DEG;
 }
 if(part==='legs')return measureSemantic(rig,'hip','abduction','L')+measureSemantic(rig,'hip','abduction','R');
 if(part==='hip'||part==='knee'||part==='ankle'){
  const hip=rig.point(`upperleg01_${side}`),knee=rig.point(`lowerleg01_${side}`),ankle=rig.point(`foot_${side}`);
  if(part==='knee')return angleAt(hip,knee,ankle);
  const pelvis=world(rig,'root').invert();
  if(part==='hip'){
   const h=knee.sub(hip).applyQuaternion(pelvis);
   return motion==='flexion'?Math.atan2(h.z,-h.y)/DEG:Math.atan2(side==='L'?h.x:-h.x,-h.y)/DEG;
  }
  const footQ=world(rig,`foot_${side}`);
  if(motion==='flexion'){
   // Same reading as the solver's ankle dorsiflexion: shank in the foot frame.
   const l=ankle.sub(knee).applyQuaternion(footQ.invert());
   return Math.atan2(-l.z,-l.y)/DEG;
  }
  const f=new Vector3(0,0,1).applyQuaternion(footQ).applyQuaternion(pelvis);
  return (side==='L'?1:-1)*Math.atan2(f.x,f.z)/DEG;
 }
 const s=rig.point(`upperarm01_${side}`),e=rig.point(`lowerarm01_${side}`),w=rig.point(`wrist_${side}`);
 if(part==='shoulder'){
  const h=e.clone().sub(s).applyQuaternion(world(rig,'spine01').invert());
  return motion==='flexion'?Math.atan2(h.z,-h.y)/DEG:Math.atan2(side==='L'?h.x:-h.x,-h.y)/DEG;
 }
 if(part==='elbow')return angleAt(s,e,w);
 const A=forearmAxis(rig,side),{f,n}=solvedHand(rig,side);
 if(part==='wrist'){
  if(motion==='flexion')return Math.atan2(-A.dot(n),A.dot(f))/DEG;
  const x=new Vector3().crossVectors(f,n);
  return ulnarSign(rig,side)*Math.atan2(A.dot(x),A.dot(f))/DEG;
 }
 // forearm: absolute palm roll about the forearm axis, measured against a
 // reference perpendicular built from the forearm and the upper arm.
 const ref=new Vector3().crossVectors(A,e.clone().sub(s)).normalize();
 if(ref.lengthSq()<.5)ref.set(1,0,0).addScaledVector(A,-A.x).normalize();
 const p=n.clone().addScaledVector(A,-n.dot(A));
 return pronationSign(rig,side)*signedAbout(ref,p,A);
}
/** +1 when a positive rotation of the hand about the distal forearm axis is
 * pronation: the thumb side turns toward the palm normal. */
function pronationSign(rig:HumanRig,side:Side){
 const A=forearmAxis(rig,side),{n}=solvedHand(rig,side);
 return new Vector3().crossVectors(A,radial(rig,side)).dot(n)>=0?1:-1;
}

/** Apply one semantic command to `doc`'s key `keyId` and return a NEW
 * document plus the solved readback. Pure in the document: `doc` is never
 * mutated, so repeated previews from the same base never stack increments.
 * Leaves `rig` solved at the edited key. */
/** `pelvisShift`: the posterior shift the caller displays this key with (the
 * workshop's pelvis schedule), so the readback matches the viewport solve. */
export function applySemanticEdit(rig:HumanRig,doc:WorkshopDoc,keyId:string,edit:SemanticEdit,origin:Vector3=rig.rest.get('root')!,pelvisShift?:number):{doc:WorkshopDoc;report:SemanticReport}{
 const next=JSON.parse(JSON.stringify(doc)) as WorkshopDoc;
 const key=keyAt(next,keyId);if(!key)throw new Error(`关键帧 ${keyId} 不存在`);
 const info=SEMANTIC_MOTIONS[edit.part]?.find(m=>m.motion===edit.motion);
 if(!info)throw new Error(`不支持的语义动作 ${edit.part}.${edit.motion}`);
 if(!Number.isFinite(edit.degrees))throw new Error('调整幅度必须是有限数值');
 const side:Side=edit.side==='L'?'L':'R',deg=edit.degrees;
 let shift=pelvisShift;
 const solve=()=>{const f=frameAt(next,key.time,origin);solveEffectiveFrame(rig,f,shift);return f;};
 const frame=solve();
 const shift0=solveEffectiveFrame(rig,frame,pelvisShift).pelvisShift;
 const [ankleLo,ankleHi]=LIMITS.ankleFlexion;
 const ankleExcess=()=>{const v=measureSemantic(rig,'ankle','flexion',side);return Math.max(0,ankleLo-v,v-ankleHi);};
 const ankleExcess0=ankleExcess();
 const before=measureSemantic(rig,edit.part,edit.motion,side);
 const hand=side==='L'?key.pose.handL:key.pose.handR;
 const leg=edit.part==='hip'||edit.part==='legs'||edit.part==='knee'||edit.part==='ankle';
 const legSides:Side[]=edit.part==='legs'?['L','R']:leg?[side]:[];
 const foot=side==='L'?key.pose.footL:key.pose.footR;
 const cn=side==='L'?'左':'右';
 let carries=SEMANTIC_CARRIES[edit.part],keeps=SEMANTIC_KEEPS;
 const keyIndex=sortedKeys(next).findIndex(k=>k.id===key.id);
 const fixedAt=(s:Side)=>frame.constraints[s==='L'?'plantL':'plantR']||isReleaseKey(next,keyIndex,s);
 const heldSides=(['L','R'] as const).filter(fixedAt),feet0=heldSides.map(s=>rig.point(`foot_${s}`));
 const footOwner=(s:Side)=>{
  if(!fixedAt(s))return key;
  if(frame.constraints[s==='L'?'plantL':'plantR'])return contactStartKey(next,s,key.time)??key;
  const ks=sortedKeys(next),p=keyIndex>0?keyIndex-1:ks.length-1;
  return contactStartKey(next,s,ks[p].time)??ks[p];
 };
 /* A held foot (planted, or a release key still on the contact) is shown at
  * the contact, never at this key's stored foot, so an FK leg edit would be
  * invisible. Split: this key leaves the contact and a neighbour key takes
  * over the contact at the same place — the previous key ends the run (a
  * release / swing key still drawn at the contact) and the next run key
  * restarts it at the old contact. Their displayed poses are checked below. */
 const lifted:Side[]=[],touched=new Map<string,typeof key>();
 const ks=sortedKeys(next),nk=ks.length;
 const prevKey=keyIndex>0?ks[keyIndex-1]:next.loop?ks[nk-1]:undefined,nextKey=keyIndex<nk-1?ks[keyIndex+1]:next.loop?ks[0]:undefined;
 const contacts=new Map(legSides.filter(fixedAt).map(x=>{const f=x==='L'?footOwner(x).pose.footL:footOwner(x).pose.footR;return [x,{target:{...f.target},yaw:f.yaw,pitch:f.pitch}] as const;}));
 const split=(x:Side)=>{
  const c=contacts.get(x);if(!c||lifted.includes(x))return;
  const flag=x==='L'?'plantL':'plantR',hold=(k:typeof key)=>{const f=x==='L'?k.pose.footL:k.pose.footR;f.target={...c.target};f.yaw=c.yaw;f.pitch=c.pitch;touched.set(k.id,k);};
  const wasPlanted=key.constraints[flag];
  key.constraints[flag]=false;lifted.push(x);
  if(prevKey&&prevKey!==key&&prevKey.constraints[flag]){prevKey.constraints[flag]=false;hold(prevKey);}
  if(wasPlanted&&nextKey&&nextKey!==key&&nextKey!==prevKey)hold(nextKey);
  // Lifting a foot drops its share of the automatic posterior pelvis shift
  // (it only acts on supported feet). Hold the shift this key was shown
  // with, else the whole body slides and every joint angle moves with it.
  if(shift===undefined&&lifted.length>1)return; // already held by the first split
  key.pose.root.z-=shift0-(shift??0);shift=undefined;
 };
 /** Rigid FK of the leg below `pivot` (hip or knee) by a world rotation —
  * rotateLegAbout (the same encoding the knee handle's free-leg drag uses);
  * split() runs first so a held foot is lifted before its target moves. */
 const legFK=(x:Side,pivot:Vector3,turn:Quaternion)=>{
  split(x);rotateLegAbout(rig,key.pose,x,pivot,turn);
 };
 const hipTurn=(x:Side,kind:'flexion'|'abduction',theta:number)=>
  new Quaternion().setFromAxisAngle((kind==='flexion'?new Vector3(-1,0,0):new Vector3(0,0,x==='L'?1:-1)).applyQuaternion(world(rig,'root')),theta);
 // Displayed pose of each touched neighbour, for the "did anything else move" check.
 const pointsAt=(d:WorkshopDoc,t:number)=>{solveEffectiveFrame(rig,frameAt(d,t,origin));return [...rig.bones.keys()].filter(b=>/^(root|spine01|head|upperleg01|lowerleg01|foot|toe1-1|upperarm01|lowerarm01|wrist)/.test(b)).map(b=>rig.point(b));};
 let reason:string|undefined;
 switch(edit.part){
  case 'hip':case 'legs':{
   // Pure FK on a solved snapshot: hip and knee/ankle positions are read once,
   // so the readback is exact rigid rotation, not a fit.
   const sides=legSides,kind=edit.part==='legs'?'abduction':edit.motion==='flexion'?'flexion':'abduction';
   const hips=sides.map(x=>rig.point(`upperleg01_${x}`));
   // Spread splits the requested angle between the two thighs.
   const theta=(edit.part==='legs'?deg/2:deg)*DEG;
   sides.forEach((x,i)=>legFK(x,hips[i],hipTurn(x,kind,theta)));
   break;
  }
  case 'knee':{
   const requested=before+deg,target=Math.max(LIMITS.kneeFlexion[0],Math.min(LIMITS.kneeFlexion[1],requested));
   if(requested<-SEMANTIC_TOLERANCE_DEG)reason='已到伸直位（0°），膝不能反向过伸';
   else if(requested>LIMITS.kneeFlexion[1]+SEMANTIC_TOLERANCE_DEG)reason=`膝屈曲上限 ${LIMITS.kneeFlexion[1]}°`;
   if(fixedAt(side)){
    // With a fixed ankle and fixed-length bones, knee flexion is determined
    // by hip-to-ankle distance. Move the pelvis along that axis so the ankle
    // target and foot orientation stay locked while the requested angle changes.
    const hip=rig.point(`upperleg01_${side}`),ankle=rig.point(`foot_${side}`),axis=hip.clone().sub(ankle),distance=axis.length();
    const upper=rig.rest.get(`upperleg01_${side}`)!.distanceTo(rig.rest.get(`lowerleg01_${side}`)!);
    const lower=rig.rest.get(`lowerleg01_${side}`)!.distanceTo(rig.rest.get(`foot_${side}`)!);
    if(distance<1e-8)reason='髋与踝重合，无法确定伸腿方向';
    else{
     const targetDistance=Math.sqrt(Math.max(0,upper*upper+lower*lower+2*upper*lower*Math.cos(target*DEG)));
     axis.multiplyScalar((targetDistance-distance)/distance);
    const targetRootZ=rig.point('root').z+axis.z;
     key.pose.root.x+=axis.x;key.pose.root.y+=axis.y;key.pose.root.z+=axis.z;
    // Refit root.z to the natural pelvis correction after changing the pose,
    // keeping the intended world-space pelvis displacement stable on commit.
    shift=undefined;
    for(let i=0;i<5;i++){
     solve();
     const correction=targetRootZ-rig.point('root').z;
     if(Math.abs(correction)<1e-8)break;
     key.pose.root.z+=correction;
    }
    solve();
    carries='膝屈伸时骨盆沿髋—踝方向随动；支撑脚的位置与朝向保持锁定，踝角会随小腿方向变化';
    keeps='支撑脚与其他关键帧保持不变；只调整选中帧的膝角与骨盆位置';
    }
   }else{
    const hip=rig.point(`upperleg01_${side}`),knee=rig.point(`lowerleg01_${side}`),ankle=rig.point(`foot_${side}`);
    // Hinge from the solved bend plane; a straight leg falls back to the axis
    // whose positive turn swings the ankle backward (knees flex backward).
    const thigh=knee.clone().sub(hip),shank=ankle.clone().sub(knee),axis=new Vector3().crossVectors(thigh,shank);
    if(axis.lengthSq()<1e-8){
     axis.set(1,0,0).applyQuaternion(world(rig,'root'));
     const back=new Vector3(0,0,-1).applyQuaternion(world(rig,'root'));
     if(new Vector3().crossVectors(axis,shank).dot(back)<0)axis.negate();
    }
    // The pole lies in the bend plane, which the hinge keeps; turning it about the knee keeps it there.
    legFK(side,knee,new Quaternion().setFromAxisAngle(axis.normalize(),deg*DEG));
   }
   break;
  }
  case 'ankle':{
   // A held foot is shown at its contact: split first, then this key's own foot turns.
   const c=contacts.get(side);split(side);
   if(c){foot.target={...c.target};foot.yaw=c.yaw;foot.pitch=c.pitch;}
   // footRotation = Ry(yaw)·Rx(pitch): +pitch drops the toes, +yaw turns them toward +X (the left side).
   if(edit.motion==='flexion')foot.pitch-=deg;else foot.yaw+=side==='L'?deg:-deg;
   break;
  }
  case 'trunk':{
   // Five per-segment YXZ rotations do not compose 1:1 into the thorax
   // angle once the spine is already bent, so a few secant steps fit the
   // field delta to the measured change (deterministic: fixed iteration count).
   const field=edit.motion==='lean'?'lean':edit.motion==='rotation'?'chest':'side';
   const start=key.pose[field];let x=deg;
   for(let i=0;i<4&&deg!==0;i++){
    key.pose[field]=start+x;solve();
    const got=measureSemantic(rig,'trunk',edit.motion,side)-before;
    if(Math.abs(got-deg)<.01||Math.abs(got)<1e-6)break;
    x*=deg/got;
   }
   key.pose[field]=start+x;
   break;
  }
  case 'shoulder':{
   // Thorax-fixed axes: flexion about the thorax lateral axis (same sign both
   // sides), abduction about the thorax forward axis (mirrored per side).
   const t=world(rig,'spine01');
   const axis=edit.motion==='flexion'?new Vector3(-1,0,0):new Vector3(0,0,side==='L'?1:-1);
   rotateArmAbout(rig,key.pose,side,'upper',axis.applyQuaternion(t),deg);break;
  }
  case 'elbow':{
   const ru=rig.rest.get(`lowerarm01_${side}`)!.clone().sub(rig.rest.get(`upperarm01_${side}`)!);
   const rl=rig.rest.get(`wrist_${side}`)!.clone().sub(rig.rest.get(`lowerarm01_${side}`)!);
   // The solver maps the rest bend normal onto the solved bend plane, so this
   // is the hinge even for a straight arm; rotating the forearm about it by
   // +θ opens the angle between upper-arm extension and forearm (flexion).
   const hinge=new Vector3().crossVectors(ru,rl).normalize().applyQuaternion(world(rig,`upperarm01_${side}`));
   const max=next.freeArms?180:LIMITS.elbowFlexion[1];
   if(before+deg<-SEMANTIC_TOLERANCE_DEG)reason='已到伸直位（0°），肘不能反向过伸';
   else if(before+deg>max+SEMANTIC_TOLERANCE_DEG)reason=`肘屈曲上限 ${max}°`;
   rotateArmAbout(rig,key.pose,side,'forearm',hinge,deg);break;
  }
  case 'wrist':
   rotateHandFrame(hand,edit.motion==='flexion'?'flex':'dev',edit.motion==='flexion'?deg:ulnarSign(rig,side)*deg);break;
  case 'forearm':{
   q.setFromAxisAngle(forearmAxis(rig,side),pronationSign(rig,side)*deg*DEG);
   const f=new Vector3(hand.forward.x,hand.forward.y,hand.forward.z).applyQuaternion(q);
   const n=new Vector3(hand.normal.x,hand.normal.y,hand.normal.z).applyQuaternion(q);
   hand.forward={x:f.x,y:f.y,z:f.z};hand.normal={x:n.x,y:n.y,z:n.z};break;
  }
 }
 let neighbourMm=0;
 if(touched.size){
  for(const k of touched.values()){const a=pointsAt(doc,k.time),b=pointsAt(next,k.time);a.forEach((p,i)=>{neighbourMm=Math.max(neighbourMm,p.distanceTo(b[i])*1000);});}
 }
 if(lifted.length){
  const names=lifted.map(x=>x==='L'?'左':'右').join('、'),times=[...touched.values()].map(k=>k.time.toFixed(2)).join('、');
  carries=`${SEMANTIC_CARRIES[edit.part]}。${names}脚原为支撑：本帧改为离地，使用新的脚位${times?`；${times}s 接管原接触点（显示姿态变化 ${neighbourMm.toFixed(1)} mm），相邻帧之间的过渡随之改变`:''}`;
  keeps='其余关节角保持；只改本帧该腿与相邻帧的支撑标记 / 接触脚位';
 }
 const childSides=edit.part==='legs'?(['L','R'] as const):[side];
 const childJoints=edit.part==='knee'&&fixedAt(side)?[]:CHILD_JOINTS[edit.part]??[];
 const childAngles=()=>childJoints.flatMap(([p,m])=>childSides.map(x=>({p,m,x,v:measureSemantic(rig,p,m,x)})));
 solveEffectiveFrame(rig,frameAt(doc,key.time,origin),pelvisShift);
 const children0=childAngles();
 solve();
 const after=measureSemantic(rig,edit.part,edit.motion,side);
 const childMoved=childAngles().map((c,i)=>({...c,d:c.v-children0[i].v})).find(c=>Math.abs(c.d)>CHILD_TOLERANCE_DEG);
 let actual=after-before;
 actual=((actual+540)%360)-180; // angle readbacks wrap at ±180°
 // Feet the edit deliberately moved are judged by reach instead of drift.
 const footDriftMm=Math.max(0,...heldSides.map((s,i)=>lifted.includes(s)?0:rig.point(`foot_${s}`).distanceTo(feet0[i])*1000));
 const arm=edit.part!=='trunk'&&!leg;
 const targetResidualMm=arm?rig.point(`wrist_${side}`).distanceTo(new Vector3(hand.target.x,hand.target.y,hand.target.z))*1000:undefined;
 // Swing-foot checks: the solver does not clamp a swing sole or the ankle angle.
 let soleMm=0,ankleOut=false;
 if(leg){
  for(const s of legSides){
   const g=footGeometry(rig.rest,s),ankle=rig.point(`foot_${s}`);
   const named=Math.min(...g.names.map(n=>rig.point(n).y));
   const lowest=footLowestY(g,named,ankle.y,rig.bone(`foot_${s}`).getWorldQuaternion(new Quaternion()));
   soleMm=Math.max(soleMm,footDepth(g,lowest)*1000);
  }
  // Only an edit that pushes the ankle out of (or further out of) its range is flagged.
  ankleOut=ankleExcess()>Math.max(ankleExcess0,0)+SEMANTIC_TOLERANCE_DEG;
  if(soleMm>5)reason=`${edit.part==='legs'?'':cn}脚底低于地面 ${soleMm.toFixed(0)} mm`;
  else if(ankleOut&&edit.part==='ankle')reason=`超出踝关节参考范围 ${ankleLo}°…${ankleHi}°`;
 }
 if(childMoved&&!reason)reason=`${childMoved.x==='L'?'左':'右'}${SEMANTIC_PART_LABELS[childMoved.p]}被带动 ${childMoved.d.toFixed(1)}°`;
 if(neighbourMm>1&&!reason)reason=`接管接触的相邻关键帧显示姿态变化 ${neighbourMm.toFixed(1)} mm`;
 const residual=actual-deg,ok=Math.abs(residual)<=SEMANTIC_TOLERANCE_DEG&&footDriftMm<1&&soleMm<=5&&neighbourMm<=1&&!childMoved&&!(ankleOut&&edit.part==='ankle');
 if(!ok&&!reason){
  if(footDriftMm>=1)reason=`支撑脚被带动 ${footDriftMm.toFixed(1)} mm`;
  else if(edit.part==='wrist'&&!next.freeArms){
   const {f}=solvedHand(rig,side);
   if(forearmAxis(rig,side).angleTo(f)/DEG>WRIST_BEND_LIMIT_DEG-2)reason=`腕弯曲锥限 ${Math.round(WRIST_BEND_LIMIT_DEG)}°（可在通用调整启用自由手臂）`;
  }
  else if(edit.part==='shoulder'&&next.clavicleLift)reason='抬肩辅助随手高度移动了肩部';
  else if(targetResidualMm!==undefined&&targetResidualMm>1)reason=`手腕目标不可达，残差 ${targetResidualMm.toFixed(1)} mm`;
  reason??='求解限位或几何耦合，实际变化与请求不同';
 }
 if(ok)reason=undefined;
 else if(reason&&Math.abs(residual)<=SEMANTIC_TOLERANCE_DEG&&(soleMm>5||ankleOut))reason=`${reason}（角度已按请求执行）`;
 return {doc:next,report:{requested:deg,actual,residual,ok,unit:'°',reason,carries,keeps,footDriftMm,targetResidualMm}};
}

export interface GroundReport{ok:boolean;dropMm:number;reason?:string;detail:string;
 /** Largest knee-angle change of a planted leg caused by the body moving down / up (°). */
 plantedKneeDeg:number}
/** 「落地」: translate THIS key's whole body vertically — pelvis, both hand
 * targets/poles, knee poles and every foot that is not on a contact — until
 * the lowest sole of `side`'s free foot touches the rest floor. A pure
 * vertical translation keeps every moved joint angle; only a leg whose foot
 * is planted re-bends to reach its (unchanged) contact, and that change is
 * reported. Other keys are never touched. `side:'both'` grounds the lower of
 * the two free feet. Pure in the document, like applySemanticEdit. */
export function groundFoot(rig:HumanRig,doc:WorkshopDoc,keyId:string,side:Side|'both',origin:Vector3=rig.rest.get('root')!,pelvisShift?:number):{doc:WorkshopDoc;report:GroundReport}{
 const next=JSON.parse(JSON.stringify(doc)) as WorkshopDoc;
 const key=keyAt(next,keyId);if(!key)throw new Error(`关键帧 ${keyId} 不存在`);
 const solve=()=>{const f=frameAt(next,key.time,origin);solveEffectiveFrame(rig,f,pelvisShift);return f;};
 const frame=solve(),ks=sortedKeys(next),i=ks.findIndex(k=>k.id===key.id);
 // A planted foot, or a release key still drawn at its contact, is already on its contact.
 const held=(x:Side)=>frame.constraints[x==='L'?'plantL':'plantR']||isReleaseKey(next,i,x);
 const sole=(x:Side)=>{
  const g=footGeometry(rig.rest,x),ankle=rig.point(`foot_${x}`),named=Math.min(...g.names.map(n=>rig.point(n).y));
  return footLowestY(g,named,ankle.y,rig.bone(`foot_${x}`).getWorldQuaternion(new Quaternion()))-g.groundY;
 };
 const free=(side==='both'?(['L','R'] as const):[side]).filter(x=>!held(x));
 const nothing=(why:string)=>({doc:JSON.parse(JSON.stringify(doc)) as WorkshopDoc,report:{ok:false,dropMm:0,reason:why,detail:'',plantedKneeDeg:0}});
 if(!free.length)return nothing('该脚在此帧已是支撑（贴在接触点上），无需落地');
 const x=free.reduce((a,b)=>sole(a)<=sole(b)?a:b),dy=sole(x);
 const cn=x==='L'?'左':'右';
 if(Math.abs(dy)<.001)return {doc:next,report:{ok:true,dropMm:0,detail:`${cn}脚已着地`,plantedKneeDeg:0}};
 const planted=(['L','R'] as const).filter(held);
 const knee0=planted.map(p=>measureSemantic(rig,'knee','flexion',p));
 // Hold the posterior pelvis shift this key was shown with: lowering the body
 // bends the planted leg into more dorsiflexion, and an automatic shift would
 // slide the whole body backward too (not a vertical translation any more).
 const shift0=solveEffectiveFrame(rig,frame,pelvisShift).pelvisShift;
 const base=JSON.parse(JSON.stringify(key.pose)) as typeof key.pose;
 let total=0,clamped=false;
 const place=(d:number)=>{
  const down=(v:{x:number;y:number;z:number})=>({...v,y:v.y-d}),y=base.root.y-d;
  clamped=y<-.55||y>.35;
  key.pose.root={...base.root,y:Math.max(-.55,Math.min(.35,y))}; // solvePose's root clamp
  // shortcut: one fixed-point pass on root.z; the auto shift depends weakly on z, upgrade to an iteration if residual z drift is ever visible.
  key.pose.handL={...base.handL,target:down(base.handL.target),pole:down(base.handL.pole)};
  key.pose.handR={...base.handR,target:down(base.handR.target),pole:down(base.handR.pole)};
  for(const s of ['L','R'] as const){
   const f=s==='L'?key.pose.footL:key.pose.footR,b=s==='L'?base.footL:base.footR;
   f.pole=down(b.pole);f.target=held(s)?b.target:down(b.target);
  }
  // The viewport solves with the schedule's shift for the NEW pose; bake the
  // difference into root.z so what is stored is what was shown (shift0).
  const f=frameAt(next,key.time,origin),auto=solveEffectiveFrame(rig,f).pelvisShift;
  key.pose.root={...key.pose.root,z:base.root.z+(auto-shift0)};
  solveEffectiveFrame(rig,frameAt(next,key.time,origin));
 };
 // The solver's own clamps (ankle, pelvis fold) can still nudge the result, so
 // a few fixed-point steps land the sole within 0.5 mm. Deterministic.
 for(let it=0;it<6;it++){place(total+=sole(x));if(Math.abs(sole(x))<5e-4)break;}
 const after=sole(x),p=key.pose;
 const reach=planted.map(s=>{const t=(s==='L'?p.footL:p.footR).target;return rig.point(`foot_${s}`).distanceTo(new Vector3(t.x,t.y,t.z))*1000;});
 const plantedKneeDeg=Math.max(0,...planted.map((s,k)=>Math.abs(measureSemantic(rig,'knee','flexion',s)-knee0[k])));
 const miss=reach.findIndex(d=>d>2);
 // Dorsiflexion past the ankle reference range means the planted leg is
 // folding the ankle to keep its contact: report it instead of claiming success.
 const dorsi=planted.map(s=>measureSemantic(rig,'ankle','flexion',s)),overAnkle=dorsi.findIndex(v=>v>LIMITS.ankleFlexion[1]+SEMANTIC_TOLERANCE_DEG);
 let reason:string|undefined;
 if(clamped)reason='骨盆已到升降范围极限';
 else if(overAnkle>=0)reason=`${planted[overAnkle]==='L'?'左':'右'}支撑踝背屈 ${dorsi[overAnkle].toFixed(0)}° 超过参考范围 ${LIMITS.ankleFlexion[1]}°：身体需下降 ${(total*100).toFixed(1)} cm，太多了；减小大腿角度，或让支撑脚也移动`;
 else if(miss>=0)reason=`${planted[miss]==='L'?'左':'右'}支撑腿够不到自己的接触点（差 ${reach[miss].toFixed(0)} mm）`;
 else if(Math.abs(after)>.002)reason=`${cn}脚底仍${after>0?'高于':'低于'}地面 ${Math.abs(after*1000).toFixed(0)} mm`;
 const verb=total>0?'下降':'上升';
 const detail=`本帧整体${verb} ${Math.abs(total*100).toFixed(1)} cm，${cn}脚落到地面；手、离地的脚与各关节角随身体平移不变`+
  (planted.length?`；${planted.map(s=>s==='L'?'左':'右').join('、')}支撑腿重新求解，膝角变化 ${plantedKneeDeg.toFixed(1)}°`:'');
 return {doc:next,report:{ok:!reason,dropMm:total*1000,reason,detail,plantedKneeDeg}};
}
