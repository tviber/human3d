import {describe,it,expect,beforeAll,vi} from 'vitest';
import fs from 'node:fs';
import {Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from './rig';
import {attachRacket} from './props/racket';
import {motionFileById} from './motion-files';
import {sampleTimes,solveWorkshop} from './pose-package';
import {buildPelvisSchedule,pelvisSampleCount} from './pelvis-schedule';
import {probeFrames} from './quality-probe';
import {WORKSHOP_REVISION,workshopMeta} from './protocol';
import {compileMotion,defaultDocument,flattenPose,frameAt,frameAtCompiled,sampleMotion,samplePose,
 serializeDoc,sortedKeys,type WorkshopDoc} from './document';
import {measurePelvisCorrection,solvePose} from './solver';
import {VALIDATION_LIMITS} from './validate';
import {mulberry32,randomDoc} from './random-document';

/* PR-B (issue #10): the compiled sampling snapshot. compileMotion clones and
 * deep-freezes the document, paying buildModel's full preprocessing once;
 * frameAtCompiled/sampleMotion sample that snapshot and must be bit-identical
 * to the kept compat path (frameAt = buildModel∘frameFromModel per call,
 * samplePose = always-Hermite). Both paths run the SAME arithmetic over
 * identical inputs, so toEqual — bitwise equality — is the honest bar, not a
 * tolerance.
 *
 * The call-count pin works through vi.mock('./document'): pose-package,
 * quality-probe and random-document all import './document' relatively, so
 * their calls route through the counting wrappers too. Solver modules import
 * only types/toV — they can never inflate the frameAt count. The pelvis
 * schedule samples `frameAtCompiled` on its own 120 Hz grid; that cost is
 * part of the compiled count below, and `frameAt` stays at zero. */
const calls=vi.hoisted(()=>({compile:0,frameAt:0,compiled:0}));
vi.mock('./document',async importOriginal=>{
 const m=await importOriginal<typeof import('./document')>();
 return {...m,
  compileMotion:(...a:Parameters<typeof m.compileMotion>)=>{calls.compile++;return m.compileMotion(...a);},
  frameAt:(...a:Parameters<typeof m.frameAt>)=>{calls.frameAt++;return m.frameAt(...a);},
  frameAtCompiled:(...a:Parameters<typeof m.frameAtCompiled>)=>{calls.compiled++;return m.frameAtCompiled(...a);}};
});
const resetCalls=()=>{calls.compile=0;calls.frameAt=0;calls.compiled=0;};

let rig:HumanRig,racket:ReturnType<typeof attachRacket>;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
 racket=attachRacket(rig);
},30000);

const origin=()=>rig.rest.get('root')!;
const meta=(doc:WorkshopDoc,fps:number)=>workshopMeta({motionId:'mot_compiled-test',
 manifestSHA256:'test-manifest',bones:rig.bones.size,
 actionId:'workshop-doc',revision:WORKSHOP_REVISION,definitionSHA256:'test-definition',
 documentName:doc.name,prop:doc.keys.some(k=>k.constraints.grip),loop:doc.loop,
 source:'compiled.test',license:'test',requestFingerprint:'test',
 fps,duration:doc.duration,keys:doc.keys.length});
/** The equivalence grid: 160 uniform instants, every authored key instant,
 * plus clamp/seam edges outside and at the ends of [0, duration]. */
const timesFor=(doc:WorkshopDoc)=>{
 const ts:number[]=[];
 for(let i=0;i<160;i++)ts.push(i/159*doc.duration);
 for(const k of sortedKeys(doc))ts.push(k.time);
 ts.push(-.05,doc.duration-1e-9,doc.duration,doc.duration+.5);
 return ts;
};

describe('compile once, sample many — batch consumers go through the snapshot',()=>{
 it('solveWorkshop compiles once and samples grid + authored key instants',()=>{
  const doc=defaultDocument(rig.rest),fps=40;
  resetCalls();
  solveWorkshop(rig,doc,fps,meta(doc,fps));
  expect(calls.compile).toBe(1);
  /* capture()'s extraTimes pass re-samples every key instant AFTER the
   * uniform grid — a key coinciding with a grid point is visited twice
   * (pose-package.ts), so the count is grid+keys, never deduplicated. */
  expect(calls.compiled).toBe(sampleTimes(doc.duration,fps).length+sortedKeys(doc).length+pelvisSampleCount(doc.duration));
  expect(calls.frameAt).toBe(0); // the per-call buildModel path stays cold
 });
 it('probeFrames compiles once and samples the uniform grid only',()=>{
  const doc=defaultDocument(rig.rest),fps=40;
  resetCalls();
  probeFrames(rig,doc,fps,racket);
  expect(calls.compile).toBe(1);
  expect(calls.compiled).toBe(sampleTimes(doc.duration,fps).length+pelvisSampleCount(doc.duration)); // no extraTimes pass; the schedule grid is separate
  expect(calls.frameAt).toBe(0);
 });
 it('measures the same pelvis shift solvePose applies when no override is passed',()=>{
  const doc=defaultDocument(rig.rest);
  const f=frameAt(doc,doc.duration/2,origin());
  const state={support:f.support,gripAmount:f.gripAmount,clavicleLift:f.clavicleLift,gripSide:f.gripSide};
  expect(measurePelvisCorrection(rig,f.pose,f.constraints,state).shift).toBe(solvePose(rig,f.pose,f.constraints,state).pelvisShift);
 });
 it('reports the applied non-negative pelvis override',()=>{
  const doc=defaultDocument(rig.rest),f=frameAt(doc,doc.duration/2,origin());
  const state={support:f.support,gripAmount:f.gripAmount,clavicleLift:f.clavicleLift,gripSide:f.gripSide};
  const negative=solvePose(rig,f.pose,f.constraints,{...state,pelvisShift:-.01});
  const negativeRoot=rig.point('root').clone();
  const zero=solvePose(rig,f.pose,f.constraints,{...state,pelvisShift:0});
  expect(negative.pelvisShift).toBe(0);
  expect(negativeRoot.distanceTo(rig.point('root'))).toBe(0);
  expect(zero.pelvisShift).toBe(0);
 });
});

describe('compiled path is bit-identical to the compat path',()=>{
 const sweep=(doc:WorkshopDoc)=>{
  const c=compileMotion(doc,origin());
  for(const t of timesFor(doc)){
   expect(frameAtCompiled(c,t)).toEqual(frameAt(doc,t,origin()));
   expect(flattenPose(sampleMotion(c,t))).toEqual(flattenPose(samplePose(doc,t,origin())));
  }
 };
 for(const seed of [20260601,7,90210])
  it(`agrees on 16 seeded random docs (seed ${seed} — loop/stepped mixes included)`,()=>{
   const rng=mulberry32(seed);
   for(let i=0;i<16;i++)sweep(randomDoc(rng,rig.rest));
  });
 it('agrees on the seeded default and bundled forehand documents',()=>{
  sweep(defaultDocument(rig.rest));
  sweep(motionFileById('forehand')!.document!);
 });
 it('keeps randomDoc byte-identical across the compiled-path move',()=>{
  // hipTrajectory inside the generator moved to the snapshot too — the same
  // seed must still emit the same document, byte for byte.
  expect(serializeDoc(randomDoc(mulberry32(424242),rig.rest)))
   .toBe(serializeDoc(randomDoc(mulberry32(424242),rig.rest)));
 });
});

describe('snapshot isolation — later doc edits cannot move a compiled trajectory',()=>{
 it('keeps the pre-edit frame after heavy in-place mutation',()=>{
  const doc=defaultDocument(rig.rest),o=origin();
  const c=compileMotion(doc,o);
  const t0=.4,f0=frameAtCompiled(c,t0); // mid-grid, inside the .22–.5 interval
  doc.keys[0].pose.footL.target.x+=.1;   // planted run-start contact
  doc.keys[0].constraints.plantL=!doc.keys[0].constraints.plantL;
  doc.keys[1].time+=.01;
  doc.duration*=.5;
  doc.gripSide='L';
  doc.inbetweens=false;
  doc.handFrames.L='world';
  expect(frameAtCompiled(c,t0)).toEqual(f0);
  /* Compat sampling sees every edit — the difference is guaranteed on
   * several axes at once (stepped mode pose, duration halved so t0 clamps to
   * the new end, 'L' grip side stamped on the frame). */
  expect(frameAt(doc,t0,o)).not.toEqual(f0);
 });
 it('interleaved consumers over one snapshot match fresh-compile-per-t',()=>{
  const doc=defaultDocument(rig.rest),o=origin();
  const c=compileMotion(doc,o),ts=timesFor(doc);
  /* Forward and reversed passes over one snapshot: a hidden per-call memo
   * that only fed monotone sequences would surface here. */
  for(const seq of [ts,[...ts].reverse()])
   for(const t of seq)
    expect(frameAtCompiled(c,t)).toEqual(frameAtCompiled(compileMotion(doc,o),t));
 });
});

describe('snapshot immutability',()=>{
 it('freezes the snapshot and its cloned keys — writes are dead',()=>{
  const doc=defaultDocument(rig.rest);
  const c=compileMotion(doc,origin());
  expect(Object.isFrozen(c)).toBe(true);
  /* Strict mode throws TypeError on a frozen write, sloppy transpiles make
   * it a silent no-op — either way the value must not move. */
  try{(c as {duration:number}).duration=0;}catch{/* TypeError = the freeze doing its job */}
  expect(c.duration).toBe(doc.duration);
  /* The cloned keys are deep-frozen. c.model is opaque — reached into only
   * to observe the freeze, never to sample. */
  const k=c.model.keys[0];
  for(const v of [k,k.pose,k.constraints,k.pose.footL.target])expect(Object.isFrozen(v)).toBe(true);
  try{k.time=99;}catch{/* same */}
  expect(k.time).toBe(doc.keys[0].time);
 });
 it('clones the origin — mutating the caller vector cannot move the snapshot',()=>{
  const doc=defaultDocument(rig.rest),o=new Vector3(1,2,3);
  const c=compileMotion(doc,o),f0=frameAtCompiled(c,.3);
  o.set(9,9,9);
  expect(c.origin).not.toBe(o); // an owned clone, never the caller's alias
  expect([c.origin.x,c.origin.y,c.origin.z]).toEqual([1,2,3]);
  expect(frameAtCompiled(c,.3)).toEqual(f0);
 });
 it('defaults the origin to ZERO',()=>{
  const c=compileMotion(defaultDocument(rig.rest));
  expect([c.origin.x,c.origin.y,c.origin.z]).toEqual([0,0,0]);
 });
});

describe('package identity',()=>{
 it('solveWorkshop over the compiled path stays deterministic',()=>{
  const doc=defaultDocument(rig.rest),fps=40;
  const a=JSON.stringify(solveWorkshop(rig,doc,fps,meta(doc,fps)));
  const b=JSON.stringify(solveWorkshop(rig,doc,fps,meta(doc,fps)));
  expect(a).toBe(b);
 });
 it('keeps a compiled loop root track position and velocity continuous through the real schedule path',()=>{
  const doc=randomDoc(mulberry32(7),rig.rest),fps=120;
  expect(doc.loop).toBe(true);
  // Clearance-driven regeneration can select valid documents with extreme
  // authored root offsets at the loop seam. Keep the authored root fixed so
  // this fixture measures solver-added root motion, not raw key overshoot.
  const rootPose={...doc.keys[0].pose.root};
  for(const key of doc.keys)key.pose.root={...rootPose};
  const compiled=compileMotion(doc,origin());
  const schedule=buildPelvisSchedule(rig,compiled);
  // Seed 7 produces a loop whose raw correction exceeds the admissible track
  // limits. This assertion pins the integration test to followLoopShift.
  expect(schedule.passthrough).toBe(false);
  expect(schedule.at(0)).toBeCloseTo(schedule.at(doc.duration),12);
  const scheduledShifts=Array.from({length:13},(_,i)=>schedule.at(doc.duration*i/12));
  expect(scheduledShifts.every(Number.isFinite)).toBe(true);
  expect(Math.max(...scheduledShifts)-Math.min(...scheduledShifts)).toBeLessThanOrEqual(.15);
  const pkg=solveWorkshop(rig,doc,fps,meta(doc,fps));
  const {timestamps}=pkg.timeline,root=pkg.tracks.translation.values;
  const n=timestamps.length,dim=3,dt0=timestamps[1]-timestamps[0],dt1=timestamps[n-1]-timestamps[n-2];
  const first=[0,1,2].map(axis=>root[dim+axis]-root[axis]);
  const last=[0,1,2].map(axis=>root[(n-1)*dim+axis]-root[(n-2)*dim+axis]);
  expect(timestamps[0]).toBe(0);
  expect(timestamps[n-1]).toBe(doc.duration);
  for(let axis=0;axis<dim;axis++){
   expect(Math.abs(root[(n-1)*dim+axis]-root[axis])).toBeLessThan(1e-6);
   const seamAcceleration=Math.abs(first[axis]/dt0-last[axis]/dt1)/((dt0+dt1)/2);
   expect(seamAcceleration,`root axis ${axis} seam acceleration`).toBeLessThanOrEqual(VALIDATION_LIMITS.rootAccelMPerS2+1e-6);
  }
 });
});
