import {beforeAll,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import {Bone,Matrix4,Object3D,Quaternion,Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {VRM_HUMANOID_REQUIRED_BONES,type CharacterRigProfile} from './character-rig';
import {CharacterRigAdapter} from './character-rig-adapter';
import {frameAt,mirrorDoc} from './document';
import {motionFileById} from './motion-files';
import {HumanRig} from './rig';
import {solveEffectiveFrame} from './solver';

type HumanoidSemantic=(typeof VRM_HUMANOID_REQUIRED_BONES)[number];
const semanticParent:Record<HumanoidSemantic,HumanoidSemantic|null>={
 hips:null,spine:'hips',head:'spine',
 leftUpperLeg:'hips',leftLowerLeg:'leftUpperLeg',leftFoot:'leftLowerLeg',
 rightUpperLeg:'hips',rightLowerLeg:'rightUpperLeg',rightFoot:'rightLowerLeg',
 leftUpperArm:'spine',leftLowerArm:'leftUpperArm',leftHand:'leftLowerArm',
 rightUpperArm:'spine',rightLowerArm:'rightUpperArm',rightHand:'rightLowerArm',
};
const offsets:Record<HumanoidSemantic,Vector3>={
 hips:new Vector3(),spine:new Vector3(0,.18,0),head:new Vector3(0,.66,0),
 leftUpperLeg:new Vector3(.1,-.05,0),leftLowerLeg:new Vector3(0,-.45,0),leftFoot:new Vector3(0,-.44,0),
 rightUpperLeg:new Vector3(-.1,-.05,0),rightLowerLeg:new Vector3(0,-.45,0),rightFoot:new Vector3(0,-.44,0),
 leftUpperArm:new Vector3(.2,.22,0),leftLowerArm:new Vector3(.26,-.22,0),leftHand:new Vector3(.22,-.18,0),
 rightUpperArm:new Vector3(-.2,.22,0),rightLowerArm:new Vector3(-.26,-.22,0),rightHand:new Vector3(-.22,-.18,0),
};
let sourceRig:HumanRig;
const idleDoc=motionFileById('idle')!.document!;
const forehandDoc=motionFileById('forehand')!.document!;

beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 sourceRig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);

function makeTargetProfile(heightScale=1,widthScale=1,yaw=0,twistedAxes=false):CharacterRigProfile{
 const semantics=[...VRM_HUMANOID_REQUIRED_BONES],indexOf=new Map(semantics.map((semantic,index)=>[semantic,index]));
 const rootPosition=new Vector3(0,.94*heightScale,0),yawQ=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),yaw);
 const desired=new Map<number,Vector3>(),worldQ=new Map<number,Quaternion>();
 const bones:CharacterRigProfile['bones']=[];
 for(const [index,semantic]of semantics.entries()){
  const parentName=semanticParent[semantic],parentIndex=parentName===null?null:indexOf.get(parentName)!;
  let position:Vector3;
  let localRotation=new Quaternion();
  if(parentIndex===null){
   position=rootPosition.clone();localRotation.copy(yawQ);
  }else{
   const parentPosition=desired.get(parentIndex)!;
   const offset=offsets[semantic].clone();offset.x*=widthScale;offset.y*=heightScale;offset.z*=heightScale;
   position=parentPosition.clone().add(offset.applyQuaternion(yawQ));
   if(twistedAxes)localRotation.setFromAxisAngle(new Vector3(1,(index%3)+1,(index%2)+1).normalize(),.17*(index%5+1));
  }
  if(parentIndex!==null){
   const parentRotation=worldQ.get(parentIndex)!;
   const localPosition=position.clone().sub(desired.get(parentIndex)!).applyQuaternion(parentRotation.clone().invert());
   const parentQ=parentRotation.clone();
   const nodeWorldQ=parentQ.multiply(localRotation);
   const parentWorld=desired.get(parentIndex)!;
   bones.push({index,name:`node-${semantic}`,parentIndex,translation:localPosition.toArray() as [number,number,number],rotation:localRotation.toArray() as [number,number,number,number],scale:[1,1,1],worldPosition:position.toArray() as [number,number,number],parentDistanceMeters:position.distanceTo(parentWorld),skinJoint:true});
   worldQ.set(index,nodeWorldQ);
  }else{
   bones.push({index,name:`node-${semantic}`,parentIndex:null,translation:position.toArray() as [number,number,number],rotation:localRotation.toArray() as [number,number,number,number],scale:[1,1,1],worldPosition:position.toArray() as [number,number,number],parentDistanceMeters:null,skinJoint:true});
   worldQ.set(index,localRotation.clone());
  }
  desired.set(index,position);
 }
 const meshIndex=bones.length;
 bones.push({index:meshIndex,name:'mesh',parentIndex:null,translation:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1],worldPosition:[0,0,0],parentDistanceMeters:null,skinJoint:false});
 const humanoidBones=Object.fromEntries(semantics.map((semantic,index)=>[semantic,index]));
 return {
  schemaVersion:1,source:{format:'glb',sha256:'b'.repeat(64)},coordinateSystem:{handedness:'right',upAxis:'Y',unit:'meter'},
  vrm:{state:'verified',specVersion:'1.0'},mappingSource:'vrm',humanoidBones,bones,
  skins:[{meshNode:meshIndex,jointNodeIndices:semantics.map((_,index)=>index),inverseBindMatrixCount:semantics.length,vertexCount:1,skinIndexCount:1,skinIndexItemSize:4,skinWeightCount:1,skinWeightItemSize:4,invalidJointIndices:0,invalidWeightVertices:0,bindPose:'verified'}],
  assessment:{restPose:'verified',sideMapping:'verified',heightMeters:1.78*heightScale},
 };
}

function makeTarget(profile:CharacterRigProfile){
 const root=new Object3D(),objects=profile.bones.map(bone=>bone.skinJoint?new Bone():new Object3D());
 for(const bone of profile.bones){
  const object=objects[bone.index];object.name=bone.name;object.position.fromArray(bone.translation);object.quaternion.fromArray(bone.rotation);object.scale.fromArray(bone.scale);
  if(bone.parentIndex===null)root.add(object);else objects[bone.parentIndex].add(object);
 }
 root.updateMatrixWorld(true);
 return {root,objects};
}

function rigFrame(doc=idleDoc,time=0){return frameAt(doc,time,sourceRig.rest.get('root')!)}
function nearVector(actual:Vector3,expected:Vector3,tolerance=1e-8){expect(actual.distanceTo(expected)).toBeLessThan(tolerance)}
function asVector(value:{x:number;y:number;z:number}){return new Vector3(value.x,value.y,value.z)}
function mirrorQuaternion(q:Quaternion){
 const elements=new Matrix4().makeRotationFromQuaternion(q).elements,sign=[-1,1,1];
 for(let row=0;row<3;row++)for(let column=0;column<3;column++)elements[column*4+row]*=sign[row]*sign[column];
 return new Quaternion().setFromRotationMatrix(new Matrix4().fromArray(elements));
}

const endpointPairs:[string,string][]=[
 ['leftUpperArm','rightUpperArm'],['leftLowerArm','rightLowerArm'],['leftHand','rightHand'],
 ['leftUpperLeg','rightUpperLeg'],['leftLowerLeg','rightLowerLeg'],['leftFoot','rightFoot'],
];

describe('CharacterRigAdapter',()=>{
 it('round-trips target rest transforms and restores them after an applied pose',()=>{
  const profile=makeTargetProfile(1,1,0,true),target=makeTarget(profile),adapter=new CharacterRigAdapter(target.root,profile,target.objects,sourceRig.rest);
  const rest=target.objects.map(object=>({position:object.position.clone(),rotation:object.quaternion.clone(),scale:object.scale.clone()}));
  sourceRig.reset();adapter.applyFromSourceRig(sourceRig,rigFrame());
  target.objects.forEach((object,index)=>{
   nearVector(object.position,rest[index].position,1e-12);
   expect(object.quaternion.angleTo(rest[index].rotation)).toBeLessThan(1e-7);
   nearVector(object.scale,rest[index].scale,1e-12);
  });
  const frame=rigFrame(forehandDoc,forehandDoc.duration*.62);solveEffectiveFrame(sourceRig,frame);adapter.applyFromSourceRig(sourceRig,frame);adapter.reset();
  target.objects.forEach((object,index)=>{
   nearVector(object.position,rest[index].position,1e-12);
   expect(object.quaternion.angleTo(rest[index].rotation)).toBeLessThan(1e-7);
   nearVector(object.scale,rest[index].scale,1e-12);
  });
 });

 it('scales root and task-space points by target height while preserving world-delta rotations across local axes',()=>{
  const frame=rigFrame(idleDoc,.72),shifted={...frame,pose:{...frame.pose,yaw:30,lean:9,chest:-13,side:6,root:{x:.06,y:.025,z:-.035}}};
  sourceRig.reset();solveEffectiveFrame(sourceRig,shifted);
  const profileA=makeTargetProfile(1.25,.82,Math.PI/2,false),profileB=makeTargetProfile(1.25,.82,Math.PI/2,true);
  const targetA=makeTarget(profileA),targetB=makeTarget(profileB);
  const adapterA=new CharacterRigAdapter(targetA.root,profileA,targetA.objects,sourceRig.rest),adapterB=new CharacterRigAdapter(targetB.root,profileB,targetB.objects,sourceRig.rest);
  const restQuatsA=targetA.objects.map(node=>node.getWorldQuaternion(new Quaternion())),restQuatsB=targetB.objects.map(node=>node.getWorldQuaternion(new Quaternion()));
  const resultA=adapterA.applyFromSourceRig(sourceRig,shifted),resultB=adapterB.applyFromSourceRig(sourceRig,shifted);
  expect(resultA.heightScale).toBeCloseTo(1.25,10);
  expect(resultA.mappedSemantics).toContain('leftLowerArm');
  expect(resultA.mappedSemantics).toContain('leftHand');
  expect(resultA.mappedSemantics).toContain('leftFoot');
  expect(resultA.mappedSemantics).toContain('rightFoot');
  expect(resultA.frame.pose.yaw).toBe(shifted.pose.yaw);
  expect(resultA.frame.pose.lean).toBe(shifted.pose.lean);
  expect(resultA.frame.pose.chest).toBe(shifted.pose.chest);
  expect(resultA.frame.pose.side).toBe(shifted.pose.side);
  expect(resultA.frame.pose.root.x).toBeCloseTo(-.035*1.25,8);
  expect(resultA.frame.pose.root.z).toBeCloseTo(-.06*1.25,8);
  expect(resultA.frame.pose.footL.yaw).toBeCloseTo(shifted.pose.footL.yaw+90,5);
  expect(resultA.frame.pose.footL.pitch).toBeCloseTo(shifted.pose.footL.pitch,5);
  const sourceRootDelta=sourceRig.point('root').sub(sourceRig.rest.get('root')!).multiplyScalar(resultA.heightScale).applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),Math.PI/2));
  nearVector(targetA.objects[profileA.humanoidBones.hips].getWorldPosition(new Vector3()),new Vector3(...profileA.bones[profileA.humanoidBones.hips].worldPosition as [number,number,number]).add(sourceRootDelta),1e-7);
  const expectedHand=new Vector3(shifted.pose.handR.target.x,shifted.pose.handR.target.y,shifted.pose.handR.target.z)
   .sub(sourceRig.rest.get('root')!).multiplyScalar(resultA.heightScale).applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),Math.PI/2))
   .add(new Vector3(...profileA.bones[profileA.humanoidBones.hips].worldPosition as [number,number,number]));
  nearVector(asVector(resultA.frame.pose.handR.target),expectedHand,1e-7);
  for(const semantic of resultA.mappedSemantics){
   const index=profileA.humanoidBones[semantic],sourceName=semantic==='leftLowerArm'?'lowerarm02_L':semantic==='rightLowerArm'?'lowerarm02_R':semantic==='leftHand'?'wrist_L':semantic==='rightHand'?'wrist_R':semantic==='leftFoot'?'foot_L':semantic==='rightFoot'?'foot_R':undefined;
   if(!sourceName)continue;
   const deltaA=targetA.objects[index].getWorldQuaternion(new Quaternion()).multiply(restQuatsA[index].clone().invert());
   const deltaB=targetB.objects[profileB.humanoidBones[semantic]].getWorldQuaternion(new Quaternion()).multiply(restQuatsB[profileB.humanoidBones[semantic]].clone().invert());
   const basis=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),Math.PI/2),expectedDelta=basis.clone().multiply(sourceRig.bone(sourceName).getWorldQuaternion(new Quaternion())).multiply(basis.clone().invert());
   expect(deltaA.angleTo(expectedDelta)).toBeLessThan(1e-6);expect(deltaB.angleTo(expectedDelta)).toBeLessThan(1e-6);
  }
  for(const residual of Object.values(resultA.endpointResidualMeters))expect(Number.isFinite(residual)&&residual>=0).toBe(true);
  expect(resultB.heightScale).toBeCloseTo(resultA.heightScale,12);
 });

 it('preserves left-right mirror symmetry through frameAt, solveEffectiveFrame and target application',()=>{
  const profile=makeTargetProfile(1,1,0,false),target=makeTarget(profile),adapter=new CharacterRigAdapter(target.root,profile,target.objects,sourceRig.rest);
  const time=forehandDoc.duration*.61;
  const capture=(doc:typeof forehandDoc)=>{
   const frame=rigFrame(doc,time);sourceRig.reset();solveEffectiveFrame(sourceRig,frame);adapter.applyFromSourceRig(sourceRig,frame);
   return new Map(profile.humanoidBones&&Object.entries(profile.humanoidBones).map(([semantic,index])=>[semantic,{position:target.objects[index].getWorldPosition(new Vector3()),rotation:target.objects[index].getWorldQuaternion(new Quaternion())}]));
  };
  const right=capture(forehandDoc),left=capture(mirrorDoc(forehandDoc));
  for(const [leftName,rightName]of endpointPairs){
   const l=right.get(leftName)!,r=right.get(rightName)!,mirrored=left.get(leftName)!,mirroredOther=left.get(rightName)!;
   expect(mirrored.position.x).toBeCloseTo(-r.position.x,6);expect(mirrored.position.y).toBeCloseTo(r.position.y,6);expect(mirrored.position.z).toBeCloseTo(r.position.z,6);
   expect(mirroredOther.position.x).toBeCloseTo(-l.position.x,6);expect(mirroredOther.position.y).toBeCloseTo(l.position.y,6);expect(mirroredOther.position.z).toBeCloseTo(l.position.z,6);
   expect(mirrored.rotation.angleTo(mirrorQuaternion(r.rotation))).toBeLessThan(1e-5);
  }
 });
});
