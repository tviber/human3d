import {beforeAll,expect,it} from 'vitest';
import fs from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Matrix4,SkinnedMesh,Vector3,type BufferGeometry} from 'three';
import {createSsjHair} from './ssj-hair';
import {HairSpring} from './hair-spring';

let body:BufferGeometry;
beforeAll(async()=>{
 const b=fs.readFileSync('public/models/human.glb');const gltf=await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');
 gltf.scene.traverse(o=>{if(o instanceof SkinnedMesh)body=o.geometry;});
});
const setup=()=>{const hair=createSsjHair(body);return {...hair,spring:new HairSpring(hair.geometry,hair.locks,hair.collider)};};
const tilt=(angle:number)=>new Matrix4().makeTranslation(0,1.67,.06).multiply(new Matrix4().makeRotationZ(angle)).multiply(new Matrix4().makeTranslation(0,-1.67,-.06));
const tipIndex=(g:BufferGeometry,id=0)=>{const f=g.getAttribute('hairFlex');for(let i=0;i<f.count;i++)if(f.getX(i)===id&&f.getY(i)===1)return i;throw new Error('No real lock tip');};
const tip=(g:BufferGeometry)=>new Vector3().fromBufferAttribute(g.getAttribute('position'),tipIndex(g));

it('bends under world gravity when the head tilts, keeping roots and the scalp fixed',()=>{
 const {geometry:g,spring,locks}=setup(),rest=g.getAttribute('position').array.slice(),f=g.getAttribute('hairFlex');
 spring.settle(new Matrix4());const upright=tip(g).sub(locks[0].tip);
 spring.settle(tilt(Math.PI/2));const sideways=tip(g).sub(locks[0].tip);
 expect(sideways.x).toBeLessThan(-.004);expect(sideways.distanceTo(upright)).toBeGreaterThan(.004);
 const p=g.getAttribute('position');for(let i=0;i<p.count;i++)if(f.getY(i)===0)for(let j=0;j<3;j++)expect(p.array[i*3+j]).toBe(rest[i*3+j]);
 expect([...p.array].every(Number.isFinite)).toBe(true);g.dispose();
});

it('lags a head turn, rebounds, then settles instead of wobbling on a timer',()=>{
 const {geometry:g,spring}=setup(),m=tilt(.65);spring.settle(new Matrix4());spring.update(1/60,m);const lag=tip(g);
 spring.settle(m);const equilibrium=tip(g);expect(lag.distanceTo(equilibrium)).toBeGreaterThan(.003);
 spring.settle(new Matrix4());spring.update(1/60,m);const direction=tip(g).sub(equilibrium).normalize();let rebound=false;
 for(let i=0;i<180;i++){spring.update(1/120,m);if(tip(g).sub(equilibrium).dot(direction)<-.00005)rebound=true;}
 expect(rebound).toBe(true);expect(tip(g).distanceTo(equilibrium)).toBeLessThan(.0001);
 const stopped=tip(g);for(let i=0;i<120;i++)spring.update(1/120,m);expect(tip(g).distanceTo(stopped)).toBeLessThan(.00001);g.dispose();
});

it('stays bounded and gives comparable results at 30, 60 and 120 Hz',()=>{
 const results:Vector3[]=[];
 for(const fps of [30,60,120]){
  const {geometry:g,spring,locks,collider}=setup(),inverse=collider.clone().invert();spring.settle(new Matrix4());
  for(let i=1;i<=fps*2;i++)spring.update(1/fps,tilt(.7*Math.sin(i/fps*5)));
  const p=g.getAttribute('position');
  for(let j=0;j<locks.length;j++){
   const index=tipIndex(g,j),v=new Vector3().fromBufferAttribute(p,index);
   expect(v.distanceTo(locks[j].tip)).toBeLessThanOrEqual(.024001);
   expect(v.clone().applyMatrix4(inverse).length()).toBeGreaterThanOrEqual(.9999);
  }
  results.push(tip(g));g.dispose();
 }
 expect(results[0].distanceTo(results[2])).toBeLessThan(.0007);expect(results[1].distanceTo(results[2])).toBeLessThan(.0007);
});

it('resets after a long frame/teleport and exports the same settled pose after different histories',()=>{
 const {geometry:g,spring}=setup(),m=tilt(.7);spring.settle(m);const expected=g.getAttribute('position').array.slice();
 for(let i=0;i<100;i++)spring.update(1/60,tilt(Math.sin(i/10)));
 spring.settle(m);expect(g.getAttribute('position').array).toEqual(expected);
 spring.update(5,m);const rest=tip(g);spring.reset(m);expect(tip(g).distanceTo(rest)).toBeLessThan(1e-8);
 spring.update(1/60,new Matrix4().makeTranslation(10,0,0));expect([...g.getAttribute('position').array].every(Number.isFinite)).toBe(true);
 expect(tip(g).distanceTo(rest)).toBeLessThan(1e-8);g.dispose();
});
