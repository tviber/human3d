import {Euler,Quaternion,Vector3,MathUtils} from 'three';
import {HumanRig} from './rig';
import {blendGrip} from './grip';
import {applyHandShape} from './hand-shape';
import {PROPS} from './props';
import {DEG,LIMITS,angleAt,pelvisDorsiCorrection,solveTwoBone,type DorsiLeg} from './kinematics';
import type {EffectiveFrame,PoseParams,KeyConstraints,SupportWeights} from './document';
import {toV} from './document';
import {FOOT_CLEARANCE_M,footDepth,footGeometry,footLift,footRotation,type FootGeometry,type Side} from './foot';
import {handFrame} from './hand-frame';

/** Kinematic stage of the pipeline: task-space pose → skeleton, with joint
 * limits and foot contacts enforced geometrically. This replaces forward
 * dynamics for authoring — muscle control stays a later stage. */
export const DORSI_LIMIT_DEG=20;

export interface SolveState{support?:SupportWeights;gripAmount?:number;clavicleLift?:boolean;freeArms?:boolean;
 /** Which hand grips (finger wrap + racket mount + clavicle assist). Absent
  * means 'R' — the pre-WP-D behaviour every existing caller relied on. */
 gripSide?:Side;
 /** Posterior shift (m) applied instead of this frame's argmin. Absent, or
  * within 1e-9 m of the argmin, leaves the historical solve untouched. */
 pelvisShift?:number}
export interface SolveReport{pelvisShift:number;pelvisSaturated:boolean}

/** The per-frame dorsiflexion argmin. Stops before leg IK and the arms: the
 * shift is fixed once the spine and the support-weighted ankle targets exist,
 * and that is the number `solvePose` applies when no override is passed.
 * Keeping the preamble here (instead of calling `solvePose`) is what makes a
 * 120 Hz schedule cheap enough to build on every capture. */
export function measurePelvisCorrection(rig:HumanRig,p:PoseParams,c:KeyConstraints,state:SolveState={}){
 const {pelvisShift:_drop,...rest}=state;
 void _drop;
 return rig.batch(()=>{
  rig.reset();
  const root=rig.bone('root'),origin=rig.rest.get('root')!;
  root.position.copy(origin).add(new Vector3(
    MathUtils.clamp(p.root.x,-.6,.6),
    MathUtils.clamp(p.root.y,-.55,.35),
    MathUtils.clamp(p.root.z,-.6,.6)));
  rig.rotate('root',0,p.yaw,0);
  for(const n of ['spine05','spine04','spine03','spine02','spine01'])rig.rotate(n,p.lean/5,p.chest/5,p.side/5);
  rig.rotate('neck01',-p.lean*.22,-p.chest*.15,-p.side*.2);rig.rotate('neck02',-p.lean*.22,0,0);rig.rotate('head',-p.lean*.12,0,0);
  const support=rest.support??{L:c.plantL?1:0,R:c.plantR?1:0};
  const legs=(['L','R'] as const).map(side=>{
    const f=side==='L'?p.footL:p.footR;
    return {side,target:toV(f.target),pole:toV(f.pole),footQ:footRotation(f.yaw,f.pitch),
      a:rig.rest.get(`upperleg01_${side}`)!.distanceTo(rig.rest.get(`lowerleg01_${side}`)!),
      b:rig.rest.get(`lowerleg01_${side}`)!.distanceTo(rig.rest.get(`foot_${side}`)!)};
  });
  const dorsiLegs:DorsiLeg[]=legs.map(l=>({hip:rig.point(`upperleg01_${l.side}`),target:l.target,pole:l.pole,
    upper:l.a,lower:l.b,footQ:l.footQ,weight:support[l.side]}));
  const correction=pelvisDorsiCorrection(dorsiLegs,DORSI_LIMIT_DEG,.15);
  return {shift:correction.shift,saturated:correction.saturated,worstDorsiflexion:0};
 });
}

/** Solve one frame. `state` carries the interpolated support weights and grip
 * amount from the document sampler; without it the discrete constraint flags
 * are used (weight 1 when planted, grip 1 when gripping). */
export function solvePose(rig:HumanRig,p:PoseParams,c:KeyConstraints,state:SolveState={}):SolveReport{
 /* One batch: every intermediate world-matrix flush inside the solve is
  * deferred — reads self-update their ancestor chains — and a single
  * model.updateMatrixWorld(true) at batch exit restores the postcondition
  * (a fully-flushed rig) that callers/tests reading .matrixWorld rely on. */
 return rig.batch(()=>{
  rig.reset();
  const root=rig.bone('root'),origin=rig.rest.get('root')!;
  root.position.copy(origin).add(new Vector3(
    MathUtils.clamp(p.root.x,-.6,.6),
    MathUtils.clamp(p.root.y,-.55,.35),
    MathUtils.clamp(p.root.z,-.6,.6)));
  rig.rotate('root',0,p.yaw,0);
  for(const n of ['spine05','spine04','spine03','spine02','spine01'])rig.rotate(n,p.lean/5,p.chest/5,p.side/5);
  rig.rotate('neck01',-p.lean*.22,-p.chest*.15,-p.side*.2);rig.rotate('neck02',-p.lean*.22,0,0);rig.rotate('head',-p.lean*.12,0,0);

  const support=state.support??{L:c.plantL?1:0,R:c.plantR?1:0};
  const gripAmount=state.gripAmount??(c.grip?1:0);
  const gripSide=state.gripSide??'R';
  const legs=(['L','R'] as const).map(side=>{
    const f=side==='L'?p.footL:p.footR;
    return {side,target:toV(f.target),pole:toV(f.pole),footQ:footRotation(f.yaw,f.pitch),
      a:rig.rest.get(`upperleg01_${side}`)!.distanceTo(rig.rest.get(`lowerleg01_${side}`)!),
      b:rig.rest.get(`lowerleg01_${side}`)!.distanceTo(rig.rest.get(`foot_${side}`)!)};
  });
  // Posterior pelvis correction against ankle dorsiflexion. Each leg is
  // weighted by its support, so a foot leaving the ground releases the
  // correction continuously instead of flipping the whole pelvis by 15 cm.
  const dorsiLegs:DorsiLeg[]=legs.map(l=>({hip:rig.point(`upperleg01_${l.side}`),target:l.target,pole:l.pole,
    upper:l.a,lower:l.b,footQ:l.footQ,weight:support[l.side]}));
  const correction=pelvisDorsiCorrection(dorsiLegs,DORSI_LIMIT_DEG,.15);
  const override=state.pelvisShift;
  const useOverride=override!==undefined&&Math.abs(override-correction.shift)>1e-9;
  const applied=useOverride?Math.max(0,override!):correction.shift;
  // The else branch is the historical statement, kept as its own statement so
  // an absent override subtracts `correction.shift` exactly as before.
  if(useOverride){if(applied>0){root.position.z-=applied;rig.syncWorld();}}
  else if(correction.shift>0){root.position.z-=correction.shift;rig.syncWorld();}
  for(const l of legs){rig.limb(l.side,'leg',l.target,l.pole);rig.worldRotation(`foot_${l.side}`,l.footQ);}

  // Clavicle assist (doc flag): the GRIPPING shoulder girdle rides up with a
  // high hand target — the authored reach behaviour, mirrored across sides.
  // `target.y − p.root.y` recovers the control-space height the authored
  // formula used (world y minus root y). The local z-rotation flips sign under
  // the x-mirror, hence the ±8/±5 pattern.
  if(state.clavicleLift){
    const lift=Math.max(0,(toV(gripSide==='R'?p.handR.target:p.handL.target).y-p.root.y-1.1)/.62);
    const s=gripSide==='R'?-1:1;
    rig.rotate(`clavicle_${gripSide}`,0,0,s*lift*8);rig.rotate(`shoulder01_${gripSide}`,0,0,s*lift*5);
    rig.syncWorld();
  }
  rig.limb('R','arm',toV(p.handR.target),toV(p.handR.pole),state.freeArms?180:145);
  rig.limb('L','arm',toV(p.handL.target),toV(p.handL.pole),state.freeArms?180:145);
  rig.hand('R',toV(p.handR.forward).normalize(),toV(p.handR.normal).normalize(),state.freeArms?180:undefined);
  rig.hand('L',toV(p.handL.forward).normalize(),toV(p.handL.normal).normalize(),state.freeArms?180:undefined);
  /* Hand shape: the authored fist ⇄ open ramp. `blendGrip` solves the wrap
   * from the rest pose, writes the authored shape as its base, then blends
   * shape → wrap, so at amount 0 the gripping hand shows exactly the authored
   * shape and at 1 the full wrap. An absent channel is the relaxed shape, and
   * applyHandShape at relaxed is BIT-IDENTICAL to the relaxHand call it
   * replaces (same axes, same 12/16/8° angles — pinned by hand-shape.test.ts),
   * so every pre-existing document keeps its exact trajectory. */
  const other=gripSide==='R'?'L':'R';
  const spread=(side:Side)=>applyHandShape(rig,side,p.handSpread?.[side]);
  blendGrip(rig,gripSide,gripAmount,PROPS.racket.handle,()=>spread(gripSide));
  spread(other);
  rig.syncWorld();
  return {pelvisShift:applied,pelvisSaturated:correction.saturated||applied+1e-9<correction.shift};
 });
}

/** The single solve entry for a sampled document frame: support fades, the
 * grip ramp and the clavicle assist all come from the frame, never re-derived. */
export function solveEffectiveFrame(rig:HumanRig,f:EffectiveFrame,pelvisShift?:number){
  return solvePose(rig,f.pose,f.constraints,{support:f.support,gripAmount:f.gripAmount,clavicleLift:f.clavicleLift,freeArms:f.freeArms,gripSide:f.gripSide,pelvisShift});
}

/** Ankle dorsiflexion (degrees) of the solved rig, from the shank direction
 * in the foot's own frame. Measured on the rig, not on the target geometry. */
function ankleDorsiflexion(rig:HumanRig,side:Side){
  const a=new Vector3(),b=new Vector3();
  const shank=rig.worldPointInto(`foot_${side}`,a).sub(rig.worldPointInto(`lowerleg01_${side}`,b));
  const q=rig.bone(`foot_${side}`).getWorldQuaternion(new Quaternion()).invert();
  const local=shank.applyQuaternion(q);
  return Math.atan2(-local.z,-local.y)/DEG;
}

/** Rotate a hand's stored forward/normal pair by a delta around a named axis,
 * keeping the pair orthonormal. */
export function rotateHandFrame(h:{forward:{x:number;y:number;z:number};normal:{x:number;y:number;z:number}},kind:'flex'|'dev'|'twist',degrees:number){
  const f=toV(h.forward).normalize(),n=toV(h.normal).normalize();
  const axis=kind==='flex'?new Vector3().crossVectors(f,n):kind==='dev'?n.clone():f.clone();
  const q=new Quaternion().setFromAxisAngle(axis.normalize(),degrees*DEG);
  const nf=f.clone().applyQuaternion(q),nn=n.clone().applyQuaternion(q);
  nn.addScaledVector(nf,-nn.dot(nf)).normalize();
  h.forward={x:nf.x,y:nf.y,z:nf.z};h.normal={x:nn.x,y:nn.y,z:nn.z};
}

/** FK-style authoring, encoded back into the existing task-space targets.
 * The rig must be solved at the edited key. Rotating the upper arm carries
 * the elbow, forearm and hand; rotating the forearm keeps the elbow fixed.
 * Unlike a pole edit, this moves the wrist target as well, so the shoulder
 * can reach the whole sphere. The solver still owns all final bone writes. */
export function rotateArmJoint(rig:HumanRig,p:PoseParams,side:Side,joint:'upper'|'forearm',kind:'lift'|'swing'|'twist',degrees:number){
  const shoulder=rig.point(`upperarm01_${side}`),elbow=rig.point(`lowerarm01_${side}`),wrist=rig.point(`wrist_${side}`);
  const direction=joint==='upper'?elbow.clone().sub(shoulder):wrist.clone().sub(elbow);
  const body=rig.bone(`upperarm01_${side}`).parent!.getWorldQuaternion(new Quaternion());
  const axis=kind==='twist'?direction.normalize():new Vector3(kind==='lift'?1:0,kind==='swing'?1:0,0).applyQuaternion(body);
  rotateArmAbout(rig,p,side,joint,axis,degrees);
}
/** rotateArmJoint with an explicit world axis (through the shoulder for
 * 'upper', through the elbow for 'forearm'). Same encoding and preconditions:
 * the rig must be solved at the edited key. */
export function rotateArmAbout(rig:HumanRig,p:PoseParams,side:Side,joint:'upper'|'forearm',axis:Vector3,degrees:number){
  const shoulder=rig.point(`upperarm01_${side}`),elbow=rig.point(`lowerarm01_${side}`),wrist=rig.point(`wrist_${side}`);
  const pivot=joint==='upper'?shoulder:elbow;
  const turn=new Quaternion().setFromAxisAngle(axis.clone().normalize(),degrees*DEG);
  const end=wrist.sub(pivot).applyQuaternion(turn).add(pivot);
  const mid=joint==='upper'?elbow.sub(pivot).applyQuaternion(turn).add(pivot):elbow;
  const hand=side==='L'?p.handL:p.handR;
  const store=(v:Vector3)=>({x:v.x,y:v.y,z:v.z});
  hand.target=store(end);
  if(joint==='upper'){
    // The elbow itself lies ON the upper-arm twist axis. Storing it as the
    // pole loses the roll reference when the chain is collinear, leaving
    // only the hand-frame rotation visible. Carry the solved upper-arm
    // plane through the turn and encode it in an off-axis pole instead.
    const restUpper=rig.rest.get(`lowerarm01_${side}`)!.clone().sub(rig.rest.get(`upperarm01_${side}`)!);
    const restLower=rig.rest.get(`wrist_${side}`)!.clone().sub(rig.rest.get(`lowerarm01_${side}`)!);
    const upperWorld=rig.bone(`upperarm01_${side}`).getWorldQuaternion(new Quaternion());
    const plane=new Vector3().crossVectors(restUpper,restLower).normalize().applyQuaternion(upperWorld).applyQuaternion(turn);
    const bend=new Vector3().crossVectors(end.clone().sub(shoulder).normalize(),plane).normalize();
    hand.pole=store(mid.clone().addScaledVector(bend,restUpper.length()));
  }else hand.pole=store(mid);
  const rest=handFrame(rig.rest,side),world=rig.bone(`wrist_${side}`).getWorldQuaternion(new Quaternion());
  hand.forward=store(rest.forward.applyQuaternion(world).applyQuaternion(turn));
  hand.normal=store(rest.normal.applyQuaternion(world).applyQuaternion(turn));
}

/** Rigid FK of one leg about a world pivot (hip for thigh turns, knee for
 * shank turns): ankle target, knee pole and foot orientation rotate together,
 * so every joint angle below the pivot is unchanged. Same encoding pattern as
 * rotateArmAbout: the rig must be solved at the edited pose — the ankle
 * position and foot frame are read live — and the solver still owns all final
 * bone writes. The yaw·pitch foot storage drops the turn's roll component,
 * the same trade-off every foot-orientation write makes. */
export function rotateLegAbout(rig:HumanRig,p:PoseParams,side:Side,pivot:Vector3,turn:Quaternion){
  const f=side==='L'?p.footL:p.footR,ankle=rig.point(`foot_${side}`),footQ=rig.bone(`foot_${side}`).getWorldQuaternion(new Quaternion());
  const about=(v:Vector3)=>v.clone().sub(pivot).applyQuaternion(turn).add(pivot);
  const a=about(ankle),pole=about(toV(f.pole));
  f.target={x:a.x,y:a.y,z:a.z};f.pole={x:pole.x,y:pole.y,z:pole.z};
  const e=new Euler().setFromQuaternion(turn.clone().multiply(footQ),'YXZ');f.pitch=e.x/DEG;f.yaw=e.y/DEG;
}

/** Bound a rigid leg turn so the rotated foot's sole stays within the
 * analyzer's own contact band: a pointer-driven knee drag can request a turn
 * whose rotated ankle target and foot orientation would bury the sole.
 * Truncating the ankle height afterwards would break the rigid rotation's
 * joint-angle invariant, so the turn itself is bisected toward identity until
 * footLift stays at the limit — the knee still follows as far as clearance
 * allows. The limit is min(baseline, −FOOT_CLEARANCE_M): a sole at ground
 * (baseline 0) may tilt into the same 2 cm band `foot-depth-*` tolerates, so
 * dragging stays alive instead of deadlocking on an exact-0 floor; a sole
 * buried deeper than the band is only allowed back up, never deeper. Returns
 * the full turn whenever it stays at the limit. `p` is only probed. */
export function boundLegTurnForClearance(rig:HumanRig,p:PoseParams,side:Side,pivot:Vector3,turn:Quaternion,geo:FootGeometry,iterations=12):Quaternion{
  const foot=side==='L'?'footL':'footR';
  const liftAt=(q:Quaternion)=>{
    const probe:PoseParams={...p,[foot]:{...p[foot]}};
    rotateLegAbout(rig,probe,side,pivot,q);
    const f=probe[foot];
    return footLift(geo,f.target.y,f.yaw,f.pitch);
  };
  const id=new Quaternion(),limit=Math.min(liftAt(id),-FOOT_CLEARANCE_M);
  if(liftAt(turn)>=limit)return turn;
  let lo=0,hi=1;
  for(let i=0;i<iterations;i++){
    const m=(lo+hi)/2;
    if(liftAt(id.clone().slerp(turn,m))>=limit)lo=m;else hi=m;
  }
  return id.clone().slerp(turn,lo);
}

/** One check. `ok` is decided from `value` against `limit` in `unit`; the
 * label and detail stay human-readable, the rest is machine-readable. */
export interface CheckItem{code:string;ok:boolean;label:string;detail:string;value:number|null;limit:number|null;unit:string}
export interface Analysis{items:CheckItem[];com:Vector3;comStable:boolean;support:Vector3[];racketTip:Vector3}

/** Whole-body CoM estimate from segment midpoints with de Leva-style mass
 * fractions. Engineering approximation for balance checks, not anthropometrics. */
const SEGMENTS:[string,string,number][]=[
  ['spine01','neck01',.4346],['neck01','head',.0694],
  ['upperarm01_L','lowerarm01_L',.0271],['upperarm01_R','lowerarm01_R',.0271],
  ['lowerarm01_L','wrist_L',.0223],['lowerarm01_R','wrist_R',.0223],
  ['upperleg01_L','lowerleg01_L',.1416],['upperleg01_R','lowerleg01_R',.1416],
  ['lowerleg01_L','foot_L',.0433],['lowerleg01_R','foot_R',.0433],
];
/** Sole offset for the CoM foot pseudo-segment — shared read-only const. */
const COM_SOLE_OFFSET=new Vector3(0,-.03,.05);
function estimateCoM(rig:HumanRig){
  const com=new Vector3(),a=new Vector3(),b=new Vector3();let mass=0;
  for(const [s1,s2,m]of SEGMENTS){const mid=rig.worldPointInto(s1,a).add(rig.worldPointInto(s2,b)).multiplyScalar(.5);com.addScaledVector(mid,m);mass+=m;}
  for(const side of ['L','R']as const){const foot=rig.worldPointInto(`foot_${side}`,a).add(COM_SOLE_OFFSET);com.addScaledVector(foot,.0137);mass+=.0137;}
  return com.multiplyScalar(1/mass);
}
/** Convex hull of planted-foot rectangles in the ground plane. */
export function supportPolygon(p:PoseParams,c:KeyConstraints){
  const pts:Vector3[]=[];
  for(const side of ['L','R']as const){
    const f=side==='L'?p.footL:p.footR;if(!(side==='L'?c.plantL:c.plantR))continue;
    const yaw=(f.yaw)*DEG,dir=new Vector3(Math.sin(yaw),0,Math.cos(yaw)),wide=new Vector3(dir.z,0,-dir.x);
    for(const [u,v]of [[.2,0],[-.07,0],[0,.05],[0,-.05]]as const){
      const base=toV(f.target).addScaledVector(dir,u).addScaledVector(wide,v);
      pts.push(new Vector3(base.x,0,base.z));
    }
  }
  if(pts.length<3)return pts.map(p2=>p2.clone());
  pts.sort((a,b)=>a.x-b.x||a.z-b.z);
  const cross=(o:Vector3,a:Vector3,b:Vector3)=>(a.x-o.x)*(b.z-o.z)-(a.z-o.z)*(b.x-o.x);
  const lower:Vector3[]=[];for(const p2 of pts){while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],p2)<=0)lower.pop();lower.push(p2);}
  const upper:Vector3[]=[];for(let i=pts.length-1;i>=0;i--){const p2=pts[i];while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],p2)<=0)upper.pop();upper.push(p2);}
  lower.pop();upper.pop();return lower.concat(upper);
}
/** Distance from a ground-plane point to a convex polygon (0 inside). */
function distanceToPolygon(p:Vector3,poly:Vector3[]){
  if(poly.length<3)return Infinity;
  let min=Infinity,inside=true;
  for(let i=0;i<poly.length;i++){
    const a=poly[i],b=poly[(i+1)%poly.length];
    const e=new Vector3().subVectors(b,a),d=new Vector3().subVectors(p,a);
    const u=MathUtils.clamp(d.dot(e)/e.lengthSq(),0,1);
    min=Math.min(min,a.clone().addScaledVector(e,u).distanceTo(p));
    if((b.x-a.x)*(p.z-a.z)-(b.z-a.z)*(p.x-a.x)<0)inside=false;
  }
  return inside?0:min;
}

/** Tolerance on limit comparisons: solver residue, not a physical allowance. */
const NUMERIC_EPS=1e-3;
/** Per-side limit checks measured on the solved rig: joint flexion limits,
 * ankle dorsiflexion and sole depth. Independent of which feet are planted,
 * so the package builder can run them on every sampled frame, whatever the
 * document's constraint mix. */
function limitItems(rig:HumanRig):CheckItem[]{
  const items:CheckItem[]=[];
  /* worldPointInto pool: reads the post-syncWorld matrixWorld straight,
   * ~30× cheaper per read than point()'s ancestor re-walk. Results are
   * VOLATILE — consume inside the expression; ≤3 concurrent (audit:
   * angleAt uses all 3, every other site ≤2). */
  const _pv=[new Vector3(),new Vector3(),new Vector3()];let _pi=0;
  const P=(n:string)=>{const v=_pv[_pi];_pi=(_pi+1)%_pv.length;return rig.worldPointInto(n,v);};
  const deg=(code:string,label:string,value:number,limit:number,ok=value<=limit+NUMERIC_EPS):CheckItem=>
    ({code,ok,label,detail:`${value.toFixed(0)}° / ≤${limit}°`,value,limit,unit:'deg'});
  for(const side of ['L','R']as const){
    const label=side==='L'?'左':'右';
    const knee=angleAt(P(`upperleg01_${side}`),P(`lowerleg01_${side}`),P(`foot_${side}`));
    items.push({...deg(`knee-flexion-${side}`,`${label}膝屈曲`,knee,LIMITS.kneeFlexion[1])});
    const elbow=angleAt(P(`upperarm01_${side}`),P(`lowerarm01_${side}`),P(`wrist_${side}`));
    items.push({...deg(`elbow-flexion-${side}`,`${label}肘屈曲`,elbow,LIMITS.elbowFlexion[1])});
    const shoulder=P(`lowerarm01_${side}`).sub(P(`upperarm01_${side}`)).angleTo(new Vector3(0,-1,0))/DEG;
    items.push({...deg(`shoulder-elevation-${side}`,`${label}肩上抬`,shoulder,LIMITS.shoulderElevation[1])});
    const dorsi=ankleDorsiflexion(rig,side);
    items.push({...deg(`ankle-dorsiflexion-${side}`,`${label}踝背屈`,dorsi,DORSI_LIMIT_DEG)});
    const geo=footGeometry(rig.rest,side);
    const lowest=Math.min(...geo.names.map(n=>P(n).y));
    const depth=footDepth(geo,lowest);
    items.push({code:`foot-depth-${side}`,ok:depth<=FOOT_CLEARANCE_M+NUMERIC_EPS,label:`${label}脚入地`,
      detail:depth<=FOOT_CLEARANCE_M?`脚底最低点高于地面平面 · 入地 ${(depth*1000).toFixed(1)}mm`:`脚底入地 ${(depth*100).toFixed(1)}cm`,
      value:depth,limit:FOOT_CLEARANCE_M,unit:'m'});
  }
  return items;
}
export function analyzePose(rig:HumanRig,p:PoseParams,c:KeyConstraints,racket?:{localToWorld(v:Vector3):Vector3}):Analysis{
  const items:CheckItem[]=[];
  /* Real flush: analyzePose always runs post-batch (solveEffectiveFrame's
   * batch-end flush already left the tree current, so this is normally a
   * no-op repeat) — it also repairs a tree written outside any batch, which
   * is what the readers below (worldPointInto — no ancestor re-walk) need. */
  rig.syncWorld();
  /* Same volatile-pool contract as limitItems' P — ≤3 concurrent results. */
  const _pv=[new Vector3(),new Vector3(),new Vector3()];let _pi=0;
  const P=(n:string)=>{const v=_pv[_pi];_pi=(_pi+1)%_pv.length;return rig.worldPointInto(n,v);};
  const limits=limitItems(rig);
  for(const side of ['L','R']as const){
    items.push(...limits.filter(it=>it.code.endsWith(`-${side}`)));
    const planted=side==='L'?c.plantL:c.plantR;
    if(planted){
      const target=toV((side==='L'?p.footL:p.footR).target);
      const slip=P(`foot_${side}`).distanceTo(target);
      const label=side==='L'?'左':'右';
      items.push({code:`support-slip-${side}`,ok:slip<.01,label:`${label}脚支撑`,
        detail:slip<.01?`锁定 · 残差 ${(slip*1000).toFixed(1)}mm`:`滑移 ${(slip*100).toFixed(1)}cm`,value:slip,limit:.01,unit:'m'});
    }
  }
  const com=estimateCoM(rig),support=supportPolygon(p,c);
  const planted=c.plantL||c.plantR;
  const dist=planted?distanceToPolygon(new Vector3(com.x,0,com.z),support):null;
  const comStable=planted?(dist as number)<=.02:false;
  items.push({code:'com-support',ok:comStable,label:'重心投影',
    detail:!planted?'没有支撑脚':comStable?'在支撑多边形内':`距支撑多边形 ${((dist as number)*100).toFixed(1)}cm`,
    value:dist,limit:.02,unit:'m'});
  const racketTip=racket?racket.localToWorld(PROPS.racket.tipLocal.clone()):new Vector3();
  return {items,com,comStable,support,racketTip};
}
