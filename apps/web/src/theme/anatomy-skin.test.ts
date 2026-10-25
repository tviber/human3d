import {beforeAll,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Raycaster,SkinnedMesh,Vector2,Vector3} from 'three';
import {HumanRig} from '@human3d/motion-core';
import {applyAnatomySkin,createAnatomyAtlas,type AnatomyAtlas,type AnatomyMetadata} from './anatomy-skin';

let mesh:SkinnedMesh,rig:HumanRig,atlas:AnatomyAtlas;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));gltf.scene.traverse(o=>{if(o instanceof SkinnedMesh)mesh=o;});gltf.scene.updateMatrixWorld(true);
 // The offline writer emits standard RGBA PNG scanlines with filter 0.
 const png=fs.readFileSync('public/models/anatomy-mask.png'),chunks:Buffer[]=[];
 for(let offset=8;offset<png.length;){const length=png.readUInt32BE(offset);if(png.toString('ascii',offset+4,offset+8)==='IDAT')chunks.push(png.subarray(offset+8,offset+8+length));offset+=length+12;}
 const metadata=JSON.parse(fs.readFileSync('public/models/anatomy-regions.json','utf8')) as AnatomyMetadata;
 const rows=inflateSync(Buffer.concat(chunks)),pixels=new Uint8Array(metadata.width*metadata.height*4),stride=metadata.width*4;
 for(let y=0;y<metadata.height;y++){expect(rows[y*(stride+1)]).toBe(0);pixels.set(rows.subarray(y*(stride+1)+1,(y+1)*(stride+1)),y*stride);}
 atlas=createAnatomyAtlas(metadata,pixels);
});
function regionFromFront(x:number,y:number){
 rig.reset();rig.model.updateMatrixWorld(true);mesh.computeBoundingSphere();mesh.computeBoundingBox();
 const hits=new Raycaster(new Vector3(x,y,2),new Vector3(0,0,-1)).intersectObject(mesh,false);
 expect(hits.length).toBeGreaterThan(0);return atlas.regionAt(hits[0].uv!);
}
describe('source-derived UV muscle atlas on the production human',()=>{
 it('preserves every triangle position, normal and skin weight from the pre-UV asset',()=>{
  // SHA256 after GLTFLoader's normalisation, from 0541e56's human.glb.
  // Pin the real deformation inputs, rather than only asserting vertex count.
  const index=mesh.geometry.index!,hash=createHash('sha256');
  for(const key of ['position','normal','skinIndex','skinWeight']){
   const attr=mesh.geometry.getAttribute(key),values=key==='skinIndex'?new Uint16Array(index.count*attr.itemSize):new Float32Array(index.count*attr.itemSize);
   for(let i=0;i<index.count;i++)for(let k=0;k<attr.itemSize;k++)values[i*attr.itemSize+k]=attr.getComponent(index.getX(i),k);
   hash.update(new Uint8Array(values.buffer));
  }
  expect(hash.digest('hex')).toBe('2c11a86978f36b758d951693f13b39c919f0e2ff31ae1366ffc6eb204f4c5f0e');
  const source=mesh.geometry.getAttribute('_source_vertex');expect(source.count).toBe(55784);
  for(const key of ['position','normal','skinIndex','skinWeight']){
   const attr=mesh.geometry.getAttribute(key);let identical=true;
   for(let i=0;i<source.count;i++)for(let k=0;k<attr.itemSize;k++)if(attr.getComponent(i,k)!==attr.getComponent(source.getX(i),k))identical=false;
   expect(identical,`${key}: UV seam copies retain source topology identity`).toBe(true);
  }
 });
 it('has valid UVs, complete source identities and expanded visible regions',()=>{
  const uv=mesh.geometry.getAttribute('uv'),index=mesh.geometry.index!;
  expect(uv.count).toBe(mesh.geometry.getAttribute('position').count);
  for(let i=0;i<uv.count;i++){expect(uv.getX(i)).toBeGreaterThanOrEqual(0);expect(uv.getX(i)).toBeLessThanOrEqual(1);expect(uv.getY(i)).toBeGreaterThanOrEqual(0);expect(uv.getY(i)).toBeLessThanOrEqual(1);}
  let degenerate=0;
  for(let i=0;i<index.count;i+=3){const a=index.getX(i),b=index.getX(i+1),c=index.getX(i+2),area=(uv.getX(b)-uv.getX(a))*(uv.getY(c)-uv.getY(a))-(uv.getY(b)-uv.getY(a))*(uv.getX(c)-uv.getX(a));if(Math.abs(area)<1e-12)degenerate++;}
  expect(degenerate).toBe(0);
  const counts=new Map<number,number>();for(let i=0;i<atlas.pixels.length;i+=4){const id=atlas.pixels[i]+atlas.pixels[i+1]*256;counts.set(id,(counts.get(id)??0)+1);}
  expect(atlas.metadata.regions).toHaveLength(410);
  const source=JSON.parse(fs.readFileSync('assets/anatomy/z-anatomy/source.json','utf8'));
  const sourceMuscles=source.items.filter((item:{kind:string})=>item.kind==='muscle');
  expect(sourceMuscles).toHaveLength(462);
  expect(atlas.metadata.source.license).toBe('CC-BY-SA-4.0');expect(atlas.metadata.source.conversionCommit).toBe('28912432581accd7a1c62129d55f0e9758221d48');
  expect(createHash('sha256').update(fs.readFileSync('assets/anatomy/z-anatomy/geometry.npz')).digest('hex')).toBe(atlas.metadata.source.geometrySHA256);
  const represented=atlas.metadata.regions.flatMap(r=>r.sourceObjects.map(o=>o.node));
  expect(represented.sort()).toEqual(sourceMuscles.map((item:{nodeName:string})=>item.nodeName).sort());
  expect(new Set(represented).size).toBe(represented.length);
  for(const key of ['pectoralis_L','rectus_L','sternocleidomastoid_L','masseter_L','serratus_anterior_L','brachioradialis_L','sartorius_L','rectus_femoris_L','vastus_medialis_L','fibularis_longus_L']){
   const region=atlas.metadata.regions.find(r=>r.key===key)!;expect(region,key).toBeDefined();expect(counts.get(region.id),key).toBeGreaterThan(100);
  }
  const high=atlas.metadata.regions.find(r=>r.key==='brachioradialis_L')!;expect(high.id).toBeGreaterThan(255);
  const pixel=Array.from({length:atlas.metadata.width*atlas.metadata.height},(_,i)=>i).find(i=>atlas.pixels[i*4]+atlas.pixels[i*4+1]*256===high.id)!;
  expect(atlas.regionAt(new Vector2((pixel%atlas.metadata.width+.5)/atlas.metadata.width,(Math.floor(pixel/atlas.metadata.width)+.5)/atlas.metadata.height))?.key).toBe(high.key);
  expect(atlas.metadata.regions.find(r=>r.key==='pectoralis_minor_L')?.surfaceTexels).toBe(0);
  for(const side of ['L','R']){
   expect(atlas.metadata.regions.find(r=>r.key==='rectus_'+side)?.surfaceTexels).toBeGreaterThan(5000);
   expect(atlas.metadata.regions.find(r=>r.key==='masseter_'+side)?.surfaceTexels).toBeGreaterThan(1000);
  }
  const policy=JSON.parse(fs.readFileSync('assets/anatomy/surface-policy.json','utf8'));
  const excluded=atlas.metadata.regions.filter(r=>r.key.replace(/_[LRC]$/,'') in policy.excludedMuscles||r.sourceObjects.some(o=>o.group in policy.excludedGroups));
  expect(excluded.length).toBeGreaterThan(100);
  for(const region of excluded){expect(region.surfaceExclusion,region.key).toBeTruthy();expect(counts.get(region.id)??0,region.key).toBe(0);expect(region.surfaceTexels,region.key).toBe(0);}
  const eye=atlas.metadata.regions.filter(r=>r.sourceObjects.some(o=>o.group==='Extra-ocular muscles.g'));
  expect(eye.length).toBeGreaterThan(0);expect(eye.every(r=>r.surfaceTexels===0)).toBe(true);
 });
 it('identifies named left/right chest, abdomen and thighs independently of skin weights',()=>{
  expect(regionFromFront(.08,1.34)?.key).toBe('pectoralis_L');expect(regionFromFront(-.08,1.34)?.key).toBe('pectoralis_R');
  expect(regionFromFront(.035,1.13)?.key).toBe('rectus_L');expect(regionFromFront(.13,.73)?.key).toMatch(/^(rectus_femoris|vastus_medialis|vastus_lateralis|sartorius)_L$/);
  expect(regionFromFront(.08,1.34)?.sourceObjects.some(o=>o.name.includes('pectoralis major'))).toBe(true);
 });
 it('keeps UV region identity on an arm moved through the real rig',()=>{
  rig.reset();rig.model.updateMatrixWorld(true);
  const index=mesh.geometry.index!,uv=mesh.geometry.getAttribute('uv'),weights=mesh.geometry.getAttribute('skinWeight'),si=mesh.geometry.getAttribute('skinIndex');
  let vertex=-1;
  for(let i=0;i<uv.count;i++)if(atlas.regionAt(new Vector2(uv.getX(i),uv.getY(i)))?.key==='biceps_L'&&Array.from({length:4},(_,k)=>weights.getComponent(i,k)>.1&&mesh.skeleton.bones[si.getComponent(i,k)].name.startsWith('upperarm')).some(Boolean)){vertex=i;break;}
  expect(vertex).toBeGreaterThanOrEqual(0);const rest=mesh.getVertexPosition(vertex,new Vector3());
  rig.limbToWorldTargets('L','arm',new Vector3(.3,1.6,.3),new Vector3(.5,1.5,0));rig.model.updateMatrixWorld(true);
  expect(mesh.getVertexPosition(vertex,new Vector3()).distanceTo(rest)).toBeGreaterThan(.05);
  expect(atlas.regionAt(new Vector2(uv.getX(vertex),uv.getY(vertex)))?.key).toBe('biceps_L');expect(index.count).toBeGreaterThan(0);
 });
 it('starts uniformly matte and leaves geometry/weights unchanged when installing highlight material',()=>{
  const geometry=mesh.geometry,skin=applyAnatomySkin(mesh,atlas);
  expect(skin.id.value).toBe(0);expect(skin.amount.value).toBe(0);expect(mesh.geometry).toBe(geometry);
  expect(Array.isArray(mesh.material)).toBe(false);if(Array.isArray(mesh.material))return;
  expect(mesh.material).toMatchObject({vertexColors:false,roughness:.76,metalness:0,map:null});
 });
});
