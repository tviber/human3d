import {Box3,BufferGeometry,CatmullRomCurve3,Float32BufferAttribute,Matrix4,SphereGeometry,Vector3} from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {createHairCardGeometry,type HairCard} from './hair-cards';

export type {HairLock} from './hair-cards';
type Point=[number,number,number];
type CardSpec={root:Point;bend:Point;tip:Point;width:number;depth:number;widthAxis:Point;shape?:HairCard['shape']};

/**
 * Deterministic SSJ card layout, authored in scalp-relative units; +Z faces forward.
 * Cards cover the crown in overlapping swept spikes, with separate forelock,
 * temple, occipital and nape layers so the silhouette reads from every side.
 */
const SSJ_CARDS:readonly CardSpec[]=[
 // Tall crown spikes.
 {root:[0,.50,-.14],bend:[-.10,1.55,-.28],tip:[.20,2.72,-.70],width:.58,depth:.24,widthAxis:[1,0,0]},
 {root:[-.25,.46,-.12],bend:[-.62,1.45,-.30],tip:[-1.02,2.46,-.68],width:.52,depth:.21,widthAxis:[.1,0,1]},
 {root:[.25,.46,-.12],bend:[.60,1.40,-.34],tip:[1.0,2.42,-.76],width:.52,depth:.21,widthAxis:[.1,0,-1]},
 {root:[-.46,.32,-.20],bend:[-.88,1.12,-.42],tip:[-1.36,2.00,-.68],width:.48,depth:.20,widthAxis:[0,0,1]},
 {root:[.46,.32,-.20],bend:[.86,1.08,-.42],tip:[1.34,2.02,-.72],width:.48,depth:.20,widthAxis:[0,0,-1]},
 {root:[-.14,.35,-.45],bend:[-.38,1.28,-.78],tip:[-.48,2.62,-1.18],width:.50,depth:.22,widthAxis:[1,0,0]},
 {root:[.14,.35,-.45],bend:[.42,1.27,-.78],tip:[.72,2.56,-1.22],width:.49,depth:.22,widthAxis:[1,0,0]},
 {root:[-.52,.17,-.34],bend:[-.90,.75,-.55],tip:[-1.22,1.56,-.78],width:.43,depth:.18,widthAxis:[0,0,1]},
 {root:[.52,.17,-.34],bend:[.90,.77,-.57],tip:[1.24,1.62,-.80],width:.43,depth:.18,widthAxis:[0,0,-1]},
 {root:[-.66,.02,-.08],bend:[-1.04,.48,-.28],tip:[-1.48,.98,-.50],width:.36,depth:.16,widthAxis:[0,0,1]},
 {root:[.66,.02,-.08],bend:[1.04,.50,-.30],tip:[1.48,1.02,-.52],width:.36,depth:.16,widthAxis:[0,0,-1]},
 // Front-facing spikes and swept bangs.
 {root:[-.38,.66,.42],bend:[-.66,1.24,.45],tip:[-.88,2.12,.10],width:.43,depth:.18,widthAxis:[1,0,0]},
 {root:[.34,.65,.42],bend:[.66,1.22,.44],tip:[.92,2.08,.08],width:.43,depth:.18,widthAxis:[1,0,0]},
 {root:[-.36,.68,.62],bend:[-.46,.39,1.02],tip:[-.25,.00,1.18],width:.36,depth:.13,widthAxis:[1,0,0],shape:'triangle'},
 {root:[.06,.76,.66],bend:[.28,.44,1.06],tip:[.60,.14,1.16],width:.34,depth:.12,widthAxis:[1,0,0],shape:'triangle'},
 {root:[.54,.54,.54],bend:[.86,.30,.90],tip:[1.00,.04,.96],width:.27,depth:.11,widthAxis:[1,0,0],shape:'triangle'},
 {root:[-.72,.34,.38],bend:[-1.02,.14,.66],tip:[-1.12,-.12,.82],width:.24,depth:.10,widthAxis:[0,0,1],shape:'triangle'},
 // Temple and ear locks frame the face without hiding the eyes.
 {root:[-.87,.06,.26],bend:[-1.06,-.12,.44],tip:[-1.20,-.52,.38],width:.25,depth:.12,widthAxis:[0,0,1],shape:'triangle'},
 {root:[.87,.06,.26],bend:[1.06,-.12,.44],tip:[1.20,-.52,.38],width:.25,depth:.12,widthAxis:[0,0,-1],shape:'triangle'},
 // Back and nape layers close the silhouette from behind.
 {root:[-.48,-.16,-.62],bend:[-.70,.32,-.98],tip:[-.88,.94,-1.24],width:.34,depth:.17,widthAxis:[1,0,0]},
 {root:[.48,-.16,-.62],bend:[.70,.32,-.98],tip:[.88,.94,-1.24],width:.34,depth:.17,widthAxis:[1,0,0]},
 {root:[-.18,-.30,-.78],bend:[-.34,.08,-1.12],tip:[-.52,.60,-1.42],width:.28,depth:.14,widthAxis:[1,0,0]},
 {root:[.18,-.30,-.78],bend:[.34,.08,-1.12],tip:[.56,.62,-1.42],width:.28,depth:.14,widthAxis:[1,0,0]},
 {root:[0,-.28,-.84],bend:[.04,.06,-1.20],tip:[.22,.72,-1.52],width:.32,depth:.15,widthAxis:[1,0,0]},
];

/** Fit stylized HairDeck-style cards to the actual upper scalp in the supplied body mesh. */
export function createSsjHair(body:BufferGeometry){
 body.computeBoundingBox();
 const top=body.boundingBox!.max.y,position=body.getAttribute('position'),scalp=new Box3(),p=new Vector3();
 for(let i=0;i<position.count;i++)if(position.getY(i)>top-.105)scalp.expandByPoint(p.fromBufferAttribute(position,i));
 if(scalp.isEmpty())throw new Error('人体模型缺少可用于贴合超赛发型的头皮顶点');
 const center=scalp.getCenter(new Vector3());center.y=top-.105;
 const radii=scalp.getSize(new Vector3()).multiplyScalar(.5);radii.x+=.003;radii.y=.108;radii.z+=.003;
 const point=(v:Point)=>new Vector3(v[0]*radii.x,v[1]*radii.y,v[2]*radii.z).add(center);

 const cards:HairCard[]=SSJ_CARDS.map(spec=>{
  const curve=new CatmullRomCurve3([point(spec.root),point(spec.bend),point(spec.tip)],false,'centripetal');
  const count=13,widthAxis=new Vector3(...spec.widthAxis).normalize();
  const points=Array.from({length:count},(_,i)=>{
   const t=i/(count-1),centerline=curve.getPoint(t);
   const swell=Math.pow(Math.max(0,Math.sin(Math.PI*Math.pow(t,.84))),.72);
   const profile=Math.max(.018,(.16+.84*swell)*Math.pow(1-t,.18));
   return {position:centerline,width:spec.width*radii.x*profile,thickness:spec.depth*radii.z*Math.max(.025,profile*.86)};
  });
  return {points,shape:spec.shape??'triangle',rootWidthDirection:widthAxis};
 });

 const {geometry:cardGeometry,locks}=createHairCardGeometry(cards);
 const cardUv=cardGeometry.getAttribute('uv');
 for(let i=0;i<cardUv.count;i++)cardUv.setXY(i,.50+cardUv.getX(i)*.03,.97+cardUv.getY(i)*.01);
 cardUv.needsUpdate=true;

 // Gold cap sits over the scalp; the separate cards create the sharp silhouette and cast shadows.
 const cap=new SphereGeometry(1,32,16,0,Math.PI*2,0,1),capPosition=cap.getAttribute('position'),capUv=cap.getAttribute('uv');
 for(let i=0;i<capPosition.count;i++){
  const x=capUv.getX(i),y=capUv.getY(i),phi=x*Math.PI*2,front=Math.sin(phi);
  const theta=(1-y)*(1.62-.53*Math.max(0,front)+.36*Math.max(0,-front));
  p.set(-Math.cos(phi)*Math.sin(theta),Math.cos(theta)*1.12,Math.sin(phi)*Math.sin(theta)*(front<0?1.22:1)).multiply(radii).add(center);
  capPosition.setXYZ(i,p.x,p.y,p.z);capUv.setXY(i,.50+x*.03,.97+y*.01);
 }
 cap.setAttribute('hairFlex',new Float32BufferAttribute(new Float32Array(capPosition.count*2),2));
 cap.computeVertexNormals();cap.computeBoundingBox();cap.computeBoundingSphere();
 const geometry=mergeGeometries([cap,cardGeometry])!;
 cap.dispose();cardGeometry.dispose();geometry.computeBoundingBox();geometry.computeBoundingSphere();

 const collider=new Matrix4().makeScale(radii.x,radii.y*1.12,radii.z*1.1);collider.setPosition(center);
 return {geometry,locks,collider};
}
