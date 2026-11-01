import {BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, Quaternion, TubeGeometry, CatmullRomCurve3, Vector3, CylinderGeometry, TorusGeometry} from 'three';
import type {HumanRig} from '../rig';
import {gripFrame,type GripHandleFrame,type HandleGrip} from '../grip';

/** The tennis racket as a held prop (plugin). Everything racket-specific lives
 * here: the frame geometry, the handle the hand wraps (RACKET_HANDLE), the
 * string-bed tip (RACKET_TIP_LOCAL), the bevel ring and the wrist mount. The
 * solver and the hand-wrap code are prop-agnostic; the workshop imports the
 * racket through the props registry (props/index.ts). */
/** Handle the hand wraps: a 22 mm grip radius, centred 9 mm forward and 31 mm
 * normal of the palm frame. */
export const RACKET_HANDLE:HandleGrip={radius:.022,forward:.009,normal:.031};
/** Tip (string-bed centre) in the racket's local frame, metres along +Y. */
export const RACKET_TIP_LOCAL=new Vector3(0,.61,0);

/* ---- bevels (八棱面) -----------------------------------------------------
 * The handle is an octagonal prism: eight flat bevels around the +Y axis, and
 * the author may turn the racket so a chosen bevel sits under the palm. The
 * numbering is RELATIVE TO THE PALM, not to fixed geometry: bevel 1 is the
 * facet resting against the palm at the default mount, and 2…8 continue in 45°
 * steps. Two consequences, both deliberate:
 *  - a document that never touches the channel keeps the same serialized
 *    shape (bevel 1 remains the absent default), and
 *  - the same bevel number means the same grip on either hand, so mirroring a
 *    document keeps its bevel (measured: the right palm rests on the local −X
 *    facet, the left — whose mount is the x-mirror — on local +X; both are
 *    facet centres of a prism built with thetaStart=π/8).
 * The selected facet remains seated toward the thumb-index web while the grip
 * solver follows the mounted shaft axis and octagonal section when tilted. */
export const RACKET_BEVELS=8;
/** Canonical bevel: the facet in the palm at the default mount. */
export const RACKET_BEVEL_DEFAULT=1;
/** Maximum racket shaft tilt relative to the palm, in degrees. */
export const RACKET_GRIP_TILT_LIMIT_DEG=45;
/** Canonical racket shaft tilt: the existing mount stays unchanged. */
export const RACKET_GRIP_TILT_DEFAULT=0;
const BEVEL_STEP=Math.PI/4;
/** Local azimuth (x=sinθ, z=cosθ) of the palm facet, per mount side. Measured
 * on the real rig: the right palm rests on local −X (270°), the left mount is
 * the x-mirror so its palm rests on local +X (90°). Both are facet centres of
 * a prism built with thetaStart=π/8 (facet centres at multiples of 45°). */
const PALM_AZIMUTH:Record<'L'|'R',number>={R:Math.PI*1.5,L:Math.PI*.5};
/** Facet index in 1..8. Out-of-range/non-finite input falls back to the
 * canonical bevel instead of producing a NaN rotation. */
export function normalizeBevel(bevel?:number|null){
  if(!Number.isFinite(bevel as number))return RACKET_BEVEL_DEFAULT;
  return ((Math.round(bevel as number)-1)%RACKET_BEVELS+RACKET_BEVELS)%RACKET_BEVELS+1;
}
/** Which way the numbers run on each side: the left hand's bevel order is the
 * mirror of the right's, so bevel k always names the facet at the same offset
 * from the palm on both hands AND the mirrored document's racket is the exact
 * x-mirror of the source's (numbers travel with the geometry). */
const bevelSign=(side:'L'|'R')=>side==='R'?1:-1;
/** Canonical fallback roll for bevel `bevel` about local +Y. The actual mount
 * derives its roll from the live web proxy; this retains the palm-relative
 * numbering convention if that proxy degenerates. */
export function bevelRoll(side:'L'|'R',bevel?:number){
 return -bevelSign(side)*(normalizeBevel(bevel)-1)*BEVEL_STEP;
}
/** Clamp a requested shaft tilt to the authored range; non-finite values fall
 * back to the unchanged canonical mount. The document validator rejects
 * out-of-range values, while this low-level guard keeps direct prop callers
 * from producing a NaN quaternion. */
export function normalizeGripTilt(tilt?:number|null){
 if(!Number.isFinite(tilt as number))return RACKET_GRIP_TILT_DEFAULT;
 return Math.max(-RACKET_GRIP_TILT_LIMIT_DEG,Math.min(RACKET_GRIP_TILT_LIMIT_DEG,tilt as number));
}
/** Outward direction of bevel `bevel`'s facet in racket-local coordinates
 * (unit, XZ plane) — the direction the number label sits on. Fixed per facet,
 * so labels are children of the racket group and turn with the geometry. */
export function bevelDirection(side:'L'|'R',bevel?:number){
  const theta=PALM_AZIMUTH[side]+bevelSign(side)*(normalizeBevel(bevel)-1)*BEVEL_STEP;
  return new Vector3(Math.sin(theta),0,Math.cos(theta));
}
/** Where bevel `bevel`'s number label sits: just outside the facet, above the
 * grip band. Core owns the anchor; drawing the glyph needs a canvas, which the
 * DOM-free core must not touch — the workshop renders the sprite. */
export function bevelAnchor(side:'L'|'R',bevel:number,{radius=.028,y=.084}:{radius?:number;y?:number}={}){
  const d=bevelDirection(side,bevel);
  return new Vector3(d.x*radius,y,d.z*radius);
}

/** Racket coordinates: +Y runs through the handle to the head; grip origin is
 * the center of the contact cylinder. Attachment is wrist-local, never world-follow. */
function createRacket(){
  const group=new Group();group.name='RacketGrip';
  const blue=new MeshStandardMaterial({color:0x294de1,metalness:.45,roughness:.3});
  // flatShading: the eight radial segments ARE the bevels — smooth normals made
  // the handle read as a round rod and hid the facets the numbering names.
  const dark=new MeshStandardMaterial({color:0x172737,roughness:.85,flatShading:true});
  const silver=new MeshStandardMaterial({color:0xc4d0d8,metalness:.65,roughness:.35});
  const handle=new Mesh(new CylinderGeometry(.016,.018,.145,8,1,false,Math.PI/8),dark);group.add(handle);
  const cap=new Mesh(new CylinderGeometry(.020,.020,.012,8),dark);cap.position.y=-.075;group.add(cap);
  for(let y=-.065;y<.07;y+=.012){const wrap=new Mesh(new TorusGeometry(.017,.0008,4,16),silver);wrap.rotation.x=Math.PI/2;wrap.position.y=y;group.add(wrap);}
  const shaft=new Mesh(new CylinderGeometry(.008,.010,.14,10),blue);shaft.position.y=.142;group.add(shaft);
  const ellipse=[];for(let i=0;i<=64;i++){const t=i/64*Math.PI*2;ellipse.push(new Vector3(Math.sin(t)*.128,.445+Math.cos(t)*.166,0));}
  const frame=new Mesh(new TubeGeometry(new CatmullRomCurve3(ellipse,true),96,.009,8,true),blue);group.add(frame);
  for(const sign of [-1,1]){const a=new Vector3(0,.205,0),b=new Vector3(sign*.087,.322,0),v=b.clone().sub(a);const throat=new Mesh(new CylinderGeometry(.006,.007,v.length(),8),blue);throat.position.copy(a).add(b).multiplyScalar(.5);throat.quaternion.setFromUnitVectors(new Vector3(0,1,0),v.normalize());group.add(throat);}
  const strings:number[]=[];
  for(let x=-.112;x<=.112;x+=.016){const dy=.159*Math.sqrt(1-x*x/(.121*.121));strings.push(x,.445-dy,0,x,.445+dy,0);}
  for(let y=-.144;y<=.144;y+=.016){const dx=.121*Math.sqrt(1-y*y/(.159*.159));strings.push(-dx,.445+y,0,dx,.445+y,0);}
  const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(strings,3));group.add(new LineSegments(g,new LineBasicMaterial({color:0x8f9caa,transparent:true,opacity:.7})));
  group.traverse(o=>{if(o instanceof Mesh){o.castShadow=true;o.receiveShadow=true;}});
  return group;
}
/** The racket's transform inside the right wrist's local frame, built from
 * the right palmar frame: +Y handle along the grip axis, string-bed normal
 * twisted onto the palmar forward (independent from wrist movement). */
function racketLocalTransform(rig:HumanRig){
  const frame=gripFrame(rig,'R',RACKET_HANDLE);
  const quaternion=new Quaternion().setFromUnitVectors(new Vector3(0,1,0),frame.axis);
  const current=new Vector3(0,0,1).applyQuaternion(quaternion);
  const twist=Math.atan2(new Vector3().crossVectors(current,frame.forward).dot(frame.axis),current.dot(frame.forward));
  quaternion.premultiply(new Quaternion().setFromAxisAngle(frame.axis,twist));
  return {position:frame.center.clone(),quaternion};
}
/** The single authoritative local mount transform. Both the rendered racket
 * and the grip solver consume this exact orientation, so tilt and bevel cannot
 * drift away from the finger-wrap frame. */
function racketMountTransform(rig:HumanRig,side:'L'|'R',bevel?:number,gripTilt?:number){
  const t=racketLocalTransform(rig);
  if(side==='L'){
    t.position.x=-t.position.x;
    t.quaternion.set(t.quaternion.x,-t.quaternion.y,-t.quaternion.z,t.quaternion.w);
  }
  const tiltDegrees=normalizeGripTilt(gripTilt),tilt=tiltDegrees*Math.PI/180;
  if(tilt!==0)t.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),tilt));
  // The selected bevel faces the live skeletal thumb-index web proxy, even at
  // zero tilt. Using the current wrist-local roots matches the visible pose;
  // the radial projection removes the along-shaft offset before choosing roll.
  const wristBone=rig.bone(`wrist_${side}`),thumb=wristBone.worldToLocal(rig.point(`finger1-1_${side}`)),index=wristBone.worldToLocal(rig.point(`finger2-1_${side}`));
  const web=thumb.add(index).multiplyScalar(.5).sub(t.position),axis=new Vector3(0,1,0).applyQuaternion(t.quaternion).normalize();
  const radial=web.addScaledVector(axis,-web.dot(axis));
  let roll=bevelRoll(side,bevel);
  if(radial.lengthSq()>1e-12){
    radial.normalize().applyQuaternion(t.quaternion.clone().invert());
    const facet=bevelDirection(side,bevel),delta=Math.atan2(radial.x,radial.z)-Math.atan2(facet.x,facet.z);
    roll=Math.atan2(Math.sin(delta),Math.cos(delta));
  }
  if(roll!==0)t.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),roll));
  return t;
}
/** Grip axes expressed in the gripping wrist's local coordinates. The left
 * frame is derived from the actual mirrored mount, whose +Y points opposite
 * `gripFrame(L).axis`; do not reconstruct it by applying the right formula. */
export function racketGripFrame(rig:HumanRig,side:'L'|'R'='R',bevel?:number,gripTilt?:number):GripHandleFrame{
  const {position,quaternion}=racketMountTransform(rig,side,bevel,gripTilt);
  return {center:position,axis:new Vector3(0,1,0).applyQuaternion(quaternion).normalize(),
    normal:new Vector3(1,0,0).applyQuaternion(quaternion).normalize(),
    forward:new Vector3(0,0,1).applyQuaternion(quaternion).normalize(),halfLength:.0725};
}
/** (Re)mount a racket on the requested wrist. The left mount is the exact
 * x-mirror of the right transform — bilateral wrist local frames coincide
 * with world axes at rest, so negating position.x and the quaternion's y/z
 * is the true mirrored mount: the head exits on the left thumb side and the
 * string bed faces the mirrored-palm direction. Computing the same
 * construction from the LEFT grip frame would instead point +Y along the
 * left axis — the head on the pinky side, a 180°-flipped handle — which is
 * why the mount mirrors a canonical transform instead.
 *
 * `gripTilt` tips the shaft in the racket's local YZ plane around local +X;
 * positive values tip the head toward local +Z (palmar forward). It is applied
 * as a LOCAL post-rotation, so it changes racket orientation without moving
 * the grip origin or rotating the wrist/fingers. The x-reflection leaves a
 * local X rotation unchanged, so the same tilt on either side preserves the
 * exact mirrored mount. `bevel` then rolls around the tilted handle axis to
 * seat the requested facet toward the projected thumb-index web; the mirrored
 * web produces the opposite roll on the left. */
export function mountRacket(rig:HumanRig,racket:Group,side:'L'|'R'='R',bevel?:number,gripTilt?:number){
  const t=racketMountTransform(rig,side,bevel,gripTilt);
  racket.position.copy(t.position);racket.quaternion.copy(t.quaternion);
  racket.removeFromParent();
  rig.bone(`wrist_${side}`).add(racket);
}
export function attachRacket(rig:HumanRig,side:'L'|'R'='R',bevel?:number,gripTilt?:number){
  const racket=createRacket();mountRacket(rig,racket,side,bevel,gripTilt);return racket;
}
