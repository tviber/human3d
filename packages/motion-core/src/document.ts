import {Matrix4,Quaternion,Vector3} from 'three';
import {DEG,smoothstep} from './kinematics';
import {WORKSHOP_LIMITS} from './limits';
import {RELAXED_SPREAD} from './hand-shape';
import {RACKET_BEVEL_DEFAULT} from './props/racket';
import type {Side} from './foot';

/** Trajectory-first motion document (schema v2): keyframes carry task-space
 * poses AND constraints (foot plants, grip, contact). MuJoCo dynamics is
 * deliberately absent — continuous motion comes from per-segment linear or bounded Hermite
 * in-betweens over effector targets, and plausibility is checked
 * kinematically (see solver.ts). */

export interface V3{x:number;y:number;z:number}
export const toV=(v:V3)=>new Vector3(v.x,v.y,v.z);
const fromV=(v:Vector3):V3=>({x:v.x,y:v.y,z:v.z});

export interface HandTarget{target:V3;pole:V3;forward:V3;normal:V3}
export interface FootTarget{target:V3;pole:V3;yaw:number;pitch:number}
/** Hand shape per side, 0 = closed fist, .5 = relaxed (the absent default),
 * 1 = spread open. A pose CHANNEL, not a display flag: it is sampled and
 * interpolated like every other pose value, so a fist can open over a
 * transition. Keys may name one side only. */
export interface HandSpread{L?:number;R?:number}
export interface PoseParams{
  /** Root offset from the rest pelvis origin, metres, world space. */
  root:V3;
  /** Engineering joint coordinates: yaw of the pelvis, then spine bend/twist/side in degrees. */
  yaw:number;lean:number;chest:number;side:number;
  handL:HandTarget;handR:HandTarget;
  footL:FootTarget;footR:FootTarget;
  /** Optional per-hand finger shape; an absent side is relaxed (.5). */
  handSpread?:HandSpread;
}
export interface KeyConstraints{
  /** A planted foot's contact (target, yaw, pitch) is held across the interval that starts at this key. */
  plantL:boolean;plantR:boolean;
  /** The gripping hand (WorkshopDoc.gripSide) keeps the wrap fingers and shows the racket. */
  grip:boolean;
  /** Contact event: the racket head position at this key is a target point. */
  contact:boolean;
}
export type KeyInterpolation='hermite'|'linear';
export interface WorkshopKey{id:string;time:number;label:string;pose:PoseParams;constraints:KeyConstraints;interpolation?:KeyInterpolation;videoTime?:number}
/** How a hand target is interpolated between keys: in world space, or in the
 * pelvis frame (the laboratory's convention, so a hand keeps its place on the
 * body while the trunk turns). Poles always stay in world space. */
export type HandFrame='world'|'pelvis';
export interface WorkshopDoc{
  schemaVersion:2;id:string;name:string;english:string;
  duration:number;inbetweens:boolean;
  /** Periodic motion: the key chain wraps so velocity, contacts and grip are continuous across the seam. */
  loop:boolean;
  handFrames:Record<Side,HandFrame>;
  /** Clavicle assist: the gripping shoulder girdle (gripSide) rides up with a
   * high hand target (the authored reach behaviour — the solver derives the
   * amount per frame). */
  clavicleLift?:boolean;
  /** Authoring policy: allow the arms and wrists beyond anatomical bend limits. */
  freeArms?:boolean;
  /** Which hand grips the racket: 'L' mirrors the whole grip stage — wrap
   * fingers, wrist cone, clavicle assist and racket mount — onto the left
   * wrist. Absent means 'R' (canonical form; normalizeDoc folds an explicit
   * 'R' back to absent so equivalent documents share fingerprints). The
   * side changes the solved trajectory, so it lives on the document, not
   * on presentation metadata. */
  gripSide?:Side;
  /** Which bevel (octagonal facet, 1–8) the palm rests on: the prop's own
   * orientation around the handle axis. Absent means 1 — the canonical facet
   * the default mount already puts in the palm, so pre-existing documents are
   * unchanged and normalizeDoc folds an explicit 1 back to absent.
   *
   * Document-level, like gripSide: a grip is chosen once and held. Unlike
   * gripSide it does NOT change the solved trajectory (the tip sits on the
   * handle axis and the wrap solves around a circular handle), so only the
   * prop's visual orientation depends on it — but it is authored data that
   * must survive export/import, so it lives in the document, not on a display
   * toggle. Numbering is palm-relative and side-signed, so the value is
   * PRESERVED by mirrorDoc (bevel k always means the same grip on either
   * hand). See docs/decisions/0010-racket-bevels-hand-shape.md. */
  gripBevel?:number;
  keys:WorkshopKey[];
}
export type DocLike=Pick<WorkshopDoc,'keys'|'duration'|'loop'|'handFrames'>;
/** Support weight of each foot in [0,1]: 1 = fully planted, 0 = free swing. */
export interface SupportWeights{L:number;R:number}
export interface EffectiveFrame{pose:PoseParams;constraints:KeyConstraints;keyIndex:number;support:SupportWeights;gripAmount:number;clavicleLift?:boolean;freeArms?:boolean;
 /** The document-level grip side flattened onto the frame — same delivery
  * pattern as clavicleLift, so solveEffectiveFrame sees it with no caller
  * contract change. Absent on hand-built frames means 'R'. */
 gripSide?:Side;
 /** The document-level bevel flattened onto the frame, same pattern as
  * gripSide. Absent means the canonical 1. Not a solve input (it only turns
  * the prop), so it is carried for the renderer's mount, never for the bones. */
 gripBevel?:number}

/** Grip closes and opens over this window after the key that toggles it. */
const GRIP_TRANSITION_S=.25;
/** κ of the Hermite tangent clamp: every interior tangent's magnitude is
 * capped at κ× the SMALLER adjacent secant rate (see the tan() comment for
 * why the larger secant can never bind). κ=3 is the classic monotone-cubic
 * bound (Fritsch–Carlson |m/s|≤3); κ=2 halves it.
 * Probe sweep @240fps (scripts/measure-quality-probe.mts, WP-C):
 *   defaultDocument channel overshoot sum over all intervals:
 *     ∞→12620mm · 1.2→7205 · 1.5→7865 · 2→8527 · 3→9814  (worst ch 97.7→76.8mm @κ2)
 *   forehand (dense 49-key) sampled-curve disturbance vs unclamped:
 *     1.2→1.91mm/0.137° · 1.5→1.27mm/0.128° · 2→1.12mm/0.112° · 3→1.04mm/0.081°
 * κ=2 removes ~⅓ of the sparse-doc overshoot while moving the dense baked
 * curve ≤1.12mm — inside the migration budgets; κ≥3 under-delivers on the
 * defect, κ≤1.5 flattens genuine acceleration into fast intervals. */
export const TANGENT_SECANT_CAP=2;
const ZERO_V3=new Vector3();

/** Deterministic flatten/unflatten so Hermite runs over every numeric field.
 * `handSpread` occupies the two TAIL channels (47 = L, 48 = R) so every
 * pre-existing channel index keeps its meaning — generate.ts's group ranges,
 * the property sweep's channel lists and any external reader stay valid. An
 * absent side flattens to RELAXED_SPREAD, and unflatten re-omits exactly that
 * value, so a document without hand shapes round-trips to the identical pose
 * object (no `handSpread` key appears out of nowhere). */
export function flattenPose(p:PoseParams):number[]{
  const out:number[]=[];
  const push=(v:V3)=>{out.push(v.x,v.y,v.z);};
  push(p.root);out.push(p.yaw,p.lean,p.chest,p.side);
  for(const h of [p.handL,p.handR]){push(h.target);push(h.pole);push(h.forward);push(h.normal);}
  for(const f of [p.footL,p.footR]){push(f.target);push(f.pole);out.push(f.yaw,f.pitch);}
  out.push(p.handSpread?.L??RELAXED_SPREAD,p.handSpread?.R??RELAXED_SPREAD);
  return out;
}
export function unflattenPose(a:number[]):PoseParams{
  let i=0;
  const vec=():V3=>({x:a[i++],y:a[i++],z:a[i++]});
  const num=()=>a[i++];
  const pose:PoseParams={root:vec(),yaw:num(),lean:num(),chest:num(),side:num(),
    handL:{target:vec(),pole:vec(),forward:vec(),normal:vec()},
    handR:{target:vec(),pole:vec(),forward:vec(),normal:vec()},
    footL:{target:vec(),pole:vec(),yaw:num(),pitch:num()},
    footR:{target:vec(),pole:vec(),yaw:num(),pitch:num()}};
  /* Short arrays come from callers that flattens predate the tail channels
   * (a stored pose handed straight to unflattenPose); they mean relaxed. */
  const spread=(value:number|undefined)=>(Number.isFinite(value)?value:RELAXED_SPREAD) as number;
  const l=spread(a[i]),r=spread(a[i+1]);
  if(l!==RELAXED_SPREAD||r!==RELAXED_SPREAD){
   pose.handSpread={};
   if(l!==RELAXED_SPREAD)pose.handSpread.L=l;
   if(r!==RELAXED_SPREAD)pose.handSpread.R=r;
  }
  return pose;
}

/** Hand forward/normal are an orthonormal basis by contract: normalize f and
 * orthogonalize n against it. Applied at document boundaries (seed, parse) so
 * sampled quat frames reproduce stored key values bit-for-bit. */
export function canonicalizeHands(p:PoseParams){
 for(const h of [p.handL,p.handR]){
  const f=toV(h.forward);
  if(f.lengthSq()<1e-12)f.set(0,0,1);
  f.normalize();h.forward=fromV(f);
  const n=toV(h.normal);
  n.addScaledVector(f,-n.dot(f));
  if(n.lengthSq()<1e-12){n.set(f.y,f.z,f.x);n.addScaledVector(f,-n.dot(f));}
  n.normalize();h.normal=fromV(n);
 }
}
const clonePose=(p:PoseParams):PoseParams=>unflattenPose(flattenPose(p));

/* ---- Channel layout (flattenPose): root 0–2 · yaw 3 · lean 4 · chest 5 · side 6
 * handL target 7–9, pole 10–12, forward 13–15, normal 16–18 · handR 19–21, 22–24, 25–27, 28–30
 * footL target 31–33, pole 34–36, yaw 37, pitch 38 · footR 39–41, 42–44, 45, 46
 * handSpread L 47, R 48 (finger shape — appended, so no old index moved) */
const ANGLE_CHANNELS=[3,4,5,6,37,38,45,46];
const FOOT_CH:Record<Side,number>={L:31,R:39};
const HAND_CH:Record<Side,number>={L:7,R:19};
/** Finger-shape channels, in the same L/R order as HAND_CH. */
export const SPREAD_CH:Record<Side,number>={L:47,R:48};
/** A contact locks the foot's target position AND its yaw/pitch. */
const lockedChannels=(ch:number)=>[ch,ch+1,ch+2,ch+6,ch+7];
const LOCK_SIDE=new Map<number,Side>();
for(const s of ['L','R']as const)for(const c of lockedChannels(FOOT_CH[s]))LOCK_SIDE.set(c,s);

const unwrapAngle=(prev:number,v:number)=>v+360*Math.round((prev-v)/360);
const yawQuat=(deg:number)=>new Quaternion().setFromAxisAngle(new Vector3(0,1,0),deg*DEG);
const vecAt=(a:number[],i:number)=>new Vector3(a[i],a[i+1],a[i+2]);
function setVecAt(a:number[],i:number,v:Vector3){a[i]=v.x;a[i+1]=v.y;a[i+2]=v.z;}
/** Orthonormal frame quaternion from a forward/normal pair; squads of these
 * keep every in-between a valid frame (never a scalar lerp of directions). */
function frameQuat(fw:Vector3,nm:Vector3){
  const f=fw.clone();if(f.lengthSq()<1e-10)f.set(0,0,1);f.normalize();
  const n=nm.clone();n.addScaledVector(f,-n.dot(f));
  if(n.lengthSq()<1e-10){n.set(f.y,f.z,f.x);n.addScaledVector(f,-n.dot(f));}
  n.normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(f,n,new Vector3().crossVectors(f,n)));
}
const basisVec=(q:Quaternion,x:number,y:number,z:number)=>new Vector3(x,y,z).applyQuaternion(q);
/** Unit-quaternion log: q ↦ axis·(θ/2) as a pure-vector quaternion (a Vector3
 * carrier), the inverse of quatExp. This is the convention in which
 * slerp(a,b,u) = a·(a⁻¹b)^u = a·exp(u·ln(a⁻¹b)), so logs compose/scale like
 * tangent-space vectors and d/du exp(uL) = exp(uL)·L. */
const quatLn=(q:Quaternion)=>{
  const s=Math.hypot(q.x,q.y,q.z);
  if(s<1e-15)return new Vector3();
  const h=Math.atan2(s,q.w); // θ/2 ∈ [0,π]
  return new Vector3(q.x,q.y,q.z).multiplyScalar(h/s);
};
/** Quaternion exponential of a pure-vector quaternion v ↦ [v̂·sin|v|, cos|v|];
 * quatLn's inverse. */
const quatExp=(v:Vector3)=>{
  const h=v.length();
  if(h<1e-15)return new Quaternion();
  const s=Math.sin(h)/h;
  return new Quaternion(v.x*s,v.y*s,v.z*s,Math.cos(h));
};
/** One key's squad data on the chain: `q` is the hemisphere-continued frame
 * quaternion; `T` its body-frame angular-velocity tangent — in the quatLn
 * half-angle convention (vec(q⁻¹q̇)=ω_body/2, so |T| is half the physical
 * rad/s rate), shared by the intervals on both sides → C¹; `b` the outgoing
 * secant log ln(q⁻¹q_next) — undefined on the last chain entry. */
interface SquadKey{q:Quaternion;T:Vector3;b?:Vector3}

/** Contact plan for one foot over the real keys. A run of planted keys holds
 * the contact (target, yaw, pitch) of its first key; the first unplanted key
 * after the run inherits that contact at its key instant, so liftoff never
 * teleports the foot, and every planted key is flagged `rest` (zero tangent).
 * Loops use cyclic adjacency; a fully planted loop anchors on key 0. */
interface ContactPlan{override:(number[]|undefined)[];rest:boolean[]}
function contactPlan(keys:WorkshopKey[],side:Side,loop:boolean,raw:number[][]):ContactPlan{
  const n=keys.length,flag=side==='L'?'plantL':'plantR',chans=lockedChannels(FOOT_CH[side]);
  const planted=keys.map(k=>k.constraints[flag]);
  const before=(j:number)=>loop?planted[(j-1+n)%n]:(j>0&&planted[j-1]);
  let start=0;
  if(loop){const s=planted.findIndex((p,j)=>p&&!planted[(j-1+n)%n]);start=s<0?0:s;}
  const override:(number[]|undefined)[]=new Array(n).fill(undefined);
  const rest=new Array<boolean>(n).fill(false);
  let contact:number[]|undefined;
  for(let k=0;k<n;k++){
    const j=loop?(start+k)%n:k,p=before(j);
    if(planted[j]&&(!p||!contact))contact=chans.map(c=>raw[j][c]);
    if(contact&&(planted[j]||p)){override[j]=contact;rest[j]=true;}
  }
  return {override,rest};
}

/** One real key as the sampler sees it. `flat` is world space with contacts
 * applied; `interp` is what Hermite runs over (pelvis-frame hands converted,
 * angles unwrapped along the chain). */
interface Entry{time:number;real:number;flat:number[];interp:number[];interpolation:KeyInterpolation;plant:Record<Side,boolean>;grip:boolean;rest:Record<Side,boolean>}
interface Model{keys:WorkshopKey[];entries:Entry[];chain:Entry[];duration:number;handFrames:Record<Side,HandFrame>;origin:Vector3;
 /** Per-side SO(3) cubic keys aligned to `chain` (index-for-index): hand
  * forward/normal frames as quaternions plus their per-key tangents. */
 squad:Record<Side,SquadKey[]>}

/** Build the sampling model once per evaluation. For loops the chain is
 * [last−D, …keys…, first+D] so the seam uses real neighbours on both sides.
 * Exported so batch consumers can hoist the per-call preprocessing out of a
 * sampling loop (frameFromModel); the Model type itself stays private —
 * callers hold it as ReturnType<typeof buildModel>. */
export function buildModel(doc:DocLike,origin:V3|Vector3):Model{
  const keys=sortedKeys(doc),n=keys.length,o=new Vector3(origin.x,origin.y,origin.z);
  const raw=keys.map(k=>flattenPose(k.pose));
  const plans={L:contactPlan(keys,'L',doc.loop,raw),R:contactPlan(keys,'R',doc.loop,raw)};
  const flat=raw.map(a=>a.slice());
  const rest={L:new Array<boolean>(n).fill(false),R:new Array<boolean>(n).fill(false)};
  for(const s of ['L','R']as const){
    const chans=lockedChannels(FOOT_CH[s]),plan=plans[s];
    for(let j=0;j<n;j++){
      rest[s][j]=plan.rest[j];
      const vals=plan.override[j];
      if(vals)chans.forEach((c,idx)=>{flat[j][c]=vals[idx];});
    }
  }
  const interp=flat.map(a=>a.slice());
  for(const s of ['L','R']as const){
    if(doc.handFrames?.[s]!=='pelvis')continue;
    const b=HAND_CH[s];
    for(let j=0;j<n;j++){
      const f=flat[j],inv=yawQuat(f[3]).invert(),root=vecAt(f,0);
      setVecAt(interp[j],b,vecAt(f,b).sub(o).sub(root).applyQuaternion(inv));
      setVecAt(interp[j],b+6,vecAt(f,b+6).applyQuaternion(inv));
      setVecAt(interp[j],b+9,vecAt(f,b+9).applyQuaternion(inv));
    }
  }
  const entries:Entry[]=keys.map((k,j)=>({time:k.time,real:j,flat:flat[j],interp:interp[j],interpolation:k.interpolation??'hermite',
    plant:{L:k.constraints.plantL,R:k.constraints.plantR},grip:k.constraints.grip,rest:{L:rest.L[j],R:rest.R[j]}}));
  let chain=entries;
  if(doc.loop&&n>=2){
    // Two periodic copies on each side give every interval in [0, D] a real
    // neighbour on both sides, so the tangent at the seam is the same
    // Catmull-Rom tangent from either direction (no velocity step).
    const D=doc.duration;
    chain=[];
    for(let j=-2;j<=n+1;j++){
      const src=entries[((j%n)+n)%n],shift=Math.floor(j/n)*D;
      chain.push({...src,time:src.time+shift,flat:src.flat.slice(),interp:src.interp.slice()});
    }
  }
  for(const c of ANGLE_CHANNELS)for(let j=1;j<chain.length;j++)chain[j].interp[c]=unwrapAngle(chain[j-1].interp[c],chain[j].interp[c]);
  /* Hand direction frames: quaternion chain + per-key tangents for the
   * SO(3) cubic in interpolate(). The frames live in the same coordinates
   * interpolate() samples — the `interp` arrays, already pelvis-rotated
   * where handFrames says so — so world and pelvis hands share this code
   * (learning[16]). */
  const squad:Record<Side,SquadKey[]>={L:[],R:[]};
  for(const s of ['L','R']as const){
    const b=HAND_CH[s],len=chain.length;
    const qs=chain.map(e=>frameQuat(vecAt(e.interp,b+6),vecAt(e.interp,b+9)));
    /* Hemisphere continuity along the WHOLE chain — the same contract
     * unwrapAngle gives ANGLE_CHANNELS. A sign flip mid-chain is the same
     * rotation, but it turns the log maps' short arcs into spurious ~360°
     * excursions in every tangent the pair feeds; per-segment dot<0 repair
     * (the old slerp path) fixed only the endpoint pair. Loop ghosts unwrap
     * with the chain, so their q can sit antipodal to the real key's — the
     * sampled ROTATIONS and their derivatives are unaffected either way. */
    for(let j=1;j<len;j++)if(qs[j-1].dot(qs[j])<0)qs[j].set(-qs[j].x,-qs[j].y,-qs[j].z,-qs[j].w);
    const sq=qs.map((q,j)=>{
      const inv=q.clone().invert();
      const lPrev=j>0?quatLn(inv.clone().multiply(qs[j-1])):undefined;   // a = ln(q_j⁻¹q_{j−1})
      const lNext=j<len-1?quatLn(inv.clone().multiply(qs[j+1])):undefined; // b = ln(q_j⁻¹q_{j+1})
      /* Interior key: body-frame angular-velocity tangent T_j = (b−a)/
       * (t_{j+1}−t_{j−1}) — a quatLn half-angle rate like every T here
       * (=|ω|/2 physical rad/s); the exact quaternion analogue of the
       * centre difference tan() uses for the scalar channels, so the curve
       * is C¹
       * in TIME through non-uniform keys (solving the per-segment
       * derivatives for a shared per-key tangent, not just the per-unit-u
       * match the standard s_i formula gives). Magnitude-capped at
       * κ·min adjacent secant rate — the same TANGENT_SECANT_CAP contract
       * as tan(), read on |a|/dt_L and |b|/dt_R.
       * Endpoint convention: zero tangent — the same rest tangent the
       * scalar tan() assigns to chain ends, so a document starts and stops
       * rotating. Loop real keys always take this interior branch; the two
       * INNER ghost entries do too — they have chain neighbours on both
       * sides, which by periodicity are the same rotations at the same Δt
       * as their source key's, so the branch already emits the source
       * key's tangent (the seam stays C¹ with no copy). */
      let T=new Vector3();
      if(lPrev&&lNext){
        const dtL=chain[j].time-chain[j-1].time,dtR=chain[j+1].time-chain[j].time;
        T=lNext.clone().sub(lPrev).multiplyScalar(1/(dtL+dtR));
        const cap=TANGENT_SECANT_CAP*Math.min(lPrev.length()/dtL,lNext.length()/dtR);
        if(T.length()>cap)T.multiplyScalar(cap/T.length());
      }
      return {q,T,b:lNext};
    });
    /* No ghost-tangent copy step here: the chain is TWO ghosts deep per
     * side, so the entries bounding the sampled [0, D] span — chain[1] and
     * chain[len−2], the inner ghosts of the last/first real keys — are
     * interior nodes whose tangents the map above already computes to the
     * source key's value. The outermost ghosts chain[0]/chain[len−1] keep
     * the endpoint rest tangent like scalar tan() does, and no read ever
     * reaches them: interpolate() resolves intervals with i≥2 for t≥0
     * (chain[2] is real key 0 at t=0), and i=len−2 occurs only at t=D
     * where u=0 annihilates every tangent term. A former version copied
     * sq[0]←sq[len−2]/sq[len−1]←sq[1] — written against a one-deep ghost
     * chain; on the two-deep chain those indices were ghost←ghost
     * misplants (the sources would be sq[n]/sq[3]) on entries that are
     * never consumed. */
    squad[s]=sq;
  }
  return {keys,entries,chain,duration:doc.duration,handFrames:doc.handFrames,origin:o,squad};
}

/** Support weight of one foot over the interval starting at chain index i.
 * Planted intervals are 1. A free interval fades out from a planted start
 * (lift-off) or fades in toward a planted end (landing), so the pelvis
 * correction that depends on it is continuous through every support change. */
function supportWeight(chain:Entry[],i:number,u:number,s:Side){
  const at=(j:number)=>j>=0&&j<chain.length?chain[j].plant[s]:false;
  if(at(i))return 1;
  const k=smoothstep(u);
  return Math.max(at(i-1)?1-k:0,at(i+1)?k:0);
}
/** Index of the key whose state governs `time`: the last chain entry starting at or before it. */
function governingIndex(chain:Entry[],time:number){
  let k=0;while(k<chain.length-1&&time>=chain[k+1].time-1e-9)k++;
  return k;
}
/** Grip amount at `time`. A key whose grip flag differs from its predecessor
 * starts a ramp at its own time, over min(GRIP_TRANSITION_S, the interval
 * before it), so the fingers never snap. Times after the last key hold it. */
function gripAmountAt(chain:Entry[],k:number,time:number){
  const e=chain[k],prev=chain[k-1];
  if(!prev||prev.grip===e.grip)return e.grip?1:0;
  const w=Math.min(GRIP_TRANSITION_S,e.time-prev.time);
  if(w<=1e-9)return e.grip?1:0;
  const s=smoothstep(Math.max(0,Math.min(1,(time-e.time)/w)));
  return e.grip?s:1-s;
}

interface Interpolated{pose:PoseParams;i:number;t0:number;dt:number;support:SupportWeights;grip:number}
function interpolate(m:Model,time:number):Interpolated{
  const {chain,origin:o}=m,len=chain.length;
  let i=0;while(i<len-2&&time>=chain[i+1].time)i++;
  const t0=chain[i].time,t1=chain[i+1].time,dt=t1-t0;
  const u=dt>1e-9?Math.max(0,Math.min(1,(time-t0)/dt)):0;
  const val=(j:number,c:number)=>chain[Math.max(0,Math.min(len-1,j))].interp[c];
  const restAt=(j:number,c:number)=>{const s=LOCK_SIDE.get(c);return s!==undefined&&chain[j].rest[s];};
  /* Nonuniform-Catmull-Rom centre difference, magnitude-capped at κ× the
   * smaller adjacent secant rate (TANGENT_SECANT_CAP). The centre
   * difference is a dt-weighted mean of the two secants, so it always lies
   * inside their magnitude range — capping at the LARGER secant could never
   * bind. What whips the segment is a tangent inflated by the fast
   * neighbour being applied inside the SLOW interval (|m·dt| ≫ |Δv|): the
   * cap therefore reads the smaller secant, the only per-key bound that
   * limits overshoot into both intervals while keeping one tangent value
   * per key (C¹ preserved). Symmetric in sign and direction, so loop ghost
   * copies get the identical tangent from either side and the seam stays
   * continuous. κ = TANGENT_SECANT_CAP, chosen by probe sweep (see the
   * const's comment). */
  const tan=(j:number,c:number)=>{
   if(j<=0||j>=len-1||restAt(j,c))return 0;
   const m=(val(j+1,c)-val(j-1,c))/(chain[j+1].time-chain[j-1].time);
   const sL=Math.abs((val(j,c)-val(j-1,c))/(chain[j].time-chain[j-1].time));
   const sR=Math.abs((val(j+1,c)-val(j,c))/(chain[j+1].time-chain[j].time));
   const cap=TANGENT_SECANT_CAP*Math.min(sL,sR);
   return m>cap?cap:m<-cap?-cap:m;
  };
  const width=chain[0].interp.length,out=new Array<number>(width);
  for(let c=0;c<width;c++){
    if(chain[i].interpolation==='linear')out[c]=val(i,c)+(val(i+1,c)-val(i,c))*u;
    else{
      const m0=tan(i,c),m1=tan(i+1,c);
      out[c]=(2*u**3-3*u*u+1)*val(i,c)+(u**3-2*u*u+u)*dt*m0+(-2*u**3+3*u*u)*val(i+1,c)+(u**3-u*u)*dt*m1;
    }
  }
  // A release key (planted run ends here) starts a swing: at its key instant
  // the foot is still at the inherited contact, so the key's stored target
  // is a mid-swing waypoint. In Hermite mode contact → waypoint → next target is C¹ and the
  // foot leaves the ground instead of sliding along it (拖步 only when the
  // stored target is itself at ground level).
  for(const s of ['L','R']as const){
    if(i<=0||chain[i].plant[s]||!chain[i-1].plant[s])continue;
    const ch=FOOT_CH[s],foot=s==='L'?'footL':'footR',mid=t0+dt/2,half=dt/2;
    const stored=m.keys[chain[i].real].pose[foot].target;
    // The two-piece swing is defined on [t0, t0+dt] only. Tail evaluations
    // (time after the last key) still land in this governing interval, so
    // clamp: an unclamped uu>1 turns the Hermite into cubic extrapolation
    // and the foot target diverges instead of holding the next key's value.
    const tc=Math.max(t0,Math.min(t0+dt,time));
    for(let c=0;c<3;c++){
      const ax=(['x','y','z']as const)[c];
      const a=chain[i].interp[ch+c],cc=chain[i+1].interp[ch+c],b=stored[ax];
      const chord=(cc-a)/dt;
      const end=i+1>=len-1||restAt(i+1,ch+c)?0:(val(i+2,ch+c)-val(i,ch+c))/(chain[i+2].time-t0);
      const h=(uu:number,v0:number,v1:number,m0:number,m1:number)=>
        (2*uu**3-3*uu*uu+1)*v0+(uu**3-2*uu*uu+uu)*half*m0+(-2*uu**3+3*uu*uu)*v1+(uu**3-uu*uu)*half*m1;
      if(chain[i].interpolation==='linear')out[ch+c]=tc<=mid
        ?a+(b-a)*((tc-t0)/half):b+(cc-b)*((tc-mid)/half);
      else out[ch+c]=tc<=mid?h((tc-t0)/half,a,b,0,chord):h((tc-mid)/half,b,cc,chord,end);
    }
  }
  const pose=unflattenPose(out);
  const Rt=yawQuat(out[3]),root=vecAt(out,0);
  for(const s of ['L','R']as const){
    const hand=s==='L'?pose.handL:pose.handR,b=HAND_CH[s],pelvis=m.handFrames[s]==='pelvis';
    if(pelvis)hand.target=fromV(vecAt(out,b).applyQuaternion(Rt).add(o).add(root));
    /* In Hermite mode, SO(3) cubic through the key frames — a corrected-slerp form of squad:
     *   q(u) = slerp(q_i, q_{i+1}, u) · exp( u(1−u)·(d0 + u·d1) )
     *   d0 = T_i·dt − b,  d1 = 2b − (T_i + T_{i+1})·dt
     * where b = ln(q_i⁻¹q_{i+1}) is the segment's secant log and T_j the
     * per-key body tangent. The right-multiplied correction vanishes at both
     * ends (the curve passes through q_i, q_{i+1} exactly) and produces the
     * key tangents: q⁻¹q'(0)/dt = T_i, q⁻¹q'(1)/dt = T_{i+1} — C¹ in time
     * for ANY T_j, including the capped/endpoint values chosen in
     * buildModel (q⁻¹q̇ is the half-angle body rate, ω_body = 2·vec(q⁻¹q̇)).
     * Chosen over the literal Shoemake double-slerp: with the
     * sparse large-rotation keys this document family produces (≥90° between
     * 0.15 s keys), Shoemake's inner slerp s_i→s_{i+1} walks ~180° off the
     * chord (dot(A,B)→0), the outer slerp's hemisphere choice flips and the
     * OUTPUT rotation jumps — a C0 defect worse than the one being fixed
     * (measured: ~120° sampled jump on defaultDocument handR, solved
     * wrist_R 101.7 rad/s). The correction form can never go antipodal: it
     * is a bounded relative-rotation bump, max measured deviation 0.11 rad
     * off the chord on defaultDocument; the per-segment slerp it replaces
     * held a constant angular rate inside each interval, so its direction
     * changed stepwise at every key — a C⁰ velocity the 0.61 m racket lever
     * turned into measured tip kicks. */
    const k0=m.squad[s][i],k1=m.squad[s][i+1];
    const q=k0.q.clone().slerp(k1.q,u);
    if(chain[i].interpolation!=='linear'){
      const b2=k0.b!;
      const d0=k0.T.clone().multiplyScalar(dt).sub(b2);
      const d1=b2.clone().multiplyScalar(2).sub(k0.T.clone().add(k1.T).multiplyScalar(dt));
      const e=d0.add(d1.multiplyScalar(u)).multiplyScalar(u*(1-u));
      q.multiply(quatExp(e));
    }
    const f=basisVec(q,1,0,0),nn=basisVec(q,0,1,0);
    if(pelvis){f.applyQuaternion(Rt);nn.applyQuaternion(Rt);}
    hand.forward=fromV(f);hand.normal=fromV(nn);
  }
  return {pose,i,t0,dt,support:{L:supportWeight(chain,i,u,'L'),R:supportWeight(chain,i,u,'R')},grip:gripAmountAt(chain,governingIndex(chain,time),time)};
}

/** Interpolated pose at time t using each key's outgoing curve, regardless of the in-between flag. */
export function samplePose(doc:DocLike,time:number,origin:V3|Vector3=ZERO_V3):PoseParams{
  return interpolate(buildModel(doc,origin),Math.max(0,Math.min(doc.duration,time))).pose;
}
export function constraintsAt(keys:WorkshopKey[],time:number):{constraints:KeyConstraints;keyIndex:number}{
  let i=0;while(i<keys.length-1&&time>=keys[i+1].time-1e-9)i++;
  if(time<keys[0].time)i=0;
  return {constraints:keys[i].constraints,keyIndex:i};
}
/** Effective frame at time t. With in-betweens off, the frame is the stored key
 * after the contact rewrite (the same numbers the selected curve reaches at key
 * instants), with no support fades and no grip ramp. */
export function frameAt(doc:WorkshopDoc,time:number,origin:V3|Vector3=ZERO_V3):EffectiveFrame{
  return frameFromModel(buildModel(doc,origin),doc,time);
}
/** frameAt over an already-built model — the body of frameAt minus the
 * per-call buildModel, for batch consumers that hoist the preprocessing.
 * `m` must come from buildModel(doc, …) on THIS document. Param 2 is narrowed
 * to exactly the doc fields it reads so a CompiledMotion (which carries those
 * four fields verbatim) satisfies it directly; full WorkshopDocs still fit. */
export function frameFromModel(m:Model,doc:Pick<WorkshopDoc,'duration'|'inbetweens'|'gripSide'|'gripBevel'|'clavicleLift'|'freeArms'>,time:number):EffectiveFrame{
  const t=Math.max(0,Math.min(doc.duration,time)),side:Side=doc.gripSide==='L'?'L':'R';
  if(!doc.inbetweens){
    const {keyIndex,constraints}=constraintsAt(m.keys,t),e=m.entries[keyIndex];
    return {pose:unflattenPose(e.flat.slice()),constraints:{...constraints},keyIndex,
      support:{L:e.plant.L?1:0,R:e.plant.R?1:0},gripAmount:e.grip?1:0,clavicleLift:doc.clavicleLift,freeArms:doc.freeArms,gripSide:side,gripBevel:doc.gripBevel};
  }
  const r=interpolate(m,t),k=m.chain[r.i].real;
  return {pose:r.pose,constraints:{...m.keys[k].constraints},keyIndex:k,support:r.support,gripAmount:r.grip,clavicleLift:doc.clavicleLift,freeArms:doc.freeArms,gripSide:side,gripBevel:doc.gripBevel};
}

/** Recursively Object.freeze a plain-JSON value — pojos, arrays and
 * primitives only (WorkshopKey contains no class instances, so the whole
 * cloned key chain is covered). Mutating a frozen key throws a TypeError in
 * strict mode instead of silently shifting the sampled trajectory. */
const freezeDeep=<T,>(v:T):T=>{
 if(v&&typeof v==='object'){
  for(const x of Object.values(v))freezeDeep(x);
  Object.freeze(v);
 }
 return v;
};

/** Immutable compiled snapshot of a WorkshopDoc: every doc-derived input is
 * cloned at compile time — poses through the flatten/unflatten round-trip
 * that covers all PoseParams fields, constraints by spread — and each cloned
 * key is deep-frozen, so sampling can never observe a later in-place edit of
 * the source document (and an accidental write into the snapshot throws).
 * `model` is opaque: the Model type stays private and is deliberately NOT
 * deep-frozen (the PR-C hook) — consumers treat the whole snapshot as
 * read-only and sample it only through frameAtCompiled/sampleMotion. */
export interface CompiledMotion{
 /** Identity of the source document — provenance only; the sampler never reads it. */
 docId:string;
 /** Key count at compile time. */
 keyCount:number;
 duration:number;
 inbetweens:boolean;
 loop:boolean;
 gripSide?:Side;
 /** Prop bevel (1–8; absent = 1) — visual orientation only, never a solve input. */
 gripBevel?:number;
 clavicleLift?:boolean;
 freeArms?:boolean;
 /** The origin buildModel baked into the snapshot — a fresh Vector3 owned by
  * the model (compile already clones the caller's argument). Exposed so an
  * invalidation check can compare the compiled origin against the live
  * rig.rest root; aliasing the caller's vector would make that check
  * vacuous. */
 origin:Vector3;
 model:Model;
}

/** Compile `doc` into a frozen sampling snapshot: clone+freeze the keys,
 * then run buildModel's full preprocessing (contact plans, pelvis-frame
 * conversion, angle unwrap, tangent caps, squad chain) once over a doc-lite
 * carrying ONLY the fields buildModel reads — keys, duration, loop,
 * handFrames. The snapshot's `origin` is model.origin — the vector the
 * engine's rest-root invalidation check compares against — never an alias
 * of the caller's argument. */
export function compileMotion(doc:WorkshopDoc,origin:V3|Vector3=ZERO_V3):CompiledMotion{
 const keys=doc.keys.map(k=>freezeDeep<WorkshopKey>({...k,pose:clonePose(k.pose),constraints:{...k.constraints}}));
 const model=buildModel({keys,duration:doc.duration,loop:doc.loop,handFrames:{...doc.handFrames}},origin);
 return Object.freeze({docId:doc.id,keyCount:keys.length,duration:doc.duration,inbetweens:doc.inbetweens,loop:doc.loop,
  gripSide:doc.gripSide,gripBevel:doc.gripBevel,clavicleLift:doc.clavicleLift,freeArms:doc.freeArms,origin:Object.freeze(model.origin),model});
}
/** frameAt over a compiled snapshot — the single sampling entry point for
 * batch consumers: the same EffectiveFrame, with the per-call buildModel
 * already paid once at compile. */
export function frameAtCompiled(c:CompiledMotion,time:number):EffectiveFrame{
 return frameFromModel(c.model,c,time);
}
/** Interpolated pose at time t over a compiled snapshot (using each key's outgoing curve,
 * regardless of the in-between flag) — samplePose minus the per-call
 * buildModel, same duration clamp. */
export function sampleMotion(c:CompiledMotion,time:number):PoseParams{
 return interpolate(c.model,Math.max(0,Math.min(c.duration,time))).pose;
}

export const sortedKeys=(doc:{keys:WorkshopKey[]})=>[...doc.keys].sort((a,b)=>a.time-b.time);

/** True when key `index` ends a planted run for this foot (a swing starts here). */
export function isReleaseKey(doc:DocLike,index:number,side:Side){
  const keys=sortedKeys(doc),n=keys.length,flag=side==='L'?'plantL':'plantR';
  if(index<0||index>=n||keys[index].constraints[flag])return false;
  const p=index>0?index-1:(doc.loop?n-1:-1);
  return p>=0&&keys[p].constraints[flag];
}
/** The key that owns the contact governing time t: the first key of the planted run. */
export function contactStartKey(doc:DocLike&{keys:WorkshopKey[]},side:Side,time:number):WorkshopKey|undefined{
  const keys=sortedKeys(doc),n=keys.length,flag=side==='L'?'plantL':'plantR';
  if(!n)return undefined;
  const {keyIndex}=constraintsAt(keys,time);
  if(!keys[keyIndex].constraints[flag])return undefined;
  if(doc.loop&&keys.every(k=>k.constraints[flag]))return keys[0];
  let j=keyIndex;
  for(let guard=0;guard<n;guard++){
    const p=j>0?j-1:(doc.loop?n-1:-1);
    if(p<0||!keys[p].constraints[flag])break;
    j=p;
  }
  return keys[j];
}

export function keyAt(doc:WorkshopDoc,id:string){return doc.keys.find(k=>k.id===id);}
function insertKey(doc:WorkshopDoc,key:WorkshopKey){doc.keys.push(key);doc.keys.sort((a,b)=>a.time-b.time);}
export function nearestKey(doc:WorkshopDoc,time:number,eps=.02){
  let best:WorkshopKey|undefined,bd=Infinity;
  for(const k of doc.keys){const d=Math.abs(k.time-time);if(d<bd){bd=d;best=k;}}
  return bd<=eps?best:undefined;
}
/** Auto-key: reuse the key at this time or sample the live pose into a new one.
 * Returns undefined at the maxKeys limit — inserting anyway would produce a
 * document the validator quarantines on next load, so callers must refuse the
 * edit and say so. `origin` must be the same rest root the caller samples
 * with: pelvis-frame hands convert through it, so a different origin stores a
 * shifted copy of the live pose (a visible jump on insertion). Explicit
 * insertion can use a smaller tolerance than the drag auto-key's 20 ms. */
export function ensureKey(doc:WorkshopDoc,time:number,origin:V3|Vector3=ZERO_V3,tolerance=.02):WorkshopKey|undefined{
  if(!Number.isFinite(time))return undefined;
  const ceiling=doc.duration-(doc.loop?WORKSHOP_LIMITS.loopGap:0);
  time=Math.max(0,Math.min(ceiling,time));
  const existing=nearestKey(doc,time,tolerance);
  if(existing)return existing;
  if(doc.keys.length>=WORKSHOP_LIMITS.maxKeys)return undefined;
  const frame=frameAt(doc,time,origin);
  const base=`k${Math.random().toString(36).slice(2,8)}`;let id=base,suffix=1;
  while(keyAt(doc,id))id=`${base}-${suffix++}`;
  const key:WorkshopKey={id,time,label:'',pose:frame.pose,constraints:frame.constraints};
  const keys=sortedKeys(doc);let i=0;
  while(i<keys.length-1&&key.time>=keys[i+1].time)i++;
  if(keys[i]&&keys[i].time<key.time&&(i<keys.length-1||doc.loop)&&keys[i].interpolation!==undefined)key.interpolation=keys[i].interpolation;
  insertKey(doc,key);return key;
}

export function serializeDoc(doc:WorkshopDoc){return JSON.stringify(doc,null,2);}
const isV3=(v:unknown):v is V3=>!!v&&typeof v==='object'&&['x','y','z'].every(k=>Number.isFinite((v as Record<string,number>)[k]));

/** Structural validator shared by import, library rehydrate and the service:
 * every numeric field must be finite, times strictly increasing and inside the
 * shared duration limits, constraint fields boolean, direction frames
 * non-degenerate, loop documents anchored at 0 s. Returns human-readable
 * problems; an empty list means the doc can enter the pose pipeline. */
export function validateDocShape(d:unknown):string[]{
 const e:string[]=[];
 if(!d||typeof d!=='object')return ['文档不是对象'];
 const doc=d as WorkshopDoc;
 if(doc.schemaVersion!==2)e.push('schemaVersion 必须为 2');
 if(typeof doc.id!=='string'||!doc.id)e.push('缺少 id');
 if(typeof doc.name!=='string')e.push('缺少 name');
 if(typeof doc.english!=='string')e.push('english 必须是字符串');
 const {minDuration,maxDuration,maxKeys,loopGap}=WORKSHOP_LIMITS;
 if(!(typeof doc.duration==='number'&&Number.isFinite(doc.duration)&&doc.duration>=minDuration&&doc.duration<=maxDuration))e.push(`duration 必须是 ${minDuration}–${maxDuration}s 的有限数`);
 if(typeof doc.inbetweens!=='boolean')e.push('inbetweens 必须是布尔值');
 if(typeof doc.loop!=='boolean')e.push('loop 必须是布尔值');
 if(doc.clavicleLift!==undefined&&typeof doc.clavicleLift!=='boolean')e.push('clavicleLift 必须是布尔值');
 if(doc.freeArms!==undefined&&typeof doc.freeArms!=='boolean')e.push('freeArms 必须是布尔值');
 if(doc.gripSide!==undefined&&doc.gripSide!=='R'&&doc.gripSide!=='L')e.push('gripSide 必须是 R 或 L');
 if(doc.gripBevel!==undefined){
  if(!Number.isInteger(doc.gripBevel)||doc.gripBevel<1||doc.gripBevel>8)e.push('gripBevel 必须是 1–8 的整数');
 }
 for(const s of ['L','R']as const){
  const v=(doc.handFrames as Record<string,unknown>|undefined)?.[s];
  if(v!=='world'&&v!=='pelvis')e.push(`handFrames.${s} 必须是 world 或 pelvis`);
 }
 if(!Array.isArray(doc.keys)||doc.keys.length<2)return [...e,'keys 至少需要 2 个关键帧'];
 if(doc.keys.length>maxKeys)e.push(`keys 不能超过 ${maxKeys} 个`);
 const vec=(v:unknown,path:string)=>{if(!isV3(v))e.push(`${path} 不是有限三维向量`);};
 const hand=(h:unknown,path:string)=>{
  if(!h||typeof h!=='object'){e.push(`${path} 缺失`);return;}
  const H=h as HandTarget;
  vec(H.target,`${path}.target`);vec(H.pole,`${path}.pole`);vec(H.forward,`${path}.forward`);vec(H.normal,`${path}.normal`);
  if(isV3(H.forward)&&!(H.forward.x**2+H.forward.y**2+H.forward.z**2>1e-6))e.push(`${path}.forward 不能是零向量`);
  if(isV3(H.normal)&&!(H.normal.x**2+H.normal.y**2+H.normal.z**2>1e-6))e.push(`${path}.normal 不能是零向量`);
  if(isV3(H.forward)&&isV3(H.normal)){
   const fl=Math.hypot(H.forward.x,H.forward.y,H.forward.z),nl=Math.hypot(H.normal.x,H.normal.y,H.normal.z);
   if(fl>1e-6&&nl>1e-6&&Math.abs(H.forward.x*H.normal.x+H.forward.y*H.normal.y+H.forward.z*H.normal.z)/(fl*nl)>.99)e.push(`${path} 的 forward 与 normal 近乎平行，无法构成方向框架`);
  }
 };
 const foot=(f:unknown,path:string)=>{
  if(!f||typeof f!=='object'){e.push(`${path} 缺失`);return;}
  const F=f as FootTarget;
  vec(F.target,`${path}.target`);vec(F.pole,`${path}.pole`);
  for(const a of ['yaw','pitch']as const)if(!Number.isFinite(F[a]))e.push(`${path}.${a} 不是有限数`);
 };
 let prev=-Infinity;const ids=new Set<string>();
 doc.keys.forEach((k,idx)=>{
  if(!k||typeof k!=='object'){e.push(`keys[${idx}] 不是对象`);return;}
  if(typeof k.id!=='string'||!k.id)e.push(`keys[${idx}] 缺少 id`);
  else if(ids.has(k.id))e.push(`keys[${idx}].id=${k.id} 重复`);
  else ids.add(k.id);
  if(typeof k.label!=='string')e.push(`keys[${idx}].label 必须是字符串`);
  if(k.interpolation!==undefined&&k.interpolation!=='hermite'&&k.interpolation!=='linear')e.push(`keys[${idx}].interpolation 必须是 hermite 或 linear`);
  if(!(typeof k.time==='number'&&Number.isFinite(k.time))){e.push(`keys[${idx}].time 不是有限数`);return;}
  if(k.time<-1e-9||k.time>doc.duration+1e-6)e.push(`keys[${idx}].time=${k.time} 超出 0–${doc.duration}`);
  if(k.time<=prev)e.push(`keys[${idx}].time=${k.time} 未严格递增（重复时间会污染补间）`);
  prev=k.time;
  const p=k.pose;
  if(!p||typeof p!=='object'){e.push(`keys[${idx}].pose 缺失`);return;}
  vec(p.root,`keys[${idx}].pose.root`);
  for(const a of ['yaw','lean','chest','side']as const)if(!Number.isFinite(p[a]))e.push(`keys[${idx}].pose.${a} 不是有限数`);
  hand(p.handL,`keys[${idx}].pose.handL`);hand(p.handR,`keys[${idx}].pose.handR`);
  foot(p.footL,`keys[${idx}].pose.footL`);foot(p.footR,`keys[${idx}].pose.footR`);
  if(p.handSpread!==undefined){
   if(!p.handSpread||typeof p.handSpread!=='object'||Array.isArray(p.handSpread))e.push(`keys[${idx}].pose.handSpread 必须是 {L?,R?} 对象`);
   else for(const s of ['L','R']as const){
    const v=(p.handSpread as Record<string,unknown>)[s];
    if(v!==undefined&&(!(typeof v==='number')||!Number.isFinite(v)||v<0||v>1))e.push(`keys[${idx}].pose.handSpread.${s} 必须是 0–1 的有限数`);
   }
  }
  const c=k.constraints;
  if(!c||typeof c!=='object'){e.push(`keys[${idx}].constraints 缺失`);return;}
  for(const f of ['plantL','plantR','grip','contact']as const)if(typeof c[f]!=='boolean')e.push(`keys[${idx}].constraints.${f} 必须是布尔值`);
  if(k.videoTime!==undefined&&!Number.isFinite(k.videoTime))e.push(`keys[${idx}].videoTime 不是有限数`);
 });
 if(doc.loop===true&&doc.keys.every(k=>k&&typeof k.time==='number')){
  const times=doc.keys.map(k=>k.time);
  if(Math.min(...times)>1e-9)e.push('loop 需要首个关键帧位于 0 s');
  if(Math.max(...times)>doc.duration-loopGap+1e-9)e.push(`loop 需要末关键帧早于 ${(doc.duration-loopGap).toFixed(2)} s`);
 }
 return e;
}
/** Blockers for turning the loop flag on, shown next to the checkbox. */
export function loopBlockers(doc:Pick<WorkshopDoc,'keys'|'duration'>):string[]{
  const times=doc.keys.map(k=>k.time),out:string[]=[];
  if(!times.length)return out;
  if(Math.min(...times)>1e-9)out.push('循环需要首个关键帧位于 0 s');
  if(Math.max(...times)>doc.duration-WORKSHOP_LIMITS.loopGap+1e-9)out.push(`循环需要末关键帧早于 ${(doc.duration-WORKSHOP_LIMITS.loopGap).toFixed(2)} s`);
  return out;
}
/** Validate and normalise an already-parsed document. Throws on the first problem. */
export function normalizeDoc(raw:unknown):WorkshopDoc{
  const errs=validateDocShape(raw);
  if(errs.length)throw new Error(`${errs[0]}${errs.length>1?`（共 ${errs.length} 处问题）`:''}`);
  const d=raw as WorkshopDoc;
  /* Canonical form: 'R' is the implicit default, so an explicit 'R' is folded
   * back to absent — documents that mean the same solve must serialize and
   * fingerprint identically (normalizedRequest embeds the parsed doc). The
   * bevel's default 1 and a relaxed hand shape (.5) are folded the same way:
   * they are what an absent channel already means, and keeping them would make
   * a document that merely touched a slider and returned it differ byte-wise
   * from the identical one that never did. */
  if(d.gripSide==='R')delete d.gripSide;
  if(d.gripBevel===RACKET_BEVEL_DEFAULT)delete d.gripBevel;
  for(const k of d.keys)canonicalizeHands(k.pose);
  for(const k of d.keys){
   const spread=k.pose.handSpread;
   if(!spread)continue;
   for(const side of ['L','R']as const)if(spread[side]===RELAXED_SPREAD)delete spread[side];
   if(spread.L===undefined&&spread.R===undefined)delete k.pose.handSpread;
  }
  return d;
}
export function parseDoc(text:string):WorkshopDoc{return normalizeDoc(JSON.parse(text));}

/** Document mirror across the rig's bilateral plane x=0 (left = +X, right =
 * −X): the same motion on the other side — a right-hand forehand becomes a
 * left-hand one. A document-level transform, not a solver flag: every
 * side-keyed input is swapped L↔R and x-mirrored, so the sampled trajectory
 * of the mirrored document is the exact reflection of the source's. The
 * convention is the one grip-side.test.ts pins on the real solve
 * (M·q·M for the x-reflection M):
 *
 *   field                         mirror
 *   root                          x→−x, y/z kept
 *   yaw                           −yaw (rotation about Y)
 *   lean                          kept (rotation about X)
 *   chest / side                  negated (Y-twist / Z-roll — see solver
 *                                 rig.rotate's YXZ Euler and foot.ts's YXZ)
 *   handL ⇄ handR                 swapped; target/pole/forward/normal x→−x
 *                                 (mirroring keeps forward·normal = 0
 *                                 exactly, so the orthonormal contract holds
 *                                 bit-for-bit and parseDoc stays a no-op)
 *   footL ⇄ footR                 swapped; target/pole x→−x, yaw→−yaw,
 *                                 pitch kept (footRotation YXZ)
 *   constraints.plantL ⇄ plantR   swapped — contact intervals move to the
 *                                 other foot: run-start contact points,
 *                                 release swings' mid-waypoints and landing
 *                                 contacts all mirror through the same
 *                                 stored-target rewrite the sampler applies
 *   constraints.grip / contact    kept (side-agnostic booleans)
 *   handFrames                    side-swapped {L←R, R←L}: the interpolation
 *                                 frame follows the hand — a right 'world'
 *                                 hand becomes a left 'world' hand, so the
 *                                 sampled path mirrors exactly. For the
 *                                 (universal) symmetric config this is a
 *                                 no-op; the pelvis frame needs no special
 *                                 mirroring because x→−x commutes with the
 *                                 yaw-rotation conversion in buildModel
 *                                 (origin.x = 0 on this rig).
 *   clavicleLift                  kept (scalar assist flag; the solver
 *                                 re-derives the side from gripSide)
 *   gripSide                      flipped — absent/'R' → 'L', 'L' → absent
 *                                 (canonical form: the R side stays implicit)
 *   duration / inbetweens / loop  kept; key times, ids, labels and videoTime
 *                                 kept — contact-interval timing is
 *                                 preserved verbatim
 *   id / name / english           mirror markers that TOGGLE so the transform
 *                                 is an involution: `id + '.mirrored'`,
 *                                 `name + ' · 镜像'`, `english + ' · MIRRORED'`,
 *                                 stripped when already present.
 *
 * The output is emitted in canonical field order, so mirror∘mirror is a
 * byte-exact identity on every document the pipeline materialises (seeds,
 * shipped assets, parseDoc output, mirrorDoc output itself); hand-scrambled
 * property order round-trips value-exact, not byte-exact. */
/** The per-key half of mirrorDoc: pose and constraints reflected across x=0
 * (left/right hands, feet and plant flags swap; spine lean keeps its sign).
 * Mirroring a mirrored key reproduces the original values, and the output is
 * written in the same field order mirrorDoc uses, so document-level
 * mirror∘mirror stays byte-exact. The workshop also applies this per key for
 * in-place pose mirroring. */
export function mirrorKey(key:WorkshopKey):WorkshopKey{
  const mv=(v:V3):V3=>({x:-v.x,y:v.y,z:v.z});
  const hand=(h:HandTarget):HandTarget=>({target:mv(h.target),pole:mv(h.pole),forward:mv(h.forward),normal:mv(h.normal)});
  const foot=(f:FootTarget):FootTarget=>({target:mv(f.target),pole:mv(f.pole),yaw:-f.yaw,pitch:f.pitch});
  const c=key.constraints,p=key.pose;
  const out:WorkshopKey={id:key.id,time:key.time,label:key.label,
    pose:{root:mv(p.root),yaw:-p.yaw,lean:p.lean,chest:-p.chest,side:-p.side,
      handL:hand(p.handR),handR:hand(p.handL),footL:foot(p.footR),footR:foot(p.footL)},
    constraints:{plantL:c.plantR,plantR:c.plantL,grip:c.grip,contact:c.contact}};
  // Hand shape is a side-keyed scalar, so it travels with its hand. An
  // explicit relaxed value is preserved rather than dropped: mirror∘mirror
  // must stay byte-exact, and normalizeDoc is the only place that folds
  // defaults away.
  if(p.handSpread){
   const swapped:HandSpread={};
   if(p.handSpread.R!==undefined)swapped.L=p.handSpread.R;
   if(p.handSpread.L!==undefined)swapped.R=p.handSpread.L;
   if(swapped.L!==undefined||swapped.R!==undefined)out.pose.handSpread=swapped;
  }
  if(key.interpolation!==undefined)out.interpolation=key.interpolation;
  if(key.videoTime!==undefined)out.videoTime=key.videoTime;
  return out;
}

export function mirrorDoc(doc:WorkshopDoc):WorkshopDoc{
  const toggle=(s:string,suffix:string)=>s.endsWith(suffix)?s.slice(0,s.length-suffix.length):s+suffix;
  /* Field coverage — every WorkshopDoc/WorkshopKey/PoseParams member has an
   * explicit rule here; when a field is added to any of those interfaces it
   * must get a line below (swap, mirror or keep — silent omission means the
   * mirrored document quietly keeps the source's value):
   *   WorkshopDoc: schemaVersion · id · name · english · duration ·
   *     inbetweens · loop · handFrames · clavicleLift · freeArms · gripSide ·
   *     gripBevel · keys
   *   WorkshopKey: id · time · label · pose · constraints · interpolation · videoTime
   *   PoseParams:  root · yaw · lean · chest · side · handL · handR ·
   *     footL · footR · handSpread   (hand: target/pole/forward/normal; foot: +yaw/pitch)
   *   KeyConstraints: plantL · plantR · grip · contact                       */
  const keys=doc.keys.map(mirrorKey);
  return {schemaVersion:2,id:toggle(doc.id,'.mirrored'),name:toggle(doc.name,' · 镜像'),english:toggle(doc.english,' · MIRRORED'),
    duration:doc.duration,inbetweens:doc.inbetweens,loop:doc.loop,
    handFrames:{L:doc.handFrames.R,R:doc.handFrames.L},
    ...(doc.clavicleLift!==undefined?{clavicleLift:doc.clavicleLift}:{}),
    ...(doc.freeArms!==undefined?{freeArms:doc.freeArms}:{}),
    ...(doc.gripSide==='L'?{}:{gripSide:'L' as const}),
    /* Bevel PRESERVED, not swapped: the numbering is palm-relative and
     * side-signed (bevelRoll flips sign with the mount), so the same number
     * is the same grip on the mirrored hand. Copying it is what keeps the
     * mirrored racket the exact x-mirror of the source's. */
    ...(doc.gripBevel!==undefined?{gripBevel:doc.gripBevel}:{}),
    keys};
}

/** Retiming rule: scaling duration preserves phase proportions and strict
 * ordering — never clamps times onto duplicates (repeated times would leave
 * zero-length intervals and NaN Hermite tangents). Keys live inside the valid
 * span [0, span] where span is `duration` (or `duration − loopGap` for loops,
 * which reserve the tail seam); scaling that span keeps the last key above its
 * predecessor, where clamping only the last key could drop it below. Loops
 * keep their anchor. */
export function retimeKeys(doc:WorkshopDoc,newDuration:number){
 const old=doc.duration;
 doc.duration=Math.max(.01,newDuration);
 const keys=sortedKeys(doc);
 const gap=doc.loop?WORKSHOP_LIMITS.loopGap:0;
 const from=old-gap,to=Math.max(1e-9,doc.duration-gap);
 if(from>1e-9){const s=to/from;for(const k of keys)k.time=Math.max(0,Math.min(to,k.time*s));}
 else keys.forEach((k,i)=>{k.time=keys.length>1?i/(keys.length-1)*to:0;});
 if(doc.loop&&keys.length)keys[0].time=0;
 doc.keys=keys;
}
/** Single-key retime: stay strictly between neighbours (a shared timestamp is
 * an event boundary, not a second pose to blend). Loop anchors do not move. */
export function setKeyTime(doc:WorkshopDoc,key:WorkshopKey,t:number){
 const keys=sortedKeys(doc),i=keys.findIndex(k=>k.id===key.id);
 if(i<0)return;
 if(doc.loop&&i===0)return;
 const lo=i===0?0:keys[i-1].time+.01;
 const hi=i===keys.length-1?(doc.loop?doc.duration-WORKSHOP_LIMITS.loopGap:doc.duration):keys[i+1].time-.01;
 key.time=Math.max(lo,Math.min(hi,t));
 doc.keys.sort((a,b)=>a.time-b.time);
}

/* ---- Default example: a compact forehand seeded from the same task-space
 * numbers as the authored ready/forehand poses, retimed into 0.80s so the
 * workbench opens with a usable five-key motion instead of a T-pose. Hands
 * interpolate in the pelvis frame, as the laboratory does. ---- */

interface SeedControls{y:number;z:number;yaw:number;chest:number;lean:number;right:[number,number,number];left:[number,number,number];rf:[number,number,number];rn:[number,number,number];lf:[number,number,number];ln:[number,number,number];stance:number}
const readySeed:SeedControls={y:-.055,z:-.05,yaw:0,chest:0,lean:5,right:[-.24,1.09,.29],left:[.17,1.14,.30],rf:[0,0,1],rn:[1,0,0],lf:[-.6,-.2,.7],ln:[-.4,.8,0],stance:.20};
/** Task-space controls → a key pose. `foot` sets the ankle target's forward
 * offset: `zBase + sign*zStep` (zStep 0 keeps both feet on the zBase line —
 * the idle/reach/squat convention; ±zStep is the staggered ready stance). */
function controlsToPoseParams(rest:ReadonlyMap<string,Vector3>,c:SeedControls,foot:{zBase:number;zStep:number}):PoseParams{
  const origin=rest.get('root')!;
  const yaw=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),c.yaw*DEG);
  const rootPos=origin.clone().add(new Vector3(0,c.y,c.z));
  const world=(v:[number,number,number])=>new Vector3(...v).sub(origin).applyQuaternion(yaw).add(rootPos);
  const hand=(target:[number,number,number],f:[number,number,number],n:[number,number,number],pole:[number,number,number]):HandTarget=>({
    target:fromV(world(target)),pole:fromV(world(pole)),
    forward:fromV(new Vector3(...f).applyQuaternion(yaw)),normal:fromV(new Vector3(...n).applyQuaternion(yaw))});
  // Planted feet live in world space: authoring keeps foot targets and poles
  // unrotated so the stance never rotates with pelvis yaw.
  const footT=(side:'L'|'R'):FootTarget=>{
    const sign=side==='L'?1:-1;
    return {target:{x:sign*c.stance,y:rest.get(`foot_${side}`)!.y,z:foot.zBase+sign*foot.zStep},
      pole:{x:sign*.22,y:.5,z:1},yaw:sign*7,pitch:0};
  };
  const pose={root:fromV(new Vector3(0,c.y,c.z)),yaw:c.yaw,lean:c.lean,chest:c.chest,side:0,
    handL:hand(c.left,c.lf,c.ln,[.51,1.13,-.12]),handR:hand(c.right,c.rf,c.rn,[-.52,1.17,-.12]),
    footL:footT('L'),footR:footT('R')};
  canonicalizeHands(pose);return pose;
}
const seedPose=(rest:ReadonlyMap<string,Vector3>,c:SeedControls)=>controlsToPoseParams(rest,c,{zBase:.018,zStep:.045});
export function defaultDocument(rest:ReadonlyMap<string,Vector3>):WorkshopDoc{
  const P=(patch:Partial<SeedControls>)=>seedPose(rest,{...readySeed,...patch});
  const plant={plantL:true,plantR:true,grip:true,contact:false};
  const keys:WorkshopKey[]=[
    {id:'k-ready',time:0,label:'准备',pose:P({}),constraints:{...plant}},
    {id:'k-back',time:.22,label:'引拍',pose:P({y:-.085,z:-.05,yaw:-32,chest:-18,right:[-.43,1.15,-.015],left:[.12,1.23,.37],rf:[0,0,1],rn:[1,0,.1]}),constraints:{...plant}},
    {id:'k-contact',time:.5,label:'触球',pose:P({y:-.03,z:-.03,yaw:15,chest:10,right:[-.34,1.12,.43],left:[.27,1.20,.10],rf:[0,.1,1],rn:[.15,.99,0]}),constraints:{...plant,contact:true}},
    {id:'k-follow',time:.66,label:'随挥',pose:P({y:-.025,z:-.02,yaw:31,chest:25,right:[.16,1.40,.25],left:[.25,1.18,.08],rf:[-.55,.66,.30],rn:[.40,.15,.80]}),constraints:{...plant}},
    {id:'k-recover',time:.8,label:'恢复',pose:P({y:-.03,z:-.02,yaw:8,chest:4,right:[-.15,1.13,.35]}),constraints:{...plant}},
  ];
  return {schemaVersion:2,id:'forehand-workshop',name:'正手挥拍 · 工作区',english:'FOREHAND WORKSHOP',duration:.8,inbetweens:true,loop:false,handFrames:{L:'pelvis',R:'pelvis'},keys};
}

/** New-motion template: a two-key neutral stance so a custom action starts
 * from a valid planted pose instead of an empty document. */
const standSeed:SeedControls={y:.002,z:0,yaw:0,chest:0,lean:0,right:[-.25,.915,.035],left:[.25,.915,.035],rf:[0,-1,0],rn:[1,0,0],lf:[0,-1,0],ln:[-1,0,0],stance:.135};
export function blankDocument(rest:ReadonlyMap<string,Vector3>,name:string,id:string):WorkshopDoc{
  const pose=seedPose(rest,standSeed);
  const constraints:KeyConstraints={plantL:true,plantR:true,grip:false,contact:false};
  return {schemaVersion:2,id,name,english:'CUSTOM MOTION',duration:1,inbetweens:true,loop:false,handFrames:{L:'pelvis',R:'pelvis'},keys:[
    {id:`${id}-a`,time:0,label:'起始',pose:clonePose(pose),constraints:{...constraints}},
    {id:`${id}-b`,time:1,label:'结束',pose:clonePose(pose),constraints:{...constraints}},
  ]};
}
export const newDocId=(name:string)=>{
  const slug=name.trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g,'-').replace(/^-+|-+$/g,'');
  return `${slug||'motion'}-${Math.random().toString(36).slice(2,7)}`;
};
