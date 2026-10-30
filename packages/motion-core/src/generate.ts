/** Experimental deterministic constraint-trajectory optimizer (issue #10 PR-D).
 *
 * The search space is deliberately tiny and auditable: authored keys may be
 * RETIMED on a lattice, and a key's per-group channels (trunk / each hand /
 * each foot) may be PHASE-shifted by resampling the SOURCE compiled motion at
 * a bounded offset — non-stacking, so a second phase move on the same group
 * replaces rather than accumulates. Locked keys, `contact` keys and foot
 * phase outside the source flight window are illegal; authored constraints
 * (`plantL/plantR/grip/contact`), doc-level fields and the key set are
 * invariant by gate, never by repair.
 *
 * Cost is measured by the SAME implementation the probe and tests share
 * (learning[4]): probeFrames through the real solve path → analyzeProbeFrames
 * → flat metric map (measureDoc) → weighted, baseline-normalized, capped
 * terms. Sweeps are greedy and deterministic — no RNG anywhere (the reserved
 * `seed` field documents that future stochastic restarts have a place to
 * hang, but v1 never reads it).
 *
 * Purity: three is used as a math library only; no DOM/node imports. The rig
 * is posed by the solver during evaluation — the same contract probeFrames
 * already has (it resets the rig when done). */
import {RACKET_TIP_LOCAL} from './props/racket';
import {Vector3} from 'three';
import type {Object3D} from 'three';
import type {HumanRig} from './rig';
import type {Side} from './foot';
import {WORKSHOP_LIMITS} from './limits';
import {solveEffectiveFrame} from './solver';
import {compileMotion,constraintsAt,flattenPose,frameAtCompiled,isReleaseKey,
 sampleMotion,sortedKeys,unflattenPose,validateDocShape,
 type CompiledMotion,type WorkshopDoc,type WorkshopKey} from './document';
import {analyzeProbeFrames,probeFrames,stepAngles,PROBE_QUAT_BONES,
 type ProbeFrame,type ProbeReport,type ProbeTip,type Quat,type Vec3} from './quality-probe';

/* ---- public types ------------------------------------------------------- */

/** One movable channel group — the flattenPose layout slices below. */
export type ChannelGroup='trunk'|'handL'|'handR'|'footL'|'footR';

/** Objective weights; every term is a baseline ratio capped at 4× (see
 * weightedCost). `intentShift` prices deviation from the authored document. */
export interface GenWeights{endEffectorJerk:number;angularJerk:number;checkViolations:number;
 footContact:number;penetration:number;ikResidual:number;intentShift:number}

export interface MotionGenRequest{
 doc:WorkshopDoc;
 /** Key ids that may neither retime nor phase — pinned verbatim by gate 5. */
 lockedKeyIds?:string[];
 /** Enabled move kinds/groups — default all-on. */
 adjust?:{time?:boolean;phase?:boolean;groups?:ChannelGroup[]};
 /** Per-key cumulative bounds — default .15s retime / .10s phase, measured
  * against the SOURCE document (never the already-moved candidate). */
 bounds?:{maxTimeShiftS?:number;maxPhaseShiftS?:number};
 weights?:Partial<GenWeights>;
 /** Search grid rate / emitted-report rate — default 40/120 fps. */
 evalFps?:number;reportFps?:number;
 /** Default 120 evals / 4 sweeps. `maxSweeps` is bounded to 1..16.
  * `evals` counts every evalDetail call — baseline, per-move trials and up
  * to two report-fps measurements. */
 budget?:{maxEvals?:number;maxSweeps?:number};
 /** v1 emits at most one candidate: undefined|1 only — >1 ⇒ 'invalid-input'. */
 candidates?:number;
 /** Reserved for future stochastic restarts — MVP is deterministic and the
  * value is read by nobody on purpose. */
 seed?:number;
 /** Called after each real probe evaluation; callback failures propagate. */
 onProgress?:(progress:MotionGenProgress)=>void;
 /** REQUIRED when the doc has contact keys: the RacketGrip Object3D returned
  * by attachRacket(rig,doc.gripSide), still parented directly to this rig's
  * matching wrist. Tip metrics are never silently mapped onto the wrist. */
 tip?:ProbeTip;
}

export interface MotionGenProgress{
 evals:number;maxEvals:number;phase:'baseline'|'search'|'report';sweep?:number;
}

/** One metrics-table row: before/after measured at reportFps. `better` is the
 * improvement direction ('na' = informational only — timings, codes). */
export interface MetricRow{before:number;after:number;unit:string;better:'down'|'up'|'na'}
/** One gate outcome recorded on the emitted/rejected candidate. */
export interface GenConstraint{code:string;ok:boolean;detail:string}
export interface MotionCandidate{doc:WorkshopDoc;objective:number;
 verdict:'improved'|'neutral'|'degraded';metrics:Record<string,MetricRow>;
 constraints:GenConstraint[];probe:ProbeReport}
export interface MotionGenResult{
 candidates:MotionCandidate[];
 /** The src metric map at evalFps — the actual divisor the objective used
  * during the search (the report-fps comparison lives in the metric rows). */
 baseline:Record<string,number>;
 rejected:{code:string;reason:string;objective?:number}[];
 diagnostics:{evals:number;sweeps:number;
  stopReason:'converged'|'eval-budget'|'no-adjustable-keys'|'invalid-input';
  /** Accepted moves in order: retime delta is cumulative vs the SOURCE time,
   * phase delta is the absolute offset it sampled at. */
  appliedMoves:{kind:string;keyId:string;group?:string;delta:number}[]};
}

/* ---- document helpers ---------------------------------------------------- */

const cloneDoc=(d:WorkshopDoc):WorkshopDoc=>JSON.parse(JSON.stringify(d));

/** Deterministic subsample: sample the source trajectory at `times` and
 * rebuild a document whose keys carry the sampled pose plus the GOVERNING
 * key's constraints (constraintsAt) and label. Doc-level fields and each
 * sample's governing outgoing interpolation carry over; validateDocShape is asserted on the result — a bad instant list
 * throws instead of emitting a document the loader would quarantine. */
export function subsampleDoc(doc:WorkshopDoc,times:number[],rest:ReadonlyMap<string,Vector3>):WorkshopDoc{
 const origin=rest.get('root')!;
 const keys=sortedKeys(doc);
 const ts=[...times].sort((a,b)=>a-b);
 const compiled=compileMotion(doc,origin);
 const out:WorkshopDoc={schemaVersion:2,id:`${doc.id}-sub`,name:`${doc.name} · 子采样`,
  english:`${doc.english} SUBSAMPLED`,duration:doc.duration,inbetweens:doc.inbetweens,loop:doc.loop,
  handFrames:{...doc.handFrames},keys:ts.map((t,i)=>{
   const sourceIndex=constraintsAt(keys,t).keyIndex,mode=keys[sourceIndex].interpolation;
   return {id:`sub${i}`,time:t,label:keys[sourceIndex].label??'',
    pose:sampleMotion(compiled,t),constraints:{...constraintsAt(keys,t).constraints},
    ...(mode!==undefined?{interpolation:mode}:{})};
  })};
 if(doc.clavicleLift!==undefined)out.clavicleLift=doc.clavicleLift;
 if(doc.freeArms!==undefined)out.freeArms=doc.freeArms;
 if(doc.gripSide!==undefined)out.gripSide=doc.gripSide;
 // The bevel is a document-level authoring property of the prop, so a
 // subsampled copy has to keep the same facet in the palm. `handSpread` needs
 // no carry: it lives in the keys' poses and sampleMotion returns it.
 if(doc.gripBevel!==undefined)out.gripBevel=doc.gripBevel;
 const problems=validateDocShape(out);
 if(problems.length)throw new Error(`subsampleDoc 产出非法文档: ${problems.join('；')}`);
 return out;
}

/* ---- move machinery ------------------------------------------------------ */

/** A fully-resolved move: retime delta in seconds; phase samples the SOURCE
 * compiled motion at srcTime+offset for the named group. */
export type GenMove=
 |{kind:'retime';keyId:string;delta:number}
 |{kind:'phase';keyId:string;group:ChannelGroup;offset:number};

/** Immutable per-run context: every "vs SOURCE" comparison the move legality
 * and gates need — sorted source keys, per-id source times, the compiled
 * snapshot phase moves sample from, the locked set, bounds and each key's
 * SOURCE flight windows per foot (raw seconds; loop docs scan cyclically so
 * bounds may wrap past the seam as ±duration-shifted times). */
export interface GenMoveContext{
 srcKeys:WorkshopKey[];srcTimes:Map<string,number>;compiled:CompiledMotion;
 locked:Set<string>;maxTimeShift:number;maxPhaseShift:number;
 /** flight[srcIndex][0=L,1=R] — {lo,hi} open bounds in source seconds, null
  * when the key isn't airborne for that side in the source document. */
 flight:({lo:number;hi:number}|null)[][];
 origin:Vector3;
}

/** Open-bound epsilon on the unbounded flight-window fallbacks — keeps a
 * phase offset strictly inside (0, duration) the way "exactly at release /
 * landing the sampler shows contact-override semantics" requires. */
const FLIGHT_EPS=1e-6;

/** Source flight window for key index `i`, side `s`, or null when the key is
 * not airborne in the SOURCE document (planted keys and release keys — whose
 * stored target is already the swing waypoint — are not phase candidates).
 * The interval is (releaseKey.time, nextPlantKey.time) with OPEN bounds; a
 * side with zero planted keys falls back to (0+ε, duration−ε). */
function flightWindow(doc:WorkshopDoc,i:number,s:Side):{lo:number;hi:number}|null{
 const keys=sortedKeys(doc),n=keys.length,flag=s==='L'?'plantL':'plantR';
 if(keys[i].constraints[flag]||isReleaseKey(doc,i,s))return null;
 if(!keys.some(k=>k.constraints[flag]))return{lo:FLIGHT_EPS,hi:doc.duration-FLIGHT_EPS};
 const D=doc.duration,loop=doc.loop;
 // Backward to the nearest non-airborne key — by construction the release
 // key that opens this airborne run. Cyclic wraps report ±D-shifted times.
 let lo=0;
 for(let st=1;st<n;st++){
  const j=loop?((i-st)%n+n)%n:i-st;
  if(j<0)break;
  if(keys[j].constraints[flag]||isReleaseKey(doc,j,s)){lo=keys[j].time+(loop?Math.floor((i-st)/n)*D:0);break;}
 }
 let hi=D;
 for(let st=1;st<=n;st++){
  const j=loop?(i+st)%n:i+st;
  if(j>=n)break;
  if(keys[j].constraints[flag]){hi=keys[j].time+(loop?Math.floor((i+st)/n)*D:0);break;}
  if(!loop&&st===n-1)break;
 }
 if(!loop)hi=Math.min(hi,D);
 return{lo,hi};
}

/** Build the move context for a document — the source snapshot and every
 * vs-source bound the move table compares against. */
export function buildGenContext(rig:HumanRig,doc:WorkshopDoc,
 opts:{lockedKeyIds?:string[];bounds?:{maxTimeShiftS?:number;maxPhaseShiftS?:number}}={}):GenMoveContext{
 const srcKeys=sortedKeys(doc);
 const origin=rig.rest.get('root')!;
 const ctx:GenMoveContext={
  srcKeys,srcTimes:new Map(srcKeys.map(k=>[k.id,k.time])),
  compiled:compileMotion(doc,origin),
  locked:new Set(opts.lockedKeyIds??[]),
  maxTimeShift:opts.bounds?.maxTimeShiftS??.15,
  maxPhaseShift:opts.bounds?.maxPhaseShiftS??.10,
  flight:[],origin};
 for(let i=0;i<srcKeys.length;i++)ctx.flight.push([flightWindow(doc,i,'L'),flightWindow(doc,i,'R')]);
 return ctx;
}

/** The retime lattice step B for one key on the CURRENT document — the move
 * table's "re-derived per move": bounded by maxTimeShiftS and a quarter of
 * the current neighbour span so dense documents self-refine their grid. */
export function retimeStep(ctx:GenMoveContext,cand:WorkshopDoc,keyId:string):number{
 const keys=sortedKeys(cand),i=keys.findIndex(k=>k.id===keyId),n=keys.length;
 if(i<0)return ctx.maxTimeShift;
 const prev=i>0?keys[i-1].time:0;
 const next=cand.loop&&i===n-1?keys[0].time+cand.duration:i<n-1?keys[i+1].time:cand.duration;
 return Math.min(ctx.maxTimeShift,Math.max(0,(next-prev)/4));
}

/** Apply one resolved move to a clone of `cand`; null when the move is
 * illegal or a no-op (post-clamp). Legality is read on the CURRENT document
 * (locked / contact / first-last / airborne), bounds against the SOURCE:
 * retime clamps inside (prev+.01, next−.01) on current neighbours AND the
 * cumulative |new−srcTime|≤maxTimeShift band; loop documents pin key0 and cap
 * the last key at duration−loopGap. Phase writes `sampleMotion(srcCompiled,
 * srcTime+offset)[group]` — the source snapshot, non-stacking; loop times
 * wrap. Foot-side phase additionally requires an airborne key whose sampled
 * instant stays strictly inside the SOURCE flight window. */
export function applyGenMove(ctx:GenMoveContext,cand:WorkshopDoc,move:GenMove):WorkshopDoc|null{
 const keys=sortedKeys(cand),n=keys.length,i=keys.findIndex(k=>k.id===move.keyId);
 if(i<0)return null;
 const k=keys[i],srcT=ctx.srcTimes.get(k.id);
 if(srcT===undefined)return null;
 if(ctx.locked.has(k.id)||k.constraints.contact)return null;
 if(move.kind==='retime'){
  const first=i===0,last=i===n-1;
  if(first||(!cand.loop&&last))return null;
  const prevT=keys[i-1].time;
  const nextT=cand.loop&&last?keys[0].time+cand.duration:keys[i+1].time;
  const lo=Math.max(prevT+.01,srcT-ctx.maxTimeShift);
  const hi=Math.min(nextT-.01,cand.loop&&last?cand.duration-WORKSHOP_LIMITS.loopGap:cand.duration,srcT+ctx.maxTimeShift);
  if(hi<=lo)return null;
  const t=Math.max(lo,Math.min(hi,k.time+move.delta));
  if(t===k.time)return null;
  const out=cloneDoc(cand);
  out.keys.find(x=>x.id===k.id)!.time=t;
  out.keys.sort((a,b)=>a.time-b.time);
  return out;
 }
 /* phase */
 const g=move.group,t=srcT+move.offset;
 if(g==='footL'||g==='footR'){
  const s:Side=g==='footL'?'L':'R';
  if(k.constraints[s==='L'?'plantL':'plantR']||isReleaseKey(cand,i,s))return null;
  const win=ctx.flight[ctx.srcKeys.findIndex(x=>x.id===k.id)][s==='L'?0:1];
  if(!win||!(t>win.lo&&t<win.hi))return null;
 }
 /* Source snapshot — the group slice of the flattened sampled pose replaces
  * the same slice of the key's current pose. Channel layout (document.ts
  * flattenPose): trunk 0–6 · handL 7–18 · handR 19–30 · footL 31–38 ·
  * footR 39–46; each hand group also carries its appended spread channel
  * (handL 47, handR 48). The foot ranges end at 47 so they never absorb the
  * appended finger channels. */
 const RANGE:Record<ChannelGroup,[number,number]>={trunk:[0,7],handL:[7,19],handR:[19,31],footL:[31,39],footR:[39,47]};
 const EXTRAS:Partial<Record<ChannelGroup,number[]>>={handL:[47],handR:[48]};
 const st=cand.loop?((t%cand.duration)+cand.duration)%cand.duration:t;
 const flat=flattenPose(k.pose),from=flattenPose(sampleMotion(ctx.compiled,st));
 const [a,b]=RANGE[g];
 let dirty=false;
 for(let c=a;c<b;c++){if(flat[c]!==from[c])dirty=true;flat[c]=from[c];}
 for(const c of EXTRAS[g]??[]){if(flat[c]!==from[c])dirty=true;flat[c]=from[c];}
 if(!dirty)return null;
 const out=cloneDoc(cand);
 out.keys.find(x=>x.id===k.id)!.pose=unflattenPose(flat);
 return out;
}

/* ---- measurement (the shared metric impl) -------------------------------- */

/** Metric keys the objective reads, by weight name. */
const COST_KEY:Record<keyof GenWeights,string>={
 endEffectorJerk:'cost.endEffectorJerk',angularJerk:'cost.angularJerk',
 checkViolations:'cost.checkViolations',footContact:'cost.footContact',
 penetration:'cost.penetration',ikResidual:'cost.ikResidual',intentShift:'cost.intentShift'};
/** Count-like terms normalize against floor 1, metric terms against 1e-3 —
 * near-zero baselines make a candidate's first defect dominate its ratio
 * (pen 0→2mm is a 2× weight term, not noise) — intended, and capped at 4×
 * together with everything else. */
const COUNT_TERMS=new Set<keyof GenWeights>(['checkViolations','intentShift']);

/** Default objective weights — the eval-amended balance from the spec. */
const DEFAULT_WEIGHTS:GenWeights={endEffectorJerk:3,angularJerk:2,checkViolations:8,
 footContact:8,penetration:4,ikResidual:4,intentShift:.08};
/** Hard upper bound on estimated solver-frame work per request. */
export const MAX_GENERATION_SAMPLED_FRAMES=300_000;
/** Hard upper bound on greedy sweeps per request. */
export const MAX_GENERATION_SWEEPS=16;

const estimatedSamples=(duration:number,fps:number)=>Math.floor(duration*fps)+2;
const isFps=(fps:number)=>Number.isSafeInteger(fps)&&fps>=1&&fps<=240;

const checkSeries=(times:number[],values:Vec3[])=>{
 if(times.length!==values.length)throw new RangeError('时间戳与位置样本数量必须一致');
 for(let i=0;i<times.length;i++){
  if(!Number.isFinite(times[i])||(i>0&&times[i]<=times[i-1]))
   throw new RangeError('时间戳必须有限且严格递增');
  if(values[i].length!==3||values[i].some(v=>!Number.isFinite(v)))
   throw new RangeError('位置样本必须是有限 Vec3');
 }
};

/** Integrated absolute positional jerk (∫|d³p/dt³|dt, m/s²).
 * Each sample interval uses the local four-point cubic interpolant. Its third
 * derivative is constant on that interval; divided differences keep the
 * estimate exact for any cubic, including nonuniform grids and the partial
 * final interval at the exact document duration. Fewer than four samples do
 * not identify a jerk and return zero. */
export function integratedPositionJerk(times:number[],positions:Vec3[]):number{
 checkSeries(times,positions);
 if(times.length<4)return 0;
 const n=times.length;let integral=0;
 for(let i=0;i<n-1;i++){
  const s=Math.min(Math.max(i-1,0),n-4),t0=times[s],t1=times[s+1],t2=times[s+2],t3=times[s+3];
  const p0=positions[s],p1=positions[s+1],p2=positions[s+2],p3=positions[s+3];
  const jerk:number[]=[];
  for(let c=0;c<3;c++){
   const d01=(p1[c]-p0[c])/(t1-t0),d12=(p2[c]-p1[c])/(t2-t1),d23=(p3[c]-p2[c])/(t3-t2);
   const d012=(d12-d01)/(t2-t0),d123=(d23-d12)/(t3-t1);
   jerk.push(6*(d123-d012)/(t3-t0));
  }
  integral+=Math.hypot(jerk[0],jerk[1],jerk[2])*(times[i+1]-times[i]);
 }
 return integral;
}

const normalizeQuat=(q:Quat):Quat=>{
 const length=Math.hypot(q[0],q[1],q[2],q[3]);
 if(!Number.isFinite(length)||length<1e-12)throw new RangeError('四元数样本必须有限且非零');
 return[q[0]/length,q[1]/length,q[2]/length,q[3]/length];
};

/** Integrated absolute angular jerk (∫|d³θ/dt³|dt, rad/s²). Rotation
 * increments are unwrapped into a cumulative world-frame rotation-vector
 * series before applying the same timestamp-aware cubic estimator. */
export function integratedAngularJerk(times:number[],quats:Quat[]):number{
 if(times.length!==quats.length)throw new RangeError('时间戳与四元数样本数量必须一致');
 const qs=quats.map(normalizeQuat),rotations:Vec3[]=[];
 let x=0,y=0,z=0;
 if(qs.length)rotations.push([x,y,z]);
 for(let i=1;i<qs.length;i++){
  const a=qs[i-1],b=qs[i];
  // b * inverse(a): shortest world-frame rotation taking sample a to b.
  let dx=-b[3]*a[0]+b[0]*a[3]-b[1]*a[2]+b[2]*a[1];
  let dy=-b[3]*a[1]+b[0]*a[2]+b[1]*a[3]-b[2]*a[0];
  let dz=-b[3]*a[2]-b[0]*a[1]+b[1]*a[0]+b[2]*a[3];
  let dw=b[3]*a[3]+b[0]*a[0]+b[1]*a[1]+b[2]*a[2];
  if(dw<0){dx=-dx;dy=-dy;dz=-dz;dw=-dw;}
  const vn=Math.hypot(dx,dy,dz);
  if(vn>1e-12){
   const angle=2*Math.atan2(vn,Math.max(0,dw)),scale=angle/vn;
   x+=dx*scale;y+=dy*scale;z+=dz*scale;
  }
  rotations.push([x,y,z]);
 }
 return integratedPositionJerk(times,rotations);
}

/** Frames carrying at least one FAILING analyzePose check — the count term;
 * possible only because ProbeFrame.check now carries per-frame ok flags. */
const applicableCheck=(x:{v:number|null;limit:number|null;ok:boolean})=>
 x.v!==null&&x.limit!==null&&Number.isFinite(x.v)&&Number.isFinite(x.limit);
const violationFrames=(frames:ProbeFrame[])=>frames.filter(f=>Object.values(f.check)
 .some(x=>applicableCheck(x)&&x.ok===false)).length;
interface CheckFailure{count:number;excess:number}
/** Per-code failed-frame counts and worst normalized excess above the limit.
 * Null/NaN/Infinity values and limits represent non-applicable observations. */
const checkFailures=(frames:ProbeFrame[])=>{
 const out=new Map<string,CheckFailure>();
 for(const f of frames)for(const [code,x]of Object.entries(f.check)){
  if(!applicableCheck(x)||x.ok!==false)continue;
  const old=out.get(code)??{count:0,excess:0};
  old.count++;
  old.excess=Math.max(old.excess,Math.max(0,(x.v!-x.limit!)/Math.max(Math.abs(x.limit!),1e-12)));
  out.set(code,old);
 }
 return out;
};

interface EvalDetail{metrics:Record<string,number>;report:ProbeReport;worstCode:string|null}

/** One probe at `fps` folded into the flat metric map — the single
 * implementation behind evalCost, the emitted baseline, the metrics table and
 * the public measureDoc (learning[4]: no second copy to drift). probeFrames
 * compiles once and samples through the canonical frozen-snapshot path. */
function evalDetail(rig:HumanRig,doc:WorkshopDoc,fps:number,tip?:ProbeTip):EvalDetail{
 const frames=probeFrames(rig,doc,fps,tip);
 const report=analyzeProbeFrames({doc,fps,frames,rest:rig.rest});
 const gs=report.gripSide,times=frames.map(f=>f.t);
 const hasTip=frames.length>0&&frames.every(f=>f.tip!==null);
 const tipJerk=hasTip?integratedPositionJerk(times,frames.map(f=>f.tip!)):0;
 const wristJerk=integratedPositionJerk(times,frames.map(f=>f.pos[`wrist_${gs}`]));
 let angJerk=0,angVar=0;
 for(const b of PROBE_QUAT_BONES){
  const qs=frames.map(f=>f.quat[b]);
  const st=stepAngles(qs);
  angJerk+=integratedAngularJerk(times,qs);
  for(let i=1;i<st.length;i++)angVar+=st[i];
 }
 const foot=Math.max(0,...report.footSlip.map(s=>s.maxResidual));
 const drift=Math.max(0,...report.footSlip.map(s=>s.maxDrift));
 const pen=report.sole.penetration.L+report.sole.penetration.R;
 const ik=report.ik.armResidual.v+report.ik.legResidual.v;
 const viol=violationFrames(frames);
 /* Worst check severity = the largest v/|limit| seen on any frame — a unit-
  * free ordering across mixed-unit checks. `worstCode` names which code it
  * was (carried into the metric row's unit field at emit). */
 let worstSev=0,worstCode:string|null=null;
 for(const f of frames)for(const [code,x]of Object.entries(f.check)){
  if(x.v===null||x.limit===null||!Number.isFinite(x.v)||!Number.isFinite(x.limit)||x.limit===0)continue;
  const sev=x.v/Math.abs(x.limit);
  if(sev>worstSev){worstSev=sev;worstCode=code;}
 }
 const m:Record<string,number>={
  'cost.endEffectorJerk':tipJerk+wristJerk,'cost.angularJerk':angJerk,
  'cost.checkViolations':viol,'cost.footContact':foot,'cost.penetration':pen,
  'cost.ikResidual':ik,'cost.intentShift':0,
  'wrist.jerkInt':wristJerk,'wrist.vmax':report.wrist.vmax,
  'bones.totalAngVar':angVar,'bones.maxPeakW':Math.max(0,...report.bones.map(b=>b.peakW)),
  'bones.maxPeakAlpha':Math.max(0,...report.bones.map(b=>b.peakAlpha)),
  'bones.kinked':report.kinked.length,
  'support.maxResidual':foot,'support.maxDrift':drift,
  'ik.arm':report.ik.armResidual.v,'ik.leg':report.ik.legResidual.v,'ik.reachMax':report.ik.reachMax.r,
  'sole.penL':report.sole.penetration.L,'sole.penR':report.sole.penetration.R,
  'checks.violationFrames':viol,'checks.worstCode':worstSev,
  'intent.maxTimeShiftS':0,'intent.maxPhaseShiftS':0,'intent.movedKeys':0};
 if(report.tip){
  let pathLen=0;
  for(let i=1;i<frames.length;i++){const a=frames[i-1].tip!,b=frames[i].tip!;
   pathLen+=Math.hypot(b[0]-a[0],b[1]-a[1],b[2]-a[2]);}
  m['tip.pathLen']=pathLen;m['tip.vmax']=report.tip.vmax;m['tip.vpeakT']=report.tip.vpeakT;
  m['tip.jerkInt']=tipJerk;m['tip.kicks']=report.tip.kicks;
  m['tip.topAccel']=report.tip.accelTop[0]?.a??0;
 }
 if(report.contact.time!==null){
  m['contact.time']=report.contact.time;
  if(report.contact.tipSpeed!==null)m['contact.tipSpeed']=report.contact.tipSpeed;
  /* Placeholder zero — the emit path rewrites this with the real candidate
   * vs source contact-point deviation in mm. */
  if(report.tip)m['contact.tipDevMm']=0;
 }
 for(const c of report.chain)m[`chain.relT.${c.seg}`]=c.relT;
 return{metrics:m,report,worstCode};
}

/** measureDoc — public probe→flat-metrics entry; the same numbers the
 * optimizer's objective and the emitted metrics table read. */
export function measureDoc(rig:HumanRig,doc:WorkshopDoc,fps:number,tip?:ProbeTip):Record<string,number>{
 if(!isFps(fps))throw new RangeError('fps 必须是 1..240 的整数');
 return evalDetail(rig,doc,fps,tip).metrics;
}

/** Σ w_k·min(term/max(baseline,floor),4). The 4× cap is deliberate: a term
 * past four times its baseline is catastrophic — the gradient beyond it is
 * intentionally lost so one blown term cannot be paid for by unrelated wins. */
const weightedCost=(m:Record<string,number>,w:GenWeights,base:Record<string,number>)=>{
 let c=0;
 for(const k of Object.keys(COST_KEY)as(keyof GenWeights)[]){
  const floor=COUNT_TERMS.has(k)?1:1e-3;
  c+=w[k]*Math.min((m[COST_KEY[k]]??0)/Math.max(base[COST_KEY[k]]??0,floor),4);
 }
 return c;
};

/* ---- gates --------------------------------------------------------------- */

const sameFlat=(a:WorkshopKey,b:WorkshopKey)=>{const x=flattenPose(a.pose),y=flattenPose(b.pose);
 return x.length===y.length&&x.every((v,i)=>v===y[i]);};
const sameConstraints=(a:WorkshopKey,b:WorkshopKey)=>{
 const x=a.constraints,y=b.constraints;
 return x.plantL===y.plantL&&x.plantR===y.plantR&&x.grip===y.grip&&x.contact===y.contact;};

/** Doc-gates 1–5 — the per-move invariants, cheap enough to run before every
 * trial evaluation AND re-run at emit for the record. */
function docGates(ctx:GenMoveContext,src:WorkshopDoc,cand:WorkshopDoc):GenConstraint[]{
 const rows:GenConstraint[]=[];
 const shape=validateDocShape(cand);
 rows.push({code:'shape',ok:shape.length===0,detail:shape.join('；')||'validateDocShape 通过'});
 const sk=sortedKeys(src),ck=sortedKeys(cand);
 rows.push({code:'key-set',ok:sk.length===ck.length&&sk.every((k,i)=>k.id===ck[i].id),
  detail:'关键帧 id 集合与排序一致'});
 rows.push({code:'doc-fields',ok:src.duration===cand.duration&&src.inbetweens===cand.inbetweens
  &&src.loop===cand.loop&&src.gripSide===cand.gripSide&&src.gripBevel===cand.gripBevel
  &&src.clavicleLift===cand.clavicleLift&&src.freeArms===cand.freeArms
  &&src.handFrames.L===cand.handFrames.L&&src.handFrames.R===cand.handFrames.R,
  detail:'duration/inbetweens/loop/handFrames/gripSide/gripBevel/clavicleLift/freeArms 原样'});
 rows.push({code:'constraints-pattern',ok:sk.every((k,i)=>sameConstraints(k,ck[i])),
  detail:'逐键 plantL/plantR/grip/contact 深比较'});
 const pinned=sk.every((k,i)=>{
  const c=ck[i];
  if(!(ctx.locked.has(k.id)||k.constraints.contact))return true;
  if(!sameFlat(k,c))return false;
  if(c.videoTime!==k.videoTime||c.label!==k.label||c.id!==k.id)return false;
  return c.time===k.time;
 });
 rows.push({code:'pinned-keys',ok:pinned,detail:'locked+contact 键 pose/time/label/videoTime 原样'});
 return rows;
}

/** Gate 7 — every support-run start key keeps its stored contact
 * (target/yaw/pitch verbatim — the sampler only reads the run start's stored
 * foot), and the candidate probe's worst planted residual stays <1cm. */
function plantGate(src:WorkshopDoc,cand:WorkshopDoc,report:ProbeReport):GenConstraint{
 const bad:string[]=[];
 for(const s of ['L','R']as const){
  const flag=s==='L'?'plantL':'plantR',foot=s==='L'?'footL':'footR';
  const starts=(doc:WorkshopDoc)=>{
   const ks=sortedKeys(doc),n=ks.length,out:WorkshopKey[]=[];
   for(let i=0;i<n;i++){
    const prev=doc.loop?ks[(i-1+n)%n]:ks[i-1];
    if(ks[i].constraints[flag]&&(!(prev&&prev.constraints[flag])||ks[i].constraints.replant===true))out.push(ks[i]);
   }
   return out;};
  const a=starts(src),b=starts(cand);
  if(a.length!==b.length||a.some((k,i)=>k.id!==b[i].id)){bad.push(`${s}:支撑段起点集合变化`);continue;}
  for(let i=0;i<a.length;i++){
   const x=a[i].pose[foot],y=b[i].pose[foot];
   if(x.target.x!==y.target.x||x.target.y!==y.target.y||x.target.z!==y.target.z||x.yaw!==y.yaw||x.pitch!==y.pitch)
    bad.push(`${s}:${a[i].id}接触点被改`);
  }
 }
 const slip=Math.max(0,...report.footSlip.map(v=>v.maxResidual));
 if(slip>=1e-2)bad.push(`footSlip.maxResidual ${(slip*1000).toFixed(1)}mm ≥10mm`);
 return{code:'plant-points',ok:bad.length===0,detail:bad.join('；')||`支撑起点接触点原样 · 残差 ${(slip*1000).toFixed(2)}mm`};
}

/** Gate 8 — no new failing check codes, no higher failed-frame count per
 * code, and no worse normalized limit excess vs the same-fps source probe. */
function solveCleanGate(srcFailures:Map<string,CheckFailure>,candFrames:ProbeFrame[]):GenConstraint{
 const after=checkFailures(candFrames),fresh:string[]=[],moreFrames:string[]=[],worseExcess:string[]=[];
 for(const [code,next]of after){
  const before=srcFailures.get(code);
  if(!before)fresh.push(code);
  else{
   if(next.count>before.count)moreFrames.push(`${code} ${before.count}→${next.count}`);
   if(next.excess>before.excess+1e-9)worseExcess.push(`${code} ${before.excess.toFixed(4)}→${next.excess.toFixed(4)}`);
  }
 }
 const ok=!fresh.length&&!moreFrames.length&&!worseExcess.length;
 const detail=ok
  ?`失败码/帧数/归一化超限均未恶化（基线 ${srcFailures.size} 个失败码）`
  :[fresh.length?`新增失败码 ${fresh.join(',')}`:'',moreFrames.length?`失败帧增加 ${moreFrames.join(',')}`:'',
    worseExcess.length?`归一化超限恶化 ${worseExcess.join(',')}`:''].filter(Boolean).join('；');
 return{code:'solve-clean',ok,detail};
}

/** The racket tip world position at instant `t` — the probe's exact
 * measurement path: frameAtCompiled → solveEffectiveFrame →
 * tip.localToWorld(0,.61,0). The rig is left solved; callers reset after. */
const tipPosAt=(rig:HumanRig,compiled:CompiledMotion,tip:ProbeTip,t:number)=>{
 solveEffectiveFrame(rig,frameAtCompiled(compiled,t));
 return tip.localToWorld(RACKET_TIP_LOCAL.clone());
};

/** Verify the exact Object3D returned by attachRacket is still mounted on
 * this rig's grip-side wrist. Parent identity distinguishes same-named bones
 * on another rig and prevents a detached or wrong-side prop from passing. */
function verifyRacketTip(rig:HumanRig,tip:ProbeTip|undefined,side:Side):{ok:boolean;detail:string}{
 if(!tip)return{ok:false,detail:'缺少 attachRacket tip'};
 const object=tip as ProbeTip&{isObject3D?:boolean;name?:string;parent?:Object3D|null};
 const expected=rig.bone(`wrist_${side}`),parent=object.parent;
 const ok=object.isObject3D===true&&object.name==='RacketGrip'&&parent===expected;
 if(ok)return{ok:true,detail:`RacketGrip Object3D 直接挂载于本 rig 的 wrist_${side}`};
 const parentName=parent?.name??'无 parent';
 return{ok:false,detail:`tip 必须是 RacketGrip Object3D 且 parent 身份等于本 rig 的 wrist_${side}（当前 parent: ${parentName}）`};
}

/** Gate 6 — emit-only, because it needs extra solves off the probe grid: for
 * every SOURCE contact key, tip world position cand@candTime vs src@srcTime
 * ≤1mm. A per-accepted-move candidate could still fail here (bounded: moves
 * cannot touch contact keys, so only cross-key trajectory drift can). Also
 * emits the `tip-side` row from the verified Object3D parent identity.
 * Returns the worst deviation too — the same solves feed the
 * `contact.tipDevMm` metric row. */
function contactGate(ctx:GenMoveContext,rig:HumanRig,src:WorkshopDoc,cand:WorkshopDoc,tip:ProbeTip|undefined,gs:Side):{rows:GenConstraint[];devM:number|null}{
 const rows:GenConstraint[]=[];
 const contacts=sortedKeys(src).filter(k=>k.constraints.contact);
 const tipCheck=tip?verifyRacketTip(rig,tip,gs):{ok:contacts.length===0,detail:contacts.length?'contact 文档缺少 tip':'无 contact 且未提供 tip，跳过'};
 rows.push({code:'tip-side',ok:tipCheck.ok,detail:tipCheck.detail});
 if(!contacts.length||!tip){rows.push({code:'contact-point',ok:true,detail:'无 contact 键或无 tip — 跳过'});return{rows,devM:null};}
 const bad:string[]=[];let worst=0;
 const cComp=compileMotion(cand,ctx.origin);
 for(const k of contacts){
  const ck=sortedKeys(cand).find(x=>x.id===k.id)!;
  const d=tipPosAt(rig,ctx.compiled,tip,k.time).distanceTo(tipPosAt(rig,cComp,tip,ck.time));
  worst=Math.max(worst,d);
  if(d>1e-3)bad.push(`${k.id} 偏差 ${(d*1000).toFixed(2)}mm>1mm`);
 }
 rig.reset();
 rows.push({code:'contact-point',ok:bad.length===0,
  detail:bad.join('；')||`contact 键拍头世界位 ≤1mm（最差 ${(worst*1000).toFixed(3)}mm）`});
 return{rows,devM:worst};
}

/* ---- the optimizer -------------------------------------------------------- */

const ALL_GROUPS:ChannelGroup[]=['trunk','handL','handR','footL','footR'];
type Spec={kind:'retime';keyId:string;sign:1|-1;frac:number}
        |{kind:'phase';keyId:string;group:ChannelGroup;sign:1|-1;frac:number};

/** Fixed enumeration order: keys in sorted order; per key retime ±{B,B/2}
 * first, then each enabled group's phase ±{P,P/2}. B is re-derived on the
 * current doc at apply time; P=maxPhaseShiftS. */
function enumerateSpecs(cand:WorkshopDoc,adjust:{time:boolean;phase:boolean;groups:ChannelGroup[]}):Spec[]{
 const out:Spec[]=[];
 for(const k of sortedKeys(cand)){
  if(adjust.time)for(const frac of[1,.5]as const)for(const sign of[1,-1]as const)
   out.push({kind:'retime',keyId:k.id,sign,frac});
  if(adjust.phase)for(const group of ALL_GROUPS){
   if(!adjust.groups.includes(group))continue;
   for(const frac of[1,.5]as const)for(const sign of[1,-1]as const)
    out.push({kind:'phase',keyId:k.id,group,sign,frac});
  }
 }
 return out;
}
const resolveSpec=(ctx:GenMoveContext,cand:WorkshopDoc,sp:Spec):GenMove=>
 sp.kind==='retime'
  ?{kind:'retime',keyId:sp.keyId,delta:sp.sign*sp.frac*retimeStep(ctx,cand,sp.keyId)}
  :{kind:'phase',keyId:sp.keyId,group:sp.group,offset:sp.sign*sp.frac*ctx.maxPhaseShift};

/** The deterministic greedy optimizer. Gate-0 rejects malformed/unsupported
 * requests, then greedy sweeps accept a move iff the eval-fps cost drops by
 * >0.1% AND the candidate still passes doc-gates 1–5 plus gates 7–8 on the
 * trial's own report. Emit re-measures both docs at reportFps, runs gate 6
 * (the only gate needing extra solves), and emits only when every gate holds
 * and the report-fps cost is strictly lower. */
export function generateMotion(rig:HumanRig,req:MotionGenRequest):MotionGenResult{
 const weights:GenWeights={...DEFAULT_WEIGHTS,...req.weights};
 const evalFps=req.evalFps===undefined?40:req.evalFps;
 const reportFps=req.reportFps===undefined?120:req.reportFps;
 const maxEvals=req.budget?.maxEvals===undefined?120:req.budget.maxEvals;
 const maxSweeps=req.budget?.maxSweeps===undefined?4:req.budget.maxSweeps;
 const adjust={time:req.adjust?.time??true,phase:req.adjust?.phase??true,
  groups:req.adjust?.groups??ALL_GROUPS};
 const rejected:MotionGenResult['rejected']=[];
 const diagnostics:MotionGenResult['diagnostics']={evals:0,sweeps:0,stopReason:'converged',appliedMoves:[]};
 const result=(baseline:Record<string,number>):MotionGenResult=>({candidates:[],baseline,rejected,diagnostics});
 const reject=(code:string,reason:string)=>{
  diagnostics.stopReason='invalid-input';rejected.push({code,reason});return result({});
 };

 if(!req.doc)return reject('invalid-input','缺少 workshop 文档');
 const doc=req.doc,gs:Side=doc.gripSide==='L'?'L':'R';

 /* Validate every caller-controlled resource knob before compiling or
  * sampling. The sampled-frame estimate includes baseline, search allowance
  * and both report probes; maxEvals counts all of those evaluations. */
 if(!isFps(evalFps)||!isFps(reportFps))
  return reject('invalid-input','evalFps/reportFps 必须是 1..240 的整数');
 const rawBounds=req.bounds as unknown,rawWeights=req.weights as unknown,rawBudget=req.budget as unknown;
 if(rawBounds!==undefined&&(!rawBounds||typeof rawBounds!=='object'||Array.isArray(rawBounds)))
  return reject('invalid-input','bounds 必须是包含有限正数边界的对象');
 if(rawWeights!==undefined&&(!rawWeights||typeof rawWeights!=='object'||Array.isArray(rawWeights)))
  return reject('invalid-input','weights 必须是权重对象');
 if(rawBudget!==undefined&&(!rawBudget||typeof rawBudget!=='object'||Array.isArray(rawBudget)))
  return reject('invalid-input','budget 必须是整数预算对象');
 for(const [name,value]of Object.entries(req.bounds??{}))
  if((name==='maxTimeShiftS'||name==='maxPhaseShiftS')&&(!Number.isFinite(value)||value<=0))
   return reject('invalid-input',`${name} 必须是有限正数`);
 if(Object.values(weights).some(v=>!Number.isFinite(v)||v<0)||!Object.values(weights).some(v=>v>0))
  return reject('invalid-input','weights 必须为非负有限数且至少一个权重大于 0');
 if(!Number.isSafeInteger(maxEvals)||maxEvals<4||!Number.isSafeInteger(maxSweeps)
  ||maxSweeps<1||maxSweeps>MAX_GENERATION_SWEEPS)
  return reject('invalid-input',`budget.maxEvals 必须是 ≥4 的安全整数，maxSweeps 必须是 1..${MAX_GENERATION_SWEEPS} 的安全整数`);
 if(adjust.groups.some(g=>!ALL_GROUPS.includes(g)))
  return reject('invalid-input',`adjust.groups 只能包含 ${ALL_GROUPS.join(', ')}`);

 /* gate-0 — input rejections never reach the evaluator */
 const problems=validateDocShape(doc);
 if(problems.length)return reject('invalid-input',`文档形状非法: ${problems.join('；')}`);
 if(doc.inbetweens===false)return reject('invalid-input','inbetweens:false 的文档不在优化域内（Hermite 采样才有时序自由度）');
 if((req.candidates??1)!==1)return reject('invalid-input',`v1 仅支持 candidates=1（收到 ${req.candidates}）`);
 const hasContact=doc.keys.some(k=>k.constraints.contact);
 if(hasContact&&!req.tip)return reject('tip-missing','文档含 contact 关键帧但请求未提供 attachRacket tip');
 if(req.tip){
  const mount=verifyRacketTip(rig,req.tip,gs);
  if(!mount.ok)return reject('tip-missing',mount.detail);
 }

 const evalSamples=estimatedSamples(doc.duration,evalFps),reportSamples=estimatedSamples(doc.duration,reportFps);
 const sampledWork=(maxEvals-2)*evalSamples+2*reportSamples;
 if(!Number.isSafeInteger(sampledWork)||sampledWork>MAX_GENERATION_SAMPLED_FRAMES)
  return reject('work-budget',`估算采样工作量 ${sampledWork} 帧超过上限 ${MAX_GENERATION_SAMPLED_FRAMES}`);

 const ctx=buildGenContext(rig,doc,{lockedKeyIds:req.lockedKeyIds,bounds:req.bounds});
 const src=cloneDoc(doc);
 const evaluate=(d:WorkshopDoc,fps:number,phase:MotionGenProgress['phase'],sweep?:number)=>{
  const ev=evalDetail(rig,d,fps,req.tip);diagnostics.evals++;
  req.onProgress?.({evals:diagnostics.evals,maxEvals,phase,...(sweep===undefined?{}:{sweep})});
  return ev;
 };
 const srcEval=evaluate(src,evalFps,'baseline');
 const baseline=srcEval.metrics,srcCost=weightedCost(baseline,weights,baseline);
 const srcFailures=checkFailures(srcEval.report.frames);

 /* gate-0 — the move set must be non-empty (adjust toggles may empty it) */
 const specs=enumerateSpecs(src,adjust);
 if(!specs.some(sp=>applyGenMove(ctx,src,resolveSpec(ctx,src,sp))!==null)){
  diagnostics.stopReason='no-adjustable-keys';
  rejected.push({code:'no-adjustable-keys',reason:'可调移动集合为空（全部 locked/contact/端点，或 adjust/bounds 置空）'});
  return result(baseline);
 }

 /* greedy sweeps */
 let cand=src,bestCost=srcCost;
 /* intent deviation, raw seconds per key — retime stores |newT−srcT|,
  * phase stores |offset| per (key,group): the LAST absolute offset stands
  * (phase snapshots are non-stacking). */
 const devT=new Map<string,number>(),devP=new Map<string,number>();
 const intentOf=(dT:Map<string,number>,dP:Map<string,number>)=>{
  let s=0;for(const v of dT.values())s+=v/ctx.maxTimeShift;
  for(const v of dP.values())s+=v/ctx.maxPhaseShift;return s;};
 const searchEvalLimit=maxEvals-2; // reserve both report-fps probes
 for(let sweep=0;sweep<maxSweeps;sweep++){
  diagnostics.sweeps=sweep+1;
  let accepted=0;
  for(const sp of enumerateSpecs(cand,adjust)){
   const move=resolveSpec(ctx,cand,sp);
   const next=applyGenMove(ctx,cand,move);
   if(!next)continue;
   if(docGates(ctx,src,next).some(g=>!g.ok))continue;
   if(diagnostics.evals>=searchEvalLimit){diagnostics.stopReason='eval-budget';break;}
   const ev=evaluate(next,evalFps,'search',sweep+1);
   const dT=new Map(devT),dP=new Map(devP);
   let delta:number;
   if(move.kind==='retime'){
    delta=sortedKeys(next).find(k=>k.id===move.keyId)!.time-ctx.srcTimes.get(move.keyId)!;
    dT.set(move.keyId,Math.abs(delta));
   }else{
    delta=move.offset;
    dP.set(`${move.keyId}:${move.group}`,Math.abs(move.offset));
   }
   ev.metrics['cost.intentShift']=intentOf(dT,dP);
   const cost=weightedCost(ev.metrics,weights,baseline);
   if(!(cost<bestCost*(1-1e-3)))continue;
   /* Per-ACCEPTED-move gating: gates 7–8 reuse this eval's report — cheap.
    * Gate 6 (contact point) needs extra solves and runs at emit only. */
   const g7=plantGate(src,next,ev.report),g8=solveCleanGate(srcFailures,ev.report.frames);
   if(!g7.ok||!g8.ok)continue;
   cand=next;bestCost=cost;devT.clear();for(const[k,v]of dT)devT.set(k,v);
   devP.clear();for(const[k,v]of dP)devP.set(k,v);
   diagnostics.appliedMoves.push(move.kind==='retime'
    ?{kind:'retime',keyId:move.keyId,delta}
    :{kind:'phase',keyId:move.keyId,group:move.group,delta});
   accepted++;
  }
  if(diagnostics.stopReason==='eval-budget')break;
  if(accepted===0){diagnostics.stopReason='converged';break;}
  if(sweep===maxSweeps-1)diagnostics.stopReason='eval-budget';
 }

 /* emit — re-measure both at reportFps, then gates 6–8 on that report */
 const srcRep=evaluate(src,reportFps,'report');
 const candRep=cand===src?srcRep:evaluate(cand,reportFps,'report');
 candRep.metrics['cost.intentShift']=intentOf(devT,devP);
 let maxT=0,maxP=0;const moved=new Set<string>();
 for(const[k,v]of devT){maxT=Math.max(maxT,v);moved.add(k);}
 for(const[k,v]of devP){maxP=Math.max(maxP,v);moved.add(k.split(':')[0]);}
 candRep.metrics['intent.maxTimeShiftS']=maxT;candRep.metrics['intent.maxPhaseShiftS']=maxP;
 candRep.metrics['intent.movedKeys']=moved.size;
 const srcRepCost=weightedCost(srcRep.metrics,weights,srcRep.metrics);
 const candRepCost=weightedCost(candRep.metrics,weights,srcRep.metrics);
 const objective=candRepCost/Math.max(srcRepCost,1e-9);

 const cg=contactGate(ctx,rig,src,cand,req.tip,gs);
 if(cg.devM!==null)candRep.metrics['contact.tipDevMm']=cg.devM*1000;
 const constraints=[...docGates(ctx,src,cand),...cg.rows,
  plantGate(src,cand,candRep.report),
  solveCleanGate(checkFailures(srcRep.report.frames),candRep.report.frames),
  {code:'report-fps-cost',ok:candRepCost<srcRepCost,
   detail:`cost@reportFps ${candRepCost.toFixed(4)} vs src ${srcRepCost.toFixed(4)}`}];

 const gatesFailed=constraints.some(g=>!g.ok&&g.code!=='report-fps-cost');
 if(gatesFailed||!(candRepCost<srcRepCost)){
  rejected.push({code:gatesFailed?'gates-failed':'regressed-at-report-fps',
   reason:gatesFailed
    ?`verdict degraded — 未过门禁: ${constraints.filter(g=>!g.ok).map(g=>g.code).join(',')}`
    :`reportFps 代价未严格下降（${candRepCost.toFixed(4)} vs ${srcRepCost.toFixed(4)}）`,
   objective});
  return result(baseline);
 }

 /* verdict: objective≤0.95 AND ≥1 primary metric improved ≥5% ⇒ improved.
  * Primary set: endEffectorJerk/angularJerk/violationFrames/maxResidual/pen.
  * Improvement denominators reuse the cost floors so floor-level noise
  * (4e-16→0) cannot manufacture an "improvement". */
 const PRIMARY:[string,number][]=[['cost.endEffectorJerk',1e-3],['cost.angularJerk',1e-3],
  ['checks.violationFrames',1],['support.maxResidual',1e-3],['sole.penL',1e-3],['sole.penR',1e-3]];
 const primaryImproved=PRIMARY.some(([k,f])=>{
  const b=srcRep.metrics[k],a=candRep.metrics[k];
  return b!==undefined&&a!==undefined&&(b-a)/Math.max(b,f)>=0.05;});
 const verdict:MotionCandidate['verdict']=objective<=0.95&&primaryImproved?'improved':'neutral';

 /* Metrics are sparse when the probe could not measure a quantity (no racket
  * means no tip.*, and no contact key means no contact.*). Never serialize
  * unavailable measurements as plausible-looking zeroes. */
 const ROWS:[string,string,'down'|'up'|'na'][]=[
  ['cost.endEffectorJerk','m/s²','down'],['cost.angularJerk','rad/s²','down'],
  ['tip.pathLen','m','na'],['tip.vmax','m/s','na'],['tip.vpeakT','s','na'],
  ['tip.jerkInt','m/s²','down'],['tip.kicks','count','down'],['tip.topAccel','m/s²','down'],
  ['wrist.jerkInt','m/s²','down'],['wrist.vmax','m/s','na'],
  ['bones.totalAngVar','rad','na'],['bones.maxPeakW','rad/s','na'],
  ['bones.maxPeakAlpha','rad/s²','na'],['bones.kinked','count','down'],
  ['support.maxResidual','m','down'],['support.maxDrift','m','down'],
  ['ik.arm','m','down'],['ik.leg','m','down'],['ik.reachMax','ratio','down'],
  ['sole.penL','m','down'],['sole.penR','m','down'],
  ['checks.violationFrames','frames','down'],['checks.worstCode','severity','down'],
  ['contact.time','s','na'],['contact.tipSpeed','m/s','na'],['contact.tipDevMm','mm','down'],
  ['chain.relT.pelvis','s','na'],['chain.relT.trunk','s','na'],['chain.relT.shoulderGirdle','s','na'],
  ['chain.relT.upperArm','s','na'],['chain.relT.forearm','s','na'],['chain.relT.hand','s','na'],
  ['intent.maxTimeShiftS','s','na'],['intent.maxPhaseShiftS','s','na'],['intent.movedKeys','count','na']];
 const metrics:Record<string,MetricRow>={};
 for(const[k,unit,better]of ROWS){
  const b=srcRep.metrics[k],a=candRep.metrics[k];
  if(b===undefined||a===undefined)continue;
  metrics[k]={before:b,after:a,unit,better};
 }
 metrics['checks.worstCode'].unit=candRep.worstCode??srcRep.worstCode??'none';

 return{candidates:[{doc:cand,objective,verdict,metrics,constraints,probe:candRep.report}],
  baseline,rejected,diagnostics};
}
