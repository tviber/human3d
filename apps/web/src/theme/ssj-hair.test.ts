import {beforeAll,expect,it} from 'vitest';
import fs from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {SkinnedMesh,Vector3,type BufferGeometry} from 'three';
import {createSsjHair} from './ssj-hair';

let body:BufferGeometry;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 gltf.scene.traverse(o=>{if(o instanceof SkinnedMesh)body=o.geometry;});
});
it('fits volumetric hair to the real scalp, rather than an absolute world position',()=>{
 const original=body.getAttribute('position').array.slice();
 const {geometry:hair}=createSsjHair(body),top=body.boundingBox!.max.y;
 expect(hair.index!.count).toBeGreaterThan(1000);expect(hair.boundingBox!.max.y-top).toBeGreaterThan(.14);expect(hair.boundingBox!.max.y-top).toBeLessThan(.22);
 expect(hair.boundingBox!.getSize(new Vector3()).z).toBeGreaterThan(.15);
 expect(body.getAttribute('position').array).toEqual(original);
 for(const name of ['position','normal','uv'])expect([...hair.getAttribute(name).array].every(Number.isFinite)).toBe(true);
 expect([...hair.index!.array].every(i=>i<hair.getAttribute('position').count)).toBe(true);
 // Translating the actual head surface must translate the complete hairstyle by exactly the same amount.
 const shifted=body.clone().translate(.4,.2,-.3),{geometry:moved}=createSsjHair(shifted),a=hair.getAttribute('position'),b=moved.getAttribute('position');
 expect(b.count).toBe(a.count);
 for(let i=0;i<a.count;i++)expect(new Vector3().fromBufferAttribute(b,i).sub(new Vector3().fromBufferAttribute(a,i)).distanceTo(new Vector3(.4,.2,-.3))).toBeLessThan(1e-6);
 hair.dispose();moved.dispose();shifted.dispose();
});
