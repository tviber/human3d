import {Box3,BufferGeometry,CatmullRomCurve3,Float32BufferAttribute,Matrix4,SphereGeometry,Vector3} from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {createHairCardGeometry,type HairCard} from './hair-cards';

export type {HairLock} from './hair-cards';
type Point=[number,number,number];
type CardSpec={root:Point;bend:Point;tip:Point;width:number;depth:number;widthAxis:Point;shape?:HairCard['shape'];brightness?:number;rootFlare?:number;taperStart?:number};

/**
 * Deterministic SSJ card layout, authored in scalp-relative units; +Z faces forward.
 * Broad swept cards cover the cap; a smaller set of long locks defines the flame
 * silhouette, with broken bangs and temple/nape layers framing the head.
 */
const SSJ_CARDS:readonly CardSpec[]=[
 // Wide underlayers follow the scalp so the silhouette is not a smooth bald dome.
 {root:[0,.42,.46],bend:[.02,.78,.03],tip:[-.06,.48,-.58],width:.90,depth:.16,widthAxis:[1,0,0],shape:'square',brightness:.76},
 {root:[-.36,.34,.28],bend:[-.62,.72,-.06],tip:[-.73,.48,-.64],width:.78,depth:.14,widthAxis:[1,0,.15],shape:'square',brightness:.79},
 {root:[.33,.34,.28],bend:[.60,.74,-.08],tip:[.68,.50,-.62],width:.76,depth:.14,widthAxis:[1,0,-.15],shape:'square',brightness:.79},
 {root:[0,.24,-.50],bend:[.10,.60,-.88],tip:[.04,.34,-1.10],width:.74,depth:.13,widthAxis:[1,0,0],shape:'square',brightness:.76},
 // Crown fan: fewer, wider locks sweep up and back from the scalp.
 {root:[0,.48,-.12],bend:[-.06,1.48,-.40],tip:[-.20,2.68,-.78],width:.78,depth:.23,widthAxis:[1,0,0],brightness:.98},
 {root:[-.22,.48,-.18],bend:[-.50,1.38,-.42],tip:[-.88,2.50,-.78],width:.72,depth:.22,widthAxis:[.9,0,.2],brightness:.93},
 {root:[.18,.48,-.18],bend:[.49,1.43,-.40],tip:[.90,2.58,-.81],width:.74,depth:.22,widthAxis:[.9,0,-.2],brightness:.99},
 {root:[-.42,.30,-.18],bend:[-.90,1.05,-.42],tip:[-1.33,1.92,-.70],width:.58,depth:.20,widthAxis:[0,0,1],brightness:.88},
 {root:[.42,.30,-.20],bend:[.86,1.10,-.46],tip:[1.28,2.00,-.75],width:.58,depth:.20,widthAxis:[0,0,-1],brightness:.94},
 {root:[-.43,.25,-.56],bend:[-.68,.92,-.86],tip:[-1.00,1.70,-1.18],width:.48,depth:.18,widthAxis:[1,0,0],brightness:.87},
 {root:[.40,.25,-.56],bend:[.66,.96,-.88],tip:[.98,1.74,-1.20],width:.47,depth:.18,widthAxis:[1,0,0],brightness:.92},
 {root:[-.08,.20,-.70],bend:[.05,.74,-1.05],tip:[.34,1.46,-1.36],width:.44,depth:.17,widthAxis:[1,0,0],brightness:.85},
 // Front crest transitions into five broken, pointed bangs.
 {root:[-.38,.48,.34],bend:[-.61,1.08,.10],tip:[-.83,1.90,-.18],width:.62,depth:.19,widthAxis:[1,0,0],brightness:.93},
 {root:[.28,.50,.36],bend:[.58,1.13,.12],tip:[.84,2.00,-.14],width:.61,depth:.19,widthAxis:[1,0,0],brightness:.98},
 {root:[.02,.60,.30],bend:[-.18,1.27,.00],tip:[-.28,2.24,-.30],width:.66,depth:.20,widthAxis:[1,0,0],brightness:.96},
 // Five pointed fringe locks start at the front hairline and stagger over the brow.
 {root:[-.70,.68,.48],bend:[-.73,.22,.82],tip:[-.70,.08,.80],width:.52,depth:.10,widthAxis:[1,0,0],shape:'triangle',brightness:.95,rootFlare:.62,taperStart:.38},
 {root:[-.38,.83,.67],bend:[-.43,.32,.98],tip:[-.49,-.05,.92],width:.60,depth:.11,widthAxis:[1,0,0],shape:'triangle',brightness:.98,rootFlare:.62,taperStart:.38},
 {root:[-.04,.90,.58],bend:[.02,.34,1.08],tip:[.13,-.08,1.03],width:.64,depth:.12,widthAxis:[1,0,0],shape:'triangle',brightness:1,rootFlare:.62,taperStart:.34},
 {root:[.32,.83,.68],bend:[.43,.32,.99],tip:[.52,.00,.93],width:.60,depth:.11,widthAxis:[1,0,0],shape:'triangle',brightness:.96,rootFlare:.62,taperStart:.38},
 {root:[.68,.68,.51],bend:[.75,.24,.78],tip:[.84,.12,.60],width:.46,depth:.10,widthAxis:[1,0,0],shape:'triangle',brightness:.91,rootFlare:.62,taperStart:.4},
 // Temple locks frame the face; rear layers taper down instead of sticking sideways.
 {root:[-.82,.45,.34],bend:[-1.00,.10,.52],tip:[-1.10,-.30,.40],width:.25,depth:.10,widthAxis:[0,0,1],shape:'triangle',brightness:.84},
 {root:[.82,.45,.34],bend:[1.00,.10,.52],tip:[1.10,-.30,.40],width:.25,depth:.10,widthAxis:[0,0,-1],shape:'triangle',brightness:.88},
 {root:[-.88,.22,-.26],bend:[-1.03,-.06,-.42],tip:[-1.12,-.34,-.50],width:.30,depth:.12,widthAxis:[0,0,1],shape:'triangle',brightness:.82},
 {root:[.88,.22,-.26],bend:[1.03,-.06,-.42],tip:[1.12,-.34,-.50],width:.30,depth:.12,widthAxis:[0,0,-1],shape:'triangle',brightness:.86},
 {root:[-.48,.08,-.45],bend:[-.79,.38,-.82],tip:[-1.05,.88,-1.18],width:.42,depth:.16,widthAxis:[1,0,0],brightness:.86},
 {root:[.46,.08,-.45],bend:[.76,.42,-.84],tip:[1.01,.92,-1.20],width:.41,depth:.16,widthAxis:[1,0,0],brightness:.90},
 {root:[-.56,.40,-.72],bend:[-.60,.00,-.92],tip:[-.65,-.45,-.67],width:.52,depth:.14,widthAxis:[1,0,0],brightness:.83},
 {root:[-.28,.52,-.80],bend:[-.32,.10,-.96],tip:[-.32,-.48,-.82],width:.58,depth:.15,widthAxis:[1,0,0],brightness:.87},
 {root:[0,.55,-.84],bend:[.02,.05,-1.00],tip:[.04,-.55,-.88],width:.62,depth:.16,widthAxis:[1,0,0],brightness:.80},
 {root:[.28,.52,-.80],bend:[.32,.10,-.96],tip:[.32,-.48,-.82],width:.58,depth:.15,widthAxis:[1,0,0],brightness:.89},
 {root:[.56,.40,-.72],bend:[.60,.00,-.92],tip:[.65,-.45,-.67],width:.52,depth:.14,widthAxis:[1,0,0],brightness:.85},
 // Narrow gold ribbons break up the main locks, as separate HairDeck cards.
 {root:[0,.50,.22],bend:[-.02,1.38,-.36],tip:[-.12,2.48,-.74],width:.19,depth:.06,widthAxis:[1,0,0],shape:'triangle',brightness:1},
 {root:[-.31,.50,-.12],bend:[-.57,1.34,-.42],tip:[-.88,2.28,-.76],width:.18,depth:.06,widthAxis:[.9,0,.2],shape:'triangle',brightness:.99},
 {root:[.27,.50,-.14],bend:[.54,1.38,-.40],tip:[.87,2.34,-.79],width:.18,depth:.06,widthAxis:[.9,0,-.2],shape:'triangle',brightness:1},
 {root:[-.36,.83,.67],bend:[-.42,.33,1.00],tip:[-.50,.00,.95],width:.16,depth:.05,widthAxis:[1,0,0],shape:'triangle',brightness:.99},
 {root:[.02,.90,.58],bend:[.04,.36,1.10],tip:[.14,-.04,1.06],width:.18,depth:.055,widthAxis:[1,0,0],shape:'triangle',brightness:1},
 {root:[.34,.83,.68],bend:[.44,.33,1.00],tip:[.51,.02,.95],width:.16,depth:.05,widthAxis:[1,0,0],shape:'triangle',brightness:.99},
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
 const physicalLength=(card:CardSpec)=>Math.hypot((card.tip[0]-card.root[0])*radii.x,(card.tip[1]-card.root[1])*radii.y,(card.tip[2]-card.root[2])*radii.z);
 const clearTip=(v:Point):Point=>{
  const radius=Math.hypot(v[0],v[1]/1.12,v[2]/1.1);
  if(radius>=1.04)return v;
  const scale=1.04/radius;return [v[0]*scale,v[1]*scale,v[2]*scale];
 };

 const cards:HairCard[]=[...SSJ_CARDS].sort((a,b)=>physicalLength(b)-physicalLength(a)).map((spec,index)=>{
  const curve=new CatmullRomCurve3([point(spec.root),point(spec.bend),point(clearTip(spec.tip))],false,'centripetal');
  const count=17,widthAxis=new Vector3(...spec.widthAxis).normalize();
  const points=Array.from({length:count},(_,i)=>{
   const t=i/(count-1),centerline=curve.getPoint(t);
   const swell=Math.pow(Math.max(0,Math.sin(Math.PI*Math.pow(t,.84))),.72);
   const rootFlare=(spec.rootFlare??.45)+(1-(spec.rootFlare??.45))*Math.min(1,t*3.2),taperStart=spec.taperStart??.64,tipTaper=t<=taperStart?1:Math.pow((1-t)/(1-taperStart),1.15);
   const profile=Math.max(.025,rootFlare*(.76+.24*swell)*tipTaper);
   return {position:centerline,width:spec.width*radii.x*profile,thickness:spec.depth*radii.z*Math.max(.025,profile*.86)};
  });
  const brightness=spec.brightness??(.82+((index*7)%11)*.018);
  return {points,shape:spec.shape??'triangle',rootWidthDirection:widthAxis,brightness};
 });

 const {geometry:cardGeometry,locks}=createHairCardGeometry(cards);

 // A dark root shell fills small gaps; the cards remain the visible hair surface.
 const cap=new SphereGeometry(1,32,16,0,Math.PI*2,0,1.65),capPosition=cap.getAttribute('position'),capUv=cap.getAttribute('uv');
 const capColors=new Float32Array(capPosition.count*3);
 for(let i=0;i<capPosition.count;i++){
  const x=capUv.getX(i),y=capUv.getY(i),phi=x*Math.PI*2,front=Math.sin(phi);
  const theta=(1-y)*(1.50-.68*Math.max(0,front)+.10*Math.max(0,-front)+.035*Math.sin(phi*8+.4));
  p.set(-Math.cos(phi)*Math.sin(theta),Math.cos(theta)*1.04,Math.sin(phi)*Math.sin(theta)*(front<0?1.12:1)).multiply(radii).add(center);
  capPosition.setXYZ(i,p.x,p.y,p.z);
  const shade=.36+.08*(.5+.5*Math.sin(phi*8+y*4));capColors.set([shade,shade,shade],i*3);
 }
 cap.setAttribute('hairFlex',new Float32BufferAttribute(new Float32Array(capPosition.count*2),2));
 cap.setAttribute('color',new Float32BufferAttribute(capColors,3));
 cap.computeVertexNormals();cap.computeBoundingBox();cap.computeBoundingSphere();
 const geometry=mergeGeometries([cap,cardGeometry])!;
 cap.dispose();cardGeometry.dispose();geometry.computeBoundingBox();geometry.computeBoundingSphere();

 const collider=new Matrix4().makeScale(radii.x,radii.y*1.12,radii.z*1.1);collider.setPosition(center);
 return {geometry,locks,collider};
}
