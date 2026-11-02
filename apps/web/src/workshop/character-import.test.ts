import {describe,it,expect} from 'vitest';
import {VRM_HUMANOID_REQUIRED_BONES} from '@human3d/motion-core';
import {inspectCharacterFile,MAX_CHARACTER_GLB_BYTES,MAX_CHARACTER_VERTICES} from './character-import';

type HumanoidSemantic=(typeof VRM_HUMANOID_REQUIRED_BONES)[number];
const parent:Record<HumanoidSemantic,HumanoidSemantic|null>={
 hips:null,spine:'hips',head:'spine',
 leftUpperLeg:'hips',leftLowerLeg:'leftUpperLeg',leftFoot:'leftLowerLeg',
 rightUpperLeg:'hips',rightLowerLeg:'rightUpperLeg',rightFoot:'rightLowerLeg',
 leftUpperArm:'spine',leftLowerArm:'leftUpperArm',leftHand:'leftLowerArm',
 rightUpperArm:'spine',rightLowerArm:'rightUpperArm',rightHand:'rightLowerArm',
};
interface TestGltf{
 asset:{version:string};scene:number;scenes:{nodes:number[]}[];
 nodes:{name:string;translation:number[];children?:number[];mesh?:number;skin?:number}[];
 extensionsUsed?:string[];extensions?:Record<string,unknown>;
 buffers?:{byteLength:number;uri?:string}[];
 bufferViews?:{buffer:number;byteOffset:number;byteLength:number;target?:number}[];
 accessors?:{bufferView:number;componentType:number;count:number;type:string}[];
 meshes?:{primitives:{attributes:Record<string,number>;indices?:number}[]}[];
 skins?:{joints:number[];skeleton:number;inverseBindMatrices:number}[];
}
const localPosition:Record<HumanoidSemantic,number[]>={
 hips:[0,0,0],spine:[0,.5,0],head:[0,.7,0],
 leftUpperLeg:[.1,-.1,0],leftLowerLeg:[0,-.4,0],leftFoot:[0,-.4,0],
 rightUpperLeg:[-.1,-.1,0],rightLowerLeg:[0,-.4,0],rightFoot:[0,-.4,0],
 leftUpperArm:[.2,.35,0],leftLowerArm:[.3,0,0],leftHand:[.3,0,0],
 rightUpperArm:[-.2,.35,0],rightLowerArm:[-.3,0,0],rightHand:[-.3,0,0],
};
function glbJson(withVrm:boolean,withSkin=false):TestGltf{
 const semantics=[...VRM_HUMANOID_REQUIRED_BONES];
 const indexOf=new Map(semantics.map((semantic,index)=>[semantic,index]));
 const nodes:TestGltf['nodes']=semantics.map(semantic=>({name:semantic,translation:localPosition[semantic]}));
 semantics.forEach((semantic,index)=>{
  const parentName=parent[semantic];
  if(parentName===null)return;
  const owner=nodes[indexOf.get(parentName)!];
  owner.children=[...(owner.children??[]),index];
 });
 const sceneNodes=[indexOf.get('hips')!];
 const humanBones=Object.fromEntries(semantics.map((semantic,index)=>[semantic,{node:index}]));
 const json:TestGltf={asset:{version:'2.0'},scene:0,scenes:[{nodes:sceneNodes}],nodes};
 if(withVrm){json.extensionsUsed=['VRMC_vrm'];json.extensions={VRMC_vrm:{specVersion:'1.0',humanoid:{humanBones}}};}
 if(withSkin){
  const meshNode=nodes.length;nodes.push({name:'skinnedMesh',translation:[0,0,0],mesh:0,skin:0});sceneNodes.push(meshNode);
  json.buffers=[{byteLength:1056}];
  json.bufferViews=[
   {buffer:0,byteOffset:0,byteLength:36,target:34962},
   {buffer:0,byteOffset:36,byteLength:12,target:34962},
   {buffer:0,byteOffset:48,byteLength:48,target:34962},
   {buffer:0,byteOffset:96,byteLength:960},
  ];
  json.accessors=[
   {bufferView:0,componentType:5126,count:3,type:'VEC3'},
   {bufferView:1,componentType:5121,count:3,type:'VEC4'},
   {bufferView:2,componentType:5126,count:3,type:'VEC4'},
   {bufferView:3,componentType:5126,count:semantics.length,type:'MAT4'},
  ];
  json.meshes=[{primitives:[{attributes:{POSITION:0,JOINTS_0:1,WEIGHTS_0:2}}]}];
  json.skins=[{joints:semantics.map((_,index)=>index),skeleton:indexOf.get('hips')!,inverseBindMatrices:3}];
 }
 return json;
}
function skinBinary(){
 const buffer=new ArrayBuffer(1056),view=new DataView(buffer);
 const positions=[0,0,0,.1,0,0,0,.1,0];
 positions.forEach((value,index)=>view.setFloat32(index*4,value,true));
 for(let vertex=0;vertex<3;vertex++)view.setFloat32(48+vertex*16,1,true);
 const worldPosition=(semantic:HumanoidSemantic):number[]=>{
  const parentName=parent[semantic],local=localPosition[semantic];
  if(parentName===null)return [...local];
  return worldPosition(parentName).map((value,index)=>value+local[index]);
 };
 VRM_HUMANOID_REQUIRED_BONES.forEach((semantic,index)=>{
  const [x,y,z]=worldPosition(semantic),offset=96+index*64;
  view.setFloat32(offset,1,true);view.setFloat32(offset+20,1,true);view.setFloat32(offset+40,1,true);view.setFloat32(offset+60,1,true);
  view.setFloat32(offset+48,-x,true);view.setFloat32(offset+52,-y,true);view.setFloat32(offset+56,-z,true);
 });
 return buffer;
}
function encodeGlb(json:unknown,binary?:ArrayBuffer){
 const text=new TextEncoder().encode(JSON.stringify(json));
 const jsonLength=(text.length+3)&~3,binLength=binary?(binary.byteLength+3)&~3:0;
 const total=12+8+jsonLength+(binary?8+binLength:0),buffer=new ArrayBuffer(total),view=new DataView(buffer),bytes=new Uint8Array(buffer);
 view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,total,true);
 view.setUint32(12,jsonLength,true);view.setUint32(16,0x4e4f534a,true);bytes.set(text,20);bytes.fill(0x20,20+text.length,20+jsonLength);
 if(binary){const start=20+jsonLength;view.setUint32(start,binLength,true);view.setUint32(start+4,0x004e4942,true);bytes.set(new Uint8Array(binary),start+8);}
 return buffer;
}
function appendChunk(source:ArrayBuffer,type:number,text:string){
 const data=new TextEncoder().encode(text),chunkLength=(data.length+3)&~3,total=source.byteLength+8+chunkLength;
 const buffer=new ArrayBuffer(total),bytes=new Uint8Array(buffer),view=new DataView(buffer);
 bytes.set(new Uint8Array(source));view.setUint32(8,total,true);view.setUint32(source.byteLength,chunkLength,true);view.setUint32(source.byteLength+4,type,true);
 bytes.set(data,source.byteLength+8);bytes.fill(type===0x4e4f534a?0x20:0,source.byteLength+8+data.length,total);
 return buffer;
}
function fileFrom(buffer:ArrayBuffer,name='character.glb'){
 return {name,size:buffer.byteLength,arrayBuffer:async()=>buffer} as Blob&{name:string};
}

describe('local GLB character inspection',()=>{
 it('recognizes a true VRM extension from payload metadata, not from bone names',async()=>{
  const result=await inspectCharacterFile(fileFrom(encodeGlb(glbJson(true))));
  expect(result.profile.vrm).toEqual({state:'verified',specVersion:'1.0'});
  expect(result.profile.mappingSource).toBe('vrm');
  expect(Object.keys(result.profile.humanoidBones)).toHaveLength(VRM_HUMANOID_REQUIRED_BONES.length);
  expect(result.profile.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result.validation.status).toBe('unsupported'); // metadata is valid, but this fixture has no skin.
  expect(result.validation.issues.map(issue=>issue.code)).toContain('no-skinned-mesh');
 });

 it('extracts skin weights, bind pose, body height and side mapping through GLTFLoader',async()=>{
  const result=await inspectCharacterFile(fileFrom(encodeGlb(glbJson(true,true),skinBinary())));
  expect(result.profile.skins).toHaveLength(1);
  expect(result.profile.skins[0]).toMatchObject({vertexCount:3,skinIndexCount:3,skinIndexItemSize:4,skinWeightCount:3,skinWeightItemSize:4,invalidJointIndices:0,invalidWeightVertices:0,bindPose:'verified'});
  expect(result.profile.assessment).toMatchObject({restPose:'verified',sideMapping:'verified'});
  expect(result.profile.assessment.heightMeters).toBeCloseTo(2.1,5);
  expect(result.validation.status).toBe('warning'); // The fixture omits optional finger bones.
 });

 it('does not infer a VRM contract from humanoid-looking node names',async()=>{
  const result=await inspectCharacterFile(fileFrom(encodeGlb(glbJson(false)),'tripo-vrm-named.glb'));
  expect(result.profile.vrm.state).toBe('absent');
  expect(result.profile.mappingSource).toBe('none');
  expect(result.validation.issues.map(issue=>issue.code)).toContain('manual-mapping-required');
 });

 it('keeps an unmatched registry lookup in the needs-mapping state',async()=>{
  const result=await inspectCharacterFile(fileFrom(encodeGlb(glbJson(false,true),skinBinary())),{registryMappings:{hips:'missing-node'}});
  expect(result.profile.mappingSource).toBe('none');
  expect(result.validation.status).toBe('needs-mapping');
 });

 it('rejects oversized assets before reading or parsing them',async()=>{
  let read=false;
  const oversized={name:'oversized.glb',size:MAX_CHARACTER_GLB_BYTES+1,arrayBuffer:async()=>{read=true;return new ArrayBuffer(0);}} as unknown as Blob&{name:string};
  await expect(inspectCharacterFile(oversized)).rejects.toThrow('超过');
  expect(read).toBe(false);
 });

 it('rejects external GLB resource URIs instead of fetching them',async()=>{
  const json=glbJson(false) as TestGltf;
  json.buffers=[{byteLength:4,uri:'https://example.invalid/mesh.bin'}];
  await expect(inspectCharacterFile(fileFrom(encodeGlb(json)))).rejects.toThrow('不能引用外部文件');
 });

 it('rejects oversized accessors and index streams before invoking GLTFLoader',async()=>{
  const geometry=glbJson(false) as TestGltf;
  geometry.accessors=[
   {bufferView:0,componentType:5126,count:3,type:'VEC3'},
   {bufferView:0,componentType:5123,count:MAX_CHARACTER_VERTICES+1,type:'VEC4'},
  ];
  geometry.meshes=[{primitives:[{attributes:{POSITION:0,JOINTS_0:1}}]}];
  await expect(inspectCharacterFile(fileFrom(encodeGlb(geometry)))).rejects.toThrow('顶点属性');

  const indices=glbJson(false) as TestGltf;
  indices.accessors=[
   {bufferView:0,componentType:5126,count:3,type:'VEC3'},
   {bufferView:0,componentType:5125,count:MAX_CHARACTER_VERTICES*6+1,type:'SCALAR'},
  ];
  indices.meshes=[{primitives:[{attributes:{POSITION:0},indices:1}]}];
  await expect(inspectCharacterFile(fileFrom(encodeGlb(indices)))).rejects.toThrow('索引数量');
 });

 it('rejects unaligned chunks and duplicate JSON chunks',async()=>{
  const unaligned=encodeGlb(glbJson(false)),unalignedView=new DataView(unaligned);
  unalignedView.setUint32(12,unalignedView.getUint32(12,true)-1,true);
  await expect(inspectCharacterFile(fileFrom(unaligned))).rejects.toThrow('4 字节对齐');
  const duplicate=appendChunk(encodeGlb(glbJson(false)),0x4e4f534a,'{}');
  await expect(inspectCharacterFile(fileFrom(duplicate))).rejects.toThrow('只能包含一个');
 });

 it('rejects non-GLB and malformed VRM extension payloads',async()=>{
  const notGlb={name:'not-glb.glb',size:8,arrayBuffer:async()=>new ArrayBuffer(8)} as Blob&{name:string};
  await expect(inspectCharacterFile(notGlb)).rejects.toThrow('GLB');
  const json=glbJson(true) as ReturnType<typeof glbJson>;
  json.extensions!.VRMC_vrm={specVersion:'1.0',humanoid:{humanBones:{hips:{node:999}}}};
  const result=await inspectCharacterFile(fileFrom(encodeGlb(json)));
  expect(result.profile.vrm.state).toBe('invalid');
  expect(result.validation.status).toBe('unsupported');
 });
});
