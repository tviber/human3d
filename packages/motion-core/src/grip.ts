import type {HumanRig} from './rig';
import {handFrame} from './hand-frame';
import {frameRotation} from './kinematics';
import {Quaternion,Vector3} from 'three';

/** A held prop's handle as the hand wraps it: the wrap radius and where the
 * grip centre sits relative to the palm (metres, palmar forward / normal).
 * Props own their handle (see props/racket.ts); the hand-wrap solver stays
 * prop-agnostic and takes it as an argument. */
export interface HandleGrip{radius:number;forward:number;normal:number}

/** Palmar grip frame of one hand in wrist-local rest coordinates (which equal
 * world axes at rest). `forward`/`normal`/`center` are polar vectors — the
 * left frame is their x-mirror because handFrame negates the left normal —
 * while `axis` is a cross product, so it mirrors as (x,−y,−z): the same
 * handle line with opposite sense. `center` sits on the handle, offset from
 * the palm by the prop's `handle` (forward/normal, m). */
export function gripFrame(rig:HumanRig,side:'L'|'R',handle:HandleGrip){
  const wrist=rig.rest.get(`wrist_${side}`)!;
  const {forward,normal,flexionAxis:axis}=handFrame(rig.rest,side);
  const base=rig.rest.get(`finger3-1_${side}`)!.clone().add(rig.rest.get(`finger4-1_${side}`)!).multiplyScalar(.5);
  return {forward,normal,axis,center:base.sub(wrist).addScaledVector(forward,handle.forward).addScaledVector(normal,handle.normal)};
}

/* ---- scratch registers (issue #10 PR-C, eval MAJOR-2 audit) -------------
 * Dedicated regs — never shared with any other function:
 *  _gripWq      wrist world quat, read at fn entry, read again across every
 *               worldRotation call (rig methods never touch these regs)
 *  _gripPrev    previousDirection — persists across joint iterations BY DESIGN
 *  _gripDes/_gripDes2  desired + limited desired
 *  _gripTurn/_gripRest/_gripTarget  per-iteration temps
 *  _gripPt      worldToLocal scratch (worldToLocal mutates+returns its arg)
 *  _gripIdent   immutable identity quaternion — slerp arg only
 * blendGrip's grip[] clones are STORED across relaxHand — they remain
 * fresh clones and must NEVER come from scratch. */
const _gripWq=new Quaternion(),_gripPrev=new Vector3(),_gripDes=new Vector3(),
      _gripDes2=new Vector3(),_gripTurn=new Quaternion(),_gripRest=new Vector3(),
      _gripTarget=new Quaternion(),_gripPt=new Vector3();
const _gripIdent=new Quaternion();
export function applyGrip(rig:HumanRig,side:'L'|'R',handle:HandleGrip){
  const {axis,normal,forward,center}=gripFrame(rig,side,handle);
  const wrist=rig.bone(`wrist_${side}`),wq=wrist.getWorldQuaternion(_gripWq);
  const contactRadius=handle.radius;
  for(let finger=1;finger<=5;finger++){
    let previousDirection:Vector3|undefined;
    const winding=finger===1?-1:1;
    for(let joint=1;joint<=3;joint++){
      const name=`finger${finger}-${joint}_${side}`,bone=rig.bone(name);
      const origin=wrist.worldToLocal(rig.pointInto(name,_gripPt)).sub(center);
      const x=origin.dot(forward),y=origin.dot(normal),distance=Math.hypot(x,y);
      const theta=Math.atan2(y,x),alpha=Math.acos(Math.min(1,contactRadius/Math.max(contactRadius,distance)));
      const tangent=theta+winding*alpha;
      let dx=contactRadius*Math.cos(tangent)-x,dy=contactRadius*Math.sin(tangent)-y;
      if(Math.hypot(dx,dy)<1e-8){dx=-Math.sin(theta)*winding;dy=Math.cos(theta)*winding;}
      let desired=_gripDes.copy(forward).multiplyScalar(dx).addScaledVector(normal,dy).normalize();
      if(previousDirection){const limit=(joint===3?75:100)*Math.PI/180,angle=previousDirection.angleTo(desired);if(angle>limit){_gripTurn.setFromUnitVectors(previousDirection,desired);_gripTurn.slerp(_gripIdent,1-limit/angle);desired=_gripDes2.copy(previousDirection).applyQuaternion(_gripTurn);}}
      previousDirection=_gripPrev.copy(desired);
      const bi=rig.info.bones.find(b=>b.name===name)!;
      const restDir=_gripRest.fromArray(bi.tail).sub(rig.rest.get(name)!);
      const target=_gripTarget.copy(wq).multiply(frameRotation(restDir,axis,desired,axis));
      rig.worldRotation(name,target);
    }
  }
  rig.syncWorld();
}

/** Grip at `amount` in [0,1] on `side`'s hand: the base hand pose at 0, full
 * wrap at 1.
 * The wrap is solved once, from the rest finger pose (as the authored grip
 * poses are), and each finger joint is then blended from the base local
 * rotation to its grip local rotation. Blending inside the sequential wrap
 * solve made the result jump as the amount approached 1, because each joint's
 * wrap geometry depends on the joints solved before it.
 *
 * `base` writes the hand pose the wrap blends FROM — the authored hand shape
 * (fist ⇄ open) for the gripping hand. Omitted, it is the legacy relaxed pose
 * (relaxHand + identity thumb), so every pre-existing document solves exactly
 * as before. */
export function blendGrip(rig:HumanRig,side:'L'|'R',amount:number,handle:HandleGrip,base?:()=>void){
  const names:string[]=[];
  for(let finger=1;finger<=5;finger++)for(let joint=1;joint<=3;joint++)names.push(`finger${finger}-${joint}_${side}`);
  applyGrip(rig,side,handle);
  const grip=names.map(n=>rig.bone(n).quaternion.clone());
  if(base)base();
  else{
    rig.relaxHand(side);
    // relaxHand curls fingers 2–5 but leaves the thumb where applyGrip put it;
    // the relaxed thumb is the rest pose, so amount 0 must reach identity too.
    for(let joint=1;joint<=3;joint++)rig.bone(`finger1-${joint}_${side}`).quaternion.identity();
  }
  names.forEach((n,i)=>rig.bone(n).quaternion.slerp(grip[i],amount));
  rig.syncWorld();
}
