import {LoopOnce,LoopRepeat,Quaternion,Vector3,type AnimationAction,type AnimationMixer,type Bone,type Object3D} from 'three';
import {angleAt,buildPelvisSchedule,checkPosePackageShape,compileMotion,frameAtCompiled,gripFrame,RACKET_HANDLE,solveEffectiveFrame,HumanRig} from '@human3d/motion-core';
import type {CompiledMotion,DebugOptions,DynamicsRecords,MuscleActionFile,MotionCapabilities,PelvisSchedule,PosePackage,WorkshopDoc} from '@human3d/motion-core';
import type {DynamicsCase,DynamicsReplay} from '../lab/dynamics';

/** Per-frame measurements for the inspector/QA: joint angles from FK points,
 * the racket grip offset, and anchor positions. */
export interface FrameReadout{knee:number;elbow:number;gripError:number;footL:number[];footR:number[];root:number[];hand:number[];bones:number;vertices:number}
export type SourceStatus='loading'|'ready'|'error';

/** One trajectory backend behind the engine's single playhead (`engine.time`).
 * clip / document / pose-package all write the shared skin rig; dynamics keeps
 * its own replay object, exposed through `physics` for the panel and QA. */
export interface MotionSource{
  kind:'clip'|'document'|'dynamics'|'pose-package';
  status:SourceStatus;error?:string;readonly duration:number;
  seek(t:number):void;
  /** Camera/floor anchor: the rig root for skinned sources, the physical body for dynamics. */
  rootPoint():Vector3;
  /** Each implementation resolves names in its own domain (rig bones vs MyoSim bodies). */
  point(name:string):Vector3|undefined;
  /** Whether the prop is on screen this frame — the document grip ramp counts. */
  wantsProp():boolean;
  /** Wrist the prop mounts on ('R' when absent) — constant per source, so the
   * engine can remount the racket once per source instead of per frame. */
  readonly propSide?:'L'|'R';
  /** Bevel the prop is rolled to (facet in the palm), constant per source like
   * propSide. Absent means the canonical bevel 1. */
  readonly propBevel?:number;
  /** Whole-model visual offset (walk accumulates one stride per loop wrap). */
  readonly modelOffset?:Vector3;
  /** Loop-seam side effect, e.g. the walk clip accumulating its stride. */
  loopWrapAdvance?():void;
  setDebug?(o:DebugOptions):void;
  diagnostics():FrameReadout|null;
  /** Escape hatch for the dynamics panel and QA hooks. */
  physics?:DynamicsReplay;
  activate?():void;deactivate?():void;dispose?():void;
}

/** Shared skeleton measurement (the old engine.diagnostics() shape). The
 * racket grip error is only meaningful while the prop is wanted — callers pass
 * the racket in then, otherwise gripError is 0. `side` selects the gripping
 * wrist the error and `hand` anchor read (right remains the default). */
function rigReadout(rig:HumanRig,racket?:{getWorldPosition(v:Vector3):Vector3},side:'L'|'R'='R'):FrameReadout{
  rig.model.updateMatrixWorld(true);
  const p=(n:string)=>rig.point(n);
  let gripError=0;
  if(racket)gripError=rig.bone(`wrist_${side}`).localToWorld(gripFrame(rig,side,RACKET_HANDLE).center.clone()).distanceTo(racket.getWorldPosition(new Vector3()));
  return {knee:angleAt(p('upperleg01_R'),p('lowerleg01_R'),p('foot_R')),elbow:angleAt(p('upperarm01_R'),p('lowerarm01_R'),p('wrist_R')),gripError,footL:p('foot_L').toArray(),footR:p('foot_R').toArray(),root:p('root').toArray(),vertices:rig.info.vertices,bones:rig.bones.size,hand:p(`wrist_${side}`).toArray()};
}

/** A baked AnimationClip driven through the shared mixer. The engine owns the
 * mixer; the source only steers its action's time. `modelOffset` carries the
 * walk stride accumulation — it survives seeks so the wrap keeps translating,
 * and the engine clears it on scrub/switch (the old walkOffset semantics). */
export class ClipSource implements MotionSource{
  readonly kind='clip' as const;status:SourceStatus='ready';
  readonly modelOffset=new Vector3();
  constructor(private rig:HumanRig,private mixer:AnimationMixer,private action:AnimationAction,private stride:Vector3,private racket?:{getWorldPosition(v:Vector3):Vector3}){}
  get duration(){return this.action.getClip().duration;}
  setLoop(loop:boolean){this.action.setLoop(loop?LoopRepeat:LoopOnce,loop?Infinity:1);this.action.clampWhenFinished=true;}
  activate(){this.modelOffset.set(0,0,0);this.action.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();}
  deactivate(){this.modelOffset.set(0,0,0);this.action.stop();}
  seek(t:number){
    this.action.enabled=true;this.action.setEffectiveWeight(1);this.action.paused=false;
    // `-1e-6` keeps a LoopRepeat action from wrapping the exact end to frame 0.
    this.action.time=Math.min(this.duration-1e-6,Math.max(0,t));this.mixer.update(0);
  }
  loopWrapAdvance(){this.modelOffset.add(this.stride);}
  wantsProp(){return false;}
  rootPoint(){return this.rig.point('root');}
  point(name:string){return this.rig.bones.has(name)?this.rig.point(name):undefined;}
  diagnostics(){return rigReadout(this.rig,this.racket);}
}

/** A WorkshopDoc solved live: frameAtCompiled → solveEffectiveFrame, the same
 * path the service's package builder samples. `origin` must be the rest root —
 * the same pelvis-frame origin the workshop and service use, else pelvis-frame
 * hands shift. `doc` is constructor-fixed by contract (playback never edits
 * it), so one compiled snapshot serves the source's whole lifetime — duration
 * and propSide read through the snapshot too, staying correct even if a
 * mutable document were ever handed in. */
export class DocumentSource implements MotionSource{
  readonly kind='document' as const;status:SourceStatus='ready';
  private readonly compiled:CompiledMotion;private readonly schedule:PelvisSchedule;private grip=0;
  constructor(private rig:HumanRig,private doc:WorkshopDoc,private racket?:{getWorldPosition(v:Vector3):Vector3}){
    this.compiled=compileMotion(doc,rig.rest.get('root')!);
    this.schedule=buildPelvisSchedule(rig,this.compiled);
  }
  get duration(){return this.compiled.duration;}
  seek(t:number){
    const time=Math.max(0,Math.min(this.compiled.duration,t));
    const f=frameAtCompiled(this.compiled,time);
    solveEffectiveFrame(this.rig,f,this.schedule.passthrough?undefined:this.schedule.at(time));
    this.grip=f.gripAmount;
  }
  wantsProp(){return this.grip>0;}
  /** The document's authored grip side — the racket mount and readout follow it. */
  get propSide(){return this.compiled.gripSide==='L'?'L':'R';}
  /** The authored bevel (facet rolled into the palm); absent is bevel 1. */
  get propBevel(){return this.compiled.gripBevel;}
  rootPoint(){return this.rig.point('root');}
  point(name:string){return this.rig.bones.has(name)?this.rig.point(name):undefined;}
  diagnostics(){return rigReadout(this.rig,this.wantsProp()?this.racket:undefined,this.propSide);}
}

const _qa=new Quaternion(),_qb=new Quaternion();
/** Reference decoder for delivered pose packages: local quaternions slerped
 * between the two bracketing samples, the root track lerped. Untracked bones
 * stay at their rest pose (identity local rotation). */
export class PosePackageSource implements MotionSource{
  readonly kind='pose-package' as const;
  status:SourceStatus='ready';error?:string;
  private ts:number[]=[0];private rootValues:number[]=[0,0,0];private _duration=0;
  private rotations:{bone:Bone;values:number[]}[]=[];
  /** @param prop Package-level prop hint (the derived spec's
   * capabilities.prop). v2 packages carry no per-frame grip channel, so the
   * prop is either constantly present or absent — `wantsProp` returns the
   * constant. The spec description records this ceiling. */
  constructor(private rig:HumanRig,pkg:unknown,private prop?:MotionCapabilities['prop'],private racket?:{getWorldPosition(v:Vector3):Vector3}){
    const problems=checkPosePackageShape(pkg,new Set(rig.bones.keys()));
    // Loud refusal: a malformed package must surface as an error state, never
    // silently decode into garbage poses.
    if(problems.length){this.status='error';this.error=`姿态包结构不合规：${problems[0]}${problems.length>1?`（共 ${problems.length} 处问题）`:''}`;return;}
    const p=pkg as PosePackage;
    this._duration=p.timeline.duration;this.ts=p.timeline.timestamps;this.rootValues=p.tracks.translation.values;
    for(const tr of p.tracks.rotations)this.rotations.push({bone:rig.bone(tr.bone),values:tr.values});
  }
  get duration(){return this._duration;}
  /** Last timestamp index at or before `t` (timeline timestamps are ascending). */
  private lowerIndex(t:number){
    let lo=0,hi=this.ts.length-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(this.ts[mid]<=t)lo=mid;else hi=mid-1;}
    return lo;
  }
  seek(t:number){
    if(this.status!=='ready')return;
    const time=Math.max(0,Math.min(this._duration,t)),i=this.lowerIndex(time),j=Math.min(i+1,this.ts.length-1);
    const dt=this.ts[j]-this.ts[i],u=dt>1e-9?(time-this.ts[i])/dt:0;
    this.rig.reset();
    const v=this.rootValues;
    this.rig.bone('root').position.set(v[i*3]+(v[j*3]-v[i*3])*u,v[i*3+1]+(v[j*3+1]-v[i*3+1])*u,v[i*3+2]+(v[j*3+2]-v[i*3+2])*u);
    for(const tr of this.rotations){
      _qa.fromArray(tr.values,i*4);_qb.fromArray(tr.values,j*4);
      // The builder normalized quaternion hemisphere, so this slerp is the short arc.
      tr.bone.quaternion.copy(_qa).slerp(_qb,u);
    }
    this.rig.model.updateMatrixWorld(true);
  }
  wantsProp(){return this.status==='ready'&&!!this.prop;}
  /** The prop capability's declared mount side ('R' when undeclared). */
  get propSide(){return this.prop?.side==='L'?'L':'R';}
  get propBevel(){return this.prop?.bevel;}
  rootPoint(){return this.rig.point('root');}
  point(name:string){return this.rig.bones.has(name)?this.rig.point(name):undefined;}
  diagnostics(){return rigReadout(this.rig,this.wantsProp()?this.racket:undefined,this.propSide);}
}

/** Shared replay holder: one MyoSim replay per engine, reloaded per motion —
 * the same single-replay semantics the old engine.physics/physicsPromise had. */
export interface DynamicsSession{rig:HumanRig;parent:Object3D;replay?:DynamicsReplay;promise?:Promise<DynamicsReplay>;retired?:boolean}
export const createDynamicsSession=(rig:HumanRig,parent:Object3D):DynamicsSession=>({rig,parent});

/** Dynamics replay source. `static create` keeps the dynamics module behind a
 * lazy import; `load` drives status loading→ready/error with the promise
 * singleton and the replay's own out-of-order guard preserved. */
export class DynamicsSource implements MotionSource{
  readonly kind='dynamics' as const;
  status:SourceStatus='loading';error?:string;
  /** The last requested case; mirrors the old physicsCase (set at load start so
   * the panel reports the attempted profile even when the load fails). */
  profile:DynamicsCase='baseline';
  private debug?:DebugOptions;
  /** Load generation: load/deactivate/dispose each bump it, so a stale
   * in-flight load can recognize that somebody else (a newer load, a source
   * switch, engine teardown) owns the session now — and must not apply
   * `status='ready'`/`root.visible=true` after the fact. */
  private gen=0;
  private constructor(private session:DynamicsSession){}
  static create(session:DynamicsSession){return new DynamicsSource(session);}
  get physics(){return this.session.replay;}
  get duration(){return this.session.replay?.duration??0;}
  /** Load the record for `id`. 'applied' → the engine finishes activation;
   * 'superseded' → a newer load or a source switch owns the replay now;
   * 'error' → status/error already carry the message. The envelope's
   * `records` URLs take precedence inside the replay; a bare spec falls back
   * to the per-action `/dynamics/<id>/<case>` path convention. */
  async load(id:string,profile:DynamicsCase,muscleAction?:MuscleActionFile,records?:DynamicsRecords):Promise<'applied'|'superseded'|'error'>{
    const g=++this.gen;
    this.profile=profile;this.status='loading';this.error=undefined;
    const s=this.session;
    // Segment 1 — obtain the shared replay. ONLY a failure here may clear
    // s.promise, and only while it still names the dead one: a rejected
    // creation promise is poison for every later load, but a stale load must
    // not clear a promise a newer owner already replaced.
    const p=s.promise??=import('../lab/dynamics').then(m=>m.DynamicsReplay.create(s.rig));
    let replay:DynamicsReplay;
    try{replay=await p;}
    catch(err){
      if(s.promise===p)s.promise=undefined;
      if(this.gen!==g||s.retired)return 'superseded';
      this.status='error';this.error=err instanceof Error?err.message:String(err);
      return 'error';
    }
    if(this.gen!==g||s.retired){
      // Only a RETIRED session disposes the fresh replay — it can never be
      // adopted. A merely superseded one keeps it: the shared session
      // promise hands the same object to whichever load owns it now.
      if(s.retired&&s.replay!==replay)replay.dispose();
      return 'superseded';
    }
    if(!s.replay){s.replay=replay;s.parent.add(replay.root);}
    // Segment 2 — the record load inside the already-adopted replay. A failure
    // here keeps s.promise and s.replay so a retry re-runs the record fetch on
    // the SAME replay; clearing them would orphan a second DynamicsReplay the
    // session can never adopt (physics/duration/seek would keep pointing at
    // the first, record-less one — playback stuck at duration 0).
    let accepted:boolean;
    try{accepted=await replay.load(id,profile,muscleAction,records);}
    catch(err){
      if(this.gen!==g||s.retired)return 'superseded';
      this.status='error';this.error=err instanceof Error?err.message:String(err);
      return 'error';
    }
    if(!accepted||this.gen!==g||s.retired)return 'superseded';
    this.status='ready';replay.root.visible=true;if(this.debug)replay.setOptions(this.debug);
    return 'applied';
  }
  seek(t:number){const r=this.session.replay;if(this.status!=='ready'||!r)return;r.seek(Math.max(0,Math.min(r.duration,t)));}
  rootPoint(){return this.point('Full Body')??this.session.rig.point('root');}
  point(name:string){const r=this.session.replay;return r?.ready?r.point(name):undefined;}
  wantsProp(){return false;}
  setDebug(o:DebugOptions){this.debug=o;this.session.replay?.setOptions(o);}
  diagnostics(){return null;}
  /** The bump retires any in-flight load of this source: switching away while
   * a record is still loading must not let the stale await resurrect the
   * replay (status='ready', root.visible=true) over the new source. */
  deactivate(){this.gen++;if(this.session.replay)this.session.replay.root.visible=false;}
  dispose(){const s=this.session;this.gen++;s.retired=true;if(s.replay){const r=s.replay;s.replay=undefined;r.dispose();}}
}

/** Cross-source pose blend (~.32 s): snapshots the whole skeleton at switch
 * time, then each tick blends every bone from the snapshot toward what the new
 * source wrote this frame. Replaces the mixer crossFade, which only worked
 * clip→clip. Skin-to-skin only (clip/document/pose-package); dynamics switches
 * stay hard cuts, as before. */
export class PoseFade{
  private static readonly DURATION=.32;
  private snapshot?:Map<Bone,Quaternion>;private rootAt?:Vector3;private elapsed=Infinity;
  get active(){return this.elapsed<PoseFade.DURATION;}
  start(rig:HumanRig){
    this.snapshot=new Map([...rig.bones.values()].map(b=>[b,b.quaternion.clone()]));
    this.rootAt=rig.bone('root').position.clone();this.elapsed=0;
  }
  clear(){this.snapshot=undefined;this.elapsed=Infinity;}
  /** Advance the blend by `dt` wall seconds (0 keeps the blend frozen). */
  apply(rig:HumanRig,dt:number){
    if(!this.snapshot)return;
    this.elapsed+=dt;
    const u=Math.min(1,this.elapsed/PoseFade.DURATION),cur=new Quaternion();
    for(const [b,q]of this.snapshot){cur.copy(b.quaternion);b.quaternion.copy(q).slerp(cur,u);}
    if(this.rootAt){const root=rig.bone('root');root.position.lerpVectors(this.rootAt,root.position,u);}
    rig.model.updateMatrixWorld(true);
    if(this.elapsed>=PoseFade.DURATION)this.clear();
  }
}
