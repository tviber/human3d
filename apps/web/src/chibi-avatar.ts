import {Bone,Group,Quaternion,Vector3} from 'three';
import type {HumanRig} from '@human3d/motion-core';

const RETARGET:[string,string][]=[
 ['root','Hip'],
 ['spine05','Pelvis'],['spine04','Waist'],['spine03','Spine01'],['spine02','Spine02'],['spine01','NeckTwist01'],['neck01','NeckTwist02'],['head','head'],
 ['clavicle_L','L_Clavicle'],['upperarm01_L','L_Upperarm'],['upperarm02_L','L_UpperarmTwist01'],['lowerarm01_L','L_Forearm'],['lowerarm02_L','L_ForearmTwist01'],['wrist_L','L_Hand'],
 ['clavicle_R','R_Clavicle'],['upperarm01_R','R_Upperarm'],['upperarm02_R','R_UpperarmTwist01'],['lowerarm01_R','R_Forearm'],['lowerarm02_R','R_ForearmTwist01'],['wrist_R','R_Hand'],
 ['finger1-1_L','L_Thumb1'],['finger1-2_L','L_Thumb2'],['finger1-3_L','L_Thumb3'],
 ['finger2-1_L','L_Index1'],['finger2-2_L','L_Index2'],['finger2-3_L','L_Index3'],
 ['finger3-1_L','L_Mid1'],['finger3-2_L','L_Mid2'],['finger3-3_L','L_Mid3'],
 ['finger4-1_L','L_Ring1'],['finger4-2_L','L_Ring2'],['finger4-3_L','L_Ring3'],
 ['finger5-1_L','L_Pinky1'],['finger5-2_L','L_Pinky2'],['finger5-3_L','L_Pinky3'],
 ['finger1-1_R','R_Thumb1'],['finger1-2_R','R_Thumb2'],['finger1-3_R','R_Thumb3'],
 ['finger2-1_R','R_Index1'],['finger2-2_R','R_Index2'],['finger2-3_R','R_Index3'],
 ['finger3-1_R','R_Mid1'],['finger3-2_R','R_Mid2'],['finger3-3_R','R_Mid3'],
 ['finger4-1_R','R_Ring1'],['finger4-2_R','R_Ring2'],['finger4-3_R','R_Ring3'],
 ['finger5-1_R','R_Pinky1'],['finger5-2_R','R_Pinky2'],['finger5-3_R','R_Pinky3'],
 ['upperleg01_L','L_Thigh'],['upperleg02_L','L_ThighTwist01'],['lowerleg01_L','L_Calf'],['lowerleg02_L','L_CalfTwist01'],['foot_L','L_Foot'],['toe1-1_L','L_ToeBase'],
 ['upperleg01_R','R_Thigh'],['upperleg02_R','R_ThighTwist01'],['lowerleg01_R','R_Calf'],['lowerleg02_R','R_CalfTwist01'],['foot_R','R_Foot'],['toe1-1_R','R_ToeBase'],
];

type BonePose={bone:Bone;position:Vector3;quaternion:Quaternion;scale:Vector3};

/** Display the Tripo chibi rig while the original HumanRig remains the
 * authoritative pose rig. World-space rotation deltas are retargeted onto the
 * chibi's rest pose, so persisted documents and solvers keep their coordinates. */
export type AvatarMode='chibi'|'original';
export class ChibiAvatarBridge{
 private readonly bones:BonePose[]=[];
 private readonly sourceRest=new Map<string,Quaternion>();
 private readonly targetRest=new Map<string,Quaternion>();
 private readonly target=new Map<string,Bone>();
 private readonly racketScale=new Map<'L'|'R',number>();
 private readonly rootRest:Vector3;
 private readonly basePosition:Vector3;
 readonly scale=1.7;
 constructor(private readonly source:HumanRig,readonly avatar:Group){
  avatar.rotation.y=-Math.PI/2;avatar.scale.setScalar(this.scale);avatar.updateMatrixWorld(true);
  const hip=avatar.getObjectByName('Hip') as Bone|undefined,sourceRoot=source.point('root');
  if(!hip?.isBone)throw new Error('Q版模型缺少骨盆骨骼 Hip');
  const avatarRoot=hip.getWorldPosition(new Vector3());
  this.rootRest=sourceRoot.clone();
  // Keep the shoes on the scene floor; align the pelvis on X/Z and let the
  // avatar's shorter torso retain its own proportions.
  this.basePosition=new Vector3(sourceRoot.x-avatarRoot.x,0,sourceRoot.z-avatarRoot.z);
  avatar.position.copy(this.basePosition);avatar.updateMatrixWorld(true);
  source.model.updateMatrixWorld(true);
  for(const [from,to]of RETARGET){
   const src=source.bone(from),dst=avatar.getObjectByName(to) as Bone|undefined;
   if(!dst?.isBone)throw new Error(`Q版模型缺少骨骼 ${to}`);
   this.target.set(from,dst);
   if(!this.sourceRest.has(from))this.sourceRest.set(from,src.getWorldQuaternion(new Quaternion()));
   this.targetRest.set(from,dst.getWorldQuaternion(new Quaternion()));
  }
  for(const side of ['L','R'] as const){
   const sourceWidth=source.rest.get(`finger2-1_${side}`)!.distanceTo(source.rest.get(`finger5-1_${side}`)!);
   const index=this.target.get(`finger2-1_${side}`)!,pinky=this.target.get(`finger5-1_${side}`)!;
   const targetWidth=index.getWorldPosition(new Vector3()).distanceTo(pinky.getWorldPosition(new Vector3()));
   const ratio=targetWidth/sourceWidth;
   this.racketScale.set(side,Number.isFinite(ratio)&&ratio>0?ratio:1);
  }
  avatar.traverse(o=>{if((o as Bone).isBone){const bone=o as Bone;this.bones.push({bone,position:bone.position.clone(),quaternion:bone.quaternion.clone(),scale:bone.scale.clone()});}});
  this.sync();
 }
 sync(){
  this.source.model.updateMatrixWorld(true);
  for(const pose of this.bones){pose.bone.position.copy(pose.position);pose.bone.quaternion.copy(pose.quaternion);pose.bone.scale.copy(pose.scale);}
  const sourceRoot=this.source.point('root');
  this.avatar.position.copy(this.basePosition).add(sourceRoot.sub(this.rootRest));
  this.avatar.updateMatrixWorld(true);
  for(const [from]of RETARGET){
   const dst=this.target.get(from)!,parent=dst.parent;
   const current=this.source.bone(from).getWorldQuaternion(new Quaternion());
   const delta=current.multiply(this.sourceRest.get(from)!.clone().invert());
   const desired=delta.multiply(this.targetRest.get(from)!.clone());
   if(parent){
    const parentWorld=parent.getWorldQuaternion(new Quaternion());
    dst.quaternion.copy(parentWorld.invert().multiply(desired));
   }else dst.quaternion.copy(desired);
   dst.updateWorldMatrix(true,false);
  }
  this.avatar.updateMatrixWorld(true);
 }
 point(name:string){
  const bone=this.target.get(name);if(!bone)throw new Error(`Q版模型未映射骨骼 ${name}`);
  return bone.getWorldPosition(new Vector3());
 }
 /** Convert a position dragged on the avatar back into the original rig's
  * world coordinates while preserving the pointer's movement delta. */
 toSourcePoint(sourceName:string,targetName:string,point:Vector3){
  return this.source.point(sourceName).add(point.sub(this.point(targetName)));
 }
 headHandle(){return this.point('head').add(new Vector3(0,0,.22));}
 syncProp(sourceProp:Group,displayProp:Group,side:'L'|'R'){
  const sourceHand=this.source.bone(`wrist_${side}`),targetHand=this.target.get(`wrist_${side}`)!;
  sourceHand.updateWorldMatrix(true,false);sourceProp.updateWorldMatrix(true,true);
  const sourcePosition=sourceProp.getWorldPosition(new Vector3()),sourceRotation=sourceProp.getWorldQuaternion(new Quaternion());
  const handPosition=sourceHand.getWorldPosition(new Vector3()),handRotation=sourceHand.getWorldQuaternion(new Quaternion());
  const handInverse=handRotation.invert();
  const localPosition=sourcePosition.sub(handPosition).applyQuaternion(handInverse);
  const localRotation=handInverse.clone().multiply(sourceRotation);
  const restMap=this.targetRest.get(`wrist_${side}`)!.clone().invert().multiply(this.sourceRest.get(`wrist_${side}`)!);
  const handScale=this.racketScale.get(side)??1;
  if(displayProp.parent!==targetHand)targetHand.add(displayProp);
  displayProp.position.copy(localPosition).applyQuaternion(restMap).multiplyScalar(handScale/this.scale);
  displayProp.quaternion.copy(restMap).multiply(localRotation);displayProp.scale.setScalar(handScale/this.scale);
  displayProp.updateMatrixWorld(true);
 }
}
