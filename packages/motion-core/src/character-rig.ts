export const CHARACTER_RIG_PROFILE_VERSION=1 as const;

/** VRM 1.0 requires these 15 semantic bones. Fingers, toes, shoulders and
 * additional torso bones are optional and are reported as capabilities. */
export const VRM_HUMANOID_REQUIRED_BONES=[
 'hips','spine','head',
 'leftUpperLeg','leftLowerLeg','leftFoot',
 'rightUpperLeg','rightLowerLeg','rightFoot',
 'leftUpperArm','leftLowerArm','leftHand',
 'rightUpperArm','rightLowerArm','rightHand',
] as const;
export type VrmRequiredHumanoidBone=typeof VRM_HUMANOID_REQUIRED_BONES[number];

export type CharacterRigStatus='supported'|'warning'|'needs-mapping'|'unsupported';
export type CharacterRigMappingSource='vrm'|'registry'|'manual'|'none';
export type CharacterRigAssessment='verified'|'mismatch'|'unverified'|'other';
export type VrmExtensionState='verified'|'absent'|'invalid';

export interface CharacterRigBone{
 index:number;
 name:string;
 parentIndex:number|null;
 translation:[number,number,number];
 rotation:[number,number,number,number];
 scale:[number,number,number];
 worldPosition:[number,number,number];
 parentDistanceMeters:number|null;
 skinJoint:boolean;
}

export interface CharacterSkinBinding{
 meshNode:number;
 jointNodeIndices:number[];
 inverseBindMatrixCount:number|null;
 vertexCount:number;
 skinIndexCount:number;
 skinIndexItemSize:number;
 skinWeightCount:number;
 skinWeightItemSize:number;
 invalidJointIndices:number;
 invalidWeightVertices:number;
 bindPose:CharacterRigAssessment;
}

/** Serializable import result. This is a character asset profile, not a motion
 * document or a replacement for the existing MakeHuman pose-package manifest. */
export interface CharacterRigProfile{
 schemaVersion:typeof CHARACTER_RIG_PROFILE_VERSION;
 source:{format:'glb'|'vrm';sha256:string;license?:string};
 coordinateSystem:{handedness:'right';upAxis:'Y';unit:'meter'};
 vrm:{state:VrmExtensionState;specVersion?:string};
 mappingSource:CharacterRigMappingSource;
 humanoidBones:Record<string,number>;
 bones:CharacterRigBone[];
 skins:CharacterSkinBinding[];
 assessment:{restPose:CharacterRigAssessment;sideMapping:CharacterRigAssessment;heightMeters:number|null};
}

export type CharacterRigIssueCode=
 |'profile-version-unsupported'|'coordinate-system-unsupported'|'source-hash-invalid'|'vrm-extension-invalid'|'vrm-version-unsupported'
 |'no-bones'|'duplicate-node-index'|'duplicate-bone-name'|'parent-node-missing'|'parent-cycle'
 |'invalid-bone-transform'|'invalid-humanoid-scale'|'unknown-humanoid-semantic'|'humanoid-node-missing'
 |'duplicate-humanoid-node'|'missing-required-bone'|'invalid-humanoid-hierarchy'|'required-bone-not-skinned'
 |'no-skinned-mesh'|'invalid-skin-joints'|'inverse-bind-count-mismatch'|'skin-attributes-missing'
 |'skin-attribute-count-mismatch'|'skin-attribute-layout-invalid'|'invalid-skin-joint-index'|'invalid-skin-weight'|'bind-pose-mismatch'
 |'bind-pose-unverified'|'manual-mapping-required'|'non-vrm-mapping'|'rest-pose-unverified'
 |'rest-pose-unrecognized'|'side-mapping-mismatch'|'side-mapping-unverified'|'height-unverified'
 |'optional-finger-bones-missing';

export interface CharacterRigIssue{
 code:CharacterRigIssueCode;
 severity:'error'|'warning'|'info';
 semantic?:string;
 nodeIndex?:number;
 meshNode?:number;
}
export interface CharacterRigValidation{
 status:CharacterRigStatus;
 issues:CharacterRigIssue[];
 capabilities:{fingers:boolean;toes:boolean;shoulders:boolean;chest:boolean;upperChest:boolean;neck:boolean};
}

const OPTIONAL_CAPABILITIES={
 fingers:[
  'leftThumbMetacarpal','leftThumbProximal','leftThumbDistal','leftIndexProximal','leftIndexIntermediate','leftIndexDistal',
  'leftMiddleProximal','leftMiddleIntermediate','leftMiddleDistal','leftRingProximal','leftRingIntermediate','leftRingDistal',
  'leftLittleProximal','leftLittleIntermediate','leftLittleDistal',
  'rightThumbMetacarpal','rightThumbProximal','rightThumbDistal','rightIndexProximal','rightIndexIntermediate','rightIndexDistal',
  'rightMiddleProximal','rightMiddleIntermediate','rightMiddleDistal','rightRingProximal','rightRingIntermediate','rightRingDistal',
  'rightLittleProximal','rightLittleIntermediate','rightLittleDistal',
 ],
 toes:['leftToes','rightToes'],
 shoulders:['leftShoulder','rightShoulder'],
 chest:['chest'],
 upperChest:['upperChest'],
 neck:['neck'],
} as const;

const REQUIRED_HIERARCHY:[string,string][]=[
 ['spine','hips'],['head','spine'],
 ['leftUpperArm','spine'],['leftLowerArm','leftUpperArm'],['leftHand','leftLowerArm'],
 ['rightUpperArm','spine'],['rightLowerArm','rightUpperArm'],['rightHand','rightLowerArm'],
 ['leftLowerLeg','leftUpperLeg'],['leftFoot','leftLowerLeg'],
 ['rightLowerLeg','rightUpperLeg'],['rightFoot','rightLowerLeg'],
 ['leftUpperLeg','hips'],['rightUpperLeg','hips'],
];
const FINGER_CHAINS=[
 ['leftThumbMetacarpal','leftThumbProximal','leftThumbDistal'],
 ['rightThumbMetacarpal','rightThumbProximal','rightThumbDistal'],
 ['leftIndexProximal','leftIndexIntermediate','leftIndexDistal'],
 ['rightIndexProximal','rightIndexIntermediate','rightIndexDistal'],
 ['leftMiddleProximal','leftMiddleIntermediate','leftMiddleDistal'],
 ['rightMiddleProximal','rightMiddleIntermediate','rightMiddleDistal'],
 ['leftRingProximal','leftRingIntermediate','leftRingDistal'],
 ['rightRingProximal','rightRingIntermediate','rightRingDistal'],
 ['leftLittleProximal','leftLittleIntermediate','leftLittleDistal'],
 ['rightLittleProximal','rightLittleIntermediate','rightLittleDistal'],
] as const;

const finiteTuple=(value:unknown,length:number):value is number[]=>
 Array.isArray(value)&&value.length===length&&value.every(Number.isFinite);
const norm4=(q:number[])=>Math.hypot(q[0],q[1],q[2],q[3]);

/** Validate an extracted profile without depending on DOM, GLTFLoader, or node.
 * The importer supplies the observations; this function enforces the shared
 * semantic, hierarchy, transform, and skin-binding contract. */
export function validateCharacterRigProfile(profile:CharacterRigProfile):CharacterRigValidation{
 const issues:CharacterRigIssue[]=[];
 const add=(code:CharacterRigIssueCode,severity:CharacterRigIssue['severity'],extra:Partial<CharacterRigIssue>={})=>issues.push({code,severity,...extra});
 if(profile.schemaVersion!==CHARACTER_RIG_PROFILE_VERSION)add('profile-version-unsupported','error');
 if(profile.coordinateSystem.handedness!=='right'||profile.coordinateSystem.upAxis!=='Y'||profile.coordinateSystem.unit!=='meter')
  add('coordinate-system-unsupported','error');
 if(!/^[0-9a-f]{64}$/.test(profile.source.sha256))add('source-hash-invalid','error');
 if(profile.vrm.state==='invalid')add('vrm-extension-invalid','error');
 if(profile.vrm.state==='verified'&&profile.vrm.specVersion!=='1.0')add('vrm-version-unsupported','error');
 if(profile.vrm.state==='verified'&&profile.mappingSource!=='vrm')add('non-vrm-mapping','warning');
 if(profile.vrm.state==='absent'&&profile.mappingSource==='none')add('manual-mapping-required','warning');
 if(profile.vrm.state==='absent'&&profile.mappingSource!=='none')add('non-vrm-mapping','warning');

 const byIndex=new Map<number,CharacterRigBone>(),byName=new Map<string,CharacterRigBone>();
 for(const bone of profile.bones){
  if(!Number.isInteger(bone.index)||bone.index<0||byIndex.has(bone.index))add('duplicate-node-index','error',{nodeIndex:bone.index});
  else byIndex.set(bone.index,bone);
  if(!bone.name.trim())add('invalid-bone-transform','error',{nodeIndex:bone.index});
  else if(byName.has(bone.name))add('duplicate-bone-name','warning',{nodeIndex:bone.index});
  else byName.set(bone.name,bone);
  if(!finiteTuple(bone.translation,3)||!finiteTuple(bone.rotation,4)||!finiteTuple(bone.scale,3)||!finiteTuple(bone.worldPosition,3)
   ||(bone.parentDistanceMeters!==null&&(!Number.isFinite(bone.parentDistanceMeters)||bone.parentDistanceMeters<0))){
   add('invalid-bone-transform','error',{nodeIndex:bone.index});
   continue;
  }
  const qNorm=norm4(bone.rotation);
  if(!Number.isFinite(qNorm)||Math.abs(qNorm-1)>1e-3)add('invalid-bone-transform','error',{nodeIndex:bone.index});
  if(bone.parentIndex!==null&&(!Number.isInteger(bone.parentIndex)||bone.parentIndex<0))add('parent-node-missing','error',{nodeIndex:bone.index});
  if(bone.scale.some(value=>value<=0)&&bone.skinJoint)add('invalid-humanoid-scale','error',{nodeIndex:bone.index});
 }
 if(profile.bones.length===0)add('no-bones','error');
 for(const bone of profile.bones){
  if(bone.parentIndex!==null&&!byIndex.has(bone.parentIndex))add('parent-node-missing','error',{nodeIndex:bone.index});
 }

 // Detect cycles independently of node order. A malformed hierarchy must not
 // make descendant checks loop forever.
 const visitState=new Map<number,0|1|2>();
 const visit=(index:number):boolean=>{
  const state=visitState.get(index)??0;
  if(state===1)return false;
  if(state===2)return true;
  visitState.set(index,1);
  const parent=byIndex.get(index)?.parentIndex;
  if(parent!==null&&parent!==undefined&&byIndex.has(parent)&&!visit(parent))return false;
  visitState.set(index,2);return true;
 };
 for(const index of byIndex.keys())if(!visit(index)){add('parent-cycle','error',{nodeIndex:index});break;}

 const seenNodes=new Map<number,string>();
 for(const [semantic,nodeIndex]of Object.entries(profile.humanoidBones)){
  if(!byIndex.has(nodeIndex)){add('humanoid-node-missing','error',{semantic,nodeIndex});continue;}
  const previous=seenNodes.get(nodeIndex);
  if(previous)add('duplicate-humanoid-node','error',{semantic,nodeIndex});
  else seenNodes.set(nodeIndex,semantic);
  if(!VRM_HUMANOID_REQUIRED_BONES.includes(semantic as VrmRequiredHumanoidBone)&&!Object.values(OPTIONAL_CAPABILITIES).some(group=>group.includes(semantic as never)))
   add('unknown-humanoid-semantic','warning',{semantic,nodeIndex});
 }
 const missingRequired=VRM_HUMANOID_REQUIRED_BONES.filter(semantic=>profile.humanoidBones[semantic]===undefined);
 for(const semantic of missingRequired){
  const severity=profile.mappingSource==='none'?'warning':'error';
  add('missing-required-bone',severity,{semantic});
 }

 const isDescendant=(childSemantic:string,parentSemantic:string)=>{
  let index=profile.humanoidBones[childSemantic];
  const ancestor=profile.humanoidBones[parentSemantic];
  if(index===undefined||ancestor===undefined)return true; // Missing-bone issue is more useful.
  const seen=new Set<number>();
  while(index!==undefined&&!seen.has(index)){
   if(index===ancestor)return true;
   seen.add(index);
   const parent=byIndex.get(index)?.parentIndex;
   if(parent===null||parent===undefined)return false;
   index=parent;
  }
  return false;
 };
 for(const [child,parent]of REQUIRED_HIERARCHY)if(!isDescendant(child,parent))add('invalid-humanoid-hierarchy','error',{semantic:child,nodeIndex:profile.humanoidBones[child]});
 const checkOrderedChain=(chain:readonly string[])=>{
  const mapped=chain.filter(semantic=>profile.humanoidBones[semantic]!==undefined);
  for(let index=1;index<mapped.length;index++){
   const child=mapped[index],parent=mapped[index-1];
   if(!isDescendant(child,parent))add('invalid-humanoid-hierarchy','error',{semantic:child,nodeIndex:profile.humanoidBones[child]});
  }
 };
 checkOrderedChain(['hips','spine','chest','upperChest','neck','head']);
 const torsoAnchor=profile.humanoidBones.upperChest!==undefined?'upperChest':profile.humanoidBones.chest!==undefined?'chest':'spine';
 for(const side of ['left','right'] as const){
  const shoulder=`${side}Shoulder`,upperArm=`${side}UpperArm`,lowerArm=`${side}LowerArm`,hand=`${side}Hand`;
  checkOrderedChain([torsoAnchor,...(profile.humanoidBones[shoulder]!==undefined?[shoulder]:[]),upperArm,lowerArm,hand]);
  checkOrderedChain([`${side}Foot`,`${side}Toes`]);
 }
 for(const chain of FINGER_CHAINS){
  const side=chain[0].startsWith('left')?'left':'right';
  checkOrderedChain([`${side}Hand`,...chain]);
 }
 if(profile.humanoidBones.upperChest!==undefined&&profile.humanoidBones.chest===undefined)add('invalid-humanoid-hierarchy','error',{semantic:'upperChest'});

 if(profile.skins.length===0)add('no-skinned-mesh','error');
 const allSkinJoints=new Set<number>();
 for(const skin of profile.skins){
  const uniqueJoints=new Set(skin.jointNodeIndices);
  if(!byIndex.has(skin.meshNode)||skin.jointNodeIndices.length===0||uniqueJoints.size!==skin.jointNodeIndices.length||skin.jointNodeIndices.some(index=>!byIndex.has(index)))
   add('invalid-skin-joints','error',{meshNode:skin.meshNode});
  skin.jointNodeIndices.forEach(index=>allSkinJoints.add(index));
  if(skin.inverseBindMatrixCount!==null&&skin.inverseBindMatrixCount!==skin.jointNodeIndices.length)add('inverse-bind-count-mismatch','error',{meshNode:skin.meshNode});
  if(skin.skinIndexCount===0||skin.skinWeightCount===0)add('skin-attributes-missing','error',{meshNode:skin.meshNode});
  if(skin.skinIndexItemSize!==4||skin.skinWeightItemSize!==4)add('skin-attribute-layout-invalid','error',{meshNode:skin.meshNode});
  if(skin.skinIndexCount!==skin.vertexCount||skin.skinWeightCount!==skin.vertexCount)add('skin-attribute-count-mismatch','error',{meshNode:skin.meshNode});
  if(skin.invalidJointIndices>0)add('invalid-skin-joint-index','error',{meshNode:skin.meshNode});
  if(skin.invalidWeightVertices>0)add('invalid-skin-weight','error',{meshNode:skin.meshNode});
  if(skin.bindPose==='mismatch')add('bind-pose-mismatch','error',{meshNode:skin.meshNode});
  if(skin.bindPose==='unverified')add('bind-pose-unverified','warning',{meshNode:skin.meshNode});
 }
 for(const semantic of VRM_HUMANOID_REQUIRED_BONES){
  const index=profile.humanoidBones[semantic];
  if(index!==undefined&&!allSkinJoints.has(index))add('required-bone-not-skinned','error',{semantic,nodeIndex:index});
 }

 const missingFingers=OPTIONAL_CAPABILITIES.fingers.some(semantic=>profile.humanoidBones[semantic]===undefined);
 if(missingFingers)add('optional-finger-bones-missing','warning');
 if(profile.assessment.restPose==='unverified')add('rest-pose-unverified','warning');
 if(profile.assessment.restPose==='other')add('rest-pose-unrecognized','warning');
 if(profile.assessment.sideMapping==='mismatch')add('side-mapping-mismatch','error');
 if(profile.assessment.sideMapping==='unverified')add('side-mapping-unverified','warning');
 if(profile.assessment.heightMeters===null||!Number.isFinite(profile.assessment.heightMeters)||profile.assessment.heightMeters<=0)add('height-unverified','warning');

 const hasErrors=issues.some(issue=>issue.severity==='error');
 const needsMapping=profile.mappingSource==='none'&&missingRequired.length>0;
 const hasWarnings=issues.some(issue=>issue.severity==='warning');
 const capabilities={
  fingers:OPTIONAL_CAPABILITIES.fingers.every(semantic=>profile.humanoidBones[semantic]!==undefined),
  toes:OPTIONAL_CAPABILITIES.toes.every(semantic=>profile.humanoidBones[semantic]!==undefined),
  shoulders:OPTIONAL_CAPABILITIES.shoulders.every(semantic=>profile.humanoidBones[semantic]!==undefined),
  chest:profile.humanoidBones.chest!==undefined,
  upperChest:profile.humanoidBones.upperChest!==undefined,
  neck:profile.humanoidBones.neck!==undefined,
 };
 return {status:hasErrors?'unsupported':needsMapping?'needs-mapping':hasWarnings?'warning':'supported',issues,capabilities};
}
