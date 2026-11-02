import {Matrix4,Object3D,Quaternion,SkinnedMesh,Vector3} from 'three';
import {validateCharacterRigProfile,type CharacterRigMappingSource,type CharacterRigProfile,type CharacterSkinBinding} from '@human3d/motion-core';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

export const MAX_CHARACTER_GLB_BYTES=64*1024*1024;
export const MAX_CHARACTER_GLTF_NODES=16_384;
export const MAX_CHARACTER_VERTICES=2_000_000;
export const MAX_CHARACTER_SKIN_JOINTS=8_192;
const MAX_CHARACTER_INDICES=MAX_CHARACTER_VERTICES*6;
const MAX_CHARACTER_ACCESSORS=131_072;
const MAX_CHARACTER_PRIMITIVES=65_536;
const MAX_CHARACTER_ACCESSOR_SCALARS=MAX_CHARACTER_VERTICES*32;
const GLB_MAGIC=0x46546c67,GLB_JSON_CHUNK=0x4e4f534a,GLB_BIN_CHUNK=0x004e4942;
const SKIN_WEIGHT_SUM_TOLERANCE=.02;
const BIND_POSE_MATRIX_TOLERANCE=.01;

interface RawGltfNode{name?:string;children?:number[];mesh?:number;skin?:number}
interface RawGltfSkin{joints?:number[];inverseBindMatrices?:number}
interface RawGltfBuffer{uri?:string}
interface RawGltfImage{uri?:string}
interface RawGltfAccessor{count?:number;componentType?:number;type?:string}
interface RawGltfPrimitive{attributes?:Record<string,number>;indices?:number;targets?:Record<string,number>[]}
interface RawGltfMesh{primitives?:RawGltfPrimitive[]}
interface RawGltfJson{
 asset?:{version?:string};
 extensionsUsed?:string[];
 extensions?:Record<string,unknown>;
 nodes?:RawGltfNode[];
 buffers?:RawGltfBuffer[];
 images?:RawGltfImage[];
 skins?:RawGltfSkin[];
 accessors?:RawGltfAccessor[];
 meshes?:RawGltfMesh[];
}
interface ParsedGltf{
 scene:Object3D;
 parser:{json:RawGltfJson;getDependency:(type:string,index:number)=>Promise<Object3D>};
}

export interface CharacterImportOptions{
 /** Explicit mappings are only used when the asset has no usable VRM extension. */
 manualMappings?:Record<string,number>;
 registryMappings?:Record<string,string>;
 sourceLicense?:string;
}
export interface ImportedCharacter{
 scene:Object3D;
 objectsByIndex:Object3D[];
 profile:CharacterRigProfile;
 validation:ReturnType<typeof validateCharacterRigProfile>;
}

function readGlbJson(buffer:ArrayBuffer):RawGltfJson{
 if(buffer.byteLength<20)throw new Error('GLB 文件过短。');
 const view=new DataView(buffer);
 if(view.getUint32(0,true)!==GLB_MAGIC)throw new Error('文件不是 GLB 2.0。');
 if(view.getUint32(4,true)!==2)throw new Error('只支持 glTF 2.0 二进制文件。');
 if(view.getUint32(8,true)!==buffer.byteLength)throw new Error('GLB 文件长度与头部声明不一致。');
 let offset=12,jsonText:string|undefined,chunkIndex=0,binSeen=false;
 while(offset<buffer.byteLength){
  if(offset+8>buffer.byteLength)throw new Error('GLB 数据块头部不完整。');
  const length=view.getUint32(offset,true),type=view.getUint32(offset+4,true),start=offset+8,end=start+length;
  if(length%4!==0)throw new Error('GLB 数据块长度必须按 4 字节对齐。');
  if(end>buffer.byteLength)throw new Error('GLB 数据块超出文件范围。');
  if(chunkIndex===0&&type!==GLB_JSON_CHUNK)throw new Error('GLB 第一个数据块必须是 JSON。');
  if(type===GLB_JSON_CHUNK){
   if(jsonText!==undefined||chunkIndex!==0)throw new Error('GLB 只能包含一个且位于首位的 JSON 数据块。');
   jsonText=new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(buffer,start,length)).trimEnd();
  }else if(type===GLB_BIN_CHUNK){
   if(binSeen||chunkIndex!==1)throw new Error('GLB BIN 数据块必须唯一且紧跟 JSON 数据块。');
   binSeen=true;
  }
  offset=end;chunkIndex++;
 }
 if(offset!==buffer.byteLength)throw new Error('GLB 数据块未覆盖整个文件。');
 if(!jsonText)throw new Error('GLB 缺少 JSON 数据块。');
 let json:unknown;
 try{json=JSON.parse(jsonText);}catch{throw new Error('GLB JSON 数据无效。');}
 if(!json||typeof json!=='object'||Array.isArray(json))throw new Error('GLB 根数据必须是对象。');
 return json as RawGltfJson;
}

function checkImportBudget(json:RawGltfJson,fileSize:number){
 if(fileSize>MAX_CHARACTER_GLB_BYTES)throw new Error(`角色文件超过 ${MAX_CHARACTER_GLB_BYTES/1024/1024} MiB 限制。`);
 if(json.asset?.version!=='2.0')throw new Error('GLB asset.version 必须为 2.0。');
 const externalUri=(uri:string|undefined)=>typeof uri==='string'&&!uri.toLowerCase().startsWith('data:');
 if((json.buffers??[]).some(buffer=>externalUri(buffer.uri))||(json.images??[]).some(image=>externalUri(image.uri)))
  throw new Error('角色 GLB 不能引用外部文件，只支持内嵌资源。');
 const nodes=json.nodes??[];
 if(nodes.length===0)throw new Error('GLB 没有节点。');
 if(nodes.length>MAX_CHARACTER_GLTF_NODES)throw new Error(`角色骨架节点超过 ${MAX_CHARACTER_GLTF_NODES} 个限制。`);
 const skins=json.skins??[];
 const jointCount=skins.reduce((sum,skin)=>sum+(skin.joints?.length??0),0);
 if(jointCount>MAX_CHARACTER_SKIN_JOINTS)throw new Error(`角色蒙皮关节超过 ${MAX_CHARACTER_SKIN_JOINTS} 个限制。`);
 const meshes=json.meshes??[],accessors=json.accessors??[];
 if(skins.length>MAX_CHARACTER_GLTF_NODES||meshes.length>MAX_CHARACTER_GLTF_NODES)throw new Error('角色 skin 或 mesh 数量超出限制。');
 if(accessors.length>MAX_CHARACTER_ACCESSORS)throw new Error(`角色 accessor 数量超过 ${MAX_CHARACTER_ACCESSORS.toLocaleString()} 个限制。`);
 const components:Record<string,number>={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};
 const componentTypes=new Set([5120,5121,5122,5123,5125,5126]);
 let accessorScalars=0;
 for(const accessor of accessors){
  const componentCount=accessor.type?components[accessor.type]:undefined,count=accessor.count;
  if(count===undefined||!Number.isSafeInteger(count)||count<1||componentCount===undefined||!componentTypes.has(accessor.componentType??-1))
   throw new Error('GLB accessor 布局无效。');
  const scalarCount=count*componentCount;
  if(!Number.isSafeInteger(scalarCount))throw new Error('GLB accessor 元素数量超出安全范围。');
  accessorScalars+=scalarCount;
  if(accessorScalars>MAX_CHARACTER_ACCESSOR_SCALARS)throw new Error('角色 accessor 解码数据超过资源限制。');
 }
 const getAccessor=(value:unknown):RawGltfAccessor=>{
  if(!Number.isInteger(value)||Number(value)<0||!accessors[Number(value)])throw new Error('GLB primitive 引用了无效 accessor。');
  return accessors[Number(value)];
 };
 for(const skin of skins){
  if(skin.inverseBindMatrices===undefined)continue;
  const accessor=getAccessor(skin.inverseBindMatrices);
  if((accessor.count??0)>MAX_CHARACTER_SKIN_JOINTS)throw new Error(`角色 inverse-bind 矩阵超过 ${MAX_CHARACTER_SKIN_JOINTS} 个限制。`);
 }
 let vertexCount=0,indexCount=0,primitiveCount=0;
 for(const mesh of meshes){
  for(const primitive of mesh.primitives??[]){
   if(++primitiveCount>MAX_CHARACTER_PRIMITIVES)throw new Error(`角色 mesh primitive 数量超过 ${MAX_CHARACTER_PRIMITIVES.toLocaleString()} 个限制。`);
   if(!record(primitive.attributes))throw new Error('GLB primitive 缺少有效 attributes。');
   const attributes=primitive.attributes;
   const positionId=attributes.POSITION;
   const positionCount=positionId===undefined?undefined:getAccessor(positionId).count;
   if(positionCount!==undefined){
    vertexCount+=positionCount;
    if(vertexCount>MAX_CHARACTER_VERTICES)throw new Error(`角色顶点超过 ${MAX_CHARACTER_VERTICES.toLocaleString()} 个限制。`);
   }
   const attributeIds=[...Object.values(attributes),...(primitive.targets??[]).flatMap(target=>record(target)?Object.values(target):[])];
   for(const accessorId of attributeIds){
    const count=getAccessor(accessorId).count;
    if(count!==undefined&&count>MAX_CHARACTER_VERTICES)throw new Error(`角色顶点属性超过 ${MAX_CHARACTER_VERTICES.toLocaleString()} 个限制。`);
    if(positionCount!==undefined&&count!==positionCount)throw new Error('GLB 顶点属性 accessor 数量与 POSITION 不一致。');
   }
   if(primitive.indices!==undefined){
    const accessor=getAccessor(primitive.indices);
    if(accessor.type!=='SCALAR')throw new Error('GLB primitive indices accessor 必须为 SCALAR。');
    indexCount+=accessor.count??0;
    if(indexCount>MAX_CHARACTER_INDICES)throw new Error(`角色索引数量超过 ${MAX_CHARACTER_INDICES.toLocaleString()} 个限制。`);
   }
  }
 }
}

function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function hashHex(bytes:ArrayBuffer){
 if(!globalThis.crypto?.subtle)throw new Error('角色校验需要 https 或 localhost 环境（crypto.subtle 不可用）。');
 return globalThis.crypto.subtle.digest('SHA-256',bytes).then(digest=>Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join(''));
}

function readVrmMappings(json:RawGltfJson,nodeCount:number){
 const extension=json.extensions?.VRMC_vrm;
 if(extension===undefined)return {state:'absent' as const,specVersion:undefined,mappings:{}};
 if(!json.extensionsUsed?.includes('VRMC_vrm')||!record(extension))return {state:'invalid' as const,specVersion:undefined,mappings:{}};
 const specVersion=typeof extension.specVersion==='string'?extension.specVersion:undefined;
 const humanoid=record(extension.humanoid)?extension.humanoid:undefined;
 const humanBones=humanoid&&record(humanoid.humanBones)?humanoid.humanBones:undefined;
 if(!specVersion||!humanBones)return {state:'invalid' as const,specVersion,mappings:{}};
 const mappings:Record<string,number>={};
 let invalid=false;
 for(const [semantic,value]of Object.entries(humanBones)){
  if(!record(value)||!Number.isInteger(value.node)||Number(value.node)<0||Number(value.node)>=nodeCount){invalid=true;continue;}
  mappings[semantic]=Number(value.node);
 }
 return {state:invalid?'invalid' as const:'verified' as const,specVersion,mappings};
}

interface NumericAttribute{
 itemSize:number;count:number;normalized:boolean;
 array?:ArrayLike<number>;offset?:number;data?:{array:ArrayLike<number>;stride:number};
}
function attrValue(attribute:NumericAttribute,vertex:number,component:number){
 const array=attribute.data?.array??attribute.array;
 if(!array)return Number.NaN;
 const stride=attribute.data?.stride??attribute.itemSize,offset=attribute.data?attribute.offset??0:0;
 const raw=Number(array[vertex*stride+offset+component]);
 if(!attribute.normalized)return raw;
 if(array instanceof Uint8Array||array instanceof Uint8ClampedArray)return raw/255;
 if(array instanceof Uint16Array)return raw/65535;
 if(array instanceof Int8Array)return Math.max(raw/127,-1);
 if(array instanceof Int16Array)return Math.max(raw/32767,-1);
 return raw;
}

function inspectSkinWeights(mesh:SkinnedMesh,jointCount:number){
 const skinIndex=mesh.geometry.getAttribute('skinIndex'),skinWeight=mesh.geometry.getAttribute('skinWeight');
 let invalidJointIndices=0,invalidWeightVertices=0;
 const count=Math.min(mesh.geometry.getAttribute('position')?.count??0,skinIndex?.count??0,skinWeight?.count??0);
 if(skinIndex&&skinWeight){
  for(let vertex=0;vertex<count;vertex++){
   for(let component=0;component<Math.min(4,skinIndex.itemSize);component++){
    const joint=attrValue(skinIndex,vertex,component);
    if(!Number.isInteger(joint)||joint<0||joint>=jointCount)invalidJointIndices++;
   }
   let sum=0,invalid=false;
   for(let component=0;component<Math.min(4,skinWeight.itemSize);component++){
    const weight=attrValue(skinWeight,vertex,component);
    if(!Number.isFinite(weight)||weight<0)invalid=true;
    sum+=weight;
   }
   if(invalid||sum<=0||Math.abs(sum-1)>SKIN_WEIGHT_SUM_TOLERANCE)invalidWeightVertices++;
  }
 }
 return {skinIndex,skinWeight,invalidJointIndices,invalidWeightVertices};
}

function bindPoseStatus(mesh:SkinnedMesh,inverseBindCount:number|null,jointCount:number):CharacterSkinBinding['bindPose']{
 if(inverseBindCount===null)return 'unverified';
 if(inverseBindCount!==jointCount||mesh.skeleton.bones.length!==jointCount||mesh.skeleton.boneInverses.length!==jointCount)return 'mismatch';
 const bindInverse=mesh.bindMatrix.clone().invert(),identity=new Matrix4();
 for(let index=0;index<jointCount;index++){
  const candidate=bindInverse.clone().multiply(mesh.skeleton.bones[index].matrixWorld)
   .multiply(mesh.skeleton.boneInverses[index]).multiply(mesh.bindMatrix);
  const elements=candidate.elements,expected=identity.elements;
  for(let element=0;element<16;element++)if(Math.abs(elements[element]-expected[element])>BIND_POSE_MATRIX_TOLERANCE)return 'mismatch';
 }
 return 'verified';
}

function assessRestPose(mappings:Record<string,number>,objects:Object3D[]):CharacterRigProfile['assessment']{
 const hipsIndex=mappings.hips,hipsObject=hipsIndex===undefined?undefined:objects[hipsIndex];
 if(hipsObject)hipsObject.updateWorldMatrix(true,false);
 const hipsPosition=hipsObject?.getWorldPosition(new Vector3());
 const hipsRotation=hipsObject?.getWorldQuaternion(new Quaternion()).invert();
 const point=(semantic:string):[number,number,number]|undefined=>{
  const index=mappings[semantic],object=index===undefined?undefined:objects[index];
  if(!object||!hipsPosition||!hipsRotation)return undefined;
  const local=object.getWorldPosition(new Vector3()).sub(hipsPosition).applyQuaternion(hipsRotation);
  return local.toArray() as [number,number,number];
 };
 const hips=hipsPosition?[0,0,0] as [number,number,number]:undefined;
 const head=point('head'),leftFoot=point('leftFoot'),rightFoot=point('rightFoot');
 const feet=[leftFoot,rightFoot].filter((value):value is [number,number,number]=>!!value);
 const height=hips&&head&&feet.length?Math.max(head[1],hips[1])-Math.min(...feet.map(foot=>foot[1])):null;
 const leftUpper=point('leftUpperArm'),leftLower=point('leftLowerArm'),rightUpper=point('rightUpperArm'),rightLower=point('rightLowerArm');
 let restPose:CharacterRigProfile['assessment']['restPose']='unverified';
 if(leftUpper&&leftLower&&rightUpper&&rightLower){
  const elevation=(a:number[],b:number[])=>Math.atan2(b[1]-a[1],Math.hypot(b[0]-a[0],b[2]-a[2]))*180/Math.PI;
  const left=elevation(leftUpper,leftLower),right=elevation(rightUpper,rightLower);
  const tPose=Math.abs(left)<=25&&Math.abs(right)<=25;
  const aPose=left>=-65&&left<=-10&&right>=-65&&right<=-10;
  restPose=tPose||aPose?'verified':'other';
 }
 let sideMapping:CharacterRigProfile['assessment']['sideMapping']='unverified';
 const leftLeg=point('leftUpperLeg'),rightLeg=point('rightUpperLeg');
 if(leftUpper&&rightUpper&&leftLeg&&rightLeg)
  sideMapping=leftUpper[0]>rightUpper[0]&&leftLeg[0]>rightLeg[0]?'verified':'mismatch';
 return {restPose,sideMapping,heightMeters:height};
}

/** Parse a local GLB/VRM file, preserve its content hash, and build a pure-data
 * profile. A .vrm suffix is recorded as provenance only; VRM status is based on
 * the actual VRMC_vrm extension and its humanoid mapping. */
export async function inspectCharacterFile(file:Blob&{name?:string},options:CharacterImportOptions={}):Promise<ImportedCharacter>{
 const name=file.name??'character.glb',extension=name.toLowerCase().slice(name.lastIndexOf('.'));
 if(extension!=='.glb'&&extension!=='.vrm')throw new Error('当前只支持单文件 GLB/VRM 角色资产。');
 if(file.size>MAX_CHARACTER_GLB_BYTES)throw new Error(`角色文件超过 ${MAX_CHARACTER_GLB_BYTES/1024/1024} MiB 限制。`);
 const bytes=await file.arrayBuffer();
 if(bytes.byteLength!==file.size)throw new Error('读取角色文件时长度发生变化。');
 const json=readGlbJson(bytes);checkImportBudget(json,file.size);
 const digest=await hashHex(bytes);
 const loaded=await new GLTFLoader().parseAsync(bytes,'') as unknown as ParsedGltf;
 const raw=loaded.parser.json;
 const rawNodes=raw.nodes??[];
 if(rawNodes.length!==json.nodes?.length)throw new Error('GLB 节点数量在解析前后不一致。');
 loaded.scene.updateMatrixWorld(true);
 const objects=await Promise.all(rawNodes.map((_,index)=>loaded.parser.getDependency('node',index)));
 const parentByIndex=new Map<number,number>();
 rawNodes.forEach((node,parent)=>node.children?.forEach(child=>{if(!parentByIndex.has(child))parentByIndex.set(child,parent);}));
 const allJointIndices=new Set<number>();
 for(const skin of raw.skins??[])for(const joint of skin.joints??[])allJointIndices.add(joint);
 const bones:CharacterRigProfile['bones']=rawNodes.map((rawNode,index)=>{
  const object=objects[index];object.updateWorldMatrix(true,false);
  const world=object.getWorldPosition(new Vector3()),parentIndex=parentByIndex.get(index)??null;
  const parentDistanceMeters=parentIndex===null?null:world.distanceTo(objects[parentIndex].getWorldPosition(new Vector3()));
  return {index,name:rawNode.name??object.name??`node-${index}`,parentIndex,
   translation:object.position.toArray() as [number,number,number],rotation:object.quaternion.toArray() as [number,number,number,number],
   scale:object.scale.toArray() as [number,number,number],worldPosition:world.toArray() as [number,number,number],parentDistanceMeters,skinJoint:allJointIndices.has(index)};
 });
 const vrm=readVrmMappings(json,rawNodes.length);
 let humanoidBones:Record<string,number>=vrm.mappings,mappingSource:CharacterRigMappingSource=vrm.state==='verified'?'vrm':'none';
 if(vrm.state==='absent'&&options.manualMappings){humanoidBones=options.manualMappings;mappingSource='manual';}
 else if(vrm.state==='absent'&&options.registryMappings){
  const byName=new Map<string,number[]>();
  rawNodes.forEach((node,index)=>{if(node.name){const list=byName.get(node.name)??[];list.push(index);byName.set(node.name,list);}});
  humanoidBones={};
  for(const [semantic,name]of Object.entries(options.registryMappings)){
   const found=byName.get(name);if(found?.length===1)humanoidBones[semantic]=found[0];
  }
  mappingSource='registry';
 }
 if(vrm.state==='absent'&&Object.keys(humanoidBones).length===0)mappingSource='none';
 const skins:CharacterSkinBinding[]=[];
 for(let meshNode=0;meshNode<rawNodes.length;meshNode++){
  const skinIndex=rawNodes[meshNode].skin;
  if(skinIndex===undefined)continue;
  const skin=raw.skins?.[skinIndex],jointNodeIndices=skin?.joints??[];
  const inverseAccessor=skin?.inverseBindMatrices;
  const inverseBindMatrixCount=inverseAccessor===undefined?null:raw.accessors?.[inverseAccessor]?.count??null;
  const nodeObject=objects[meshNode],skinnedMeshes:SkinnedMesh[]=[];
  if((nodeObject as SkinnedMesh).isSkinnedMesh)skinnedMeshes.push(nodeObject as SkinnedMesh);
  else nodeObject.traverse(child=>{if((child as SkinnedMesh).isSkinnedMesh)skinnedMeshes.push(child as SkinnedMesh);});
  if(skin&&skinnedMeshes.length===0){
   skins.push({meshNode,jointNodeIndices,inverseBindMatrixCount,vertexCount:0,skinIndexCount:0,skinIndexItemSize:0,skinWeightCount:0,skinWeightItemSize:0,invalidJointIndices:0,invalidWeightVertices:0,bindPose:'unverified'});
   continue;
  }
  for(const mesh of skinnedMeshes){
   const {skinIndex:indices,skinWeight:weights,invalidJointIndices,invalidWeightVertices}=inspectSkinWeights(mesh,jointNodeIndices.length);
   const vertexCount=mesh.geometry.getAttribute('position')?.count??0;
   skins.push({meshNode,jointNodeIndices,inverseBindMatrixCount,vertexCount,skinIndexCount:indices?.count??0,skinIndexItemSize:indices?.itemSize??0,
    skinWeightCount:weights?.count??0,skinWeightItemSize:weights?.itemSize??0,invalidJointIndices,invalidWeightVertices,
    bindPose:bindPoseStatus(mesh,inverseBindMatrixCount,jointNodeIndices.length)});
  }
 }
 const profile:CharacterRigProfile={
  schemaVersion:1,source:{format:extension==='.vrm'?'vrm':'glb',sha256:digest,...(options.sourceLicense?{license:options.sourceLicense}:{})},
  coordinateSystem:{handedness:'right',upAxis:'Y',unit:'meter'},
  vrm:{state:vrm.state,...(vrm.specVersion?{specVersion:vrm.specVersion}:{})},mappingSource,humanoidBones,bones,skins,
  assessment:assessRestPose(humanoidBones,objects),
 };
 return {scene:loaded.scene,objectsByIndex:objects,profile,validation:validateCharacterRigProfile(profile)};
}
