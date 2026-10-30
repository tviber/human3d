import {describe,it,expect,beforeAll} from 'vitest';
import fs from 'node:fs';
import {Quaternion,Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from './rig';
import {attachRacket} from './props/racket';
import {blankDocument,contactStartKey,flattenPose,frameAt,isReleaseKey,mirrorKey,normalizeDoc,samplePose,validateDocShape,type WorkshopDoc,type WorkshopKey} from './document';
import {ankleYForLift,footGeometry,footLift,footLowestY,soleOffset,toeSupportRise,type Side} from './foot';
import {analyzePose,measurePelvisCorrection,solveEffectiveFrame} from './solver';
import {mulberry32} from './random-document';

/** Regression tests for issue #2 P1-1..P1-5. Every case runs through the same
 * path the engine and the service use: frameAt → solveEffectiveFrame → rig
 * measurements. solveEffectiveFrame forwards every frame-carried solve state
 * (support fades, grip ramp, clavicle assist), so the tests stay valid as
 * EffectiveFrame gains fields. */
let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
 attachRacket(rig);
},30000);

const clone=<T,>(x:T):T=>JSON.parse(JSON.stringify(x));
const origin=()=>rig.rest.get('root')!;
function solveAt(doc:WorkshopDoc,t:number,mode?:'stepped'){
  const d=mode==='stepped'?{...doc,inbetweens:false}:doc;
  const f=frameAt(d as WorkshopDoc,t,origin());
  const r=solveEffectiveFrame(rig,f);
  return {f,...r};
}
const footPoint=(side:Side)=>rig.point(`foot_${side}`).clone();
/** Stance keys with explicit times; keys are cloned from the blank template. */
function docWith(times:number[],edit:(i:number,k:WorkshopKey)=>void,duration=times[times.length-1]+.5){
  const base=blankDocument(rig.rest,'t','t');
  const tmpl=base.keys[0];
  const doc:WorkshopDoc={...base,duration,keys:[]};
  times.forEach((time,i)=>{const k=clone(tmpl);k.id=`k${i}`;k.time=time;edit(i,k);doc.keys.push(k);});
  return doc;
}

describe('P1-1 pelvis correction is continuous and reports saturation',()=>{
 // The issue's lunge repro: the rear foot lifts at t=1 and replants at t=2.
 const lunge=()=>docWith([0,1,2],(i,k)=>{
  k.constraints={plantL:true,plantR:i!==1,grip:false,contact:false};
  k.pose.root={x:0,y:-.3,z:-.05};k.pose.lean=30;k.pose.footL.target.z=.3;k.pose.footR.target.z=-.25;
 },2);
 it('moves the pelvis in small steps across the lift and replant at 60 fps',()=>{
  const d=lunge();let prev:number|null=null,maxStep=0;
  for(let i=0;i<=120;i++){
   const {f}=solveAt(d,i/60);void f;
   const z=rig.bone('root').position.z;
   if(prev!==null)maxStep=Math.max(maxStep,Math.abs(z-prev));
   prev=z;
  }
  // The issue measured 150 mm in one step; the weighted correction stays under 5 mm per frame.
  expect(maxStep).toBeLessThan(.005);
 });
 it('reports a saturated rear leg as a failed check instead of clamping silently',()=>{
  const d=lunge();const r=solveAt(d,0);
  expect(r.pelvisSaturated).toBe(true);
  const a=analyzePose(rig,r.f.pose,r.f.constraints);
  const dorsi=a.items.find(i=>i.code==='ankle-dorsiflexion-R');
  expect(dorsi?.ok).toBe(false);
 });
});

describe('P1-2 stepped mode uses the contact-rewritten key pose',()=>{
 it('keeps a planted foot still across keys of one contact run',()=>{
  const d=docWith([0,1],(i,k)=>{
   k.constraints={plantL:true,plantR:true,grip:false,contact:false};
   if(i===1)k.pose.footL.target.z+=.15; // moved target inside the same planted run
  },1);
  const a=solveAt(d,.2,'stepped'),b=solveAt(d,.9,'stepped');
  void a;void b;
  const p1=footPoint('L');solveAt(d,.2,'stepped');const q1=footPoint('L');solveAt(d,.9,'stepped');const q2=footPoint('L');
  expect(q1.distanceTo(q2)).toBeLessThan(.002);
  expect(p1.distanceTo(q1)).toBeLessThan(.002);
 });
});

describe('P1-3 a contact locks the foot orientation as well as the ankle',()=>{
 it('keeps yaw and pitch fixed across a planted run, so toes do not slide',()=>{
  const d=docWith([0,1],(i,k)=>{
   k.constraints={plantL:true,plantR:true,grip:false,contact:false};
   if(i===1){k.pose.footL.yaw=25;k.pose.footL.pitch=12;k.pose.footL.target.z+=.05;}
  },1);
  const toes=footGeometry(rig.rest,'L').names;
  solveAt(d,.2);const q1=rig.bone('foot_L').getWorldQuaternion(new Quaternion());
  const p1=toes.map(n=>rig.point(n).clone());
  solveAt(d,.8);const q2=rig.bone('foot_L').getWorldQuaternion(new Quaternion());
  const p2=toes.map(n=>rig.point(n).clone());
  expect(q1.angleTo(q2)*180/Math.PI).toBeLessThan(.5);
  for(let i=0;i<toes.length;i++)expect(p1[i].distanceTo(p2[i])).toBeLessThan(.002);
 });
});

describe('P1-4 foot height is the sole, measured on the solved rig',()=>{
 it('places the lowest solved foot point at the requested sole lift',()=>{
  for(const [yaw,pitch] of [[0,0],[30,10],[-20,-15]]){
   const g=footGeometry(rig.rest,'L');
   const lift=.1;
   const d=docWith([0,1],(_,k)=>{
    k.constraints={plantL:false,plantR:true,grip:false,contact:false};
    k.pose.footL.yaw=yaw;k.pose.footL.pitch=pitch;
    k.pose.footL.target.y=ankleYForLift(g,lift,yaw,pitch);
   },2);
   solveAt(d,0);
   const named=Math.min(...g.names.map(n=>rig.point(n).y)),ankle=rig.point('foot_L');
   const lowest=footLowestY(g,named,ankle.y,rig.bone('foot_L').getWorldQuaternion(new Quaternion()));
   expect(Math.abs((lowest-g.groundY)-lift)).toBeLessThan(.003);
   expect(Math.abs(footLift(g,ankle.y,yaw,pitch)-lift)).toBeLessThan(.003);
  }
 });
});

describe('supported foot pitch resolves toe and heel support without ground penetration',()=>{
 it.each(['L','R']as const)('%s toe support raises and lowers the body with foot pitch',side=>{
  const geo=footGeometry(rig.rest,side),pitch=12;
  const doc=docWith([0,1],(_,k)=>{k.constraints={plantL:true,plantR:true,grip:false,contact:false};},1);
  const baseline=solveAt(doc,0);void baseline;
  const flatRootY=rig.bone('root').position.y;
  const foot=side==='L'?doc.keys[0].pose.footL:doc.keys[0].pose.footR;
  const expectedRise=toeSupportRise(pitch);
  expect(expectedRise).toBeGreaterThan(0);
  for(const k of doc.keys)(side==='L'?k.pose.footL:k.pose.footR).pitch=pitch;
  const frame=frameAt(doc,.25,origin());
  measurePelvisCorrection(rig,frame.pose,frame.constraints,{support:frame.support});
  const measuredRootY=rig.bone('root').position.y;
  expect(measuredRootY).toBeCloseTo(flatRootY,8);
  solveEffectiveFrame(rig,frame);
  expect(rig.bone('root').position.y).toBeCloseTo(measuredRootY+expectedRise,8);
  expect(rig.bone('root').position.y-flatRootY).toBeCloseTo(expectedRise,6);
  const ankle=rig.point(`foot_${side}`),lowestNamed=Math.min(...geo.names.map(n=>rig.point(n).y));
  const lowestToe=footLowestY(geo,lowestNamed,ankle.y,rig.bone(`foot_${side}`).getWorldQuaternion(new Quaternion()));
  expect(Math.abs(lowestToe-geo.groundY)).toBeLessThan(.002);

  for(const k of doc.keys)(side==='L'?k.pose.footL:k.pose.footR).pitch=0;
  solveAt(doc,.25);
  expect(rig.bone('root').position.y).toBeCloseTo(flatRootY,8);
 });

 it.each(['L','R']as const)('%s heel support keeps body height unchanged and lifts the heel to the floor',side=>{
  const geo=footGeometry(rig.rest,side),doc=docWith([0,1],(_,k)=>{
   k.constraints={plantL:true,plantR:true,grip:false,contact:false};
   (side==='L'?k.pose.footL:k.pose.footR).pitch=-12;
  },1);
  const flat=clone(doc);for(const k of flat.keys)(side==='L'?k.pose.footL:k.pose.footR).pitch=0;
  solveAt(flat,0);const flatRootY=rig.bone('root').position.y;
  solveAt(doc,0);
  expect(rig.bone('root').position.y).toBeCloseTo(flatRootY,8);
  const ankle=rig.point(`foot_${side}`),lowestNamed=Math.min(...geo.names.map(n=>rig.point(n).y));
  const lowest=footLowestY(geo,lowestNamed,ankle.y,rig.bone(`foot_${side}`).getWorldQuaternion(new Quaternion()));
  const foot=side==='L'?doc.keys[0].pose.footL:doc.keys[0].pose.footR;
  expect(lowest,`ankle ${rig.point(`foot_${side}`).y}, target ${foot.target.y}, pitch ${foot.pitch}, lift ${footLift(geo,foot.target.y,foot.yaw,foot.pitch)}`)
   .toBeCloseTo(geo.groundY,4);
  expect(soleOffset(geo,0,-12)).toBeLessThan(soleOffset(geo,0,0));
 });
});

describe('P1-5 dragging a planted foot writes the contact run start',()=>{
 it('resolves the run start key and moves the planted foot through the whole run',()=>{
  const d=docWith([0,.5,1,1.5],(i,k)=>{
   k.constraints={plantL:i<3,plantR:true,grip:false,contact:false};
  },2);
  expect(contactStartKey(d,'L',.8)?.id).toBe('k0');
  expect(contactStartKey(d,'L',1.2)?.id).toBe('k0');
  expect(contactStartKey(d,'L',1.7)).toBeUndefined();
  const before=(solveAt(d,.75),footPoint('L'));
  const start=contactStartKey(d,'L',.75)!;
  start.pose.footL.target.z+=.12;
  const after=(solveAt(d,.75),footPoint('L'));
  expect(after.distanceTo(before)).toBeGreaterThan(.1);
 });
});

describe('replant declares a fresh contact on a planted key',()=>{
 it('re-anchors the run at the replant key and stops contactStartKey there',()=>{
  const d=docWith([0,.5,1,1.5],(i,k)=>{
   k.constraints={plantL:true,plantR:true,grip:false,contact:false};
   k.pose.footL.target.z=i*.1;
   if(i===2)k.constraints.replant=true;
  },2);
  expect(contactStartKey(d,'L',.75)?.id).toBe('k0');
  expect(contactStartKey(d,'L',1.2)?.id).toBe('k2');
  expect(contactStartKey(d,'L',1.6)?.id).toBe('k2');
  // The last pre-replant key still samples the run anchor; from the replant
  // key onward its own stored foot is live. The [k1,k2) interval carries the
  // smooth transition into the new contact — the authored step.
  expect(samplePose(d,.5,origin()).footL.target.z).toBeCloseTo(0,9);
  expect(samplePose(d,1.2,origin()).footL.target.z).toBeCloseTo(.2,9);
  expect(samplePose(d,.75,origin()).footL.target.z).toBeCloseTo(.1,9);
 });
 it('lets a copied planted frame hold its own contact instead of inheriting the run anchor',()=>{
  const d=docWith([0,.5,1],(i,k)=>{
   k.constraints={plantL:true,plantR:true,grip:false,contact:false};
  },1.5);
  const copy=clone(d.keys[1]);copy.id='k1-copy';copy.time=.75;copy.constraints.replant=true;
  d.keys.push(copy);d.keys.sort((a,b)=>a.time-b.time);
  // Move the copy's foot: the earlier keys' stored values must not change,
  // and the copy — not the run start — owns the contact at its time.
  const before=d.keys[1].pose.footL.target.x;
  copy.pose.footL.target.x+=.1;
  expect(contactStartKey(d,'L',.75)?.id).toBe('k1-copy');
  expect(d.keys[1].pose.footL.target.x).toBe(before);
 });
 it('validates replant type and folds it where it cannot break a run',()=>{
  const d=docWith([0,.5,1],(i,k)=>{k.constraints={plantL:true,plantR:true,grip:false,contact:false};if(i===1)k.constraints.replant=true;},1.5);
  d.keys[1].constraints.replant='yes' as unknown as boolean;
  expect(validateDocShape(d).some(p=>p.includes('replant'))).toBe(true);
  // Meaningful on keys[1] (planted after planted) — kept; on an unplanted or
  // predecessor-free key it folds to the canonical absent form.
  const n=docWith([0,.5,1,1.5],(i,k)=>{
   k.constraints={plantL:i!==2,plantR:i!==2,grip:false,contact:false};
   if(i===1||i===2)k.constraints.replant=true;
  },2);
  const out=normalizeDoc(clone(n));
  expect(out.keys[1].constraints.replant).toBe(true);
  expect(out.keys[2].constraints.replant).toBeUndefined();
 });
 it('mirrors the replant flag with the key',()=>{
  const d=docWith([0],(i,k)=>{k.constraints={plantL:true,plantR:false,grip:false,contact:false,replant:true};},.5);
  expect(mirrorKey(d.keys[0]).constraints.replant).toBe(true);
  expect(mirrorKey(d.keys[0]).constraints.plantL).toBe(false);
 });
});

describe('review P2-1 only planted and release keys defer to the contact owner',()=>{
 it('keeps stored foot orientation live on free-swing keys inside a swing stretch',()=>{
  // K0 plant → K1 release → K2 free swing → K3 replant. Stored yaw/pitch are
  // dead only on the locked run and the release instant; K2's are real
  // keyframe data the swing passes through.
  const d=docWith([0,1,2,3],(i,k)=>{
   k.constraints={plantL:i===0||i===3,plantR:true,grip:false,contact:false};
   k.pose.footL.yaw=i*20;k.pose.footL.pitch=i*10;
  },3);
  expect(isReleaseKey(d,1,'L')).toBe(true);
  expect(isReleaseKey(d,2,'L')).toBe(false);
  const at=(t:number)=>samplePose(d,t,origin()).footL;
  // Release instant: inherited contact orientation (K0 stored 0/0), its own
  // stored 20/10 is dead.
  expect(at(1).yaw).toBeCloseTo(0,6);expect(at(1).pitch).toBeCloseTo(0,6);
  // Free-swing K2: its stored values are sampled — editing them is live.
  expect(at(2).yaw).toBeCloseTo(40,6);expect(at(2).pitch).toBeCloseTo(20,6);
  // Replant K3 opens a new contact on its own stored orientation.
  expect(at(3).yaw).toBeCloseTo(60,6);expect(at(3).pitch).toBeCloseTo(30,6);
 });
});

describe('tail-interval release extrapolation (尾部区间 release 外推)',()=>{
 it('holds the last key foot target through the tail instead of diverging',()=>{
  // Regression: non-loop doc whose second-to-last key releases the foot.
  // Samples in (lastKey.time, duration] still govern on the swing interval,
  // and the two-piece Hermite ran with uu>1 — cubic extrapolation sent the
  // foot target metres away. The fix clamps evaluation to [t0, t0+dt] so
  // the tail holds the next key's stored target.
  const g=footGeometry(rig.rest,'L');
  const d=docWith([0,.6,1.2],(i,k)=>{
   k.constraints={plantL:i===0,plantR:true,grip:false,contact:false};
   if(i===1)k.pose.footL.target={x:.14,y:.22,z:.3}; // release key: stored mid-swing waypoint
   if(i===2)k.pose.footL.target={x:.16,y:ankleYForLift(g,0,7,0),z:.25}; // unplanted landing key
  },1.8);
  expect(isReleaseKey(d,1,'L')).toBe(true);
  const stored=d.keys[2].pose.footL.target;
  for(let i=0;i<=12;i++){
   const t=.6+i*(d.duration-.6)/12;
   const {f}=solveAt(d,t);
   const tgt=f.pose.footL.target;
   expect(Number.isFinite(tgt.x)).toBe(true);
   expect(Number.isFinite(tgt.y)).toBe(true);
   expect(Number.isFinite(tgt.z)).toBe(true);
   const lowest=Math.min(...g.names.map(n=>rig.point(n).y));
   expect(lowest-g.groundY).toBeGreaterThanOrEqual(-.002);
  }
  // Sampler semantics: the tail holds the governing interval's end value,
  // which is the last key's stored target (its channels are not overridden).
  const tail=frameAt(d,d.duration,origin()).pose.footL.target;
  expect(tail.x).toBeCloseTo(stored.x,6);
  expect(tail.y).toBeCloseTo(stored.y,6);
  expect(tail.z).toBeCloseTo(stored.z,6);
 });
});

describe('loop seam, grip ramp, and random documents',()=>{
 it('joins the last and first frame of a loop without a visible velocity break',()=>{
  const d=docWith([0,.6,1.2],(i,k)=>{k.constraints={plantL:true,plantR:true,grip:false,contact:false};k.pose.lean=i*6;},1.5);
  d.loop=true;
  const dt=1/240,D=d.duration;
  const diff=(a:number,b:number)=>{const x=flattenPose(samplePose(d,a,origin())),y=flattenPose(samplePose(d,b,origin()));let m=0;for(let i=0;i<x.length;i++)m=Math.max(m,Math.abs(x[i]-y[i]));return m;};
  const seam=diff(D-dt,dt);
  let typical=0;for(let t=.05;t<D-.05;t+=.05)typical=Math.max(typical,diff(t,t+dt));
  expect(seam).toBeLessThan(2*typical+1e-3);
 });
 it('ramps the grip over a quarter second after a grip key',()=>{
  const d=docWith([0,1],(i,k)=>{k.constraints={plantL:true,plantR:true,grip:i===1,contact:false};},2);
  expect(frameAt(d,1,origin()).gripAmount).toBeCloseTo(0,5);
  expect(frameAt(d,1.125,origin()).gripAmount).toBeGreaterThan(.3);
  expect(frameAt(d,1.125,origin()).gripAmount).toBeLessThan(.7);
  expect(frameAt(d,1.5,origin()).gripAmount).toBeCloseTo(1,5);
 });
 it('hands a sub-transition hold over without jumping to full grip',()=>{
  /* false→true→false with a .1 s hold (the 本帧持拍 use case): the rise is
   * bounded by the NEXT interval too, so it finishes inside the held
   * interval and the releasing key's own ramp continues from there. Without
   * the bound the rise was still at ~35% when the release key took over and
   * the amount popped to 1 for an instant. */
  const d=docWith([0,1,1.1],(i,k)=>{k.constraints={plantL:true,plantR:true,grip:i===1,contact:false};},1.6);
  expect(frameAt(d,1.0999,origin()).gripAmount).toBeGreaterThan(.99);
  // The release interval is monotone decreasing — no upward pop at the key.
  let prev=Infinity;
  for(let i=0;i<=80;i++){
   const g=frameAt(d,1.1+i/400,origin()).gripAmount;
   expect(g).toBeLessThanOrEqual(prev+1e-9);prev=g;
  }
  // The same bound on the release side: a rise clipped by the hold starts
  // its fall at the amount the rise reached, continuous through the key.
  expect(frameAt(d,1.1,origin()).gripAmount).toBeCloseTo(1,5);
 });
 it('keeps random valid documents finite and valid through the solver',()=>{
  const rnd=mulberry32(20240607);
  const r=(a:number,b:number)=>a+(b-a)*rnd();
  for(let n=0;n<8;n++){
   const duration=r(.6,4);const count=2+Math.floor(rnd()*3);
   const times=Array.from({length:count},(_,i)=>i===0?0:Math.min(duration-.05,(i/(count-1))*duration));
   times[times.length-1]=Math.min(duration-.05,times[times.length-1]);
   const d=docWith(times,(i,k)=>{
    k.constraints={plantL:rnd()<.7,plantR:rnd()<.7,grip:rnd()<.5,contact:false};
    k.pose.root={x:r(-.1,.1),y:r(-.2,.05),z:r(-.1,.1)};
    k.pose.lean=r(-20,30);k.pose.chest=r(-20,20);k.pose.yaw=r(-40,40);
    k.pose.footL.target={x:r(-.2,.2),y:r(0,.3),z:r(-.3,.3)};k.pose.footR.target={x:r(-.2,.2),y:r(0,.3),z:r(-.3,.3)};
   },duration);
   d.duration=duration;
   expect(validateDocShape(d)).toEqual([]);
   for(let s=0;s<=10;s++){
    const t=s/10*duration;const f=frameAt(d,t,origin());
    const out=solveEffectiveFrame(rig,f);
    expect(Number.isFinite(out.pelvisShift)).toBe(true);
    const a=analyzePose(rig,f.pose,f.constraints);
    for(const it of a.items)expect(Number.isFinite(it.value??0)).toBe(true);
   }
  }
 });
});

describe('handFrames world/pelvis agree at key instants',()=>{
 it('samples the same world hand position at every key under either interpolation frame',()=>{
  // The stored hand target is world space in both modes; handFrames only
  // chooses the interpolation frame BETWEEN keys. At a key instant both
  // conventions must land on the authored target (issue-25 review: capturing
  // a pose across documents does not reinterpret hand coordinates).
  const times=[0,.6,1.2];
  const base=blankDocument(rig.rest,'hf','hf-test');
  base.keys.forEach((k,i)=>{k.time=times[i]??k.time*i;k.pose.handL.target={x:.3,y:1.1-i*.2,z:.1};});
  base.duration=1.2;
  const pelvis={...clone(base),handFrames:{L:'pelvis' as const,R:'pelvis' as const}};
  const world={...clone(base),handFrames:{L:'world' as const,R:'world' as const}};
  for(const t of times){
   const a=frameAt(pelvis,t,origin()),b=frameAt(world,t,origin());
   expect(a.pose.handL.target.x).toBeCloseTo(b.pose.handL.target.x,9);
   expect(a.pose.handL.target.z).toBeCloseTo(b.pose.handL.target.z,9);
   rig.reset();solveEffectiveFrame(rig,a);const pa=rig.point('wrist_L').clone();
   rig.reset();solveEffectiveFrame(rig,b);const pb=rig.point('wrist_L').clone();
   expect(pa.distanceTo(pb)).toBeLessThan(1e-6);
  }
 });
});

void ({} as Vector3);
void ({} as Side);
