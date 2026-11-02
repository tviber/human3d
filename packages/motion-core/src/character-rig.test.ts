import {describe,it,expect} from 'vitest';
import {VRM_HUMANOID_REQUIRED_BONES,type CharacterRigProfile,validateCharacterRigProfile} from './character-rig';

const makeProfile=():CharacterRigProfile=>{
 const semantics=[...VRM_HUMANOID_REQUIRED_BONES];
 const parentBySemantic:Record<string,string|null>={
  hips:null,spine:'hips',head:'spine',
  leftUpperLeg:'hips',leftLowerLeg:'leftUpperLeg',leftFoot:'leftLowerLeg',
  rightUpperLeg:'hips',rightLowerLeg:'rightUpperLeg',rightFoot:'rightLowerLeg',
  leftUpperArm:'spine',leftLowerArm:'leftUpperArm',leftHand:'leftLowerArm',
  rightUpperArm:'spine',rightLowerArm:'rightUpperArm',rightHand:'rightLowerArm',
 };
 const indices=Object.fromEntries(semantics.map((semantic,index)=>[semantic,index]));
 const bones=[...semantics.map((semantic,index)=>({
  index,name:`node-${semantic}`,parentIndex:parentBySemantic[semantic]===null?null:indices[parentBySemantic[semantic]!],
  translation:[0,index===0?0:.1,0] as [number,number,number],rotation:[0,0,0,1] as [number,number,number,number],
  scale:[1,1,1] as [number,number,number],worldPosition:[0,index*.1,0] as [number,number,number],
  parentDistanceMeters:index===0?null:.1,skinJoint:true,
 })),{index:15,name:'mesh',parentIndex:null,translation:[0,0,0] as [number,number,number],rotation:[0,0,0,1] as [number,number,number,number],scale:[1,1,1] as [number,number,number],worldPosition:[0,0,0] as [number,number,number],parentDistanceMeters:null,skinJoint:false}];
 return {
  schemaVersion:1,source:{format:'glb',sha256:'a'.repeat(64)},coordinateSystem:{handedness:'right',upAxis:'Y',unit:'meter'},
  vrm:{state:'verified',specVersion:'1.0'},mappingSource:'vrm',
  humanoidBones:indices,bones,
  skins:[{meshNode:15,jointNodeIndices:semantics.map((_,index)=>index),inverseBindMatrixCount:semantics.length,vertexCount:1,skinIndexCount:1,skinIndexItemSize:4,skinWeightCount:1,skinWeightItemSize:4,invalidJointIndices:0,invalidWeightVertices:0,bindPose:'verified'}],
  assessment:{restPose:'verified',sideMapping:'verified',heightMeters:1.7},
 };
};
function addOptionalBone(profile:CharacterRigProfile,semantic:string,parentSemantic:string){
 const index=profile.bones.length,parentIndex=profile.humanoidBones[parentSemantic];
 profile.humanoidBones[semantic]=index;
 profile.bones.push({index,name:`node-${semantic}`,parentIndex,translation:[0,.1,0],rotation:[0,0,0,1],scale:[1,1,1],worldPosition:[0,.2,0],parentDistanceMeters:.1,skinJoint:true});
 profile.skins[0].jointNodeIndices.push(index);
 profile.skins[0].inverseBindMatrixCount=(profile.skins[0].inverseBindMatrixCount??0)+1;
}

describe('character rig profile validation',()=>{
 it('accepts a complete VRM humanoid skeleton and reports optional capabilities',()=>{
  const result=validateCharacterRigProfile(makeProfile());
  expect(result.status).toBe('warning'); // fingers are optional in VRM 1.0
  expect(result.issues.map(issue=>issue.code)).toContain('optional-finger-bones-missing');
  expect(result.capabilities).toMatchObject({fingers:false,toes:false,shoulders:false,chest:false,neck:false});
 });

 it('requires explicit mapping for a GLB without VRM humanoid metadata',()=>{
  const profile=makeProfile();profile.vrm={state:'absent'};profile.mappingSource='none';profile.humanoidBones={};
  const result=validateCharacterRigProfile(profile);
  expect(result.status).toBe('needs-mapping');
  expect(result.issues.some(issue=>issue.code==='manual-mapping-required')).toBe(true);
  expect(result.issues.some(issue=>issue.code==='missing-required-bone'&&issue.severity==='warning')).toBe(true);
 });

 it('rejects incomplete VRM mappings and hierarchy that breaks a required limb chain',()=>{
  const profile=makeProfile();delete profile.humanoidBones.leftHand;
  const rightHand=profile.humanoidBones.rightHand;profile.humanoidBones.leftLowerArm=rightHand;
  const result=validateCharacterRigProfile(profile);
  expect(result.status).toBe('unsupported');
  expect(result.issues.some(issue=>issue.code==='missing-required-bone'&&issue.semantic==='leftHand')).toBe(true);
  expect(result.issues.some(issue=>issue.code==='duplicate-humanoid-node')).toBe(true);
  expect(result.issues.some(issue=>issue.code==='invalid-humanoid-hierarchy')).toBe(true);
 });

 it('rejects bad transforms, non-positive humanoid scale, and incomplete skin data',()=>{
  const profile=makeProfile();
  profile.bones[0].rotation=[0,0,0,0];profile.bones[0].scale=[1,0,1];profile.bones[1].parentDistanceMeters=-1;
  profile.skins[0].inverseBindMatrixCount=1;profile.skins[0].invalidWeightVertices=1;
  const result=validateCharacterRigProfile(profile);
  expect(result.status).toBe('unsupported');
  expect(result.issues.map(issue=>issue.code)).toEqual(expect.arrayContaining([
   'invalid-bone-transform','invalid-humanoid-scale','inverse-bind-count-mismatch','invalid-skin-weight',
  ]));
 });

 it('detects hierarchy cycles and invalid source hashes',()=>{
  const profile=makeProfile();
  profile.source.sha256='not-a-hash';profile.bones[0].parentIndex=1;
  const result=validateCharacterRigProfile(profile);
  expect(result.status).toBe('unsupported');
  expect(result.issues.map(issue=>issue.code)).toEqual(expect.arrayContaining(['source-hash-invalid','parent-cycle']));
 });

 it('rejects optional torso and shoulder bones placed on the wrong branch',()=>{
  const profile=makeProfile();
  addOptionalBone(profile,'chest','leftFoot');
  addOptionalBone(profile,'leftShoulder','rightFoot');
  const result=validateCharacterRigProfile(profile);
  expect(result.status).toBe('unsupported');
  expect(result.issues.filter(issue=>issue.code==='invalid-humanoid-hierarchy').map(issue=>issue.semantic)).toEqual(expect.arrayContaining(['head','chest','leftShoulder']));
 });
});
