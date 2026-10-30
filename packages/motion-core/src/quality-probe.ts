/** Quality probe: sample a workshop document at high fps through the REAL
 * solve path — frameAt → solveEffectiveFrame → analyzePose, the exact calls
 * solveWorkshop's sampler makes — and measure the defects the 40 fps semantic
 * gates cannot see: foot slip inside support intervals, per-frame solver
 * discontinuities (pelvis correction, IK clamps, slerp segment changes, wrist
 * bend clamp), ground penetration, kinetic-chain sequencing and wrist/tip
 * trajectory smoothness.
 *
 * Single implementation shared by vitest (src/workshop/quality.test.ts) and
 * the calibration CLI (scripts/measure-quality-probe.mts) — a second copy
 * would drift (learning[4]). Node-free: pure three + workshop/core modules.
 *
 * Discontinuity detection note: at high fps a true C0 position jump shows a
 * per-step rotation independent of dt; a derivative kink shows a step series
 * whose slope changes abruptly. The report therefore carries (a) raw per-step
 * angles, (b) local outlier ratios vs neighbours and (c) angular-jerk peaks. */
import {RACKET_TIP_LOCAL} from './props/racket';
import {Quaternion,Vector3} from 'three';
import type {HumanRig} from './rig';
import {DEG,WRIST_BEND_LIMIT_DEG,solveTwoBone} from './kinematics';
import {DORSI_LIMIT_DEG,analyzePose,solveEffectiveFrame} from './solver';
import {buildPelvisSchedule} from './pelvis-schedule';
import {compileMotion,frameAtCompiled,sortedKeys,toV,type WorkshopDoc} from './document';
import {sampleTimes} from './pose-package';
import {footGeometry,footLowestY,type Side} from './foot';

export type Vec3=[number,number,number];
export type Quat=[number,number,number,number];

/* ---- tracked bones ---------------------------------------------------- */
/** Bones whose world-rotation step series the probe measures. */
export const PROBE_QUAT_BONES=[
 'root','spine05','spine04','spine03','spine02','spine01','neck01','neck02','head',
 'clavicle_R','shoulder01_R','upperarm01_R','upperarm02_R','lowerarm01_R','lowerarm02_R','wrist_R',
 'clavicle_L','shoulder01_L','upperarm01_L','upperarm02_L','lowerarm01_L','lowerarm02_L','wrist_L',
 'upperleg01_L','upperleg02_L','lowerleg01_L','lowerleg02_L','foot_L',
 'upperleg01_R','upperleg02_R','lowerleg01_R','lowerleg02_R','foot_R',
] as const;
/** Joint points whose world positions are captured per frame. */
export const PROBE_POINTS=[
 'root','spine01','neck01','head','wrist_L','wrist_R','lowerarm01_R','lowerarm01_L','upperarm01_R',
 'foot_L','foot_R','lowerleg01_L','lowerleg01_R','upperleg01_L','upperleg01_R',
] as const;
/** Kinetic chain for the sequencing table (pelvis→hand): follows the
 * document's gripSide — the gripping arm is the one whose solve quality the
 * table diagnoses. Labels/parents are keyed by bone name for both sides. */
const chainBones=(side:'L'|'R')=>['root','spine01',`clavicle_${side}`,`upperarm01_${side}`,`lowerarm01_${side}`,`wrist_${side}`] as const;
const CHAIN_LABEL:Record<string,string>={root:'pelvis',spine01:'trunk',
 clavicle_R:'shoulderGirdle',upperarm01_R:'upperArm',lowerarm01_R:'forearm',wrist_R:'hand',
 clavicle_L:'shoulderGirdle',upperarm01_L:'upperArm',lowerarm01_L:'forearm',wrist_L:'hand'};
const CHAIN_PARENT:Record<string,string|undefined>={root:undefined,spine01:'root',
 clavicle_R:'spine01',upperarm01_R:'clavicle_R',lowerarm01_R:'upperarm01_R',wrist_R:'lowerarm01_R',
 clavicle_L:'spine01',upperarm01_L:'clavicle_L',lowerarm01_L:'upperarm01_L',wrist_L:'lowerarm01_L'};

/** Anything that carries a tip point in its local frame — the racket from
 * attachRacket. Tip metrics are skipped when absent (never silently mapped
 * onto the wrist). */
export interface ProbeTip{localToWorld(v:Vector3):Vector3}

/** Per-frame capture of the solved rig. All positions are world space. */
export interface ProbeFrame{
 t:number;key:number;
 root:Vec3;
 /** World quaternions (xyzw) for PROBE_QUAT_BONES. */
 quat:Record<string,Quat>;
 /** World positions for PROBE_POINTS. */
 pos:Record<string,Vec3>;
 /** Racket tip world position — null when the probe ran without a tip object. */
 tip:Vec3|null;
 /** Lowest solved foot point per side (over toe joints + virtual heel). */
 lowestFootY:{L:number;R:number};
 plant:{L:boolean;R:boolean};
 footTarget:{L:Vec3;R:Vec3};
 handTarget:{L:Vec3;R:Vec3};
 /** Posterior pelvis correction applied this frame (m) and whether the
  * 15 cm cap was hit — the recorded signal for pelvis-fold diagnostics. */
 pelvisShift:number;saturated:boolean;
 /** Gripping-arm (doc.gripSide) two-bone internals re-derived from the solved
  * shoulder root (same math rig.limb ran, kept for clamp/saturation
  * diagnostics): target distance d vs max reach, solved flexion, pole-bend
  * direction, wrist bend angle before the WRIST_BEND_LIMIT_DEG clamp. */
 arm:{d:number;reach:number;flexion:number;bendDir:Vec3;wristBend:number};
 /** Leg hip→foot-target distances per side. */
 legD:{L:number;R:number};
 /** analyzePose check entries by code: `v` is the measured value (null = not
  * applicable at this frame), `ok`/`limit` the item's verdict and bound —
  * carried per frame so downstream consumers (the PR-D optimizer's
  * violation-count and new-failure gates) can count FAILING frames, which a
  * bare worst-value per code cannot express. */
 check:Record<string,{v:number|null;ok:boolean;limit:number|null}>;
}

export interface ProbeSpike{what:string;t:number;value:number;unit:string;extra?:string}
export interface ProbeInterval{side:'L'|'R';from:number;to:number}
/** One support interval's planted-foot residuals (metres). `maxResidual` is
 * |ankle − effective contact target|; `maxDrift` is drift from the interval's
 * first solved ankle position. */
export interface ProbeSlip extends ProbeInterval{samples:number;maxResidual:number;residualT:number;maxDrift:number}
/** Per-bone rotational stats: peak angular speed (rad/s), largest single
 * step (rad), worst local outlier ratio (a kink stands out from its ±5-step
 * neighbourhood; smooth fast motion does not) and peak angular jerk (rad/s²). */
export interface ProbeBoneStat{bone:string;peakW:number;peakT:number;peakAlpha:number;alphaT:number;maxStep:number;stepT:number;kink:number;kinkT:number;jerk:number;jerkT:number}
/** Kinetic-chain segment peaks: global world-frame, inside the active window,
 * and relative-to-parent inside the window (the biomechanics convention —
 * each link's rotation wrt its parent isolates its own contribution). */
export interface ProbeChainStat{bone:string;seg:string;peak:number;t:number;activePeak:number;activeT:number;relPeak:number;relT:number}
export interface ProbeTurn{t:number;deg:number;v:number}
export interface ProbeAccel{t:number;a:number;dv:number}
/** Endpoint trajectory smoothness: peak speed, >25° direction reversals,
 * largest per-frame accelerations and per-frame |Δv| kick count. */
export interface ProbeSmooth{vmax:number;vpeakT:number;threshold:number;turns:ProbeTurn[];accelTop:ProbeAccel[];kicks:number}

export interface ProbeReport{
 /** Report label (motion id / document name). */
 name:string;
 /** Sample rate the frames were captured at. */
 fps:number;
 /** 1/fps — the finite-difference step every rate derives from. */
 dt:number;
 duration:number;keyCount:number;frameCount:number;
 /** Sorted authored key instants — the atKey classification reference. */
 keyTimes:number[];
 /** Rest-pose sole plane heights the ground metrics compare against (m). */
 groundY:{L:number;R:number};
 /** plant=true runs reconstructed from the sampled frames. */
 supportIntervals:ProbeInterval[];
 /** Per-interval planted-foot residual/drift worsts (m). */
 footSlip:ProbeSlip[];
 /** Per-bone step/peak/outlier/jerk stats, sorted by peak speed desc. */
 bones:ProbeBoneStat[];
 /** Bones with a local kink (outlier >4× and step >0.0035 rad). */
 kinked:ProbeBoneStat[];
 /** Root trajectory: max per-frame step (m), peak speed and acceleration. */
 root:{maxStep:number;stepT:number;maxV:number;maxA:number;accelT:number};
 /** Pelvis correction series: range, largest one-frame jump (m), saturated count. */
 pelvis:{shiftMin:number;shiftMax:number;maxJump:number;jumpT:number;saturatedFrames:number};
 /** Lowest solved foot point vs the rest sole plane (m). */
 sole:{minY:{L:number;R:number};minYT:{L:number;R:number};penetration:{L:number;R:number}};
 /** Gripping side the arm/chain/wrist metrics instrument (doc.gripSide, 'R'
  * default) — every per-side report label derives from it. */
 gripSide:'L'|'R';
 /** IK residuals and saturation internals (m / deg / ratio). */
 ik:{armResidual:{v:number;t:number;side:string};legResidual:{v:number;t:number;side:string};reachMax:{r:number;t:number};poleBendFlip:{v:number;t:number}};
 /** Wrist bend demand vs the solver's WRIST_BEND_LIMIT_DEG clamp. */
 wristClamp:{limitDeg:number;maxBend:number;maxBendT:number;clampedFrames:number;transitions:number[];deficitMax:number;deficitFrames:number;deficitMedian:number};
 /** The window the chain's active/relative peaks were taken over. */
 activeWindow:[number,number];
 chain:ProbeChainStat[];
 wrist:ProbeSmooth;
 /** null when the probe ran without a tip object. */
 tip:ProbeSmooth|null;
 /** Max per-frame acceleration of the authored gripping-hand target —
  * separates document/interpolation jumps from solver jumps at the wrist. */
 handTargetAccel:{a:number;t:number};
 /** Gripping-wrist per-step angle (rad) split by proximity to a key instant —
  * the slerp C0 signature: equal medians mean keys don't kink the trajectory. */
 wristStep:{atKeyMedian:number;atKeyCount:number;interiorMedian:number;interiorCount:number};
 /** Last contact-flagged key and the tip speed measured at it. */
 contact:{time:number|null;tipSpeed:number|null};
 /** Worst observed value per analyzePose check code (only codes seen with a value). */
 solverChecks:Record<string,{v:number;t:number}>;
 /** Severity-sorted spike list (desc by value). */
 spikes:ProbeSpike[];
 /** The sampled frames — kept for downstream reuse (alt-fps comparisons,
  * parity checks). Bulky: pick fields explicitly when serialising. */
 frames:ProbeFrame[];
}

/* ---- helpers --------------------------------------------------------- */
const v3a=(v:Vector3):Vec3=>[v.x,v.y,v.z];
const q4=(q:Quaternion):Quat=>[q.x,q.y,q.z,q.w];
const sub=(a:number[],b:number[]):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const len=(a:number[])=>Math.hypot(a[0],a[1],a[2]);
const dist=(a:number[],b:number[])=>len(sub(a,b));
/** Median (upper middle); 0 on empty input. */
export const median=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b);return s[Math.floor(s.length/2)]??0;};

/** Hemisphere-fixed per-step rotation angle series (rad); out[0]=0. */
export function stepAngles(series:Quat[]){
 const out:number[]=[0];
 let prev=series[0].slice();
 for(let i=1;i<series.length;i++){
  const q=series[i];
  const dot0=prev[0]*q[0]+prev[1]*q[1]+prev[2]*q[2]+prev[3]*q[3];
  const s=dot0<0?-1:1;
  const dot=Math.min(1,Math.abs(dot0));
  out.push(2*Math.acos(dot));
  prev=s<0?q.map(v=>-v):q.slice();
 }
 return out;
}
/** World-frame angular velocity vectors on each actual sample interval. The
 * midpoint timestamp keeps acceleration estimates correct when the final
 * sample is the exact, non-grid-aligned document duration. */
function angularVelocities(times:number[],series:Quat[]):{v:Vec3;t:number}[]{
 const out:{v:Vec3;t:number}[]=[];
 for(let i=1;i<series.length;i++){
  const dt=times[i]-times[i-1];
  const delta=new Quaternion(...series[i])
   .multiply(new Quaternion(...series[i-1]).invert()).normalize();
  if(delta.w<0)delta.set(-delta.x,-delta.y,-delta.z,-delta.w);
  const sin=Math.hypot(delta.x,delta.y,delta.z);
  const angle=2*Math.atan2(sin,Math.max(0,delta.w));
  const scale=sin>1e-12?angle/(sin*dt):0;
  out.push({v:[delta.x*scale,delta.y*scale,delta.z*scale],t:(times[i]+times[i-1])/2});
 }
 return out;
}
/** Local outlier ratio: step_i vs median of the neighbouring steps. A true
 * kink stands out from its own neighbourhood; smooth fast motion does not. */
function outlierRatio(steps:number[],i:number){
 const lo=Math.max(0,i-5),hi=Math.min(steps.length-1,i+5);
 const neigh=[];for(let j=lo;j<=hi;j++)if(Math.abs(j-i)>1)neigh.push(steps[j]);
 return steps[i]/(median(neigh)+1e-9);
}

/* ---- frame capture ---------------------------------------------------- */
/** Solve every sample of `doc` at `fps` through the real path and record the
 * per-frame captures the report metrics derive from. The grid follows the
 * package builder's contract (uniform 1/fps steps + the exact motion end), so
 * probe frames land on pose-package timestamps whenever the fps match. */
export function probeFrames(rig:HumanRig,doc:WorkshopDoc,fps:number,tip?:ProbeTip):ProbeFrame[]{
 const geoL=footGeometry(rig.rest,'L'),geoR=footGeometry(rig.rest,'R');
 // Same sampling origin solveWorkshop and the workshop engine pass
 // (learning[16]): pelvis-frame hands resolve through the rest root.
 const origin=rig.rest.get('root')!;
 /* The document is stable for the whole sweep — one compiled snapshot
  * instead of a buildModel per frame (same frames the compat path yields). */
 const compiled=compileMotion(doc,origin);
 const schedule=buildPelvisSchedule(rig,compiled);
 /* Gripping side read once: compiled.gripSide is the compile-time copy of
  * doc.gripSide — identical while the doc is fixed, and the value every
  * sampled frame itself reports. */
 const gs:Side=compiled.gripSide==='L'?'L':'R';
 const times=sampleTimes(doc.duration,fps);
 const frames:ProbeFrame[]=[];
 for(const t of times){
  const f=frameAtCompiled(compiled,t);
  const rep=solveEffectiveFrame(rig,f,schedule.passthrough?undefined:schedule.at(t));
  // Deliberately the same analyzePose call solveWorkshop's sampler makes —
  // check items are identical with or without a tip object; the tip is
  // measured separately below.
  const a=analyzePose(rig,f.pose,f.constraints);
  const quat:ProbeFrame['quat']={},pos:ProbeFrame['pos']={};
  for(const b of PROBE_QUAT_BONES)quat[b]=q4(rig.bone(b).getWorldQuaternion(new Quaternion()));
  for(const p of PROBE_POINTS)pos[p]=v3a(rig.point(p));
  const check:ProbeFrame['check']={};
  for(const it of a.items)check[it.code]={v:it.value,ok:it.ok,limit:it.limit};
  /* Gripping-arm (doc.gripSide — the hoisted `gs` above) two-bone internals
   * from the solved shoulder root — same math rig.limb ran, kept for
   * clamp/saturation diagnostics. */
  const r0=rig.rest.get(`upperarm01_${gs}`)!,r1=rig.rest.get(`lowerarm01_${gs}`)!,r2=rig.rest.get(`wrist_${gs}`)!;
  const al=r1.clone().sub(r0).length(),bl=r2.clone().sub(r1).length();
  const root=rig.point(`upperarm01_${gs}`),gp=gs==='L'?f.pose.handL:f.pose.handR;
  const target=toV(gp.target),pole=toV(gp.pole);
  const sv=solveTwoBone(root,target,pole,al,bl,doc.freeArms?180:145);
  const dir=target.clone().sub(root).normalize();
  const bend=pole.clone().sub(root).addScaledVector(dir,-pole.clone().sub(root).dot(dir)).normalize();
  const forearm=rig.point(`wrist_${gs}`).sub(rig.point(`lowerarm01_${gs}`)).normalize();
  const wristBend=forearm.angleTo(toV(gp.forward).normalize())/DEG;
  frames.push({
   t,key:f.keyIndex,
   root:v3a(rig.point('root')),quat,pos,
   tip:tip?v3a(tip.localToWorld(RACKET_TIP_LOCAL.clone())):null,
   lowestFootY:{
    L:footLowestY(geoL,Math.min(...geoL.names.map(nm=>rig.point(nm).y)),rig.point('foot_L').y,rig.bone('foot_L').getWorldQuaternion(new Quaternion())),
    R:footLowestY(geoR,Math.min(...geoR.names.map(nm=>rig.point(nm).y)),rig.point('foot_R').y,rig.bone('foot_R').getWorldQuaternion(new Quaternion())),
   },
   plant:{L:f.constraints.plantL,R:f.constraints.plantR},
   footTarget:{L:v3a(toV(f.pose.footL.target)),R:v3a(toV(f.pose.footR.target))},
   handTarget:{L:v3a(toV(f.pose.handL.target)),R:v3a(toV(f.pose.handR.target))},
   pelvisShift:rep.pelvisShift,saturated:rep.pelvisSaturated,
   arm:{d:target.clone().sub(root).length(),reach:al+bl,flexion:sv.flexion,bendDir:v3a(bend),wristBend},
   legD:{L:toV(f.pose.footL.target).sub(rig.point('upperleg01_L')).length(),R:toV(f.pose.footR.target).sub(rig.point('upperleg01_R')).length()},
   check,
  });
 }
 rig.reset();
 return frames;
}

/* ---- analysis --------------------------------------------------------- */
export interface AnalyzeProbeArgs{
 doc:WorkshopDoc;
 /** The rate `frames` was captured at — every rate metric derives from it. */
 fps:number;
 frames:ProbeFrame[];
 /** Rest skeleton (`rig.rest`) — the sole-plane reference for ground metrics. */
 rest:ReadonlyMap<string,Vector3>;
 /** Report label; defaults to doc.id. */
 name?:string;
 /** Kinetic-chain "active" window [t0,t1] — the forehand swing is [1.3,3.5]. */
 activeWindow?:[number,number];
}

/** Fold a captured frame series into the structured report. Pure — every
 * metric below derives only from `frames`, `doc` and `rest`. */
export function analyzeProbeFrames({doc,fps,frames,rest,name,activeWindow}:AnalyzeProbeArgs):ProbeReport{
 const dt=1/fps;
 const wristLimit=doc.freeArms?180:WRIST_BEND_LIMIT_DEG;
 const groundY={L:footGeometry(rest,'L').groundY,R:footGeometry(rest,'R').groundY};
 const keys=sortedKeys(doc);
 const keyTimes=keys.map(k=>k.time);
 const nearKey=(t:number)=>keyTimes.reduce((b,k)=>Math.min(b,Math.abs(k-t)),Infinity);
 const spikes:ProbeSpike[]=[];
 const push=(s:ProbeSpike)=>spikes.push(s);

 /* support intervals: plant flag transitions over the sampled frames */
 const intervals:ProbeInterval[]=[];
 for(const s of ['L','R']as const){
  let start:number|undefined;
  for(const f of frames){
   const on=f.plant[s];
   if(on&&start===undefined)start=f.t;
   if(!on&&start!==undefined){intervals.push({side:s,from:start,to:f.t});start=undefined;}
  }
  if(start!==undefined)intervals.push({side:s,from:start,to:doc.duration});
 }

 /* [1] foot slip inside support intervals */
 const footSlip:ProbeSlip[]=[];
 for(const iv of intervals){
  const fl=frames.filter(f=>f.t>=iv.from-1e-9&&f.t<=iv.to+1e-9&&f.plant[iv.side]);
  let worst=0,wt=0,drift=0;
  const anchor=fl[0]?.pos[`foot_${iv.side}`];
  for(const f of fl){
   const s=dist(f.pos[`foot_${iv.side}`],f.footTarget[iv.side]);
   if(s>worst){worst=s;wt=f.t;}
   if(anchor)drift=Math.max(drift,dist(f.pos[`foot_${iv.side}`],anchor));
  }
  footSlip.push({...iv,samples:fl.length,maxResidual:worst,residualT:wt,maxDrift:drift});
  if(worst>0.001)push({what:`foot-slip-${iv.side}`,t:wt,value:worst*100,unit:'cm'});
 }

 /* [2] per-bone angular speed, vector angular acceleration, step outliers */
 const boneStats:ProbeBoneStat[]=[];
 for(const b of PROBE_QUAT_BONES){
  const quats=frames.map(f=>f.quat[b]),steps=stepAngles(quats);
  const times=frames.map(f=>f.t),omega=angularVelocities(times,quats);
  const w=[0,...omega.map(x=>Math.hypot(...x.v))];
  let peakW=0,peakT=0,peakAlpha=0,alphaT=0,maxStep=0,stepT=0,kink=0,kinkT=0,jerk=0,jerkT=0;
  for(let i=1;i<steps.length;i++){
   if(w[i]>peakW){peakW=w[i];peakT=frames[i].t;}
   if(steps[i]>maxStep){maxStep=steps[i];stepT=frames[i].t;}
   const r=outlierRatio(steps,i);
   if(steps[i]>0.002&&r>kink){kink=r;kinkT=frames[i].t;}
   if(i>1){
    const midDt=omega[i-1].t-omega[i-2].t;
    const ax=(omega[i-1].v[0]-omega[i-2].v[0])/midDt;
    const ay=(omega[i-1].v[1]-omega[i-2].v[1])/midDt;
    const az=(omega[i-1].v[2]-omega[i-2].v[2])/midDt;
    const alpha=Math.hypot(ax,ay,az),at=(omega[i-1].t+omega[i-2].t)/2;
    if(alpha>peakAlpha){peakAlpha=alpha;alphaT=at;}
    const j=Math.abs(w[i]-w[i-1])/midDt;if(j>jerk){jerk=j;jerkT=at;}
   }
  }
  boneStats.push({bone:b,peakW,peakT,peakAlpha,alphaT,maxStep,stepT,kink,kinkT,jerk,jerkT});
 }
 boneStats.sort((a,b)=>b.peakW-a.peakW);
 const kinked=boneStats.filter(s=>s.kink>4&&s.maxStep>0.0035).sort((a,b)=>b.kink*b.maxStep-a.kink*a.maxStep);

 /* [3] root continuity + pelvis correction */
 let rootMaxStep=0,rootStepT=0,rootMaxV=0,rootMaxA=0,rootAT=0;
 const rootV:number[]=[0];
 for(let i=1;i<frames.length;i++){
  const d=dist(frames[i].root,frames[i-1].root);
  if(d>rootMaxStep){rootMaxStep=d;rootStepT=frames[i].t;}
  const v=d/dt;rootV.push(v);rootMaxV=Math.max(rootMaxV,v);
 }
 for(let i=1;i<rootV.length;i++){const a=Math.abs(rootV[i]-rootV[i-1])/dt;if(a>rootMaxA){rootMaxA=a;rootAT=frames[i].t;}}
 if(rootMaxStep>0.005)push({what:'root-teleport',t:rootStepT,value:rootMaxStep*100,unit:'cm'});
 push({what:'root-accel-peak',t:rootAT,value:rootMaxA,unit:'m/s²'});
 let shiftJump=0,shiftJumpT=0;
 for(let i=1;i<frames.length;i++){const d=Math.abs(frames[i].pelvisShift-frames[i-1].pelvisShift);if(d>shiftJump){shiftJump=d;shiftJumpT=frames[i].t;}}
 const sat=frames.filter(f=>f.saturated);
 if(shiftJump>0.002)push({what:'pelvisShift-jump',t:shiftJumpT,value:shiftJump*100,unit:'cm'});
 const shiftMin=Math.min(...frames.map(f=>f.pelvisShift)),shiftMax=Math.max(...frames.map(f=>f.pelvisShift));

 /* [4] ground: sole vs rest sole plane */
 const minYL=Math.min(...frames.map(f=>f.lowestFootY.L)),minYR=Math.min(...frames.map(f=>f.lowestFootY.R));
 const penL=Math.max(0,groundY.L-minYL),penR=Math.max(0,groundY.R-minYR);
 const penLt=frames.find(f=>f.lowestFootY.L===minYL)!.t,penRt=frames.find(f=>f.lowestFootY.R===minYR)!.t;
 if(penL>0.001)push({what:'sole-below-rest-plane-L',t:penLt,value:penL*100,unit:'cm'});
 if(penR>0.001)push({what:'sole-below-rest-plane-R',t:penRt,value:penR*100,unit:'cm'});

 /* [5] IK residuals + saturation internals */
 let armRes={v:0,t:0},legRes={v:0,t:0,side:''};
 let reachMax={r:0,t:0},wristClampFrames=0,wristBendMax={v:0,t:0};
 let bendFlip={v:0,t:0};
 const gs:Side=doc.gripSide==='L'?'L':'R';
 for(let i=0;i<frames.length;i++){
  const f=frames[i];
  const r=dist(f.pos[`wrist_${gs}`],f.handTarget[gs]);if(r>armRes.v)armRes={v:r,t:f.t};
  for(const s of ['L','R']as const){const rr=dist(f.pos[`foot_${s}`],f.footTarget[s]);if(rr>legRes.v)legRes={v:rr,t:f.t,side:s};}
  const rr=f.arm.d/f.arm.reach;if(rr>reachMax.r)reachMax={r:rr,t:f.t};
  /* Two counters on purpose, different deadbands: `clampedFrames` counts
   * demand exceeding the limit by >0.05° — a deadband that keeps sub-jitter
   * boundary grazes (a 0.01° exceedance delivers a bend indistinguishable
   * from the limit) out of the headline clamp percentage. `deficitFrames`
   * and `transitions` below use the strict >limit edge so the deficit
   * accounting and switch counting are complete — the two series answer
   * different questions and are not meant to agree. */
  if(f.arm.wristBend>wristLimit+0.05)wristClampFrames++;
  if(f.arm.wristBend>wristBendMax.v)wristBendMax={v:f.arm.wristBend,t:f.t};
  if(i>0){
   const b0=frames[i-1].arm.bendDir,b1=f.arm.bendDir;
   const dot=b0[0]*b1[0]+b0[1]*b1[1]+b0[2]*b1[2];
   const ang=Math.acos(Math.max(-1,Math.min(1,dot)))/DEG;
   if(ang>bendFlip.v)bendFlip={v:ang,t:f.t};
  }
 }
 if(armRes.v>0.003)push({what:`arm-reach-residual-${gs}`,t:armRes.t,value:armRes.v*100,unit:'cm'});
 if(bendFlip.v>30)push({what:'arm-pole-bend-flip',t:bendFlip.t,value:bendFlip.v,unit:'deg',extra:'elbow hinge dir change per frame'});

 /* [6] kinetic chain sequencing — world-frame segment speeds AND
  * relative-to-parent joint speeds inside the active window. */
 const active=activeWindow??[0,doc.duration];
 const chain:ProbeChainStat[]=chainBones(gs).map(b=>{
  const steps=stepAngles(frames.map(f=>f.quat[b]));
  /* relative series: q_rel = q_parent⁻¹ · q_bone per frame, then step angles */
  const p=CHAIN_PARENT[b];
  const rel=frames.map(f=>{
   if(!p)return f.quat[b];
   const qp=new Quaternion(...f.quat[p]).invert(),qb=new Quaternion(...f.quat[b]);
   return q4(qp.multiply(qb)) as Quat;
  });
  const rsteps=p?stepAngles(rel):steps;
  let g={peak:0,t:0},l={peak:0,t:0},rp={peak:0,t:0};
  for(let i=1;i<steps.length;i++){
   const w=steps[i]/dt;
   if(w>g.peak)g={peak:w,t:frames[i].t};
   if(frames[i].t>=active[0]&&frames[i].t<=active[1]&&w>l.peak)l={peak:w,t:frames[i].t};
   const rw=rsteps[i]/dt;
   if(frames[i].t>=active[0]&&frames[i].t<=active[1]&&rw>rp.peak)rp={peak:rw,t:frames[i].t};
  }
  return {bone:b,seg:CHAIN_LABEL[b],peak:g.peak,t:g.t,activePeak:l.peak,activeT:l.t,relPeak:rp.peak,relT:rp.t};
 });

 /* wrist bend clamp transitions + delivered-vs-authored hand-frame deficit */
 const clampTransitions:number[]=[];
 for(let i=1;i<frames.length;i++){
  const a=frames[i-1].arm.wristBend>wristLimit,b=frames[i].arm.wristBend>wristLimit;
  if(a!==b)clampTransitions.push(frames[i].t);
 }
 const deficitSeries=frames.map(f=>Math.max(0,f.arm.wristBend-wristLimit));
 const deficitMax=Math.max(0,...deficitSeries);
 const deficitFrames=frames.filter(f=>f.arm.wristBend>wristLimit).length;
 const deficitMed=median(deficitSeries.filter(v=>v>0));

 /* [7] wrist + tip smoothness */
 const vel=(sel:(f:ProbeFrame)=>Vec3)=>{
  const vs:Vector3[]=[];
  for(let i=1;i<frames.length;i++)vs.push(new Vector3(...sub(sel(frames[i]),sel(frames[i-1]))).multiplyScalar(1/dt));
  return vs;
 };
 const smooth=(vs:Vector3[]):ProbeSmooth=>{
  const vmax=vs.length?Math.max(...vs.map(v=>v.length())):0;
  const thresh=Math.max(.3,vmax*.15);
  const turns:ProbeTurn[]=[];
  const accs:ProbeAccel[]=[];
  for(let i=1;i<vs.length;i++){
   const dv=vs[i].clone().sub(vs[i-1]).length();
   accs.push({t:frames[i].t,a:dv/dt,dv});
   if(vs[i].length()>thresh&&vs[i-1].length()>thresh){
    const deg=vs[i].angleTo(vs[i-1])/DEG;
    if(deg>25)turns.push({t:frames[i].t,deg,v:Math.min(vs[i].length(),vs[i-1].length())});
   }
  }
  accs.sort((a,b)=>b.a-a.a);
  const kicks=accs.filter(a=>a.dv>0.1).length;
  return {vmax,threshold:thresh,turns:turns.sort((a,b)=>b.deg-a.deg),accelTop:accs.slice(0,6),kicks,
   vpeakT:frames[vs.findIndex(v=>v.length()===vmax)+1]?.t??0};
 };
 const wriS=smooth(vel(f=>f.pos[`wrist_${gs}`]));
 const hasTip=frames.length>0&&frames.every(f=>f.tip!==null);
 const tipS=hasTip?smooth(vel(f=>f.tip as Vec3)):null;
 const tipSpeedAt=(t:number)=>{
  const i=frames.reduce((b,f,j)=>Math.abs(f.t-t)<Math.abs(frames[b].t-t)?j:b,0);
  return i>0?new Vector3(...sub(frames[i].tip as Vec3,frames[i-1].tip as Vec3)).length()*fps:0;
 };
 const contactT=keyTimes.reduce((b,k)=>doc.keys.find(x=>x.time===k&&x.constraints.contact)?k:b,-1);
 // target-space vs solved-space: is the hand *target* smooth where wrist isn't?
 const tgtV=vel(f=>f.handTarget[gs]);
 const tgtAcc={t:0,a:0};
 for(let i=1;i<tgtV.length;i++){const a=tgtV[i].clone().sub(tgtV[i-1]).length()/dt;if(a>tgtAcc.a)tgtAcc.a=a,tgtAcc.t=frames[i].t;}

 /* [8] solver check worsts (every code seen with a value) */
 const solverChecks:Record<string,{v:number;t:number}>={};
 for(const f of frames)for(const [code,x]of Object.entries(f.check)){
  if(x.v===null||x.v===undefined)continue;
  const cur=solverChecks[code];
  if(!cur||x.v>cur.v)solverChecks[code]={v:x.v,t:f.t};
 }
 const wc=(code:string)=>solverChecks[code]??{v:-Infinity,t:0};
 const dorsiL=wc('ankle-dorsiflexion-L'),dorsiR=wc('ankle-dorsiflexion-R');
 const fdL=wc('foot-depth-L'),fdR=wc('foot-depth-R'),com=wc('com-support');
 if(dorsiL.v>DORSI_LIMIT_DEG)push({what:'dorsi-over-20deg-L',t:dorsiL.t,value:dorsiL.v,unit:'deg'});
 if(dorsiR.v>DORSI_LIMIT_DEG)push({what:'dorsi-over-20deg-R',t:dorsiR.t,value:dorsiR.v,unit:'deg'});
 if(fdL.v>0.001)push({what:'foot-depth-L',t:fdL.t,value:fdL.v*100,unit:'cm'});
 if(fdR.v>0.001)push({what:'foot-depth-R',t:fdR.t,value:fdR.v*100,unit:'cm'});
 if(com.v>0.02)push({what:'com-outside-support',t:com.t,value:com.v*100,unit:'cm'});

 /* slerp C0 signature: gripping-wrist step at key instants vs interior */
 const wSteps=stepAngles(frames.map(f=>f.quat[`wrist_${gs}`]));
 const atKey:number[]=[],interior:number[]=[];
 for(let i=1;i<frames.length;i++){(nearKey(frames[i].t)<dt*0.6?atKey:interior).push(wSteps[i]);}

 spikes.sort((a,b)=>b.value-a.value);
 return {
  name:name??doc.id,fps,dt,duration:doc.duration,keyCount:doc.keys.length,frameCount:frames.length,
  keyTimes,groundY,supportIntervals:intervals,footSlip,
  bones:boneStats,kinked,
  root:{maxStep:rootMaxStep,stepT:rootStepT,maxV:rootMaxV,maxA:rootMaxA,accelT:rootAT},
  pelvis:{shiftMin,shiftMax,maxJump:shiftJump,jumpT:shiftJumpT,saturatedFrames:sat.length},
  sole:{minY:{L:minYL,R:minYR},minYT:{L:penLt,R:penRt},penetration:{L:penL,R:penR}},
  gripSide:gs,
  ik:{armResidual:{...armRes,side:gs},legResidual:legRes,reachMax,poleBendFlip:bendFlip},
  wristClamp:{limitDeg:wristLimit,maxBend:wristBendMax.v,maxBendT:wristBendMax.t,
   clampedFrames:wristClampFrames,transitions:clampTransitions,
   deficitMax,deficitFrames,deficitMedian:deficitMed},
  activeWindow:[active[0],active[1]],chain,
  wrist:wriS,tip:tipS,handTargetAccel:tgtAcc,
  wristStep:{atKeyMedian:median(atKey),atKeyCount:atKey.length,interiorMedian:median(interior),interiorCount:interior.length},
  contact:{time:contactT>=0?contactT:null,tipSpeed:contactT>=0&&hasTip?tipSpeedAt(contactT):null},
  solverChecks,spikes,frames,
 };
}

/* ---- console report --------------------------------------------------- */
/** The human-readable report — the same text the calibration CLI prints. */
export function formatProbeReport(r:ProbeReport):string{
 const frames=r.frames;
 const nearKey=(t:number)=>r.keyTimes.reduce((b,k)=>Math.min(b,Math.abs(k-t)),Infinity);
 const wc=(code:string)=>r.solverChecks[code]??{v:-Infinity,t:0};
 const dorsiL=wc('ankle-dorsiflexion-L'),dorsiR=wc('ankle-dorsiflexion-R');
 const fdL=wc('foot-depth-L'),fdR=wc('foot-depth-R'),com=wc('com-support');
 const gs=r.gripSide;
 const kneeL=wc('knee-flexion-L'),kneeR=wc('knee-flexion-R'),elbG=wc(`elbow-flexion-${gs}`);
 const ctxAt=(t:number)=>{
  const f=frames.reduce((b,x)=>Math.abs(x.t-t)<Math.abs(b.t-t)?x:b);
  return `keyΔ${(nearKey(t)*1000).toFixed(0)}ms bend ${f.arm.wristBend.toFixed(0)}° reach ${(f.arm.d/f.arm.reach*100).toFixed(0)}%`;
 };
 const lines:string[]=[];
 const wriS=r.wrist,tipS=r.tip;
 lines.push(`\n=== ${r.name} @ ${r.fps}fps · ${r.frameCount} frames · ${r.keyCount} keys · ${r.duration}s ===`);
 lines.push(`支撑区间: ${r.supportIntervals.map(i=>`${i.side} ${i.from.toFixed(2)}–${i.to.toFixed(2)}s`).join(' · ')||'无'}   rest sole plane L ${(r.groundY.L*1000).toFixed(1)}mm R ${(r.groundY.R*1000).toFixed(1)}mm`);
 lines.push(`[1] foot slip\n${r.footSlip.map(iv=>`  foot_${iv.side} ${iv.from.toFixed(2)}–${iv.to.toFixed(2)}s n=${iv.samples}  |ankle−target| max ${(iv.maxResidual*1000).toFixed(2)}mm @${iv.residualT.toFixed(3)}s  | drift-from-first max ${(iv.maxDrift*1000).toFixed(2)}mm`).join('\n')||'  (no plant intervals)'}`);
 const angTop=r.bones.slice(0,8).map(s=>`  ${s.bone.padEnd(13)} peak ${s.peakW.toFixed(1).padStart(6)} rad/s @${s.peakT.toFixed(3)}s  αmax ${s.peakAlpha.toFixed(1)} rad/s²@${s.alphaT.toFixed(3)}s  step ${(s.maxStep*180/Math.PI).toFixed(2)}°@${s.stepT.toFixed(3)}s`);
 lines.push(`[2] 骨角速度 / 角加速度 top:\n${angTop.join('\n')}`);
 lines.push(`    kink>4x 邻帧: ${r.kinked.length?r.kinked.slice(0,8).map(s=>`${s.bone} ${(s.maxStep*180/Math.PI).toFixed(1)}° x${s.kink.toFixed(0)} @${s.kinkT.toFixed(3)}s(keyΔ${(nearKey(s.kinkT)*1000).toFixed(0)}ms)`).join('  '):'无'}`);
 lines.push(`[3] root: maxStep ${(r.root.maxStep*1000).toFixed(2)}mm @${r.root.stepT.toFixed(3)}s  maxV ${r.root.maxV.toFixed(3)}m/s  maxA ${r.root.maxA.toFixed(1)}m/s² @${r.root.accelT.toFixed(3)}s`);
 lines.push(`    pelvisShift ${(r.pelvis.shiftMin*100).toFixed(1)}–${(r.pelvis.shiftMax*100).toFixed(1)}cm  maxJump ${(r.pelvis.maxJump*1000).toFixed(2)}mm @${r.pelvis.jumpT.toFixed(3)}s  saturated ${r.pelvis.saturatedFrames}f`);
 lines.push(`[4] sole min y: L ${(r.sole.minY.L*1000).toFixed(1)}mm @${r.sole.minYT.L.toFixed(3)}s (below rest plane ${(r.sole.penetration.L*1000).toFixed(1)}mm)  R ${(r.sole.minY.R*1000).toFixed(1)}mm @${r.sole.minYT.R.toFixed(3)}s (${(r.sole.penetration.R*1000).toFixed(1)}mm)`);
 lines.push(`    foot-depth worst L ${(fdL.v*100).toFixed(2)}cm@${fdL.t.toFixed(3)}s R ${(fdR.v*100).toFixed(2)}cm@${fdR.t.toFixed(3)}s`);
 lines.push(`[5] IK: arm_${gs} |wrist−target| ${(r.ik.armResidual.v*100).toFixed(2)}cm @${r.ik.armResidual.t.toFixed(3)}s  reachMax ${(r.ik.reachMax.r*100).toFixed(1)}% @${r.ik.reachMax.t.toFixed(3)}s  flexion max? (见[8]肘)  pole-bend flip ${r.ik.poleBendFlip.v.toFixed(1)}°/f @${r.ik.poleBendFlip.t.toFixed(3)}s`);
 const wc2=r.wristClamp;
 lines.push(`    腕弯曲 clamp: bend max ${wc2.maxBend.toFixed(1)}° @${wc2.maxBendT.toFixed(3)}s  clamped ${wc2.clampedFrames}/${r.frameCount}f (${(100*wc2.clampedFrames/r.frameCount).toFixed(0)}%)  朝向误差 max ~${wc2.deficitMax.toFixed(0)}°  clamp 切换 ${wc2.transitions.length} 次: ${wc2.transitions.slice(0,14).map(t=>t.toFixed(3)).join(',')}${wc2.transitions.length>14?' …':''}`);
 lines.push(`    leg |foot−target| max ${(r.ik.legResidual.v*100).toFixed(2)}cm (${r.ik.legResidual.side}) @${r.ik.legResidual.t.toFixed(3)}s`);
 lines.push(`[6] 动力链峰值时序 (世界系全局 | 活动窗 ${r.activeWindow[0]}–${r.activeWindow[1]}s | 相对父级@活动窗):`);
 for(const c of r.chain)lines.push(`    ${c.seg.padEnd(14)} ${c.peak.toFixed(1).padStart(6)} rad/s @${c.t.toFixed(3)}s  |  ${c.activePeak.toFixed(1).padStart(6)} @${c.activeT.toFixed(3)}s  |  ${c.relPeak.toFixed(1).padStart(6)} @${c.relT.toFixed(3)}s`);
 lines.push(`[7] wrist_${gs}: vmax ${wriS.vmax.toFixed(2)}m/s @${wriS.vpeakT.toFixed(3)}s  折返>25°×${wriS.turns.length}${wriS.turns.length?' worst '+wriS.turns.slice(0,3).map(x=>`${x.deg.toFixed(0)}°@${x.t.toFixed(3)}s`).join(' '):''}`);
 lines.push(`    wrist accel top: ${wriS.accelTop.map(a=>`${a.a.toFixed(0)}@${a.t.toFixed(3)}`).join('  ')} m/s²`);
 lines.push(`    hand${gs} target accel max ${r.handTargetAccel.a.toFixed(0)}m/s² @${r.handTargetAccel.t.toFixed(3)}s   (target 自身跳→文档/插值;target 平滑+wrist 跳→求解器)`);
 lines.push(`    wrist_${gs} step: @key median ${(r.wristStep.atKeyMedian/DEG).toFixed(2)}° (n=${r.wristStep.atKeyCount})  interior median ${(r.wristStep.interiorMedian/DEG).toFixed(2)}° (n=${r.wristStep.interiorCount})`);
 if(tipS){
  lines.push(`    tip: vmax ${tipS.vmax.toFixed(2)}m/s @${tipS.vpeakT.toFixed(3)}s  折返>25°×${tipS.turns.length}${tipS.turns.length?' worst '+tipS.turns.slice(0,3).map(x=>`${x.deg.toFixed(0)}°@${x.t.toFixed(3)}s`).join(' '):''}`);
  lines.push(`    tip accel top (m/s² | Δv m/s 每帧): ${tipS.accelTop.map(a=>`${a.a.toFixed(0)}|${a.dv.toFixed(2)} @${a.t.toFixed(3)}[${ctxAt(a.t)}]`).join('  ')}`);
  lines.push(`    tip 速度 kick>0.1m/s 帧数: ${tipS.kicks}  wrist: ${wriS.kicks}`);
 }else{
  lines.push(`    tip: (无 tip 对象，跳过 racket-tip 度量)`);
  lines.push(`    wrist 速度 kick>0.1m/s 帧数: ${wriS.kicks}`);
 }
 if(r.contact.time!==null)lines.push(`    contact key @${r.contact.time}s: tip speed ${r.contact.tipSpeed!.toFixed(2)}m/s`);
 lines.push(`    朝向误差(clamp deficit)分布: clamped帧中位 ~${wc2.deficitMedian.toFixed(0)}°`);
 lines.push(`[8] solver checks: dorsi L ${dorsiL.v.toFixed(1)}°@${dorsiL.t.toFixed(2)}s R ${dorsiR.v.toFixed(1)}°@${dorsiR.t.toFixed(2)}s · com ${(com.v*100).toFixed(1)}cm@${com.t.toFixed(2)}s · knee L ${kneeL.v.toFixed(0)}° R ${kneeR.v.toFixed(0)}° · elbow${gs} ${elbG.v.toFixed(0)}°@${elbG.t.toFixed(2)}s`);
 lines.push(`\n严重度排序:`);
 for(const s of r.spikes.slice(0,12))lines.push(`  ${s.value.toFixed(2).padStart(8)} ${s.unit.padEnd(5)} ${s.what.padEnd(26)} @${s.t.toFixed(3)}s${s.extra?`  ${s.extra}`:''}`);
 return lines.join('\n');
}

/* ---- one-shot entry ---------------------------------------------------- */
export interface ProbeOptions{
 /** Sample rate; default 240 — the resolution the defect metrics were
  * calibrated at. Lower fps reproduces the package-time grid. */
 fps?:number;
 /** Attached tip object (the racket from attachRacket); without one the tip
  * metrics are skipped rather than silently re-purposed. */
 tip?:ProbeTip;
 /** Report label; defaults to doc.id. */
 name?:string;
 /** Kinetic-chain active window; defaults to the whole duration. */
 activeWindow?:[number,number];
}

/** Sample `doc` on `rig` and return the structured quality report. */
export function probeDocument(rig:HumanRig,doc:WorkshopDoc,opts:ProbeOptions={}):ProbeReport{
 const fps=opts.fps??240;
 const frames=probeFrames(rig,doc,fps,opts.tip);
 return analyzeProbeFrames({doc,fps,frames,rest:rig.rest,name:opts.name,activeWindow:opts.activeWindow});
}
