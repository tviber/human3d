import {Euler,Quaternion,Vector3} from 'three';
import {handFrame,rotateArmAbout} from '@human3d/motion-core';
import type {HumanRig,Side,WorkshopKey} from '@human3d/motion-core';

export type ArmRotationChannel='lift'|'swing'|'twist';
export type WristRotationChannel='flex'|'dev'|'twist';
export type ArmRotationValues=Record<ArmRotationChannel,number>;
export type WristRotationValues=Record<WristRotationChannel,number>;

const RAD_TO_DEG=180/Math.PI;
const DEG_TO_RAD=Math.PI/180;
const ORDER='YXZ';
const AXIS={lift:'x',swing:'y',twist:'z',flex:'x',dev:'y'} as const;

function eulerForRelativeRotation(rig:HumanRig,parent:string,bone:string){
 const parentWorld=rig.bone(parent).getWorldQuaternion(new Quaternion()).invert();
 const boneWorld=rig.bone(bone).getWorldQuaternion(new Quaternion());
 return new Euler().setFromQuaternion(parentWorld.multiply(boneWorld),ORDER);
}
function valuesOf(euler:Euler):ArmRotationValues{
 const round=(radians:number)=>Number((radians*RAD_TO_DEG).toFixed(1));
 return {lift:round(euler.x),swing:round(euler.y),twist:round(euler.z)};
}
function wristValuesOf(euler:Euler):WristRotationValues{
 const round=(radians:number)=>Number((radians*RAD_TO_DEG).toFixed(1));
 return {flex:round(euler.x),dev:round(euler.y),twist:round(euler.z)};
}
function setChannel(euler:Euler,channel:keyof typeof AXIS,degrees:number){
 euler[AXIS[channel]]=degrees*DEG_TO_RAD;
}

/** Read solved arm angles relative to the adjacent anatomical parent bone.
 * Split twist bones are solver helpers, not separate workshop controls. */
export function readArmRotation(rig:HumanRig|null,side:Side,joint:'upper'|'forearm'):ArmRotationValues{
 if(!rig)return {lift:0,swing:0,twist:0};
 const parent=joint==='upper'?`shoulder01_${side}`:`upperarm01_${side}`;
 const bone=joint==='upper'?`upperarm01_${side}`:`lowerarm01_${side}`;
 return valuesOf(eulerForRelativeRotation(rig,parent,bone));
}

/** Set one absolute parent-relative arm angle while preserving the other two.
 * rotateArmAbout encodes that world-space rotation into the authored hand
 * target/pole, then the production solver reconstructs the bone. */
export function setArmRotation(rig:HumanRig,pose:WorkshopKey['pose'],side:Side,joint:'upper'|'forearm',channel:ArmRotationChannel,degrees:number){
 const parentName=joint==='upper'?`shoulder01_${side}`:`upperarm01_${side}`;
 const boneName=joint==='upper'?`upperarm01_${side}`:`lowerarm01_${side}`;
 const parentWorld=rig.bone(parentName).getWorldQuaternion(new Quaternion());
 const boneWorld=rig.bone(boneName).getWorldQuaternion(new Quaternion());
 const relative=parentWorld.clone().invert().multiply(boneWorld);
 const euler=new Euler().setFromQuaternion(relative,ORDER);
 setChannel(euler,channel,degrees);
 const targetWorld=parentWorld.multiply(new Quaternion().setFromEuler(euler));
 const delta=targetWorld.multiply(boneWorld.invert()).normalize();
 if(delta.w<0)delta.set(-delta.x,-delta.y,-delta.z,-delta.w);
 const halfAngle=Math.acos(Math.max(-1,Math.min(1,delta.w)));
 const sinHalf=Math.sin(halfAngle);
 if(halfAngle<1e-8||Math.abs(sinHalf)<1e-8)return;
 const axis=new Vector3(delta.x/sinHalf,delta.y/sinHalf,delta.z/sinHalf);
 rotateArmAbout(rig,pose,side,joint,axis,2*halfAngle*RAD_TO_DEG);
}

/** Wrist orientation is measured against the main forearm bone; the distal
 * twist helper is solver-owned and should not hide a wrist rotation change. */
export function readWristRotation(rig:HumanRig|null,side:Side):WristRotationValues{
 if(!rig)return {flex:0,dev:0,twist:0};
 return wristValuesOf(eulerForRelativeRotation(rig,`lowerarm01_${side}`,`wrist_${side}`));
}

/** Encode an absolute forearm-relative wrist orientation in the existing
 * forward/normal channels consumed by the production solver. */
export function setWristRotation(rig:HumanRig,pose:WorkshopKey['pose'],side:Side,channel:WristRotationChannel,degrees:number){
 const parentWorld=rig.bone(`lowerarm01_${side}`).getWorldQuaternion(new Quaternion());
 const wristWorld=rig.bone(`wrist_${side}`).getWorldQuaternion(new Quaternion());
 const relative=parentWorld.clone().invert().multiply(wristWorld);
 const euler=new Euler().setFromQuaternion(relative,ORDER);
 setChannel(euler,channel,degrees);
 const targetWorld=parentWorld.multiply(new Quaternion().setFromEuler(euler));
 const rest=handFrame(rig.rest,side);
 const hand=side==='L'?pose.handL:pose.handR;
 const forward=rest.forward.applyQuaternion(targetWorld),normal=rest.normal.applyQuaternion(targetWorld);
 hand.forward={x:forward.x,y:forward.y,z:forward.z};
 hand.normal={x:normal.x,y:normal.y,z:normal.z};
}
