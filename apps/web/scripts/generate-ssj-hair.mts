import {readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DoubleSide,Group,Matrix4,Mesh,MeshStandardMaterial,SkinnedMesh} from 'three';
import {createSsjHair} from '../src/theme/ssj-hair';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const sourcePath=resolve(repository,'public/models/human.glb');
const outputPath=resolve(repository,'public/models/skins/ssj-hair.glb');

function installFileReaderShim(){
 if(typeof globalThis.FileReader==='function')return;
 class FileReaderShim{
  result:ArrayBuffer|string|null=null;
  onloadend:(()=>void)|null=null;
  onerror:((error:unknown)=>void)|null=null;
  readAsArrayBuffer(blob:Blob){void blob.arrayBuffer().then(buffer=>{this.result=buffer;this.onloadend?.();},error=>this.onerror?.(error));}
  readAsDataURL(blob:Blob){void blob.arrayBuffer().then(buffer=>{this.result=`data:${blob.type||'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;this.onloadend?.();},error=>this.onerror?.(error));}
 }
 (globalThis as unknown as {FileReader:new()=>FileReaderShim}).FileReader=FileReaderShim;
}

const sourceBytes=await readFile(sourcePath);
const sourceBuffer=sourceBytes.buffer.slice(sourceBytes.byteOffset,sourceBytes.byteOffset+sourceBytes.byteLength) as ArrayBuffer;
const human=await new GLTFLoader().parseAsync(sourceBuffer,'');
const bodies:SkinnedMesh[]=[];
human.scene.traverse(object=>{if(object instanceof SkinnedMesh)bodies.push(object);});
const body=bodies[0];
const head=human.scene.getObjectByName('head');
if(!body||!head)throw new Error('human.glb must include a skinned body mesh and head bone');

human.scene.updateWorldMatrix(true,true);
const toRoot=new Matrix4().copy(human.scene.matrixWorld).invert();
const headBindPose=new Matrix4().multiplyMatrices(toRoot,head.matrixWorld);
const headLocal=headBindPose.invert();
const {geometry,locks,collider}=createSsjHair(body.geometry);
geometry.applyMatrix4(headLocal);
for(const lock of locks){lock.root.applyMatrix4(headLocal);lock.tip.applyMatrix4(headLocal);}
collider.premultiply(headLocal);

const group=new Group();group.name='SSJ hair cards';
const mesh=new Mesh(geometry,new MeshStandardMaterial({color:0xf3c647,roughness:.76,metalness:0,vertexColors:true,side:DoubleSide}));
mesh.name='ssj-hair-cards';
mesh.userData={
 hairLocks:locks.map(lock=>({root:lock.root.toArray(),tip:lock.tip.toArray()})),
 hairCollider:collider.elements.slice(),
 coordinateSpace:'head-local',
 generator:'human3d TypeScript HairDeck card layout and mesher',
};
group.add(mesh);

installFileReaderShim();
const output=await new Promise<ArrayBuffer>((resolveOutput,reject)=>{
 new GLTFExporter().parse(group,result=>{
  if(result instanceof ArrayBuffer)resolveOutput(result);
  else reject(new Error('GLTFExporter did not return a binary GLB'));
 },reject,{binary:true,onlyVisible:true});
});
await writeFile(outputPath,new Uint8Array(output));
geometry.dispose();mesh.material.dispose();
console.log(`Wrote ${outputPath} (${output.byteLength} bytes)`);
