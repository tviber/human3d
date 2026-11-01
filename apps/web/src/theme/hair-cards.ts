/**
 * Hair-card cross-section mesher adapted from HairDeck's Apache-2.0
 * hairdeck/cards/mesh.py and hairdeck/cards/frames.py.
 * TypeScript port by human3d contributors; see assets/source/HAIRDECK-LICENSE.txt.
 */
import {BufferGeometry,Float32BufferAttribute,Vector3} from 'three';

export type HairCardShape='square'|'triangle';
export type HairLock={root:Vector3;tip:Vector3};

export interface HairCardPoint{
 position:Vector3;
 width:number;
 thickness:number;
}

export interface HairCard{
 points:readonly HairCardPoint[];
 shape:HairCardShape;
 rootWidthDirection:Vector3;
}

const STENCIL=[-1/12,2/3,0,-2/3,1/12] as const;
const UV_U=[0,.5,1,.5] as const;

function tangentAt(points:readonly HairCardPoint[],index:number){
 const count=points.length,tangent=new Vector3();
 if(count<5){
  tangent.subVectors(points[count-1].position,points[0].position);
 }else{
  const first=Math.min(Math.max(index-2,0),count-5);
  for(let i=0;i<5;i++)tangent.addScaledVector(points[first+i].position,STENCIL[i]);
 }
 if(tangent.lengthSq()<1e-20)tangent.subVectors(points[count-1].position,points[0].position);
 if(tangent.lengthSq()<1e-20)throw new Error('Hair card centerline must have nonzero length');
 return tangent.normalize();
}

function perpendicular(direction:Vector3,tangent:Vector3){
 const result=direction.clone().addScaledVector(tangent,-direction.dot(tangent));
 if(result.lengthSq()<1e-12){
  const fallback=Math.abs(tangent.x)<.8?new Vector3(1,0,0):new Vector3(0,0,1);
  result.copy(fallback).addScaledVector(tangent,-fallback.dot(tangent));
 }
 return result.normalize();
}

/** Parallel transport the width direction with the minimum rotation between adjacent tangents. */
function bishopFrames(direction:Vector3,tangents:readonly Vector3[]){
 const frames=[perpendicular(direction,tangents[0])];
 for(let i=1;i<tangents.length;i++){
  const previous=tangents[i-1],current=tangents[i];
  const axis=new Vector3().crossVectors(previous,current),sine=axis.length();
  const cosine=Math.max(-1,Math.min(1,previous.dot(current)));
  const frame=frames[i-1].clone();
  if(sine>1e-9){
   axis.divideScalar(sine);
   const rotated=new Vector3().crossVectors(axis,frame);
   frame.multiplyScalar(cosine)
    .addScaledVector(rotated,sine)
    .addScaledVector(axis,axis.dot(frames[i-1])*(1-cosine));
  }
  frames.push(perpendicular(frame,current));
 }
 return frames;
}

/** Convert a set of centerline cards into one indexed Three.js geometry. */
export function createHairCardGeometry(cards:readonly HairCard[]){
 if(!cards.length)throw new Error('At least one hair card is required');
 const positions:number[]=[],uvs:number[]=[],flex:number[]=[],indices:number[]=[],locks:HairLock[]=[];
 let vertexOffset=0;

 for(const card of cards){
  const points=card.points;
  if(points.length<3)throw new Error('Hair cards need at least three centerline points');
  if(points.some(point=>!Number.isFinite(point.width)||!Number.isFinite(point.thickness)||point.width<=0||point.thickness<=0))
   throw new Error('Hair-card width and thickness must be positive finite numbers');
  const tangents=points.map((_,i)=>tangentAt(points,i));
  const widths=bishopFrames(card.rootWidthDirection,tangents);
  const centers=points.map(point=>point.position);
  let totalLength=0;const distances=[0];
  for(let i=1;i<centers.length;i++){
   totalLength+=centers[i].distanceTo(centers[i-1]);distances.push(totalLength);
  }
  if(totalLength<1e-9)throw new Error('Hair card centerline must have nonzero length');
  const cardId=locks.length;
  locks.push({root:centers[0].clone(),tip:centers[centers.length-1].clone()});

  for(let i=0;i<points.length;i++){
   const point=points[i],widthAxis=widths[i];
   const tangent=tangents[i].clone().addScaledVector(widthAxis,-tangents[i].dot(widthAxis)).normalize();
   const depthAxis=new Vector3().crossVectors(widthAxis,tangent).normalize();
   const halfWidth=point.width/2;
   const positiveDepth=card.shape==='triangle'?point.thickness/3:point.thickness/2;
   const negativeDepth=card.shape==='triangle'?point.thickness/6:point.thickness/2;
   const corners=[
    point.position.clone().addScaledVector(widthAxis,halfWidth),
    point.position.clone().addScaledVector(depthAxis,positiveDepth),
    point.position.clone().addScaledVector(widthAxis,-halfWidth),
    point.position.clone().addScaledVector(depthAxis,-negativeDepth),
   ];
   const v=distances[i]/totalLength;
   const bend=Math.pow(Math.max(0,(v-.12)/.88),2);
   for(let corner=0;corner<4;corner++){
    positions.push(corners[corner].x,corners[corner].y,corners[corner].z);
    uvs.push(UV_U[corner],v);
    flex.push(cardId,bend);
   }
  }

  const ringCount=points.length;
  indices.push(vertexOffset,vertexOffset+2,vertexOffset+1,vertexOffset,vertexOffset+3,vertexOffset+2);
  for(let ring=1;ring<ringCount;ring++){
   const current=vertexOffset+ring*4,previous=current-4;
   for(let corner=0;corner<4;corner++)indices.push(current+corner,previous+corner,current+(corner+1)%4);
   for(const corner of [0,3,2,1])indices.push(previous+(corner+1)%4,current+(corner+1)%4,previous+corner);
   indices.push(current,current+1,current+2,current,current+2,current+3);
  }
  vertexOffset+=ringCount*4;
 }

 const geometry=new BufferGeometry();
 geometry.setAttribute('position',new Float32BufferAttribute(positions,3));
 geometry.setAttribute('uv',new Float32BufferAttribute(uvs,2));
 geometry.setAttribute('hairFlex',new Float32BufferAttribute(flex,2));
 geometry.setIndex(indices);
 geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();
 return {geometry,locks};
}
