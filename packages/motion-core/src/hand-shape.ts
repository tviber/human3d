import type {HumanRig} from './rig';
import type {HandJointPose} from './rig';
import {DEG} from './kinematics';
import type {Side} from './foot';

/** Finger shaper: one scalar per hand, from a closed fist (0) through the
 * relaxed hand (0.5) to a spread open hand (1). The relaxed value is the
 * ABSENT canonical form, so a document that never touches this channel solves
 * exactly as it did before the channel existed (verified bitwise against
 * `HumanRig.relaxHand`, see hand-shape.test.ts).
 *
 * The channel exists because hand shape is a pose, not a display option: a
 * fist, a relaxed hand and a spread hand read completely differently on
 * screen, and the previous rig could only express "relaxed" plus the wrap-grip
 * solve. It is deliberately ONE scalar rather than per-joint angles — the
 * authored key has to stay interpolatable through the same Hermite sampler as
 * every other channel, and a fist→open transition is exactly one number
 * crossing its range.
 *
 * Anchors are measured, not invented (hand-shape.test.ts pins them):
 *  - open: fingers slightly extended (mcp −6°, pip −2°, dip 0°) and abducted,
 *    thumb carried away from the palm;
 *  - relaxed: the legacy `relaxHand` angles (mcp 12°, pip 16°, dip 8°), thumb
 *    neutral — the value at 0.5 is bit-identical to the old solve;
 *  - fist: the punch action's articulated fist (mcp 78–86°, pip 92–98°,
 *    dip 58–62°) with the thumb closing across the index.
 *
 * Side handling: finger Flexion is identical on both hands, but the rig's
 * abduction and thumb-opposition axes are x-mirrored — the left hand needs the
 * opposite sign for the same visible motion (measured: spreading the right
 * hand needs negative abduction, the left positive; closing the thumb across
 * the palm needs positive opposition on the right, negative on the left).
 * Values below are authored for the RIGHT hand and negated for the left. */

export const FIST_SPREAD=0;
export const RELAXED_SPREAD=.5;
export const OPEN_SPREAD=1;

/** Clamp to the authored range. Non-finite input falls back to relaxed instead
 * of producing NaN quaternions downstream (the validator rejects such
 * documents; this keeps sampling robust if one ever leaks through). */
export function normalizeSpread(value?:number|null){
 return Number.isFinite(value as number)?Math.min(OPEN_SPREAD,Math.max(FIST_SPREAD,value as number)):RELAXED_SPREAD;
}

interface FingerAngles{mcp:number;pip:number;dip:number}
/** Right-hand authored anchors, degrees. The fist varies per digit the way a
 * real hand does; the open hand does not need that detail. */
const OPEN_FINGERS:FingerAngles={mcp:-6,pip:-2,dip:0};
const RELAXED_FINGERS:FingerAngles={mcp:12,pip:16,dip:8};
const FIST_FINGERS:Record<2|3|4|5,FingerAngles>={
 2:{mcp:78,pip:96,dip:60},3:{mcp:82,pip:98,dip:62},4:{mcp:84,pip:96,dip:62},5:{mcp:86,pip:92,dip:58}};
/** Abduction at the open anchor (degrees, right hand): the sign that SEPARATES
 * the fingers on the right is negative, so the left hand takes +. */
const OPEN_ABDUCTION=-14;

/** Per-digit abduction share at the open anchor — index and pinky carry the
 * spread, the middle pair barely moves (as on a real hand). */
const ABDUCTION_SHARE:Record<2|3|4|5,number>={2:1,3:.35,4:-.35,5:-1};

/** Thumb anchors, radians authored for the right hand. `cmcOpposition` is
 * negated for the left. The open thumb is carried away from the palm; the
 * fist thumb closes across the index base (measured residual 9 mm against the
 * rig's own punch pose). */
const OPEN_THUMB={cmcFlexion:-10*DEG,cmcOpposition:-30*DEG,mcp:0,ip:0};
const RELAXED_THUMB={cmcFlexion:0,cmcOpposition:0,mcp:0,ip:0};
const FIST_THUMB={cmcFlexion:44*DEG,cmcOpposition:40*DEG,mcp:-40*DEG,ip:-81.25*DEG};

/** Piecewise-linear blend between the anchors. Endpoints are returned exactly
 * (not as u=0/u=1 arithmetic) so spread=RELAXED_SPREAD reproduces the legacy
 * relaxed angles bit for bit. */
const lerp=(a:number,b:number,u:number)=>a+(b-a)*u;
const blendFingers=(from:FingerAngles,to:FingerAngles,u:number):FingerAngles=>
 u<=0?{...from}:u>=1?{...to}:{mcp:lerp(from.mcp,to.mcp,u),pip:lerp(from.pip,to.pip,u),dip:lerp(from.dip,to.dip,u)};
const blendThumb=(from:typeof OPEN_THUMB,to:typeof OPEN_THUMB,u:number):typeof OPEN_THUMB=>
 u<=0?{...from}:u>=1?{...to}:{
  cmcFlexion:lerp(from.cmcFlexion,to.cmcFlexion,u),cmcOpposition:lerp(from.cmcOpposition,to.cmcOpposition,u),
  mcp:lerp(from.mcp,to.mcp,u),ip:lerp(from.ip,to.ip,u)};

/** Joint targets for one hand at `spread`, in the rig's articulation
 * coordinates (radians). Below the relaxed knot the hand closes toward the
 * fist; above it the hand opens and the fingers abduct. */
export function handJointPose(side:Side,spread?:number|null):HandJointPose{
 const s=normalizeSpread(spread),mirror=side==='L'?-1:1;
 const half=RELAXED_SPREAD;
 const fist=s<=half;
 const u=fist?(half-s)/half:(s-half)/(OPEN_SPREAD-half);
 const fingers={} as HandJointPose['fingers'];
 for(const digit of [2,3,4,5] as const){
  const angles=fist?blendFingers(RELAXED_FINGERS,FIST_FINGERS[digit],u):blendFingers(RELAXED_FINGERS,OPEN_FINGERS,u);
  const abduction=fist?0:u*OPEN_ABDUCTION*ABDUCTION_SHARE[digit]*mirror*DEG;
  fingers[digit]={mcp:angles.mcp*DEG,pip:angles.pip*DEG,dip:angles.dip*DEG,...(abduction!==0?{abduction}:{})};
 }
 const thumb=fist?blendThumb(RELAXED_THUMB,FIST_THUMB,u):blendThumb(RELAXED_THUMB,OPEN_THUMB,u);
 return {thumb:{...thumb,cmcOpposition:thumb.cmcOpposition*mirror},fingers};
}

/** Write the shaped hand onto the rig. At the relaxed default this takes the
 * LEGACY path (relaxHand + identity thumb) so the quaternions are bit-for-bit
 * what the pre-channel solver wrote — articulateHand's axis-angle multiplies
 * introduce signed zeros (−0 vs +0 components) that would otherwise leak into
 * serialized package bytes for every untouched document. */
export function applyHandShape(rig:HumanRig,side:Side,spread?:number|null){
 if(normalizeSpread(spread)===RELAXED_SPREAD){
  rig.relaxHand(side);
  for(let joint=1;joint<=3;joint++)rig.bone(`finger1-${joint}_${side}`).quaternion.identity();
  return;
 }
 rig.articulateHand(side,handJointPose(side,spread));
}
