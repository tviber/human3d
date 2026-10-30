import {
  frameAt,HEAD_ROTATION_LIMITS,keyAt,nearestKey,sortedKeys,WORKSHOP_LIMITS,
  type FootTarget,type KeyConstraints,type PoseParams,type V3,type WorkshopDoc,type WorkshopKey,
} from '@human3d/motion-core';
import type {Vector3} from 'three';

/** Keys this close to the playhead are the same instant: the insertion reuses
 * that key as its first frame instead of stacking a duplicate timestamp. */
export const BASIC_ANCHOR_EPS=.01;
/** A distinct key just after an authored anchor can express liftoff without
 * changing the support state at the user's original key. */
const BASIC_BOUNDARY_EPS=.001;

export interface BasicInsertion{keyIds:string[];time:number;span:number}

interface FootDelta{target:V3;pole:V3;yaw:number;pitch:number}
/** Hand offsets translate target/pole only: a carry-hands template moves where
 * the hand reaches, but the wrist orientation stays as the playhead had it. */
interface HandDelta{target:V3;pole:V3}
/** A basic action is a relative motion: every key is an offset from its first key. */
interface PoseDelta{root:V3;yaw:number;lean:number;chest:number;side:number;headYaw:number;headPitch:number;footL:FootDelta;footR:FootDelta;
 handL:HandDelta;handR:HandDelta}

const EPS=1e-9;
const sub=(a:V3,b:V3):V3=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const add=(a:V3,b:V3):V3=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const isZero=(v:V3)=>Math.abs(v.x)<EPS&&Math.abs(v.y)<EPS&&Math.abs(v.z)<EPS;
/** Rotate a horizontal offset into the body frame: the same quaternion the
 * solver applies as root yaw (qY(θ)) turns the template's world-axis offsets
 * into body-relative ones, so a forward step stays forward when the playhead
 * state faces +x. Vertical components pass through untouched. */
const rotY=(v:V3,yaw:number):V3=>{
  const c=Math.cos(yaw*Math.PI/180),s=Math.sin(yaw*Math.PI/180);
  return {x:v.x*c+v.z*s,y:v.y,z:-v.x*s+v.z*c};
};
function footDelta(from:FootTarget,to:FootTarget):FootDelta{
  return {target:sub(to.target,from.target),pole:sub(to.pole,from.pole),yaw:to.yaw-from.yaw,pitch:to.pitch-from.pitch};
}
const footMoves=(d:FootDelta)=>!isZero(d.target)||!isZero(d.pole)||Math.abs(d.yaw)>EPS||Math.abs(d.pitch)>EPS;
function poseDelta(from:PoseParams,to:PoseParams):PoseDelta{
  const hand=(a:{target:V3;pole:V3},b:{target:V3;pole:V3}):HandDelta=>({target:sub(b.target,a.target),pole:sub(b.pole,a.pole)});
  return {root:sub(to.root,from.root),yaw:to.yaw-from.yaw,lean:to.lean-from.lean,chest:to.chest-from.chest,side:to.side-from.side,
   headYaw:(to.headYaw??0)-(from.headYaw??0),headPitch:(to.headPitch??0)-(from.headPitch??0),
   footL:footDelta(from.footL,to.footL),footR:footDelta(from.footR,to.footR),
   handL:hand(from.handL,to.handL),handR:hand(from.handR,to.handR)};
}
/** The state's pose with the action's offsets added, rotated into the state's
 * body frame (horizontal components turn with base.yaw). Hands are offset
 * only when the template declares carryHands — plain basic actions leave the
 * arms exactly where the playhead found them. */
function applyDelta(base:PoseParams,d:PoseDelta,carryHands=false):PoseParams{
  const foot=(f:FootTarget,e:FootDelta):FootTarget=>({target:add(f.target,rotY(e.target,base.yaw)),pole:add(f.pole,rotY(e.pole,base.yaw)),yaw:f.yaw+e.yaw,pitch:f.pitch+e.pitch});
  const hand=(f:{target:V3;pole:V3;forward:V3;normal:V3},e:HandDelta)=>({target:add(f.target,rotY(e.target,base.yaw)),pole:add(f.pole,rotY(e.pole,base.yaw)),forward:f.forward,normal:f.normal});
  const pose=structuredClone(base);
  pose.root=add(base.root,rotY(d.root,base.yaw));pose.yaw=base.yaw+d.yaw;pose.lean=base.lean+d.lean;pose.chest=base.chest+d.chest;pose.side=base.side+d.side;
  pose.headYaw=Math.max(HEAD_ROTATION_LIMITS.yaw[0],Math.min(HEAD_ROTATION_LIMITS.yaw[1],(base.headYaw??0)+d.headYaw));
  pose.headPitch=Math.max(HEAD_ROTATION_LIMITS.pitch[0],Math.min(HEAD_ROTATION_LIMITS.pitch[1],(base.headPitch??0)+d.headPitch));
  if(pose.headYaw===0)delete pose.headYaw;if(pose.headPitch===0)delete pose.headPitch;
  pose.footL=foot(base.footL,d.footL);pose.footR=foot(base.footR,d.footR);
  if(carryHands){pose.handL=hand(base.handL,d.handL);pose.handR=hand(base.handR,d.handR);}
  return pose;
}
function sequenceOf(basic:WorkshopDoc){
  const keys=sortedKeys(basic);
  if(keys.length<2)throw new Error(`基础动作 ${basic.name} 至少需要两个关键帧`);
  return {keys,span:keys[keys.length-1].time-keys[0].time};
}
const ceilingOf=(doc:Pick<WorkshopDoc,'duration'|'loop'>)=>doc.duration-(doc.loop?WORKSHOP_LIMITS.loopGap:0);

/** Why this basic action cannot be inserted at `time`, or undefined when it can.
 * Pure: the UI shows the message and leaves the document untouched. */
export function basicInsertRefusal(doc:WorkshopDoc,basic:WorkshopDoc,time:number):string|undefined{
  const {keys,span}=sequenceOf(basic);
  const anchor=nearestKey(doc,Math.max(0,Math.min(ceilingOf(doc),time)),BASIC_ANCHOR_EPS);
  const reused=anchor&&!needsConstraintBoundary(anchor,keys)?1:0;
  const added=basic.keys.length-reused;
  if(doc.keys.length+added>WORKSHOP_LIMITS.maxKeys)
   return `插入「${basic.name}」需要 ${added} 个关键帧，已达 ${WORKSHOP_LIMITS.maxKeys} 个上限，请先删除不需要的帧。`;
  if(doc.duration+span>WORKSHOP_LIMITS.maxDuration+EPS)
   return `插入「${basic.name}」后动作时长将超过 ${WORKSHOP_LIMITS.maxDuration}s 上限。`;
  return undefined;
}

function needsConstraintBoundary(anchor:WorkshopKey,seq:WorkshopKey[]):boolean{
 const deltas=seq.map(k=>poseDelta(seq[0].pose,k.pose));
 const movesFoot=(side:'L'|'R')=>deltas.some(d=>footMoves(side==='L'?d.footL:d.footR));
 return (['L','R'] as const).some(side=>{
  if(!movesFoot(side))return false;
  const flag=side==='L'?'plantL':'plantR';
  return anchor.constraints[flag]!==seq[0].constraints[flag];
 });
}

function newKeyId(doc:WorkshopDoc){
  let id='';
  do{id=`k${Math.random().toString(36).slice(2,8)}`;}while(keyAt(doc,id));
  return id;
}

/** Insert a basic action at the playhead, starting from the state there.
 *
 * - The action starts from the state at the playhead: an existing key within
 *   BASIC_ANCHOR_EPS is reused when its support flags match the action start;
 *   a distinct liftoff/plant boundary is added when they differ.
 * - Later keys are the state plus the action's offsets (root, spine, feet);
 *   hands are copied from the state, so the arms keep their pose — unless the
 *   template declares carryHands, in which case the hand target/pole offsets
 *   apply too (wrist orientation still stays as the playhead had it).
 * - Keys after the insertion point move by the action's span and the
 *   duration grows by the same amount (one ripple insert, one undo step).
 * - A foot the action moves follows the action's plant flags and is released
 *   at the last key; a foot it leaves in place keeps the state's contact, so
 *   it neither slides nor lifts off the floor.
 *
 * `origin` must be the rest root the caller samples with (see ensureKey).
 * Returns undefined and leaves `doc` untouched when the insertion is refused. */
export function insertBasicAction(doc:WorkshopDoc,basic:WorkshopDoc,time:number,origin:V3|Vector3,
 opts:{carryHands?:boolean}={}):BasicInsertion|undefined{
  if(!Number.isFinite(time)||basicInsertRefusal(doc,basic,time))return undefined;
  const {keys:seq,span}=sequenceOf(basic);
  const t=Math.max(0,Math.min(ceilingOf(doc),time));
  const anchor=nearestKey(doc,t,BASIC_ANCHOR_EPS);
  // Read the state before any mutation: the sampled pose uses the pre-insert timeline.
  const frame=anchor?undefined:frameAt(doc,t,origin);
  const start=anchor?anchor.time:t;
  const basePose=anchor?anchor.pose:frame!.pose;
  const baseCons=anchor?anchor.constraints:frame!.constraints;
  const deltas=seq.map(k=>poseDelta(seq[0].pose,k.pose));
  const last=seq.length-1;
  const movesFoot=(side:'L'|'R')=>deltas.some(d=>footMoves(side==='L'?d.footL:d.footR));
  const plant=(side:'L'|'R',j:number):boolean=>{
   const flag=side==='L'?'plantL':'plantR';
   if(!movesFoot(side))return baseCons[flag];
   return j<last&&seq[j].constraints[flag];
  };
  const consFor=(j:number):KeyConstraints=>({plantL:plant('L',j),plantR:plant('R',j),grip:baseCons.grip,contact:false});

  const keyIds:string[]=[];
  const boundary=anchor&&needsConstraintBoundary(anchor,seq);
  const insertedFrom=anchor?1:0;
  // The insertion point is the boundary: even keys only a few milliseconds
  // later belong to the old timeline and must ripple with the rest.
  const shifted=doc.keys.filter(k=>k!==anchor&&k.time>start);
  for(const k of shifted)k.time+=span;
  doc.duration+=span;
  if(anchor){
   if(boundary){
    // The original anchor remains authored exactly as-is. This adjacent key
    // starts the template's support state and gives contactPlan an explicit
    // liftoff/plant boundary before the action moves the foot.
    const key:WorkshopKey={id:newKeyId(doc),time:start+BASIC_BOUNDARY_EPS,
     label:`${basic.name} · ${seq[0].label}`,pose:applyDelta(basePose,deltas[0],opts.carryHands),constraints:consFor(0)};
    doc.keys.push(key);keyIds.push(key.id);
   }else keyIds.push(anchor.id);
  }
  for(let j=insertedFrom;j<seq.length;j++){
   const key:WorkshopKey={id:newKeyId(doc),time:start+seq[j].time-seq[0].time,label:`${basic.name} · ${seq[j].label}`,
    pose:applyDelta(basePose,deltas[j],opts.carryHands),constraints:consFor(j)};
   doc.keys.push(key);keyIds.push(key.id);
  }
  doc.keys.sort((a,b)=>a.time-b.time);
  return {keyIds,time:start,span};
}
