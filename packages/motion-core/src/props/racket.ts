import {BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, Quaternion, TubeGeometry, CatmullRomCurve3, Vector3, CylinderGeometry, TorusGeometry} from 'three';
import type {HumanRig} from '../rig';
import {gripFrame,type HandleGrip} from '../grip';

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
 *  - a document that never touches the channel is byte-identical to before
 *    (bevel 1 = no extra roll), and
 *  - the same bevel number means the same grip on either hand, so mirroring a
 *    document keeps its bevel (measured: the right palm rests on the local −X
 *    facet, the left — whose mount is the x-mirror — on local +X; both are
 *    facet centres of a prism built with thetaStart=π/8).
 * Rotating the racket never moves it relative to the hand: the tip sits on the
 * axis, the finger wrap solves around a circular handle, and no solved bone
 * reads the string-bed orientation. The bevel is an authoring choice, not a
 * solve input (see docs/decisions/0010-racket-bevels-hand-shape.md). */
export const RACKET_BEVELS=8;
/** Canonical bevel: the facet in the palm at the default mount. */
export const RACKET_BEVEL_DEFAULT=1;
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
/** Rotation about the handle axis that brings bevel `bevel` into the palm,
 * as a LOCAL post-rotation of the mounted racket (roll about local +Y).
 * Applied by mountRacket after the canonical mount, so it turns the string bed
 * and nothing else: the tip sits ON the axis (position unchanged) and the
 * finger wrap solves around a circular handle, so no solved bone reads it.
 * The sign is per side — see bevelSign: the left roll is the reflection of the
 * right one (R_y(α) conjugates to R_y(−α) across x=0). */
export function bevelRoll(side:'L'|'R',bevel?:number){
 return -bevelSign(side)*(normalizeBevel(bevel)-1)*BEVEL_STEP;
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
/** (Re)mount a racket on the requested wrist. The left mount is the exact
 * x-mirror of the right transform — bilateral wrist local frames coincide
 * with world axes at rest, so negating position.x and the quaternion's y/z
 * is the true mirrored mount: the head exits on the left thumb side and the
 * string bed faces the mirrored-palm direction. Computing the same
 * construction from the LEFT grip frame would instead point +Y along the
 * left axis — the head on the pinky side, a 180°-flipped handle — which is
 * why the mount mirrors a canonical transform instead.
 *
 * `bevel` rolls the racket about its own handle so the chosen facet sits in
 * the palm. The roll is a LOCAL post-rotation (q · R_y): the mirrored document
 * stays the exact x-mirror of the source, because a local yaw conjugates to its
 * own negation across x=0 and bevelRoll already carries the per-side sign. */
export function mountRacket(rig:HumanRig,racket:Group,side:'L'|'R'='R',bevel?:number){
  const t=racketLocalTransform(rig);
  racket.position.copy(t.position);racket.quaternion.copy(t.quaternion);
  if(side==='L'){
    racket.position.x=-racket.position.x;
    racket.quaternion.set(racket.quaternion.x,-racket.quaternion.y,-racket.quaternion.z,racket.quaternion.w);
  }
  const roll=bevelRoll(side,bevel);
  if(roll!==0)racket.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),roll));
  racket.removeFromParent();
  rig.bone(`wrist_${side}`).add(racket);
}
export function attachRacket(rig:HumanRig,side:'L'|'R'='R',bevel?:number){
  const racket=createRacket();mountRacket(rig,racket,side,bevel);return racket;
}
