import {beforeAll,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import {Quaternion,Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from './rig';
import {attachRacket} from './props/racket';
import {motionFileById} from './motion-files';
import {defaultDocument,sampleMotion,validateDocShape,type WorkshopDoc} from './document';
import {probeFrames,type Quat,type Vec3} from './quality-probe';
import {
 applyGenMove,buildGenContext,generateMotion,integratedAngularJerk,
 integratedPositionJerk,measureDoc,retimeStep,subsampleDoc,
 MAX_GENERATION_SWEEPS,type ChannelGroup,type MotionGenRequest,type MotionGenResult,
} from './generate';

let rig:HumanRig;
const loadHumanRig=async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(
  bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 return new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
};
beforeAll(async()=>{
 rig=await loadHumanRig();
},30000);

const clone=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
const forehandStudy=():WorkshopDoc=>{
 const payload=JSON.parse(fs.readFileSync('spec/examples/forehand-study.request.json','utf8')) as {action:{parameters:{document:WorkshopDoc}}};
 return clone(payload.action.parameters.document);
};
const squatSubsample=()=>subsampleDoc(motionFileById('squat')!.document!,
 [0,1.6,2.8,4.8,5.6],rig.rest);
const finitePaths=(value:unknown,path='root',bad:string[]=[]):string[]=>{
 if(typeof value==='number'){if(!Number.isFinite(value))bad.push(path);return bad;}
 if(Array.isArray(value)){value.forEach((v,i)=>finitePaths(v,`${path}[${i}]`,bad));return bad;}
 if(value&&typeof value==='object'){
  for(const[k,v]of Object.entries(value))finitePaths(v,`${path}.${k}`,bad);
 }
 return bad;
};
const expectFinite=(value:unknown)=>expect(finitePaths(value)).toEqual([]);
const expectInvalidWithoutEvaluation=(req:MotionGenRequest,code='invalid-input')=>{
 const result=generateMotion(rig,req);
 expect(result.diagnostics.stopReason).toBe('invalid-input');
 expect(result.diagnostics.evals).toBe(0);
 expect(result.candidates).toEqual([]);
 expect(result.rejected[0]?.code).toBe(code);
 return result;
};

const detuneForehand=(doc:WorkshopDoc)=>{
 const lockedKeyIds=['k-ready','k-contact'];
 const ctx=buildGenContext(rig,doc,{lockedKeyIds});
 const damaged=applyGenMove(ctx,doc,{kind:'retime',keyId:'k-back',
  delta:retimeStep(ctx,doc,'k-back')});
 if(!damaged)throw new Error('expected the real retime move to detune k-back');
 return{doc:damaged,lockedKeyIds};
};
const detuneSquat=(doc:WorkshopDoc)=>{
 const group:ChannelGroup='trunk',ctx=buildGenContext(rig,doc);
 const damaged=applyGenMove(ctx,doc,{kind:'phase',keyId:'sub2',group,offset:ctx.maxPhaseShift});
 if(!damaged)throw new Error('expected the real phase move to detune sub2:trunk');
 return damaged;
};

describe('subsampled interval curves',()=>{
 it('retains each sampled key’s governing outgoing interpolation',()=>{
  const doc=defaultDocument(rig.rest);doc.keys[0].interpolation='linear';
  const keys=doc.keys.slice().sort((a,b)=>a.time-b.time);
  const sub=subsampleDoc(doc,[keys[0].time,(keys[0].time+keys[1].time)/2,(keys[1].time+keys[2].time)/2,keys.at(-1)!.time],rig.rest);
  expect(sub.keys[0].interpolation).toBe('linear');
  expect(sub.keys[1].interpolation).toBe('linear');
  expect(sub.keys[2].interpolation).toBeUndefined();
 });
 it('carries the doc-level bevel and samples hand spread with the pose',()=>{
  const doc=defaultDocument(rig.rest);doc.gripBevel=5;
  doc.keys[0].pose.handSpread={L:.1,R:.2};doc.keys[1].pose.handSpread={L:.9,R:.8};
  const sub=subsampleDoc(doc,[0,.22],rig.rest);
  expect(sub.gripBevel).toBe(5);
  expect(sub.keys[0].pose.handSpread).toEqual({L:.1,R:.2});
  expect(sub.keys[1].pose.handSpread).toEqual({L:.9,R:.8});
 });
 it('phase-shifts only the selected hand, including its appended spread channel',()=>{
  const doc=defaultDocument(rig.rest);
  // k-back (time .22) is mid-swing, neither contact nor first/last: legal phase key.
  doc.keys[1].pose.handSpread={L:.9,R:.85};
  const ctx=buildGenContext(rig,doc,{bounds:{maxPhaseShiftS:.1}});
  const offset=.1,t=.22+offset;   // the move snapshots the source at keyTime+offset
  const src=sampleMotion(ctx.compiled,t);
  const right=applyGenMove(ctx,doc,{kind:'phase',keyId:'k-back',group:'handR',offset});
  if(!right)throw new Error('expected a legal handR phase move');
  expect(right.keys.find(k=>k.id==='k-back')!.pose.handSpread?.R).toBeCloseTo(src.handSpread!.R!,7);
  expect(right.keys.find(k=>k.id==='k-back')!.pose.handSpread?.L).toBe(.9);
  const left=applyGenMove(ctx,doc,{kind:'phase',keyId:'k-back',group:'handL',offset});
  if(!left)throw new Error('expected a legal handL phase move');
  expect(left.keys.find(k=>k.id==='k-back')!.pose.handSpread?.L).toBeCloseTo(src.handSpread!.L!,7);
  expect(left.keys.find(k=>k.id==='k-back')!.pose.handSpread?.R).toBe(.85);
 });
});

describe('integrated jerk metrics use time-aware finite differences',()=>{
 const duration=1.037;
 const grid=(fps:number)=>{
  const times=[0];
  for(let t=1/fps;t<duration;t+=1/fps)times.push(t);
  if(times.at(-1)!==duration)times.push(duration);
  return times;
 };
 const qAt=(angle:number):Quat=>{
  const q=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),angle);
  return[q.x,q.y,q.z,q.w];
 };

 it.each([15,37,120])('integrates constant positional and angular jerk at %i fps, including the partial tail',fps=>{
  const times=grid(fps),jerk=2.4,accel=1.7,velocity=.8;
  const positions=(fn:(t:number)=>number):Vec3[]=>times.map(t=>[fn(t),0,0]);
  const zeroPosition=positions(t=>velocity*t);
  const constantAcceleration=positions(t=>velocity*t+.5*accel*t*t);
  const constantJerk=positions(t=>velocity*t+.5*accel*t*t+jerk*t*t*t/6);
  expect(times.at(-1)).toBe(duration);
  expect(times[times.length-1]-times[times.length-2]).toBeLessThan(1/fps);
  expect(integratedPositionJerk(times,zeroPosition)).toBeCloseTo(0,8);
  expect(integratedPositionJerk(times,constantAcceleration)).toBeCloseTo(0,8);
  expect(integratedPositionJerk(times,constantJerk)).toBeCloseTo(jerk*duration,6);

  const angular=(fn:(t:number)=>number)=>times.map(t=>qAt(fn(t)));
  const zeroAngular=angular(t=>velocity*t);
  const constantAngularAcceleration=angular(t=>velocity*t+.5*accel*t*t);
  const constantAngularJerk=angular(t=>velocity*t+.5*accel*t*t+jerk*t*t*t/6);
  expect(integratedAngularJerk(times,zeroAngular)).toBeCloseTo(0,8);
  expect(integratedAngularJerk(times,constantAngularAcceleration)).toBeCloseTo(0,8);
  expect(integratedAngularJerk(times,constantAngularJerk)).toBeCloseTo(jerk*duration,6);
 });
});

describe('real action inputs and the shared solve/probe path',()=>{
 it('measures the four study and squat action cases through the real rig',()=>{
  const source=forehandStudy(),squat=squatSubsample();
  const sourceBefore=clone(source),squatBefore=clone(squat);
  const forehandDamage=detuneForehand(source).doc;
  const squatDamage=detuneSquat(squat);
  const cases:[string,WorkshopDoc,boolean][]=[
   ['forehand study',source,true],['squat subsample',squat,false],
   ['detuned forehand study',forehandDamage,true],['detuned squat subsample',squatDamage,false],
  ];
  const racket=attachRacket(rig,'R');
  for(const[name,doc,hasTip]of cases){
   expect(validateDocShape(doc),name).toEqual([]);
   const metrics=measureDoc(rig,doc,19,hasTip?racket:undefined);
   expectFinite(metrics);
   expect(metrics['cost.endEffectorJerk']).toBeGreaterThanOrEqual(0);
   expect(metrics['cost.angularJerk']).toBeGreaterThanOrEqual(0);
   expect('tip.jerkInt'in metrics).toBe(hasTip);
   expect('tip.pathLen'in metrics).toBe(hasTip);
   expect('contact.tipSpeed'in metrics).toBe(hasTip);
  }
  expect(source).toEqual(sourceBefore);
  expect(squat).toEqual(squatBefore);

  // No-support frames carry a null / failing CoM-support check: not applicable
  // is not a solver violation. Count from the actual solve frames.
  const unsupported=clone(squat);
  for(const key of unsupported.keys){key.constraints.plantL=false;key.constraints.plantR=false;}
  expect(validateDocShape(unsupported)).toEqual([]);
  const frames=probeFrames(rig,unsupported,19);
  expect(frames.some(frame=>frame.check['com-support']?.v===null
   &&frame.check['com-support']?.ok===false)).toBe(true);
  const expected=frames.filter(frame=>Object.values(frame.check).some(
   check=>check.v!==null&&check.limit!==null&&Number.isFinite(check.v)
    &&Number.isFinite(check.limit)&&check.ok===false)).length;
  expect(measureDoc(rig,unsupported,19)['checks.violationFrames']).toBe(expected);
 });

 it('emits a valid improved candidate without editing source, contact or pinned keys',()=>{
  const source=forehandStudy(),{doc,lockedKeyIds}=detuneForehand(source);
  const before=clone(doc),racket=attachRacket(rig,'R');
  const req:MotionGenRequest={doc,lockedKeyIds,tip:racket};
  const result=generateMotion(rig,{...req,evalFps:12,reportFps:18,
   budget:{maxEvals:8,maxSweeps:1}});
  expect(doc).toEqual(before);
  expect(result.candidates).toHaveLength(1);
  expect(result.rejected).toEqual([]);
  const candidate=result.candidates[0];
  expectFinite(candidate);
  expect(candidate.objective).toBeLessThan(1);
  expect(['improved','neutral']).toContain(candidate.verdict);
  expect(validateDocShape(candidate.doc)).toEqual([]);
  expect(candidate.probe.frameCount).toBe(candidate.probe.frames.length);
  expect(candidate.probe.frames.at(-1)?.t).toBe(candidate.doc.duration);
  for(const row of Object.values(candidate.metrics)){
   expect(Number.isFinite(row.before)).toBe(true);
   expect(Number.isFinite(row.after)).toBe(true);
   expect(typeof row.unit).toBe('string');
   expect(['down','up','na']).toContain(row.better);
  }
  for(const row of candidate.constraints)expect(row.ok,row.code).toBe(true);
  for(const code of ['shape','key-set','doc-fields','constraints-pattern','pinned-keys',
   'tip-side','contact-point','plant-points','solve-clean','report-fps-cost']){
   expect(candidate.constraints.find(row=>row.code===code)?.ok,code).toBe(true);
  }

  const byId=new Map(candidate.doc.keys.map(key=>[key.id,key]));
  for(const key of doc.keys){
   const actual=byId.get(key.id)!;
   expect(actual.constraints).toEqual(key.constraints);
   if(lockedKeyIds.includes(key.id)||key.constraints.contact){
    expect(actual.time).toBe(key.time);
    expect(actual.pose).toEqual(key.pose);
   }
  }
  expect(Math.max(0,...candidate.probe.footSlip.map(slip=>slip.maxResidual))).toBeLessThan(1e-2);
 });

 it('omits racket-tip rows when the candidate was measured without a racket',()=>{
  // This assertion only needs a valid no-racket candidate. Keep its real solve
  // path, but sample coarsely because this regression checks metric omission,
  // not high-rate search quality.
  const result=generateMotion(rig,{doc:squatSubsample(),evalFps:8,reportFps:12,
   budget:{maxEvals:120,maxSweeps:4}});
  expect(result.candidates).toHaveLength(1);
  const metrics=result.candidates[0].metrics;
  for(const key of ['tip.pathLen','tip.vmax','tip.jerkInt','contact.tipSpeed','contact.tipDevMm'])
   expect(key in metrics,key).toBe(false);
  // The 120 Hz pelvis schedule is extra real solves on every probe. Parallel
  // vitest pushes this coarse search just past the default 5s budget.
 },20000);

 it('rejects a valid-shaped request with no adjustable keys',()=>{
  const doc=squatSubsample(),before=clone(doc);
  const result=generateMotion(rig,{doc,lockedKeyIds:doc.keys.map(key=>key.id),
   evalFps:12,reportFps:18,budget:{maxEvals:4,maxSweeps:1}});
  expect(doc).toEqual(before);
  expect(result.diagnostics.stopReason).toBe('no-adjustable-keys');
  expect(result.candidates).toEqual([]);
  expect(result.rejected.some(row=>row.code==='no-adjustable-keys')).toBe(true);
  expectFinite(result.baseline);
 });

 it('returns a valid no-improvement rejection when intent is the only priced term',()=>{
  const doc=squatSubsample();
  const result=generateMotion(rig,{doc,evalFps:12,reportFps:18,
   adjust:{time:false,phase:true,groups:['trunk']},
   weights:{endEffectorJerk:0,angularJerk:0,checkViolations:0,footContact:0,
    penetration:0,ikResidual:0,intentShift:1},
   budget:{maxEvals:48,maxSweeps:1}});
  expect(result.diagnostics.stopReason).not.toBe('invalid-input');
  expect(result.candidates).toEqual([]);
  expect(result.rejected.some(row=>row.code==='regressed-at-report-fps')).toBe(true);
 });
});

describe('request validation and hard work caps',()=>{
 const doc=()=>defaultDocument(rig.rest);
 const inert=(overrides:Record<string,unknown>={}):MotionGenRequest=>({
  doc:doc(),adjust:{time:false,phase:false},evalFps:12,reportFps:18,
  ...overrides,
 } as MotionGenRequest);

 it('rejects invalid and excessive sample rates before probing',()=>{
  for(const field of ['evalFps','reportFps'])for(const bad of [0,-1,NaN,Infinity,241]){
   expectInvalidWithoutEvaluation(inert({[field]:bad}));
  }
 });

 it('measureDoc rejects invalid fps before entering the real solve path',()=>{
  const doc=defaultDocument(rig.rest),reset=vi.spyOn(rig,'reset');
  try{
   for(const fps of [NaN,0,.5,241])expect(()=>measureDoc(rig,doc,fps)).toThrow(RangeError);
   expect(reset).not.toHaveBeenCalled();
  }finally{reset.mockRestore();}
 });

 it('rejects invalid bounds and objective weights before probing',()=>{
  for(const field of ['maxTimeShiftS','maxPhaseShiftS'])for(const bad of [-1,0,NaN,Infinity]){
   expectInvalidWithoutEvaluation(inert({bounds:{[field]:bad}}));
  }
  const weightKeys=['endEffectorJerk','angularJerk','checkViolations','footContact',
   'penetration','ikResidual','intentShift'];
  for(const key of weightKeys)for(const bad of [-1,NaN,Infinity]){
   expectInvalidWithoutEvaluation(inert({weights:{[key]:bad}}));
  }
  expectInvalidWithoutEvaluation(inert({weights:{endEffectorJerk:0,angularJerk:0,
   checkViolations:0,footContact:0,penetration:0,ikResidual:0,intentShift:0}}));
 });

 it('rejects invalid, fractional, and excessive work budgets before probing',()=>{
  for(const bad of [-1,0,NaN,Infinity,1.5,3])
   expectInvalidWithoutEvaluation(inert({budget:{maxEvals:bad,maxSweeps:1}}));
  for(const bad of [-1,0,NaN,Infinity,1.5])
   expectInvalidWithoutEvaluation(inert({budget:{maxEvals:4,maxSweeps:bad}}));
  const tooManySweeps=generateMotion(rig,{doc:doc(),adjust:{time:false,phase:false},
   budget:{maxEvals:4,maxSweeps:MAX_GENERATION_SWEEPS+1}});
  expect(tooManySweeps.diagnostics.evals).toBe(0);
  expect(tooManySweeps.diagnostics.stopReason).toBe('invalid-input');
  expect(tooManySweeps.rejected[0]?.code).toBe('invalid-input');
  const tooMuchWork=generateMotion(rig,{doc:squatSubsample(),adjust:{time:false,phase:false},
   evalFps:240,reportFps:240,budget:{maxEvals:2_000,maxSweeps:1}});
  expect(tooMuchWork.diagnostics.evals).toBe(0);
  expect(tooMuchWork.diagnostics.stopReason).toBe('invalid-input');
  expect(tooMuchWork.rejected[0]?.code).toBe('work-budget');
 });

 it('accepts only an attached racket tip owned by this rig on the grip side',async()=>{
  const doc=forehandStudy();
  const missing=expectInvalidWithoutEvaluation({doc},'tip-missing');
  expect(missing.rejected[0].reason).toMatch(/tip/i);

  const unattached=attachRacket(rig,'R');
  unattached.removeFromParent();
  expect(unattached.parent).toBeNull();
  const unattachedResult=expectInvalidWithoutEvaluation({doc,tip:unattached},'tip-missing');
  expect(unattachedResult.rejected[0].reason).toMatch(/attach|wrist_R/i);

  const wrongSide=attachRacket(rig,'L');
  expect(wrongSide.parent?.name).toBe('wrist_L');
  const wrong=expectInvalidWithoutEvaluation({doc,tip:wrongSide},'tip-missing');
  expect(wrong.rejected[0].reason).toMatch(/wrist_R/);

  const otherRig=await loadHumanRig(),foreignTip=attachRacket(otherRig,'R');
  expect(foreignTip.parent?.name).toBe('wrist_R');
  const foreign=expectInvalidWithoutEvaluation({doc,tip:foreignTip},'tip-missing');
  expect(foreign.rejected[0].reason).toMatch(/rig|attach|wrist_R/i);

  const attachedHere=attachRacket(rig,'R');
  expect(attachedHere.parent).toBe(rig.bone('wrist_R'));
  const accepted=generateMotion(rig,{doc,tip:attachedHere,
   adjust:{time:false,phase:false},evalFps:12,reportFps:18,
   budget:{maxEvals:4,maxSweeps:1}});
  expect(accepted.diagnostics.evals).toBe(1);
  expect(accepted.diagnostics.stopReason).toBe('no-adjustable-keys');
  expect(accepted.rejected.some(row=>row.code==='tip-missing')).toBe(false);
  expect(accepted.baseline['contact.time']).toBeDefined();
 });

 it('keeps diagnostics.evals within maxEvals, including report measurements',()=>{
  const source=squatSubsample(),before=clone(source);
  for(const maxEvals of [4,5,7]){
   const req:MotionGenRequest={doc:source,evalFps:12,reportFps:18,
    budget:{maxEvals,maxSweeps:1}};
   const result=generateMotion(rig,req);
   expect(result.diagnostics.evals).toBeLessThanOrEqual(maxEvals);
  }
  expect(source).toEqual(before);
 });

 it('repeats the same bounded search deterministically and preserves its source',()=>{
  const doc=detuneSquat(squatSubsample()),before=clone(doc);
  const request:MotionGenRequest={doc,evalFps:12,reportFps:18,
   budget:{maxEvals:4,maxSweeps:1}};
  const first:MotionGenResult=generateMotion(rig,request);
  const second:MotionGenResult=generateMotion(rig,request);
  expect(doc).toEqual(before);
  expect(second).toEqual(first);
  expect(first.diagnostics.evals).toBeLessThanOrEqual(4);
 });
});
