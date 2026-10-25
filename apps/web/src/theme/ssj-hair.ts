import {Box3,BufferGeometry,CatmullRomCurve3,Float32BufferAttribute,Matrix4,SphereGeometry,Vector3} from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';

type Point=[number,number,number];
export type HairLock={root:Vector3;tip:Vector3};

/** Solid swept locks fitted to the original scalp; +Z is the face. */
export function createSsjHair(body:BufferGeometry){
 body.computeBoundingBox();const top=body.boundingBox!.max.y,position=body.getAttribute('position'),scalp=new Box3(),p=new Vector3();
 for(let i=0;i<position.count;i++)if(position.getY(i)>top-.105)scalp.expandByPoint(p.fromBufferAttribute(position,i));
 const center=scalp.getCenter(new Vector3());center.y=top-.105;
 const radii=scalp.getSize(new Vector3()).multiplyScalar(.5);radii.x+=.003;radii.y=.108;radii.z+=.003;
 const point=(v:Point)=>new Vector3(...v).multiply(radii).add(center);
 const geometries:BufferGeometry[]=[],locks:HairLock[]=[];
 // Broad oval sections swell beyond the root, then taper along a curved comb direction.
 const lock=(root:Point,bend:Point,tip:Point,width:number,depth:number)=>{
  const curve=new CatmullRomCurve3([point(root),point(bend),point(tip)]),vertices:number[]=[],uv:number[]=[],indices:number[]=[],flex:number[]=[];
  const id=locks.length;locks.push({root:point(root),tip:point(tip)});
  // Sample the unmarked gold area; volume and shadows come from the mesh.
  const steps=12,sides=10,u=new Vector3(),v=new Vector3();
  for(let k=0;k<steps;k++){
   const t=k/steps,c=curve.getPoint(t),tangent=curve.getTangent(t).normalize();
   u.set(1,0,0).addScaledVector(tangent,-tangent.x);
   if(u.lengthSq()<.01)u.set(0,0,1).addScaledVector(tangent,-tangent.z);
   u.normalize();v.crossVectors(tangent,u).normalize();
   const taper=Math.pow(1-t,.7)*(.85+.55*Math.sin(Math.PI*t));
   for(let j=0;j<=sides;j++){
    const angle=j/sides*Math.PI*2;
    p.copy(c).addScaledVector(u,Math.cos(angle)*radii.x*width*taper).addScaledVector(v,Math.sin(angle)*radii.z*depth*taper);
    vertices.push(p.x,p.y,p.z);uv.push(.50+j/sides*.03,.97+t*.01);flex.push(id,Math.pow(Math.max(0,(t-.2)/.8),2));
    if(k<steps-1&&j<sides){const a=k*(sides+1)+j,b=a+sides+1;indices.push(a,a+1,b,a+1,b+1,b);}
   }
  }
  const end=vertices.length/3;vertices.push(...point(tip).toArray());uv.push(.515,.98);flex.push(id,1);
  const start=vertices.length/3;vertices.push(...point(root).toArray());uv.push(.515,.97);flex.push(id,0);
  for(let j=0;j<sides;j++){const a=(steps-1)*(sides+1)+j;indices.push(a,a+1,end,start,j+1,j);}
  const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(vertices,3));geometry.setAttribute('uv',new Float32BufferAttribute(uv,2));geometry.setAttribute('hairFlex',new Float32BufferAttribute(flex,2));geometry.setIndex(indices);geometry.computeVertexNormals();geometries.push(geometry);
 };
 // FighterZ forehead silhouette + the official S.H.Figuarts 360° crown/ear/nape layers.
 lock([0,.85,.05],[-.2,1.65,-.05],[.28,2.75,-.65],.58,.25);
 lock([0,.75,-.35],[0,1.50,-.55],[.10,2.65,-.75],.60,.50);
 lock([-.38,.65,.55],[-.85,1.45,.45],[-1.0,2.40,-.25],.55,.22);
 lock([.38,.65,.45],[.72,1.55,.15],[.95,2.60,-.55],.54,.22);
 lock([-.73,.35,.35],[-1.12,.95,.05],[-1.32,1.80,-.45],.46,.20);
 lock([.73,.35,.35],[1.10,1.02,0],[1.42,1.95,-.55],.44,.20);
 lock([-.90,.02,.05],[-1.24,.30,-.20],[-1.62,.72,-.65],.35,.25);
 lock([.90,.02,.05],[1.23,.35,-.20],[1.62,.87,-.65],.35,.25);
 lock([0,.45,-.78],[.15,1.40,-1.20],[.48,2.58,-1.02],.60,.25);
 lock([-.55,.42,-.62],[-1.0,1.12,-1.10],[-1.05,2.08,-1.05],.48,.22);
 lock([.55,.42,-.62],[1.0,1.12,-1.10],[1.22,2.15,-1.10],.48,.22);
 lock([-.65,-.10,-.60],[-1.0,.35,-1.02],[-1.28,.98,-1.20],.38,.26);
 lock([.65,-.10,-.60],[1.0,.35,-1.02],[1.28,1.05,-1.20],.38,.26);
 lock([-.43,-.30,-.75],[-.68,-.02,-1.12],[-.85,.48,-1.40],.34,.24);
 lock([.43,-.30,-.75],[.68,-.02,-1.12],[.85,.48,-1.40],.34,.24);
 lock([0,-.34,-.90],[0,.02,-1.25],[.12,.72,-1.48],.40,.25);
 // Three overlapping hooked bangs, ending above the original eyelids.
 lock([-.20,1.0,.45],[-.55,.72,1.05],[-.10,.08,1.22],.34,.13);
 lock([.10,.98,.50],[.45,.70,1.10],[.60,.18,1.23],.25,.11);
 lock([.55,.60,.50],[.88,.38,.85],[.98,0,1.0],.20,.10);
 const cap=new SphereGeometry(1,32,16,0,Math.PI*2,0,1),capPosition=cap.getAttribute('position'),capUv=cap.getAttribute('uv');
 for(let i=0;i<capPosition.count;i++){
  const x=capUv.getX(i),y=capUv.getY(i),phi=x*Math.PI*2,front=Math.sin(phi),theta=(1-y)*(1.62-.53*Math.max(0,front)+.36*Math.max(0,-front));
  // The native crown and occiput are fuller than the upper-scalp ellipsoid.
  p.set(-Math.cos(phi)*Math.sin(theta),Math.cos(theta)*1.12,Math.sin(phi)*Math.sin(theta)*(front<0?1.22:1)).multiply(radii).add(center);capPosition.setXYZ(i,p.x,p.y,p.z);capUv.setXY(i,.50+x*.03,.97+y*.01);
 }
 cap.setAttribute('hairFlex',new Float32BufferAttribute(new Float32Array(capPosition.count*2),2));cap.computeVertexNormals();geometries.push(cap);
 const geometry=mergeGeometries(geometries)!;geometries.forEach(g=>g.dispose());geometry.computeBoundingBox();geometry.computeBoundingSphere();
 const collider=new Matrix4().makeScale(radii.x,radii.y*1.12,radii.z*1.1);collider.setPosition(center);
 return {geometry,locks,collider};
}
