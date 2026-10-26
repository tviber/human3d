import {Euler,Quaternion,Vector3} from 'three';
import {angleAt,handFrame,rotateArmAbout} from '@human3d/motion-core';
import type {HumanRig,Side,WorkshopKey} from '@human3d/motion-core';

export type ArmRotationChannel='lift'|'swing'|'twist';
export type WristRotationChannel='flex'|'dev'|'twist';
export type ArmRotationValues=Record<ArmRotationChannel,number>;
export type WristRotationValues=Record<WristRotationChannel,number>;

const RAD_TO_DEG=180/Math.PI;
const DEG_TO_RAD=Math.PI/180;
const ORDER='YXZ';
const AXIS={lift:'x',swing:'y',twist:'z',flex:'x',dev:'y'} as const;
const ZERO_ARM:ArmRotationValues={lift:0,swing:0,twist:0};
const ZERO_WRIST:WristRotationValues={flex:0,dev:0,twist:0};
/** Readouts live in (−180°, 180°]: a raw YXZ decode can land on an equivalent
 * angle outside it (e.g. 360° next to the lift singularity), and a straight or
 * fully folded elbow reads exactly 180° — that is a real reading, not −180°. */
const round1=(degrees:number)=>{
 const wrapped=(((degrees+180)%360)+360)%360-180;
 const value=Math.abs(wrapped+180)<.05?180:wrapped;
 return Number(value.toFixed(1));
};
const wrapRadians=(radians:number)=>Math.atan2(Math.sin(radians),Math.cos(radians));

function relativeQuaternion(rig:HumanRig,parent:string,bone:string){
 const parentWorld=rig.bone(parent).getWorldQuaternion(new Quaternion()).invert();
 return parentWorld.multiply(rig.bone(bone).getWorldQuaternion(new Quaternion()));
}
/** True when the YXZ triple reproduces `q` (quaternions double-cover, so the
 * comparison is up to sign). Used to validate the alternate branch instead of
 * assuming a sign convention. */
function encodes(candidate:readonly number[],q:Quaternion){
 const r=new Quaternion().setFromEuler(new Euler(candidate[0],candidate[1],candidate[2],ORDER));
 return Math.abs(r.dot(q))>1-1e-9;
}
/** YXZ angles of `q`, choosing between the equivalent triples the one closest
 * to `reference` (radians).
 *
 * One rotation always has two YXZ triples — (x, y, z) and (π−x, y±π, z±π) —
 * that differ by a 180° turn on the two outer channels. A canonical decode
 * always returns the same branch, so dragging the middle axis (lift) through
 * ±90° makes all three sliders flip at once even though the bone orientation
 * is continuous. At exactly ±90° the family is larger still: only y±z is
 * defined, so any split with the same sum is the same rotation. Steering by
 * the previous reading keeps a drag on its own row. Every candidate is
 * validated with `encodes`, so a wrong sign convention can never leak into
 * the readout. */
function eulerNear(q:Quaternion,reference?:readonly number[]){
 const e=new Euler().setFromQuaternion(q,ORDER);
 if(!reference)return e;
 const candidates:number[][]=[[e.x,e.y,e.z],[Math.PI-e.x,e.y+Math.PI,e.z+Math.PI]];
 if(Math.abs(Math.abs(e.x)-Math.PI/2)<1e-6){
  // Gimbal lock: y+d, z+sign·d is the same rotation for any d.
  const sign=e.x>=0?1:-1;
  const d=((reference[1]-e.y)+sign*(reference[2]-e.z))/2;
  candidates.push([e.x,e.y+d,e.z+sign*d]);
 }
 const distance=(candidate:readonly number[])=>Math.abs(wrapRadians(candidate[0]-reference[0]))+Math.abs(wrapRadians(candidate[1]-reference[1]))+Math.abs(wrapRadians(candidate[2]-reference[2]));
 let best:number[]|undefined,bestDistance=Infinity;
 for(const candidate of candidates){
  if(!encodes(candidate,q))continue;
  const d=distance(candidate);
  if(d<bestDistance){best=candidate;bestDistance=d;}
 }
 return best?new Euler(best[0],best[1],best[2],ORDER):e;
}
const radiansOf=(values:ArmRotationValues)=>[values.lift*DEG_TO_RAD,values.swing*DEG_TO_RAD,values.twist*DEG_TO_RAD] as const;
const wristRadiansOf=(values:WristRotationValues)=>[values.flex*DEG_TO_RAD,values.dev*DEG_TO_RAD,values.twist*DEG_TO_RAD] as const;
function valuesOf(euler:Euler):ArmRotationValues{
 return {lift:round1(euler.x*RAD_TO_DEG),swing:round1(euler.y*RAD_TO_DEG),twist:round1(euler.z*RAD_TO_DEG)};
}
function wristValuesOf(euler:Euler):WristRotationValues{
 return {flex:round1(euler.x*RAD_TO_DEG),dev:round1(euler.y*RAD_TO_DEG),twist:round1(euler.z*RAD_TO_DEG)};
}
function setChannel(euler:Euler,channel:keyof typeof AXIS,degrees:number){
 euler[AXIS[channel]]=degrees*DEG_TO_RAD;
}
/** Rotation from the parent's solved world orientation onto the child's, as a
 * shortest-arc axis/angle — the delta the solver has to deliver. */
function deltaQuaternion(targetWorld:Quaternion,boneWorld:Quaternion){
 const delta=targetWorld.clone().multiply(boneWorld.clone().invert()).normalize();
 return delta.w<0?delta.set(-delta.x,-delta.y,-delta.z,-delta.w):delta;
}
function rotateBy(rig:HumanRig,pose:WorkshopKey['pose'],side:Side,joint:'upper'|'forearm',delta:Quaternion){
 const halfAngle=Math.acos(Math.max(-1,Math.min(1,delta.w)));
 const sinHalf=Math.sin(halfAngle);
 if(halfAngle<1e-8||Math.abs(sinHalf)<1e-8)return;
 const axis=new Vector3(delta.x/sinHalf,delta.y/sinHalf,delta.z/sinHalf);
 rotateArmAbout(rig,pose,side,joint,axis,2*halfAngle*RAD_TO_DEG);
}

/** Read the solved upper arm relative to the shoulder. `reference` is the
 * previously displayed triple; it only selects between equivalent YXZ
 * branches, so a drag across the ±90° lift singularity stays continuous. */
export function readUpperArmRotation(rig:HumanRig|null,side:Side,reference?:ArmRotationValues):ArmRotationValues{
 if(!rig)return {...ZERO_ARM};
 const relative=relativeQuaternion(rig,`shoulder01_${side}`,`upperarm01_${side}`);
 return valuesOf(eulerNear(relative,reference&&radiansOf(reference)));
}

/** Set one absolute shoulder-relative upper-arm angle while preserving the
 * other two. All three channels are reachable: the shoulder is a ball joint
 * and `rotateArmAbout` encodes the world-space rotation into the authored hand
 * target/pole, which the production solver turns back into bone rotations. */
export function setUpperArmRotation(rig:HumanRig,pose:WorkshopKey['pose'],side:Side,channel:ArmRotationChannel,degrees:number,reference?:ArmRotationValues){
 const parentWorld=rig.bone(`shoulder01_${side}`).getWorldQuaternion(new Quaternion());
 const boneWorld=rig.bone(`upperarm01_${side}`).getWorldQuaternion(new Quaternion());
 const euler=eulerNear(parentWorld.clone().invert().multiply(boneWorld.clone()),reference&&radiansOf(reference));
 // Re-writing the angle the slider is already showing must not touch the
 // document: a no-op write would still dirty the key and cost an undo step.
 if(Math.abs(wrapRadians((degrees-euler[AXIS[channel]]*RAD_TO_DEG)*DEG_TO_RAD))<.05*DEG_TO_RAD)return;
 setChannel(euler,channel,degrees);
 rotateBy(rig,pose,side,'upper',deltaQuaternion(parentWorld.clone().multiply(new Quaternion().setFromEuler(euler)),boneWorld));
}

/** Elbow flexion of the solved rig: 0° straight, larger values flexed. Same
 * reading `measureSemantic(rig,'elbow','flexion')` uses. */
export function readElbowAngle(rig:HumanRig|null,side:Side):number{
 if(!rig)return 0;
 return round1(readElbowUnrounded(rig,side));
}
function readElbowUnrounded(rig:HumanRig,side:Side){
 return angleAt(rig.point(`upperarm01_${side}`),rig.point(`lowerarm01_${side}`),rig.point(`wrist_${side}`));
}
/** The solved elbow hinge: the rest bend normal carried by the upper arm. The
 * two-bone solver maps rotation about it 1:1 onto the flexion angle, which is
 * what makes an absolute elbow control exact. */
function elbowHinge(rig:HumanRig,side:Side){
 const upper=rig.rest.get(`lowerarm01_${side}`)!.clone().sub(rig.rest.get(`upperarm01_${side}`)!);
 const lower=rig.rest.get(`wrist_${side}`)!.clone().sub(rig.rest.get(`lowerarm01_${side}`)!);
 return new Vector3().crossVectors(upper,lower).normalize()
  .applyQuaternion(rig.bone(`upperarm01_${side}`).getWorldQuaternion(new Quaternion()));
}
/** Set the elbow to an absolute flexion angle, clamped to the solver's own
 * limit. The forearm is the hinge's only free DOF here: its direction and bend
 * plane come from the stored wrist target and pole, so this is the forearm
 * angle an author can actually command and read back. */
export function setElbowAngle(rig:HumanRig,pose:WorkshopKey['pose'],side:Side,degrees:number,max:number){
 const target=Math.max(0,Math.min(max,degrees));
 const delta=target-readElbowUnrounded(rig,side);
 if(Math.abs(delta)<.05)return;
 rotateArmAbout(rig,pose,side,'forearm',elbowHinge(rig,side),delta);
}

/** Wrist orientation is measured against the main forearm bone; the distal
 * twist helper is solver-owned and should not hide a wrist rotation change. */
export function readWristRotation(rig:HumanRig|null,side:Side,reference?:WristRotationValues):WristRotationValues{
 if(!rig)return {...ZERO_WRIST};
 const relative=relativeQuaternion(rig,`lowerarm01_${side}`,`wrist_${side}`);
 return wristValuesOf(eulerNear(relative,reference&&wristRadiansOf(reference)));
}

/** Encode an absolute forearm-relative wrist orientation in the existing
 * forward/normal channels consumed by the production solver. */
export function setWristRotation(rig:HumanRig,pose:WorkshopKey['pose'],side:Side,channel:WristRotationChannel,degrees:number,reference?:WristRotationValues){
 const parentWorld=rig.bone(`lowerarm01_${side}`).getWorldQuaternion(new Quaternion());
 const wristWorld=rig.bone(`wrist_${side}`).getWorldQuaternion(new Quaternion());
 const euler=eulerNear(parentWorld.clone().invert().multiply(wristWorld.clone()),reference&&wristRadiansOf(reference));
 if(Math.abs(wrapRadians((degrees-euler[AXIS[channel]]*RAD_TO_DEG)*DEG_TO_RAD))<.05*DEG_TO_RAD)return;
 setChannel(euler,channel,degrees);
 const targetWorld=parentWorld.clone().multiply(new Quaternion().setFromEuler(euler));
 const rest=handFrame(rig.rest,side);
 const hand=side==='L'?pose.handL:pose.handR;
 const forward=rest.forward.clone().applyQuaternion(targetWorld),normal=rest.normal.clone().applyQuaternion(targetWorld);
 hand.forward={x:forward.x,y:forward.y,z:forward.z};
 hand.normal={x:normal.x,y:normal.y,z:normal.z};
}
