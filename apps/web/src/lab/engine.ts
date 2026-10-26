import {webPlatform,type AppPlatform} from '../platform/platform';
import {AmbientLight,AnimationClip,AnimationMixer,AxesHelper,BufferGeometry,Color,DirectionalLight,Float32BufferAttribute,GridHelper,Group,HemisphereLight,Line,LineBasicMaterial,LineSegments,Mesh,MeshStandardMaterial,PerspectiveCamera,PlaneGeometry,Quaternion,Scene,SkinnedMesh,SphereGeometry,Vector3,WebGLRenderer,PCFSoftShadowMap,SRGBColorSpace,ACESFilmicToneMapping,Clock} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {HumanRig,skeletonSegments} from '@human3d/motion-core';
import {MOTIONS,motionById,muscleActionById} from '@human3d/motion-core';
import {MOTION_FILES} from '@human3d/motion-core';
import {motionDefinitionPayload} from '@human3d/motion-core';
import {canonical,rigManifestBody} from '@human3d/motion-core';
import {attachProp,mountRacket,RACKET_TIP_LOCAL} from '@human3d/motion-core';
import {checkPosePackageShape,posePackageSpec,rigMatches} from '@human3d/motion-core';
import {ClipSource,DocumentSource,DynamicsSource,PoseFade,PosePackageSource,createDynamicsSession,type DynamicsSession,type MotionSource} from '../playback/motion-source';
import {bindSceneBackground} from '../theme/scene-background';
import {applyHeroicShape} from '../theme/shape-preset';
import {SkinSwap,type SkinId} from '../theme/skin-swap';
import {SAVED_MOTION_PREFIX} from '../workshop/library';
import {loadAnatomyAtlas} from '../theme/anatomy-skin';
import {AnatomySelection} from '../theme/anatomy-selection';
import {subtleDigest} from '@human3d/motion-core';
import type {PosePackage} from '@human3d/motion-core';
import type {DynamicsCase,DynamicsReadout,DynamicsReplay} from './dynamics';
import type {DebugOptions,MotionId,MotionSpec,RigInfo,ViewId} from '@human3d/motion-core';
export interface FrameState{time:number;duration:number;phase:string;playing:boolean;knee:number;elbow:number;gripError:number;dynamics?:DynamicsReadout}
const ZERO=new Vector3();
/** sha256 hex of a canonical string via WebCrypto. `crypto.subtle` only
 * exists on secure contexts (https/localhost); where absent the hash is
 * unknowable — return undefined and let callers degrade honestly rather
 * than fabricate a check that cannot run. The digest + hex encoding is the
 * shared one from the package builder (package-export.ts); only the
 * absence policy differs (the builder must fail loudly instead). */
const sha256Hex=async(s:string):Promise<string|undefined>=>{
 if(!globalThis.crypto?.subtle)return undefined;
 return subtleDigest(s);
};
export class HumanEngine{
 scene=new Scene();camera=new PerspectiveCamera(35,1,.01,120);renderer:WebGLRenderer;controls:OrbitControls;
 model?:Group;rig?:HumanRig;mixer?:AnimationMixer;
 anatomy?:AnatomySelection;
 private skinSwap?:SkinSwap;
 /** The one and only playhead, in seconds of the active source. */
 time=0;activeId:MotionId='idle';playing=true;speed=1;private _loop=true;disposed=false;ready=false;
 private sources=new Map<MotionId,MotionSource>();private specs=new Map<MotionId,MotionSpec>();
 /** Fallback key material for pose packages that arrive without an artifact id. */
 private pkgSeq=0;
 private _source?:MotionSource;private fade=new PoseFade();private dynSession?:DynamicsSession;
 debug:DebugOptions={surface:true,skeleton:false,axes:false,targets:false,trail:false,muscles:false};
 skin:SkinId='default';
 racket?:Group;private racketSide:'L'|'R'='R';private racketBevel:number|undefined;
 /** Locally computed identities for the pose-package import gate: the rig
  * manifest hash (compared against a package's rig block — see rigMatches)
  * and each bundled envelope's definition hash (the trust closure in
  * openPosePackage). Both stay undefined/empty without WebCrypto. */
 private manifestHash?:string;private envelopeDefHash=new Map<string,string>();
 skeletonLines?:LineSegments;jointGroup=new Group();axesGroup=new Group();targetGroup=new Group();
 targetMarkers=new Map<string,Mesh>();trail?:Line;trailPoints:Vector3[]=[];
 previousPosition=new Vector3();view:ViewId='front';
 private floor?:Mesh;private grid?:GridHelper;private keyLight?:DirectionalLight;private clock=new Clock();private lastNotify=0;private resizeObserver:ResizeObserver;private raf=0;private unbindTheme?:()=>void;
 onView?:(view:ViewId)=>void;onFrame?:(frame:FrameState)=>void;onReady?:(info:RigInfo)=>void;onError?:(error:Error)=>void;
 get source(){return this._source;}
 get isPhysics(){return this._source?.kind==='dynamics';}
 private dynamicsSource(){return this._source instanceof DynamicsSource?this._source:undefined;}
 get physics(){return this.dynamicsSource()?.physics;}
 get physicsLoading(){return this.dynamicsSource()?.status==='loading';}
 get physicsCase(){return this.dynamicsSource()?.profile??'baseline';}
 get loop(){return this._loop;}
 set loop(value:boolean){this._loop=value;for(const s of this.sources.values())if(s instanceof ClipSource)s.setLoop(value);}
 constructor(public host:HTMLElement,private platform:AppPlatform=webPlatform){
  this.renderer=new WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});
  this.renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));this.renderer.outputColorSpace=SRGBColorSpace;this.renderer.toneMapping=ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.12;
  this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=PCFSoftShadowMap;
  this.renderer.domElement.setAttribute('aria-label','交互式三维人体，拖动旋转，滚轮缩放');this.renderer.domElement.setAttribute('role','img');this.host.appendChild(this.renderer.domElement);
  this.unbindTheme=bindSceneBackground(this.scene,this.platform);this.scene.add(new HemisphereLight(0xffffff,0x8592a6,2.5),new AmbientLight(0xffffff,.35));
  const key=new DirectionalLight(0xfff6ec,4.2);key.position.set(-3,5,4);key.castShadow=true;key.shadow.mapSize.set(2048,2048);key.shadow.camera.left=-3;key.shadow.camera.right=3;key.shadow.camera.top=3;key.shadow.camera.bottom=-3;key.shadow.normalBias=.012;key.shadow.bias=-.0001;this.scene.add(key,key.target);this.keyLight=key;
  const fill=new DirectionalLight(0xc3d9ff,2);fill.position.set(3,2,-3);this.scene.add(fill);
  const floor=new Mesh(new PlaneGeometry(200,200),new MeshStandardMaterial({color:0xf4f6f9,roughness:1,metalness:0}));floor.rotation.x=-Math.PI/2;floor.position.y=-.009;floor.receiveShadow=true;this.scene.add(floor);this.floor=floor;
  const grid=new GridHelper(200,800,0xc3cbd5,0xd8dfe8);grid.position.y=-.007;const gm=grid.material as LineBasicMaterial;gm.transparent=true;gm.opacity=.34;this.scene.add(grid);this.grid=grid;
  this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=true;this.controls.dampingFactor=.08;this.controls.target.set(0,.88,0);this.controls.minDistance=.3;this.controls.maxDistance=8;this.controls.maxPolarAngle=Math.PI*.49;this.controls.enablePan=true;this.camera.position.set(0,1.05,3.6);
  this.controls.addEventListener('start',()=>{this.view='free';this.onView?.('free');});
  this.scene.add(this.jointGroup,this.axesGroup,this.targetGroup);this.jointGroup.visible=false;this.axesGroup.visible=false;this.targetGroup.visible=false;
  this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(host);this.resize();
  this.animate();
 }
 async load(){
  try{
   const clipSpecs=MOTIONS.filter(m=>m.source?.kind==='clip');
   const [gltf,rigText,atlas,...clipAssets]=await Promise.all([new GLTFLoader().loadAsync(this.platform.assetUrl('/models/human.glb')),this.platform.fetchAsset('/models/rig.json').then(r=>{if(!r.ok)throw new Error('人体骨架加载失败');return r.text()}),loadAnatomyAtlas(this.platform),...clipSpecs.map(async m=>{
    const s=m.source as {kind:'clip';clip:string;meta?:string};
    const data=await this.platform.fetchAsset(s.clip).then(r=>{if(!r.ok)throw new Error('动作片段加载失败');return r.json()});
    const meta=s.meta?await this.platform.fetchAsset(s.meta).then(r=>r.json()):undefined;
    return {id:m.id as MotionId,clip:AnimationClip.parse(data),stride:new Vector3().fromArray(meta?.stride??[0,0,0])};
   })]);
   if(this.disposed){atlas.dispose();gltf.scene.traverse(o=>{if(o instanceof Mesh)o.geometry.dispose()});return;}
   const info=JSON.parse(rigText) as RigInfo;
   this.model=gltf.scene;this.scene.add(this.model);this.rig=new HumanRig(this.model,info);applyHeroicShape(this.model);
   // Local identities for the pose-package import gate — the same
   // canonical(rigManifestBody)/canonical(motionDefinitionPayload) sha256 the
   // service stamps into packages (rig.manifestSHA256 / action.definitionSHA256).
   // Without WebCrypto the hashes stay unknown and openPosePackage degrades to
   // the structural check instead of trusting what it cannot verify.
   this.manifestHash=await sha256Hex(canonical(rigManifestBody(info)));
   if(this.manifestHash===undefined)
    console.warn('crypto.subtle 不可用：姿态包导入的 rig/定义哈希核验降级为结构检查');
   for(const f of MOTION_FILES)if(f.kind==='workshop-motion'){
    const h=await sha256Hex(canonical(motionDefinitionPayload(f)));
    if(h!==undefined)this.envelopeDefHash.set(f.id,h);
   }
   this.anatomy=new AnatomySelection(this.host,this.renderer.domElement,this.camera,atlas,()=>!this.ready||!this.debug.surface);
   this.model.traverse(o=>{if(o instanceof SkinnedMesh){o.castShadow=true;o.receiveShadow=true;o.frustumCulled=false;this.anatomy!.add(o);}});
   // Sclerae at the original MakeHuman eye pivots, keeping facial silhouette intact.
   for(const side of ['L','R']){
    const eye=this.rig.bone(`eye_${side}`);const sclera=new Mesh(new SphereGeometry(.0105,20,12),new MeshStandardMaterial({color:0xbdcbd2,roughness:.5}));sclera.name='human-eye';eye.add(sclera);
   }
   this.skinSwap=new SkinSwap(this.model,this.platform);await this.skinSwap.set(this.skin);if(this.disposed)return;
   this.racket=attachProp(this.rig,'racket');this.racket.visible=false;
   this.mixer=new AnimationMixer(this.model);
   this.dynSession=createDynamicsSession(this.rig,this.scene);
   const clips=new Map(clipAssets.map(c=>[c.id,c]));
   for(const spec of MOTIONS){
    this.specs.set(spec.id,spec);const s=spec.source;
    if(s?.kind==='clip'){const c=clips.get(spec.id)!;this.sources.set(spec.id,new ClipSource(this.rig,this.mixer,this.mixer.clipAction(c.clip),c.stride,this.racket));}
    else if(s?.kind==='document')this.sources.set(spec.id,new DocumentSource(this.rig,s.document,this.racket));
    else if(s?.kind==='dynamics')this.sources.set(spec.id,DynamicsSource.create(this.dynSession));
   }
   this.loop=this._loop;
   this.makeDebug();this.ready=true;this.setMotion('idle',false);this.setView('front');this.onReady?.(info);
  }catch(err){this.onError?.(err instanceof Error?err:new Error(String(err)));}
 }
 private specOf(id:MotionId){return this.specs.get(id)??motionById(id);}
 /** Saved motions share the workshop document playback path; compile only when selected. */
 setSavedMotions(specs:MotionSpec[]){
  const active=this.activeId,time=this.time,playing=this.playing;
  const incoming=new Map(specs.map(spec=>[spec.id,spec]));
  let activeChanged=false;
  for(const [id,previous] of this.specs)if(id.startsWith(SAVED_MOTION_PREFIX)){
   const next=incoming.get(id);
   if(next&&JSON.stringify(previous)===JSON.stringify(next))continue;
   this.sources.get(id)?.dispose?.();this.sources.delete(id);this.specs.delete(id);
   if(id===active)activeChanged=true;
  }
  for(const spec of specs)if(!this.specs.has(spec.id))this.specs.set(spec.id,spec);
  if(activeChanged){
   const position=this.camera.position.clone(),target=this.controls.target.clone(),rotation=this.camera.quaternion.clone(),view=this.view;
   this.setMotion(this.specs.has(active)?active:'idle',false);
   if(this.specs.has(active)){
    this.seek(time);this.setPlaying(playing);
    this.camera.position.copy(position);this.camera.quaternion.copy(rotation);this.controls.target.copy(target);this.view=view;this.onView?.(view);this.render();
   }
  }
 }
 /** Mount the shared racket on the wrist and bevel the source's prop declares.
  * Both are constant per source, so this fires at most once per source switch;
  * prop-less sources report 'R'/bevel 1 and restore the canonical mount. */
 private syncRacketSide(src:MotionSource){
  const side=src.propSide??'R',bevel=src.propBevel;
  if(this.racket&&this.rig&&(side!==this.racketSide||bevel!==this.racketBevel)){
   mountRacket(this.rig,this.racket,side,bevel);this.racketSide=side;this.racketBevel=bevel;
  }
 }
 /** Register an externally delivered pose package as a temporary motion.
  * The package is shape-checked against the local rig; a malformed package is
  * refused loudly through onError, never decoded silently. */
 openPosePackage(pkg:unknown):MotionSpec|undefined{
  if(!this.ready||!this.rig){this.onError?.(new Error('模型尚未就绪，无法播放姿态包'));return undefined;}
  const problems=checkPosePackageShape(pkg,new Set(this.rig.bones.keys()));
  if(problems.length){this.onError?.(new Error(`姿态包不可用：${problems[0]}${problems.length>1?`（共 ${problems.length} 处问题）`:''}`));return undefined;}
  const p=pkg as PosePackage;
  // Rig identity: the package declares the rig manifest it was solved against.
  // With the local hash known a mismatch is a hard refusal — the delivered
  // local rotations would decode onto the wrong skeleton and fail silently.
  // Hash unknowable (non-secure context): degrade to the bone-name check that
  // already ran, and let the spec description say the rig was not verified.
  if(!rigMatches(p,this.manifestHash)){
   this.onError?.(new Error(`姿态包不可用：rig manifest 哈希与本地骨架不一致（声明 ${typeof p.rig?.manifestSHA256==='string'?p.rig.manifestSHA256.slice(0,12):'?'}…），FK 重放会错位`));
   return undefined;
  }
  // Key the temp entry on the package's artifact id (content-addressed), not
  // the action id: two packages solved for the same action stay distinct
  // entries, and reopening the same package is idempotent.
  const specId=`pkg:${typeof p.id==='string'&&p.id?p.id:`unkeyed-${this.pkgSeq++}`}`;
  // The display spec is derived from what the package carries: bundled
  // envelopes (matched by action.id) restore capabilities/name/phases — but
  // only when the package's action.definitionSHA256 reproduces the envelope's
  // own recomputed definition hash (a claimed-but-unproven bundled id falls
  // back to the ad-hoc parameters channel); ad-hoc packages carry
  // documentName and presentation hints there by design.
  const spec=posePackageSpec(p,specId,
   actionId=>this.envelopeDefHash.get(actionId)!==undefined&&this.envelopeDefHash.get(actionId)===p.action?.definitionSHA256,
   this.manifestHash!==undefined);
  this.specs.set(spec.id,spec);this.sources.set(spec.id,new PosePackageSource(this.rig,p,spec.capabilities?.prop,this.racket));
  this.setMotion(spec.id,false);return spec;
 }
 private loadDynamics(source:DynamicsSource,profile:DynamicsCase){
  const spec=this.specOf(this.activeId);
  // The spec's dynamics source is authoritative: it carries the envelope's
  // action parameters and record URLs straight into the replay.
  const ds=spec.source?.kind==='dynamics'?spec.source:undefined;
  void source.load(this.activeId,profile,ds?.action??muscleActionById(this.activeId),ds?.records).then(result=>{
   if(this._source!==source)return;
   const replay=source.physics;
   if(result==='applied'&&replay){
    source.setDebug(this.debug);source.seek(this.time);this.previousPosition.copy(source.rootPoint());
    this.setView(this.view==='hand'?'threeQuarter':this.view);this.playing=true;this.notify();
   }else if(result==='error'){
    this.playing=false;
    this.onFrame?.({time:0,duration:spec.duration,phase:'加载失败',playing:false,knee:0,elbow:0,gripError:0,dynamics:{case:profile,loading:false,error:source.error??'加载失败',mass:0,power:[0,0,0],totalPower:0,support:[0,0,0,0,0,0],speed:0,muscles:[]}});
   }
  });
  this.notify();
 }
 setPhysicsCase(profile:DynamicsCase){const s=this.dynamicsSource();if(s){this.playing=false;this.loadDynamics(s,profile);}}
 setMotion(id:MotionId,fade=true){
  if(!this.ready)return;
  let source=this.sources.get(id);
  const saved=this.specs.get(id);
  if(!source&&saved?.source?.kind==='document'&&this.rig){source=new DocumentSource(this.rig,saved.source.document,this.racket);this.sources.set(id,source);}
  if(!source)return;
  const previous=this._source,spec=this.specOf(id);
  const skinned=(s?:MotionSource)=>!!s&&s.kind!=='dynamics';
  this.activeId=id;this._source=source;this.time=0;
  if(source instanceof DynamicsSource){
   previous?.deactivate?.();this.fade.clear();this.playing=false;
   this.model!.visible=false;this.racket&&(this.racket.visible=false);
   this.jointGroup.visible=false;this.axesGroup.visible=false;this.targetGroup.visible=false;
   this.skeletonLines&&(this.skeletonLines.visible=false);this.trail&&(this.trail.visible=false);
   this.loadDynamics(source,'baseline');return;
  }
  this.model!.visible=true;
  previous?.deactivate?.();
  // Pose fade applies only between skinned sources; switching to or from a
  // physics replay stays a hard cut, as before.
  if(fade&&previous&&previous!==source&&skinned(previous))this.fade.start(this.rig!);else this.fade.clear();
  source.activate?.();source.seek(this.time);
  this.model!.position.copy(source.modelOffset??ZERO);
  if(this.racket){this.syncRacketSide(source);this.racket.visible=!!spec.capabilities?.prop&&source.wantsProp();}
  this.trailPoints=[];this.previousPosition.set(0,0,0);this.playing=true;this.skinSwap?.resetHair();
  this.controls.target.set(0,.88,0);this.setView(this.view==='hand'?'threeQuarter':this.view);
  this.setDebug(this.debug);this.notify();
 }
 setPlaying(value:boolean){
  if(this.isPhysics){const r=this.physics;if(r?.ready&&this.time>=r.duration-.001&&value)this.time=0;this.playing=value&&!this.physicsLoading;this.notify();return;}
  const src=this._source;
  if(value&&src&&this.time>=src.duration-.001&&this.time>0)this.seek(0);
  this.playing=value;this.notify();
 }
 seek(time:number){
  const src=this._source;if(!src)return;
  if(this.isPhysics){
   if(src.status==='ready'){const r=this.physics!;this.time=Math.max(0,Math.min(r.duration,time));src.seek(this.time);this.notify();}
   return;
  }
  this.fade.clear();
  this.time=Math.max(0,Math.min(src.duration,time));
  src.seek(this.time);
  // Scrubbing resets the accumulated walk offset — same as the old walkOffset.clear on seek.
  src.modelOffset?.set(0,0,0);this.model?.position.copy(src.modelOffset??ZERO);
  this.trailPoints=[];this.updateDebug();this.skinSwap?.resetHair();this.notify();
 }
 replay(){if(this.isPhysics){this.time=0;this.physics?.seek(0);this.playing=!this.physicsLoading;this.notify();return;}this.seek(0);this.playing=true;}
 async setSkin(s:SkinId){
  if(this.skinSwap){await this.skinSwap.set(s);this.skin=this.skinSwap.skin;}else this.skin=s;
  if(this.ready&&this.view!=='free')this.setView(this.view);
 }
 setDebug(patch:Partial<DebugOptions>){
  Object.assign(this.debug,patch);this.skinSwap?.setSurfaceVisible(this.debug.surface);
  if(this.isPhysics){this._source?.setDebug?.(this.debug);return;}
  this.model?.traverse(o=>{if(o instanceof SkinnedMesh)o.visible=this.debug.surface;});
  this.skeletonLines&&(this.skeletonLines.visible=this.debug.skeleton);this.jointGroup.visible=this.debug.skeleton;this.axesGroup.visible=this.debug.axes;this.targetGroup.visible=this.debug.targets;
  if(this.trail)this.trail.visible=this.debug.trail&&!!this.specOf(this.activeId).capabilities?.prop?.trail;this.updateDebug();
 }
 setView(view:ViewId){
  this.view=view;this.onView?.(view);const spec=this.specOf(this.activeId);
  const root=(this.isPhysics&&this.physics?.ready?this._source?.point('Full Body'):this._source?.rootPoint())??new Vector3(0,.94,0),target=root.clone();
  target.y=(spec.capabilities?.camera?.targetHeight??.87)+(this.skin==='ssj'&&!this.isPhysics?.08:0);
  if(view==='free'){const shift=target.clone().sub(this.controls.target);this.camera.position.add(shift);this.controls.target.copy(target);this.previousPosition.copy(root);this.controls.update();this.render();return;}
  if(view==='hand'&&this.rig){
   // The hand view anchors to the wrist the prop is mounted on — physics keeps
   // the lunate anchor; prop-less sources read the default right wrist.
   const wrist=(this.isPhysics&&this.physics?.ready?this._source?.point('lunate_r'):this.rig.point(`wrist_${this._source?.propSide??'R'}`))??this.rig.point('wrist_R');
   target.copy(wrist).add(new Vector3(0,.01,.03));this.camera.position.copy(target).add(new Vector3(-.34,.18,.42));
  }else{
   const distance=Math.max(this.isPhysics?4.15:spec.capabilities?.camera?.distance??3.65,this.skin==='ssj'?3.8:0,2.0/Math.max(.4,this.camera.aspect));
   const angles={front:0,side:Math.PI/2,back:Math.PI,threeQuarter:-Math.PI/4,hand:0,free:0};const a=angles[view];this.camera.position.copy(target).add(new Vector3(Math.sin(a)*distance,.14,Math.cos(a)*distance));
  }
  this.controls.target.copy(target);this.camera.lookAt(target);this.controls.update();this.previousPosition.copy(root);this.render();
 }
 private animate=()=>{
  if(this.disposed)return;this.raf=requestAnimationFrame(this.animate);const dt=Math.min(this.clock.getDelta(),.1);
  this.tick(dt);if(!this.isPhysics)this.skinSwap?.update(dt);this.controls.update();this.anatomy?.update(dt);this.render();
 };
 tick(dt:number){
  const dyn=this.dynamicsSource();
  if(dyn){
   const replay=dyn.physics;
   if(replay?.ready&&dyn.status==='ready'){
    const spec=this.specOf(this.activeId);
    if(this.playing){this.time+=dt*this.speed;if(this.time>=replay.duration){if(this.loop&&!spec.oneShot)this.time%=replay.duration;else{this.time=replay.duration;this.playing=false;}}}
    dyn.seek(this.time);
    const current=replay.point('Full Body'),delta=current.clone().sub(this.previousPosition);delta.y=0;this.controls.target.add(delta);this.camera.position.add(delta);this.previousPosition.copy(current);
    if(this.keyLight){this.keyLight.position.set(current.x-3,5,current.z+4);this.keyLight.target.position.set(current.x,0,current.z);this.keyLight.target.updateMatrixWorld();}
    this.lastNotify+=dt;if(this.lastNotify>.07){this.lastNotify=0;this.notify();}
   }
   return;
  }
  const src=this._source;
  if(!this.ready||!src||!this.model||!this.rig)return;
  const spec=this.specOf(this.activeId);
  const duration=src.duration;
  if(this.playing&&duration>0){
   this.time+=dt*this.speed;
   if(this.time>=duration){
    if(this.loop&&!spec.oneShot){
     // One tick can skip several periods (a long frame at high speed): the
     // playhead wraps modulo duration and the per-wrap side effect — walk's
     // stride accumulation — fires once per crossed period, not once per tick.
     const wraps=Math.floor(this.time/duration);
     this.time%=duration;
     for(let i=0;i<wraps;i++)src.loopWrapAdvance?.();
    }
    else{this.time=duration;this.playing=false;}
   }
  }
  src.seek(this.time);
  this.fade.apply(this.rig,this.playing?dt:0);
  // Only clip sources carry a model offset; non-clip sources can never inherit
  // a stale walk translation because ZERO is copied in.
  this.model.position.copy(src.modelOffset??ZERO);
  // The prop appears/disappears with the grip amount — during the grip ramp it
  // fades in/out rather than snapping, an acceptable semantics for the ramp.
  if(this.racket){this.syncRacketSide(src);this.racket.visible=!!spec.capabilities?.prop&&src.wantsProp();}
  this.model.updateMatrixWorld(true);
  const current=src.rootPoint(),delta=current.clone().sub(this.previousPosition);
  // Camera translation follows locomotion only; Orbit orientation / zoom remain independent.
  if(spec.capabilities?.locomotion==='follow'||this.fade.active){delta.y=0;this.controls.target.add(delta);this.camera.position.add(delta);}
  if(this.view==='hand'){const target=(src.point(`wrist_${src.propSide??'R'}`)??this.rig.point('wrist_R')).add(new Vector3(0,.01,.03)),d=target.clone().sub(this.controls.target);this.controls.target.add(d);this.camera.position.add(d);}
  this.previousPosition.copy(current);if(this.floor){this.floor.position.x=current.x;this.floor.position.z=current.z;}if(this.grid){this.grid.position.x=Math.round(current.x/.25)*.25;this.grid.position.z=Math.round(current.z/.25)*.25;}if(this.keyLight){this.keyLight.position.set(current.x-3,5,current.z+4);this.keyLight.target.position.set(current.x,0,current.z);this.keyLight.target.updateMatrixWorld();}this.updateDebug();
  this.lastNotify+=dt;if(this.lastNotify>.07){this.lastNotify=0;this.notify();}
 }
 private updateDebug(){
  if(this.isPhysics)return;
  if(!this.rig||!this.model)return;this.model.updateMatrixWorld(true);
  if(this.skeletonLines&&this.debug.skeleton){const a=this.skeletonLines.geometry.getAttribute('position');const seg=this.skeletonLines.userData.segments as {name:string;parent:string}[];seg.forEach((b,i)=>{const p=this.rig!.point(b.name),q=this.rig!.point(b.parent);a.setXYZ(i*2,p.x,p.y,p.z);a.setXYZ(i*2+1,q.x,q.y,q.z);});a.needsUpdate=true;}
  for(const group of [this.jointGroup,this.axesGroup,this.targetGroup])if(group.visible)group.children.forEach(o=>{o.position.copy(this.rig!.point(o.userData.bone));if(o instanceof AxesHelper)o.quaternion.copy(this.rig!.bone(o.userData.bone).getWorldQuaternion(new Quaternion()));});
  if(this.trail){this.trail.visible=this.debug.trail&&!!this.specOf(this.activeId).capabilities?.prop?.trail&&!!this.racket?.visible;if(this.trail.visible&&this.playing&&this.racket){const tip=this.racket.localToWorld(RACKET_TIP_LOCAL.clone());if(!this.trailPoints.length||tip.distanceTo(this.trailPoints.at(-1)!)>.005){this.trailPoints.push(tip);if(this.trailPoints.length>200)this.trailPoints.shift();this.trail.geometry.dispose();this.trail.geometry=new BufferGeometry().setFromPoints(this.trailPoints);}}}
 }
 private makeDebug(){
  if(!this.rig)return;
  const segments=skeletonSegments(this.rig.info);
  const geo=new BufferGeometry();geo.setAttribute('position',new Float32BufferAttribute(new Float32Array(segments.length*6),3));
  const lines=new LineSegments(geo,new LineBasicMaterial({color:0x367cff,depthTest:false,transparent:true,opacity:.85}));lines.renderOrder=10;lines.frustumCulled=false;lines.userData.segments=segments;this.skeletonLines=lines;this.scene.add(lines);lines.visible=false;
  const jointGeo=new SphereGeometry(.009,10,8);const jointMat=new MeshStandardMaterial({color:0x225bdb,depthTest:false});
  const names=['root','spine03','spine01','neck01','head',...['L','R'].flatMap(s=>['upperarm01_','lowerarm01_','wrist_','upperleg01_','lowerleg01_','foot_'].map(n=>n+s))];
  for(const n of names){const marker=new Mesh(jointGeo,jointMat);marker.userData.bone=n;marker.renderOrder=11;this.jointGroup.add(marker);const axis=new AxesHelper(.075);axis.userData.bone=n;axis.renderOrder=12;const mat=axis.material as LineBasicMaterial;mat.depthTest=false;this.axesGroup.add(axis);}
  for(const n of ['wrist_R','wrist_L','foot_R','foot_L']){const marker=new Mesh(new SphereGeometry(.017,12,8),new MeshStandardMaterial({color:0xec8c39,depthTest:false,transparent:true,opacity:.8,wireframe:true}));marker.userData.bone=n;marker.renderOrder=13;this.targetGroup.add(marker);this.targetMarkers.set(n,marker);}
  this.trail=new Line(new BufferGeometry(),new LineBasicMaterial({color:0x3069ed,transparent:true,opacity:.6}));this.scene.add(this.trail);this.trail.visible=false;
 }
 resize(){const w=this.host.clientWidth,h=this.host.clientHeight;if(!w||!h)return;this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.renderer.setSize(w,h);}
 diagnostics(){
  if(this.isPhysics&&this.physics?.ready){const p=this.physics;return {knee:p.jointAngle('knee_angle_r'),elbow:p.jointAngle('elbow_flexion_r'),gripError:0,footL:p.point('talus_l').toArray(),footR:p.point('talus_r').toArray(),root:p.point('Full Body').toArray(),vertices:0,bones:p.model.bodies.length,hand:p.point('3proxph_r').toArray()};}
  return this._source?.diagnostics()??null;
 }
 private notify(){
  const spec=this.specOf(this.activeId),time=this.time;
  const phase=[...spec.phases].reverse().find(p=>p.time<=time)?.label??spec.phases[0]?.label??'';
  if(this.isPhysics){
   const replay=this.physics;
   const d=replay?.diagnostics()??{case:this.physicsCase,mass:0,power:[0,0,0],totalPower:0,support:[0,0,0,0,0,0],speed:0,muscles:[]};
   this.onFrame?.({time,duration:this.physicsLoading?spec.duration:replay?.duration??spec.duration,phase,playing:this.playing,knee:replay?.jointAngle('knee_angle_r')??0,elbow:replay?.jointAngle('elbow_flexion_r')??0,gripError:0,dynamics:{...d,loading:this.physicsLoading}});return;
  }
  const src=this._source;if(!src)return;
  const d=src.diagnostics();
  this.onFrame?.({time,duration:src.duration,phase,playing:this.playing,knee:d?.knee??0,elbow:d?.elbow??0,gripError:d?.gripError??0});
 }
 render(){this.renderer.render(this.scene,this.camera);}
 dispose(){this.disposed=true;this.skinSwap?.dispose();this.anatomy?.dispose();this.unbindTheme?.();for(const s of this.sources.values())s.dispose?.();cancelAnimationFrame(this.raf);this.resizeObserver.disconnect();this.controls.dispose();this.mixer?.stopAllAction();this.scene.traverse(o=>{if(o instanceof Mesh||o instanceof LineSegments||o instanceof Line){o.geometry.dispose();const materials=Array.isArray(o.material)?o.material:[o.material];materials.forEach(m=>m.dispose());}});this.renderer.dispose();this.renderer.domElement.remove();}
}
