import {Euler,MathUtils,Object3D,Quaternion,Vector3} from 'three';
import type {EffectiveFrame,PoseParams,V3} from './document';
import {VRM_SEMANTIC_MAP} from './semantic-map';
import {footRotation} from './foot';
import type {HumanRig} from './rig';
import {validateCharacterRigProfile,type CharacterRigProfile,type CharacterRigValidation} from './character-rig';

type RetargetEndpoint='leftHand'|'rightHand'|'leftFoot'|'rightFoot';

interface RestTransform{position:Vector3;rotation:Quaternion;scale:Vector3}

export interface CharacterRigAdapterReport{
 frame:EffectiveFrame;
 heightScale:number;
 mappedSemantics:string[];
 validation:CharacterRigValidation;
 endpointResidualMeters:Record<RetargetEndpoint,number>;
}

const DRIVEN_OPTIONAL_SEMANTICS=['chest','upperChest','neck','leftShoulder','rightShoulder'] as const;
const LIMB_SEMANTICS=new Set(['leftUpperArm','leftLowerArm','rightUpperArm','rightLowerArm','leftUpperLeg','leftLowerLeg','leftFoot','rightUpperLeg','rightLowerLeg','rightFoot']);
const ENDPOINT_SOURCE_BONES:Record<RetargetEndpoint,string>={leftHand:'wrist_L',rightHand:'wrist_R',leftFoot:'foot_L',rightFoot:'foot_R'};

function vector(value:V3):Vector3{return new Vector3(value.x,value.y,value.z)}
function pointValue(value:V3,origin:Vector3,targetOrigin:Vector3,basis:Quaternion,scale:number):V3{
 const mapped=vector(value).sub(origin).multiplyScalar(scale).applyQuaternion(basis).add(targetOrigin);
 return {x:mapped.x,y:mapped.y,z:mapped.z};
}
function directionValue(value:V3,basis:Quaternion,scale=1):V3{
 const mapped=vector(value).multiplyScalar(scale).applyQuaternion(basis);
 return {x:mapped.x,y:mapped.y,z:mapped.z};
}
function footAngles(yaw:number,pitch:number,basis:Quaternion){
 const rotation=basis.clone().multiply(footRotation(yaw,pitch));
 const euler=new Euler().setFromQuaternion(rotation,'YXZ');
 if(Math.abs(euler.z)>1e-6)throw new Error('目标 hips rest 朝向含 roll，当前适配器无法编码为 foot yaw/pitch。');
 return {yaw:MathUtils.radToDeg(euler.y),pitch:MathUtils.radToDeg(euler.x)};
}

function sourceBoneForSemantic(profile:CharacterRigProfile,semantic:string):string|undefined{
 if(semantic==='hips')return 'root';
 if(semantic==='spine')return profile.humanoidBones.chest===undefined?'spine01':'spine05';
 if(semantic==='chest')return profile.humanoidBones.upperChest===undefined?'spine01':'spine03';
 if(semantic==='upperChest')return 'spine01';
 if(semantic==='neck')return 'neck02';
 if(semantic==='leftShoulder')return 'shoulder01_L';
 if(semantic==='rightShoulder')return 'shoulder01_R';
 if(semantic==='leftLowerArm')return 'lowerarm02_L';
 if(semantic==='rightLowerArm')return 'lowerarm02_R';
 if(LIMB_SEMANTICS.has(semantic))return VRM_SEMANTIC_MAP[semantic];
 if(semantic==='leftHand')return 'wrist_L';
 if(semantic==='rightHand')return 'wrist_R';
 if(semantic==='head')return 'head';
 return undefined;
}

/** Applies a canonical MakeHuman solve to a validated target hierarchy.
 * Rotations transfer as world-space deltas from the canonical identity rest
 * pose onto each target bone's captured rest orientation. Target local axes,
 * intermediate nodes, and segment lengths remain owned by the target rig. */
export class CharacterRigAdapter{
 readonly validation:CharacterRigValidation;
 readonly mappedSemantics:string[];
 private readonly restLocal=new Map<number,RestTransform>();
 private readonly restWorldPosition=new Map<number,Vector3>();
 private readonly restWorldRotation=new Map<number,Quaternion>();
 private readonly byIndex=new Map<number,CharacterRigProfile['bones'][number]>();
 private readonly nodeSemantic=new Map<number,string>();
 private readonly nodeDepth=new Map<number,number>();
 private readonly orderedBones:CharacterRigProfile['bones'];
 private readonly sourceRestRoot:Vector3;
 private readonly targetRestRootPosition:Vector3;
 private readonly targetRestRootRotation:Quaternion;
 private readonly basisInverse:Quaternion;
 private readonly hipsIndex:number;
 private readonly sourceBonesBySemantic=new Map<string,string>();

 constructor(
  readonly targetRoot:Object3D,
  readonly profile:CharacterRigProfile,
  readonly objectsByIndex:readonly Object3D[],
  sourceRest:ReadonlyMap<string,Vector3>,
 ){
  this.validation=validateCharacterRigProfile(profile);
  if(this.validation.status==='unsupported'||this.validation.status==='needs-mapping')
   throw new Error(`目标角色档案不可适配：${this.validation.issues.map(issue=>issue.code).join(', ')}`);
  const targetHeight=profile.assessment.heightMeters;
  if(targetHeight===null||!Number.isFinite(targetHeight)||targetHeight<=0)throw new Error('目标角色缺少有效身高，无法缩放根位移和任务点。');
  const sourceRoot=sourceRest.get('root');
  if(!sourceRoot)throw new Error('源骨架缺少 root rest position。');
  this.sourceRestRoot=sourceRoot.clone();
  this.hipsIndex=profile.humanoidBones.hips;
  if(!Number.isInteger(this.hipsIndex))throw new Error('目标角色缺少 hips 映射。');
  if(objectsByIndex.length!==profile.bones.length)throw new Error('目标骨架 Object3D 数量与 profile 不一致。');

  profile.bones.forEach(bone=>this.byIndex.set(bone.index,bone));
  for(const [semantic,index]of Object.entries(profile.humanoidBones))this.nodeSemantic.set(index,semantic);
  this.mappedSemantics=[];
  for(const semantic of [...Object.keys(profile.humanoidBones)].filter(name=>DRIVEN_OPTIONAL_SEMANTICS.includes(name as typeof DRIVEN_OPTIONAL_SEMANTICS[number])||LIMB_SEMANTICS.has(name)||name==='hips'||name==='head'||name==='leftHand'||name==='rightHand')){
   const sourceBone=sourceBoneForSemantic(profile,semantic);
   if(sourceBone){this.sourceBonesBySemantic.set(semantic,sourceBone);this.mappedSemantics.push(semantic);}
  }
  if(!this.sourceBonesBySemantic.has('hips'))throw new Error('目标 hips 没有 canonical source mapping。');

  targetRoot.updateMatrixWorld(true);
  for(const bone of profile.bones){
   const object=objectsByIndex[bone.index];
   if(!object)throw new Error(`目标角色缺少节点 ${bone.index}。`);
   this.restLocal.set(bone.index,{position:object.position.clone(),rotation:object.quaternion.clone(),scale:object.scale.clone()});
   this.restWorldPosition.set(bone.index,object.getWorldPosition(new Vector3()));
   this.restWorldRotation.set(bone.index,object.getWorldQuaternion(new Quaternion()));
  }
  const targetRestRootPosition=this.restWorldPosition.get(this.hipsIndex),targetRestRootRotation=this.restWorldRotation.get(this.hipsIndex);
  if(!targetRestRootPosition||!targetRestRootRotation)throw new Error('目标 hips rest transform 无效。');
  this.targetRestRootPosition=targetRestRootPosition.clone();
  this.targetRestRootRotation=targetRestRootRotation.clone();
  // The canonical source rest frame is identity by HumanRig.reset() and the
  // existing MakeHuman rig-manifest contract. This basis preserves a target
  // asset's native facing direction while mapping all source world deltas.
  this.basisInverse=this.targetRestRootRotation.clone().invert();
  this.orderedBones=[...profile.bones].sort((a,b)=>this.depth(a.index)-this.depth(b.index));
 }

 /** Restore every indexed node to the imported asset's local rest TRS. */
 reset(){
  for(const [index,rest]of this.restLocal){
   const object=this.objectsByIndex[index];
   object.position.copy(rest.position);object.quaternion.copy(rest.rotation);object.scale.copy(rest.scale);
  }
  this.targetRoot.updateMatrixWorld(true);
 }

 /** Apply one already-solved source frame. The returned frame carries target-
  * scaled world tasks; its scalar joint angles remain rest-relative semantic
  * controls for a target-space constraint solver. */
 applyFromSourceRig(sourceRig:HumanRig,frame:EffectiveFrame):CharacterRigAdapterReport{
  const sourceHeight=sourceRig.info.height,targetHeight=this.profile.assessment.heightMeters;
  if(!Number.isFinite(sourceHeight)||sourceHeight<=0||targetHeight===null||targetHeight<=0)throw new Error('源或目标骨架身高无效。');
  sourceRig.syncWorld();
  this.reset();
  const heightScale=targetHeight/sourceHeight;
  const basis=this.targetRestRootRotation;
  const targetHips=this.objectsByIndex[this.hipsIndex];
  const sourceRootPosition=sourceRig.point('root'),sourceRootRest=this.sourceRestRoot;
  const rootDelta=sourceRootPosition.sub(sourceRootRest).multiplyScalar(heightScale).applyQuaternion(basis);
  const desiredRootPosition=this.targetRestRootPosition.clone().add(rootDelta);
  if(targetHips.parent)targetHips.parent.worldToLocal(desiredRootPosition);
  targetHips.position.copy(desiredRootPosition);
  targetHips.updateWorldMatrix(false,false);

  for(const bone of this.orderedBones){
   const semantic=this.nodeSemantic.get(bone.index),sourceName=semantic?this.sourceBonesBySemantic.get(semantic):undefined;
   if(!semantic||!sourceName)continue;
   const target=this.objectsByIndex[bone.index],restWorld=this.restWorldRotation.get(bone.index);
   if(!restWorld)continue;
   const sourceWorld=sourceRig.bone(sourceName).getWorldQuaternion(new Quaternion());
   const mappedDelta=basis.clone().multiply(sourceWorld).multiply(this.basisInverse);
   const desiredWorld=mappedDelta.multiply(restWorld);
   const parentWorld=target.parent?.getWorldQuaternion(new Quaternion())??new Quaternion();
   target.quaternion.copy(parentWorld.invert().multiply(desiredWorld));
   target.updateWorldMatrix(false,false);
  }
  this.targetRoot.updateMatrixWorld(true);

  const mapPoint=(value:V3)=>pointValue(value,this.sourceRestRoot,this.targetRestRootPosition,basis,heightScale);
  const mapDirection=(value:V3)=>directionValue(value,basis);
  const pose:PoseParams={
   ...frame.pose,
   root:{...directionValue(frame.pose.root,basis,heightScale)},
   handL:{...frame.pose.handL,target:mapPoint(frame.pose.handL.target),pole:mapPoint(frame.pose.handL.pole),forward:mapDirection(frame.pose.handL.forward),normal:mapDirection(frame.pose.handL.normal)},
   handR:{...frame.pose.handR,target:mapPoint(frame.pose.handR.target),pole:mapPoint(frame.pose.handR.pole),forward:mapDirection(frame.pose.handR.forward),normal:mapDirection(frame.pose.handR.normal)},
   footL:{...frame.pose.footL,target:mapPoint(frame.pose.footL.target),pole:mapPoint(frame.pose.footL.pole),...footAngles(frame.pose.footL.yaw,frame.pose.footL.pitch,basis)},
   footR:{...frame.pose.footR,target:mapPoint(frame.pose.footR.target),pole:mapPoint(frame.pose.footR.pole),...footAngles(frame.pose.footR.yaw,frame.pose.footR.pitch,basis)},
  };
  const endpointResidualMeters={} as Record<RetargetEndpoint,number>;
  for(const endpoint of Object.keys(ENDPOINT_SOURCE_BONES) as RetargetEndpoint[]){
   const targetIndex=this.profile.humanoidBones[endpoint],targetNode=this.objectsByIndex[targetIndex];
   const sourcePoint=sourceRig.point(ENDPOINT_SOURCE_BONES[endpoint]);
   const expected=pointValue({x:sourcePoint.x,y:sourcePoint.y,z:sourcePoint.z},sourceRootRest,this.targetRestRootPosition,basis,heightScale);
   const actual=targetNode.getWorldPosition(new Vector3());
   endpointResidualMeters[endpoint]=actual.distanceTo(vector(expected));
  }
  return {frame:{...frame,pose},heightScale,mappedSemantics:[...this.mappedSemantics],validation:this.validation,endpointResidualMeters};
 }

 private depth(index:number):number{
  const cached=this.nodeDepth.get(index);if(cached!==undefined)return cached;
  const path:number[]=[];let current=index;
  while(!this.nodeDepth.has(current)){
   path.push(current);
   const parent=this.byIndex.get(current)?.parentIndex;
   if(parent===null||parent===undefined){this.nodeDepth.set(current,0);break;}
   current=parent;
  }
  while(path.length){
   const node=path.pop()!;
   if(this.nodeDepth.has(node))continue;
   const parent=this.byIndex.get(node)?.parentIndex;
   this.nodeDepth.set(node,parent===null||parent===undefined?0:(this.nodeDepth.get(parent)??0)+1);
  }
  return this.nodeDepth.get(index)??0;
 }
}
