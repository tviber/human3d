import {beforeAll,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import {Quaternion,Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from './rig';
import {footGeometry,footLowestY} from './foot';
import {blankDocument,compileMotion,defaultDocument,frameAt,frameAtCompiled,mirrorDoc,serializeDoc,type WorkshopDoc} from './document';
import {analyzePose,solveEffectiveFrame} from './solver';
import {applySemanticEdit,applyKneeBalanceEdit,captureKneeBalanceState,groundFoot,kneeBalanceSides,measureSemantic,SEMANTIC_MOTIONS,type SemanticEdit,type SemanticPart} from './semantic-edit';
import {buildPelvisSchedule} from './pelvis-schedule';
import {motionFileById} from './motion-files';
import {LIMITS} from './kinematics';

let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);
const origin=()=>rig.rest.get('root')!;
const solveAt=(doc:WorkshopDoc,t:number)=>solveEffectiveFrame(rig,frameAt(doc,t,origin()));
const solveScheduledAt=(doc:WorkshopDoc,t:number)=>{
 const compiled=compileMotion(doc,origin()),schedule=buildPelvisSchedule(rig,compiled),frame=frameAtCompiled(compiled,t);
 solveEffectiveFrame(rig,frame,schedule.passthrough?undefined:schedule.at(t));
 return {frame,analysis:analyzePose(rig,frame.pose,frame.constraints),schedule};
};

describe('semantic pose edits through the production sampler and solver',()=>{
 it('delivers every whitelisted motion on both sides with a readback equal to the request',()=>{
  const doc=blankDocument(rig.rest,'语义','semantic');
  const key=doc.keys[0];
  // Leg parts need a swing foot; they have their own test below.
  for(const part of (Object.keys(SEMANTIC_MOTIONS) as SemanticPart[]).filter(p=>!['hip','legs','knee','ankle'].includes(p)))for(const {motion} of SEMANTIC_MOTIONS[part])for(const side of part==='trunk'?['R'] as const:['L','R'] as const)for(const deg of [-12,15]){
   // The neutral stance hangs the elbow almost straight: extension from it is
   // honestly refused, so elbow extension is checked from a flexed start.
   const base=part==='elbow'&&deg<0?applySemanticEdit(rig,doc,key.id,{part,side,motion,degrees:40}).doc:doc;
   const {doc:next,report}=applySemanticEdit(rig,base,key.id,{part,side,motion,degrees:deg});
   expect(report.ok,`${part}.${motion} ${side} ${deg}: ${report.reason} actual=${report.actual}`).toBe(true);
   expect(Math.abs(report.actual-deg)).toBeLessThan(.5);
   expect(report.footDriftMm).toBeLessThan(1);
   // The readback is the solved rig of the RETURNED document, re-solved fresh.
   solveAt(base,key.time);const b=measureSemantic(rig,part,motion,side);
   solveAt(next,key.time);const a=measureSemantic(rig,part,motion,side);
   expect(a-b).toBeCloseTo(report.actual,6);
   // Other keys are never touched.
   expect(serializeDoc({...next,keys:next.keys.slice(1)})).toBe(serializeDoc({...base,keys:base.keys.slice(1)}));
  }
 });
 it('never mutates the input document, so previews from one base do not stack',()=>{
  const doc=defaultDocument(rig.rest),before=serializeDoc(doc),id=doc.keys[2].id;
  const a=applySemanticEdit(rig,doc,id,{part:'elbow',side:'R',motion:'flexion',degrees:10});
  const b=applySemanticEdit(rig,doc,id,{part:'elbow',side:'R',motion:'flexion',degrees:10});
  expect(serializeDoc(doc)).toBe(before);
  expect(serializeDoc(a.doc)).toBe(serializeDoc(b.doc));
 });
/** One key with `side`'s foot off the ground (not a release key: it is the
 * first key of a non-loop document), lifted 12 cm so leg edits stay clear. */
function swingDoc(side:'L'|'R'){
 const doc=blankDocument(rig.rest,'摆动腿',`swing-${side}`),k=doc.keys[0];
 k.constraints[side==='L'?'plantL':'plantR']=false;
 const f=side==='L'?k.pose.footL:k.pose.footR;f.target={...f.target,y:f.target.y+.12};
 f.pitch=30; // the lift bends the knee ≈60°; dropping the toes brings the ankle back near neutral
 return doc;
}
 it('is deterministic and mirror-consistent: the same command on the mirrored side yields the mirrored document',()=>{
  const doc=defaultDocument(rig.rest),id=doc.keys[1].id;
  for(const edit of [{part:'shoulder',motion:'abduction'},{part:'shoulder',motion:'flexion'},{part:'wrist',motion:'deviation'},{part:'forearm',motion:'pronation'}] as const){
   const right=applySemanticEdit(rig,doc,id,{...edit,side:'R',degrees:20}).doc;
   const left=applySemanticEdit(rig,mirrorDoc(doc),id,{...edit,side:'L',degrees:20}).doc;
   const a=mirrorDoc(right).keys[1].pose.handL,b=left.keys[1].pose.handL;
   for(const f of ['target','pole','forward','normal'] as const)expect(new Vector3(a[f].x,a[f].y,a[f].z).distanceTo(new Vector3(b[f].x,b[f].y,b[f].z)),`${edit.part}.${edit.motion} ${f}`).toBeLessThan(1e-6);
  }
 });
 it('reports clamps instead of claiming success',()=>{
  const doc=blankDocument(rig.rest,'限位','limits'),id=doc.keys[0].id;
  const elbow=applySemanticEdit(rig,doc,id,{part:'elbow',side:'R',motion:'flexion',degrees:170}).report;
  expect(elbow.ok).toBe(false);expect(elbow.actual).toBeLessThan(160);expect(elbow.reason).toMatch(/145/);
  const wrist=applySemanticEdit(rig,doc,id,{part:'wrist',side:'L',motion:'flexion',degrees:85}).report;
  expect(wrist.ok).toBe(false);expect(wrist.reason).toMatch(/腕弯曲锥限/);
  const hyper=applySemanticEdit(rig,doc,id,{part:'elbow',side:'R',motion:'flexion',degrees:-40}).report;
  expect(hyper.ok).toBe(false);expect(hyper.reason).toMatch(/伸直/);
  expect(()=>applySemanticEdit(rig,doc,id,{part:'elbow',side:'R',motion:'abduction',degrees:5})).toThrow();
  expect(()=>applySemanticEdit(rig,doc,id,{part:'elbow',side:'R',motion:'flexion',degrees:Number.NaN})).toThrow();
 });
 it('edits a swing leg: hip, knee and foot with measured readback, both sides',()=>{
  for(const side of ['L','R'] as const){
   const doc=swingDoc(side),id=doc.keys[0].id;
   // Bend the knee first so extension and hip moves stay clear of the ground.
   const bent=applySemanticEdit(rig,doc,id,{part:'knee',side,motion:'flexion',degrees:40});
   expect(bent.report.ok,bent.report.reason).toBe(true);
   for(const part of ['hip','knee','ankle'] as const)for(const {motion} of SEMANTIC_MOTIONS[part])for(const deg of [-8,10]){
    const {doc:next,report}=applySemanticEdit(rig,bent.doc,id,{part,side,motion,degrees:deg});
    expect(report.ok,`${side} ${part}.${motion} ${deg}: ${report.reason} actual=${report.actual}`).toBe(true);
    solveAt(bent.doc,0);const b=measureSemantic(rig,part,motion,side);
    solveAt(next,0);const a=measureSemantic(rig,part,motion,side);
    expect(a-b).toBeCloseTo(report.actual,6);
    // The planted foot never moves; the other leg's stored pose is untouched.
    const other=side==='L'?'footR':'footL';
    expect(next.keys[0].pose[other]).toEqual(bent.doc.keys[0].pose[other]);
    expect(report.footDriftMm).toBeLessThan(1);
   }
  }
 });
 it('moves only the commanded joint: every distal joint angle is unchanged (arm and leg, swing and planted)',()=>{
  const angles=(d:WorkshopDoc,t:number,list:[SemanticPart,'flexion'|'deviation',('L'|'R')][])=>{solveAt(d,t);return list.map(([p,m,x])=>measureSemantic(rig,p,m,x));};
  const cases:[WorkshopDoc,string,SemanticEdit,[SemanticPart,'flexion'|'deviation','L'|'R'][]][]=[];
  const stand=blankDocument(rig.rest,'支撑','planted'),sw=swingDoc('R');
  for(const side of ['L','R'] as const){
   cases.push([defaultDocument(rig.rest),'k-contact',{part:'shoulder',side,motion:'flexion',degrees:20},[['elbow','flexion',side],['wrist','flexion',side],['wrist','deviation',side]]]);
   cases.push([defaultDocument(rig.rest),'k-contact',{part:'elbow',side,motion:'flexion',degrees:15},[['wrist','flexion',side],['wrist','deviation',side]]]);
   // A planted thigh going forward lifts its foot; the knee and ankle angles hold.
   cases.push([stand,stand.keys[1].id,{part:'hip',side,motion:'flexion',degrees:25},[['knee','flexion',side],['ankle','flexion',side]]]);
  }
  cases.push([sw,sw.keys[0].id,{part:'hip',side:'R',motion:'flexion',degrees:20},[['knee','flexion','R'],['ankle','flexion','R']]]);
  cases.push([sw,sw.keys[0].id,{part:'knee',side:'R',motion:'flexion',degrees:20},[['ankle','flexion','R']]]);
  for(const [doc,keyId,edit,kids] of cases){
   const t=doc.keys.find(k=>k.id===keyId)!.time,{doc:next,report}=applySemanticEdit(rig,doc,keyId,edit);
   expect(report.ok,`${edit.part} ${edit.side}: ${report.reason}`).toBe(true);
   const a=angles(doc,t,kids),b=angles(next,t,kids);
   a.forEach((v,i)=>expect(Math.abs(b[i]-v),`${edit.part} ${edit.side} → ${kids[i].join('.')}`).toBeLessThan(.6));
  }
 });
 it('a planted thigh moved forward: the foot leaves the ground at this key only, neighbours keep their displayed pose',()=>{
  const doc=blankDocument(rig.rest,'三帧','three');
  doc.keys.splice(1,0,{...JSON.parse(JSON.stringify(doc.keys[0])),id:'three-m',time:.5,label:'中间'});
  const before=doc.keys.map(k=>{solveAt(doc,k.time);return rig.point('foot_L').clone();});
  const {doc:next,report}=applySemanticEdit(rig,doc,'three-m',{part:'hip',side:'L',motion:'flexion',degrees:25});
  expect(report.ok,report.reason).toBe(true);
  expect(report.carries).toMatch(/本帧改为离地/);
  expect(next.keys[1].constraints.plantL).toBe(false);
  // The neighbours still show the old contact (foot within 1 mm).
  for(const i of [0,2]){solveAt(next,next.keys[i].time);expect(rig.point('foot_L').distanceTo(before[i])*1000).toBeLessThan(1);}
  solveAt(next,.5);expect(rig.point('foot_L').z).toBeGreaterThan(before[1].z+.1); // the foot went forward with the thigh
  expect(next.keys[1].pose.footR).toEqual(doc.keys[1].pose.footR);
 });
 it('落地: a lifted foot comes back to the floor by translating the body; moved joint angles hold, other keys never move',()=>{
  const doc=blankDocument(rig.rest,'三帧','three');
  doc.keys.splice(1,0,{...JSON.parse(JSON.stringify(doc.keys[0])),id:'three-m',time:.5,label:'中间'});
  const sole=(x:'L'|'R')=>{
   const g=footGeometry(rig.rest,x),ankle=rig.point(`foot_${x}`),named=Math.min(...g.names.map(n=>rig.point(n).y));
   return footLowestY(g,named,ankle.y,rig.bone(`foot_${x}`).getWorldQuaternion(new Quaternion()))-g.groundY;
  };
  // Small thigh moves only: grounding a 20° flexion would need a 13 cm drop,
  // which folds the planted ankle past its range (asserted separately below).
  for(const deg of [8,5]){
   const lifted=applySemanticEdit(rig,doc,'three-m',{part:'hip',side:'L',motion:'flexion',degrees:deg}).doc;
   solveAt(lifted,.5);const s0=sole('L'),hip0=measureSemantic(rig,'hip','flexion','L'),knee0=measureSemantic(rig,'knee','flexion','L'),ankle0=measureSemantic(rig,'ankle','flexion','L');
   expect(Math.abs(s0)).toBeGreaterThan(.002); // the thigh edit really left the floor (or dug in)
   const {doc:g,report}=groundFoot(rig,lifted,'three-m','L');
   expect(report.ok,report.reason).toBe(true);
   expect(report.dropMm).toBeCloseTo(s0*1000,6);
   solveAt(g,.5);
   expect(Math.abs(sole('L'))*1000).toBeLessThan(2);
   expect(measureSemantic(rig,'hip','flexion','L')).toBeCloseTo(hip0,1);
   expect(measureSemantic(rig,'knee','flexion','L')).toBeCloseTo(knee0,1);
   expect(measureSemantic(rig,'ankle','flexion','L')).toBeCloseTo(ankle0,1);
   expect(report.detail).toMatch(/右支撑腿重新求解/);
   expect(g.keys[0]).toEqual(lifted.keys[0]);expect(g.keys[2]).toEqual(lifted.keys[2]);
  }
  const big=groundFoot(rig,applySemanticEdit(rig,doc,'three-m',{part:'hip',side:'L',motion:'flexion',degrees:20}).doc,'three-m','L').report;
  expect(big.ok).toBe(false);expect(big.reason).toMatch(/支撑踝背屈/);
  // Thigh back digs the foot in: the body would have to RISE, and the near-straight stance knee cannot reach.
  const up=groundFoot(rig,applySemanticEdit(rig,doc,'three-m',{part:'hip',side:'L',motion:'flexion',degrees:-8}).doc,'three-m','L').report;
  expect(up.ok).toBe(false);expect(up.reason).toMatch(/够不到/);
  // A planted foot is already grounded: nothing to do, document unchanged.
  const r=groundFoot(rig,doc,'three-m','R');
  expect(r.report.ok).toBe(false);expect(r.report.reason).toMatch(/已是支撑/);expect(r.doc).toEqual(doc);
 });
 it('spreads both thighs: the angle between them grows by the request',()=>{
  for(const doc of [swingDoc('R')])for(const deg of [-3,12]){
   const id=doc.keys[0].id,{doc:next,report}=applySemanticEdit(rig,doc,id,{part:'legs',motion:'spread',degrees:deg});
   expect(report.ok,`${doc.id} ${deg}: ${report.reason}`).toBe(true);
   solveAt(doc,0);const k0=rig.point('lowerleg01_L').distanceTo(rig.point('lowerleg01_R'));
   solveAt(next,0);const k1=rig.point('lowerleg01_L').distanceTo(rig.point('lowerleg01_R'));
   expect(Math.sign(k1-k0)).toBe(Math.sign(deg)); // knees part when spreading
  }
 });
 it('reports a knee pushed through the ground and the ankle reference limit',()=>{
  const doc=swingDoc('R'),id=doc.keys[0].id;
  const knee=applySemanticEdit(rig,doc,id,{part:'knee',side:'R',motion:'flexion',degrees:-90}).report;
  expect(knee.ok).toBe(false);expect(knee.reason).toMatch(/伸直/);
  const ankle=applySemanticEdit(rig,doc,id,{part:'ankle',side:'R',motion:'flexion',degrees:35}).report;
  expect(ankle.ok).toBe(false);expect(ankle.reason).toMatch(/踝关节参考范围/);
 });
 it('labels anatomical directions with the expected geometry',()=>{
  const doc=blankDocument(rig.rest,'方向','dir'),id=doc.keys[0].id;
  solveAt(doc,0);const w0=rig.point('wrist_R'),c0=rig.point('neck01');
  applySemanticEdit(rig,doc,id,{part:'shoulder',side:'R',motion:'flexion',degrees:30});
  expect(rig.point('wrist_R').z).toBeGreaterThan(w0.z+.05); // flexion carries the hand forward (+Z faces front)
  applySemanticEdit(rig,doc,id,{part:'shoulder',side:'R',motion:'abduction',degrees:30});
  expect(rig.point('wrist_R').x).toBeLessThan(w0.x-.05); // right side is −X: abduction moves outward
  applySemanticEdit(rig,doc,id,{part:'trunk',motion:'lean',degrees:20});
  expect(rig.point('neck01').z).toBeGreaterThan(c0.z+.05);
  applySemanticEdit(rig,doc,id,{part:'trunk',motion:'sideBend',degrees:15});
  expect(rig.point('neck01').x).toBeLessThan(c0.x-.03);
  const sw=swingDoc('R');solveAt(sw,0);const k0=rig.point('lowerleg01_R'),t0=rig.point('toe1-1_R');
  applySemanticEdit(rig,sw,sw.keys[0].id,{part:'hip',side:'R',motion:'flexion',degrees:25});
  expect(rig.point('lowerleg01_R').z).toBeGreaterThan(k0.z+.05); // hip flexion brings the knee forward
  applySemanticEdit(rig,sw,sw.keys[0].id,{part:'hip',side:'R',motion:'abduction',degrees:20});
  expect(rig.point('lowerleg01_R').x).toBeLessThan(k0.x-.05);
  applySemanticEdit(rig,sw,sw.keys[0].id,{part:'ankle',side:'R',motion:'flexion',degrees:15});
  expect(rig.point('toe1-1_R').y).toBeGreaterThan(t0.y+.01); // dorsiflexion lifts the toes

  // Planted stance, the user's case: thigh forward must swing the thigh itself
  // (knee point forward relative to the pelvis), not just slide the body.
  const st=blankDocument(rig.rest,'站立','stand');solveAt(st,1);
  const pelvis0=rig.point('root'),kneeRel0=rig.point('lowerleg01_L').sub(pelvis0);
  const fwd=applySemanticEdit(rig,st,st.keys[1].id,{part:'hip',side:'L',motion:'flexion',degrees:30});
  expect(fwd.report.ok,fwd.report.reason).toBe(true);
  const kneeRel1=rig.point('lowerleg01_L').sub(rig.point('root'));
  expect(kneeRel1.z-kneeRel0.z).toBeGreaterThan(.15); // thigh ≈0.45 m · sin 30°
  expect(rig.point('root').distanceTo(pelvis0)).toBeLessThan(.002); // the pelvis does not move
 });
});

describe('bilateral knee balance edits on the real forehand finish',()=>{
 const doc=motionFileById('forehand')!.document!;
 const finish=doc.keys.find(key=>key.id==='forehand-k48')!;
 const finishTime=finish.time;
 it('lowers and rebalances the forehand finish while keeping both supports and arm targets valid',()=>{
  expect(finishTime).toBe(5.2);
  expect(finish.constraints.plantL).toBe(true);expect(finish.constraints.plantR).toBe(true);
  const start=captureKneeBalanceState(rig,doc,finish.id,origin());
  expect(start.frontBack?.back).toBe('R');expect(start.frontBack?.front).toBe('L');

  const rear=applyKneeBalanceEdit(rig,doc,finish.id,{dropMeters:.012,leanDegrees:-12},start,origin());
  expect(rear.report.ok,`${rear.report.reason}; report=${JSON.stringify(rear.report)}; baseline=${JSON.stringify(start)}`).toBe(true);
  expect(rear.report.rootY).toBeLessThan(start.rootY-.01);
  expect(rear.report.comY).toBeLessThan(start.comY-.006);
  expect(rear.report.lean).toBeLessThan(start.lean-10);
  expect(rear.report.footDriftMm).toBeLessThan(1);
  expect(rear.report.solePenetrationMm).toBeLessThanOrEqual(5);
  expect(rear.report.kneeFlexion.L).toBeGreaterThanOrEqual(LIMITS.kneeFlexion[0]);
  expect(rear.report.kneeFlexion.L).toBeLessThanOrEqual(LIMITS.kneeFlexion[1]);
  expect(rear.report.kneeFlexion.R).toBeGreaterThanOrEqual(LIMITS.kneeFlexion[0]);
  expect(rear.report.kneeFlexion.R).toBeLessThanOrEqual(LIMITS.kneeFlexion[1]);
  expect(rear.report.ankleFlexion.L).toBeGreaterThanOrEqual(LIMITS.ankleFlexion[0]);
  expect(rear.report.ankleFlexion.L).toBeLessThanOrEqual(LIMITS.ankleFlexion[1]);
  expect(rear.report.ankleFlexion.R).toBeGreaterThanOrEqual(LIMITS.ankleFlexion[0]);
  expect(rear.report.ankleFlexion.R).toBeLessThanOrEqual(LIMITS.ankleFlexion[1]);
  expect(rear.report.wristResidualMm.L).toBeLessThanOrEqual(start.wristResidualMm.L+5);
  expect(rear.report.wristResidualMm.R).toBeLessThanOrEqual(start.wristResidualMm.R+5);
  const rearKey=rear.doc.keys.find(key=>key.id===finish.id)!;
  expect(rearKey.constraints).toEqual(finish.constraints);
  expect(rearKey.pose.root.x).toBe(finish.pose.root.x);expect(rearKey.pose.root.z).toBe(finish.pose.root.z);
  const nonBalanceChannels=(key:typeof finish)=>{const pose=structuredClone(key.pose);pose.root.y=0;pose.lean=0;return pose;};
  expect(nonBalanceChannels(rearKey)).toEqual(nonBalanceChannels(finish));

  const mid=captureKneeBalanceState(rig,rear.doc,finish.id,origin());
  const front=applyKneeBalanceEdit(rig,rear.doc,finish.id,{dropMeters:.012,leanDegrees:12},mid,origin());
  expect(front.report.ok,`${front.report.reason}; report=${JSON.stringify(front.report)}; baseline=${JSON.stringify(mid)}`).toBe(true);
  expect(front.report.lean).toBeCloseTo(start.lean,0);
  expect(front.report.comY).toBeLessThan(start.comY-.012);
  expect(front.report.footDriftMm).toBeLessThan(1);
  expect(front.report.solePenetrationMm).toBeLessThanOrEqual(5);
  expect(front.report.wristResidualMm.L).toBeLessThanOrEqual(start.wristResidualMm.L+5);
  expect(front.report.wristResidualMm.R).toBeLessThanOrEqual(start.wristResidualMm.R+5);
  const frontKey=front.doc.keys.find(key=>key.id===finish.id)!;
  expect(frontKey.constraints).toEqual(finish.constraints);
  expect(nonBalanceChannels(frontKey)).toEqual(nonBalanceChannels(finish));
 });

 it('classifies front and back from yaw-aware body-forward and swaps them after mirroring',()=>{
  const source=structuredClone(doc);
  const base=solveScheduledAt(source,finishTime);
  const plain=kneeBalanceSides(rig,base.frame,finish.constraints);
  expect(plain?.front).toBe('L');expect(plain?.back).toBe('R');

  // Turn the body around while preserving the world foot anchors. A +Z-only
  // or hard-coded L/R classifier would still call L the front leg here.
  const reversed=frameAt(source,finishTime,origin());reversed.pose.yaw=180;
  solveEffectiveFrame(rig,reversed);
  const turned=kneeBalanceSides(rig,reversed,finish.constraints);
  expect(turned?.front).toBe('R');expect(turned?.back).toBe('L');

  const mirrored=mirrorDoc(source),mirroredState=captureKneeBalanceState(rig,mirrored,finish.id,origin());
  expect(mirroredState.frontBack?.front).toBe('R');
  expect(mirroredState.frontBack?.back).toBe('L');
 });

 it('falls back when support is not bilateral or the feet have no clear forward split',()=>{
  const single=blankDocument(rig.rest,'单支撑','single-support'),singleKey=single.keys[0];
  singleKey.constraints.plantL=false;
  singleKey.pose.footL.target.y+=.12;singleKey.pose.footL.pitch=30;
  const one=solveScheduledAt(single,singleKey.time);
  expect(singleKey.constraints.plantL).toBe(false);expect(singleKey.constraints.plantR).toBe(true);
  expect(one.frame.support.L).toBeLessThan(.98);expect(one.frame.support.R).toBeGreaterThanOrEqual(.98);
  expect(kneeBalanceSides(rig,one.frame,singleKey.constraints)).toBeUndefined();

  const ambiguous=structuredClone(doc),ambiguousFinish=ambiguous.keys.find(item=>item.id===finish.id)!;
  // Every key is bilateral-planted, so the sampler uses its contact-start
  // keys as anchors and ignores finish-only target edits. Make the authored
  // anchors themselves share local-forward depth to construct a truly tied
  // stance at the selected finish key.
  for(const key of ambiguous.keys){
   const depth=(key.pose.footL.target.z+key.pose.footR.target.z)/2;
   key.pose.footL.target.z=depth;key.pose.footR.target.z=depth;
  }
  const tied=solveScheduledAt(ambiguous,finishTime);
  expect(ambiguousFinish.constraints.plantL).toBe(true);expect(ambiguousFinish.constraints.plantR).toBe(true);
  expect(kneeBalanceSides(rig,tied.frame,ambiguousFinish.constraints)).toBeUndefined();
 });

 it('rejects an out-of-range follow-up without losing the last valid preview',()=>{
  const start=captureKneeBalanceState(rig,doc,finish.id,origin());
  const valid=applyKneeBalanceEdit(rig,doc,finish.id,{dropMeters:.012,leanDegrees:-12},start,origin());
  expect(valid.report.ok,`${valid.report.reason}; report=${JSON.stringify(valid.report)}; baseline=${JSON.stringify(start)}`).toBe(true);
  const lastValidState=captureKneeBalanceState(rig,valid.doc,finish.id,origin());
  const rejected=applyKneeBalanceEdit(rig,valid.doc,finish.id,{dropMeters:1,leanDegrees:-180},lastValidState,origin());
  expect(rejected.report.ok).toBe(false);
  expect(serializeDoc(rejected.doc)).toBe(serializeDoc(valid.doc));
  expect(rejected.report.reason).toBeTruthy();
 });

 it('keeps balance changes continuous through neighboring sampled frames',()=>{
  const start=captureKneeBalanceState(rig,doc,finish.id,origin());
  const rear=applyKneeBalanceEdit(rig,doc,finish.id,{dropMeters:.012,leanDegrees:-12},start,origin());
  expect(rear.report.ok,`${rear.report.reason}; report=${JSON.stringify(rear.report)}; baseline=${JSON.stringify(start)}`).toBe(true);
  const middle=captureKneeBalanceState(rig,rear.doc,finish.id,origin());
  const changed=applyKneeBalanceEdit(rig,rear.doc,finish.id,{dropMeters:.012,leanDegrees:12},middle,origin());
  expect(changed.report.ok,`${changed.report.reason}; report=${JSON.stringify(changed.report)}; baseline=${JSON.stringify(middle)}`).toBe(true);
  const times=[5.1,5.125,5.15,5.175,5.2];
  const samples=times.map(time=>{
   const solved=solveScheduledAt(changed.doc,time);
   return {rootY:rig.point('root').y,lean:solved.frame.pose.lean,support:solved.frame.support,constraints:solved.frame.constraints,
    leftFoot:rig.point('foot_L').clone(),rightFoot:rig.point('foot_R').clone()};
  });
  for(let i=1;i<samples.length;i++){
   expect(samples[i].constraints.plantL).toBe(true);expect(samples[i].constraints.plantR).toBe(true);
   expect(samples[i].support.L).toBeGreaterThan(.95);expect(samples[i].support.R).toBeGreaterThan(.95);
   expect(Math.abs(samples[i].rootY-samples[i-1].rootY)).toBeLessThan(.02);
   expect(Math.abs(samples[i].lean-samples[i-1].lean)).toBeLessThan(8);
   expect(samples[i].leftFoot.distanceTo(samples[i-1].leftFoot)).toBeLessThan(.03);
   expect(samples[i].rightFoot.distanceTo(samples[i-1].rightFoot)).toBeLessThan(.03);
  }
 });
});
