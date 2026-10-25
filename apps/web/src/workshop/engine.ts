import {webPlatform,type AppPlatform} from '../platform/platform';
import {AmbientLight,BufferGeometry,Color,DirectionalLight,DoubleSide,Float32BufferAttribute,Group,HemisphereLight,Line,LineBasicMaterial,LineDashedMaterial,LineLoop,LineSegments,Mesh,MeshBasicMaterial,MeshStandardMaterial,PerspectiveCamera,Plane,PlaneGeometry,Raycaster,RingGeometry,Scene,SkinnedMesh,SphereGeometry,Vector2,Vector3,WebGLRenderer,PCFSoftShadowMap,SRGBColorSpace,ACESFilmicToneMapping,Clock,GridHelper} from 'three';
import {RACKET_TIP_LOCAL} from '@human3d/motion-core';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {HumanRig,skeletonSegments} from '@human3d/motion-core';
import {attachProp,mountRacket} from '@human3d/motion-core';
import type {RigInfo,ViewId} from '@human3d/motion-core';
import type {CompiledMotion,EffectiveFrame,PoseParams,WorkshopDoc,WorkshopKey} from '@human3d/motion-core';
import {buildPelvisSchedule,compileMotion,contactStartKey,frameAtCompiled,isReleaseKey,parseDoc,serializeDoc,sortedKeys,toV} from '@human3d/motion-core';
import {analyzePose,solveEffectiveFrame,type Analysis} from '@human3d/motion-core';
import type {PelvisSchedule} from '@human3d/motion-core';
import {ankleYForLift,footGeometry,type FootGeometry,type Side} from '@human3d/motion-core';
import {bindSceneBackground} from '../theme/scene-background';
import {applyHeroicShape} from '../theme/shape-preset';
import {SkinSwap,type SkinId} from '../theme/skin-swap';
import {loadAnatomyAtlas} from '../theme/anatomy-skin';
import {AnatomySelection} from '../theme/anatomy-selection';

export interface WorkshopFrame{time:number;duration:number;playing:boolean;label:string;analysis?:Analysis}
export interface WorkshopOptions{handles:boolean;trajectories:boolean;balance:boolean;onion:boolean;onionCount:number;onionMode:'keys'|'step';onionStep:number}
/** Ghost cap per direction: ≤3 keeps even a maxKeys document cheap — keys mode
 * brackets only the ±N keys around the playhead, never the whole timeline. */
export const ONION_MAX=3;
/** Ghost instants for one playhead position. `keys` brackets the playhead with
 * the nearest real key times on each side (strict — the key under the playhead
 * is the live pose, not a ghost); on a loop document the bracket continues
 * across the seam — the previous-cycle tail keys ghost the head of the strip
 * and vice versa. `step` takes t±k·Δt, dropping instants that fall outside
 * [0,duration]. Returned dist is 1 = nearest. */
export function onionTimes(doc:WorkshopDoc,time:number,o:Pick<WorkshopOptions,'onionCount'|'onionMode'|'onionStep'>){
  const out:{time:number;dir:-1|1;dist:number}[]=[];
  const n=Math.max(1,Math.min(ONION_MAX,Math.round(o.onionCount)||1));
  if(o.onionMode==='step'){
    const dt=Math.max(.01,o.onionStep);
    for(let d=1;d<=n;d++){
      if(time-d*dt>=-1e-9)out.push({time:Math.max(0,time-d*dt),dir:-1,dist:d});
      if(time+d*dt<=doc.duration+1e-9)out.push({time:Math.min(doc.duration,time+d*dt),dir:1,dist:d});
    }
    return out;
  }
  const keys=sortedKeys(doc);
  // Walk order: descending away from the playhead on each side. For a loop
  // document the bracket continues across the seam — the "previous" poses of
  // a playhead near 0 are the tail keys' own instants (the sampler wraps the
  // chain the same way), and vice versa. A key already bracketing one side is
  // never duplicated onto the other (degenerate tiny docs).
  const beforeDesc=keys.filter(k=>k.time<time-1e-9).reverse();
  const after=keys.filter(k=>k.time>time+1e-9);
  if(doc.loop){
    // Only the SELECTED keys are taken: wrapping draws from the unused pool —
    // and the key sitting on the playhead stays the live pose, never a ghost.
    const used=new Set([...beforeDesc.slice(0,n),...after.slice(0,n)].map(k=>k.id));
    const free=(k:WorkshopKey)=>Math.abs(k.time-time)>1e-9&&!used.has(k.id);
    for(let i=keys.length-1;i>=0&&beforeDesc.length<n;i--){const k=keys[i];if(free(k)){used.add(k.id);beforeDesc.push(k);}}
    for(let i=0;i<keys.length&&after.length<n;i++){const k=keys[i];if(free(k)){used.add(k.id);after.push(k);}}
  }
  const before=beforeDesc.slice(0,n).reverse(),afterN=after.slice(0,n);
  before.forEach((k,i)=>out.push({time:k.time,dir:-1,dist:before.length-i}));
  afterN.forEach((k,i)=>out.push({time:k.time,dir:1,dist:i+1}));
  return out;
}
/* ---------- fixed-camera render export (WP-D) ---------- */
/** Self-describing still contract: every exported frame is a
 * STILL_WIDTH×STILL_HEIGHT PNG shot through a named camera preset (default
 * CAPTURE_VIEW). Same document + time + view ⇒ same pixels — the live
 * viewport size, device pixel ratio and the user's orbit never leak in. */
export const STILL_WIDTH=640,STILL_HEIGHT=720;
export const CAPTURE_VIEW:ViewId='threeQuarter';
/** Sheet budget: even a maxKeys document must review as one image, so denser
 * timelines are decimated by sheetTimes down to ≤SHEET_MAX_TILES tiles, laid
 * out SHEET_COLS per row with a SHEET_LABEL_H caption band under each tile. */
export const SHEET_MAX_TILES=12,SHEET_COLS=4,SHEET_LABEL_H=28;
/** Uniform decimation pinning both endpoints — the first and last key are the
 * two poses a reviewer least wants dropped. Step >1 when len>max keeps the
 * picks strictly increasing (no duplicate tiles); input order is preserved. */
export function sheetTimes(times:number[],max=SHEET_MAX_TILES):number[]{
  if(times.length<=max)return times.slice();
  const out:number[]=[];
  for(let i=0;i<max;i++)out.push(times[Math.round(i*(times.length-1)/(max-1))]);
  return out;
}
/** `view` picks the camera preset (default CAPTURE_VIEW); `overlays:true`
 * keeps editor furniture (handles, trajectories, contact markers, onion
 * ghosts, CoM/support gizmos) in the image — off by default because a review
 * still must read as the pose itself, not as the editor. */
export interface CaptureOptions{view?:ViewId;overlays?:boolean}
interface CaptureSnapshot{time:number;playing:boolean;view:ViewId;cam:Vector3;target:Vector3;ratio:number;overlays:{handles:boolean;trajectories:boolean[];contacts:boolean[];onion:boolean[];balance:boolean[]}|null}
/** Re-entrancy mutex for export captures: a second programmatic capture must
 * refuse outright — two interleaved captures would snapshot and restore
 * transport/camera/overlay state in the wrong order (the UI also disables
 * the export buttons, but engine calls are not limited to those buttons).
 * `run` owns the flag so a rejection or throw always releases it. */
export class CaptureMutex{
 private busy=false;
 get held(){return this.busy;}
 run<T>(fn:()=>Promise<T>):Promise<T>{
  if(this.busy)return Promise.reject(new Error('已有导出任务进行中'));
  this.busy=true;
  // Defer fn into the promise chain: a synchronously throwing fn still lands
  // in .finally instead of wedging busy forever.
  return Promise.resolve().then(fn).finally(()=>{this.busy=false;});
 }
}
type DragKind='root'|'hand'|'foot'|'swing'|'poleArm'|'poleLeg'|'tip'|'contact';
/** `passive` handles render but never start a drag — used for the actual foot
 * during a release interval, where the editable control is the swing point. */
interface Handle{kind:DragKind;side?:'L'|'R';mesh:Mesh;keyId?:string;passive?:boolean}

/** Pose-editor scene: same rig and view language as the lab viewer, but every
 * effector is a draggable task-space handle resolved by the kinematic solver. */
export class WorkshopEngine{
  scene=new Scene();camera=new PerspectiveCamera(35,1,.01,120);renderer:WebGLRenderer;controls:OrbitControls;
  model?:Group;rig?:HumanRig;racket?:Group;ready=false;disposed=false;
  anatomy?:AnatomySelection;
  private skinSwap?:SkinSwap;
  playing=true;speed=1;time=0;view:ViewId='threeQuarter';
  /** Review mode (false) hides handles and refuses every pointer pick, so a
   * camera gesture can never write the document (issue #23 PR-A). */
  editable=true;
  options:WorkshopOptions={handles:true,trajectories:true,balance:true,onion:false,onionCount:2,onionMode:'keys',onionStep:.1};
  private clock=new Clock();private raf=0;private lastNotify=0;private resizeObserver:ResizeObserver;private unbindTheme?:()=>void;
  private keyLight?:DirectionalLight;
  private handleGroup=new Group();private handles:Handle[]=[];private contactMarkers:Mesh[]=[];
  private trajectories=new Map<string,Line>();private comMarker?:Mesh;private comLine?:Line;private supportLoop?:LineLoop;
  /** Onion-skin ghosts: 2×ONION_MAX line skeletons, slots [0..2]=past,
   * [3..5]=future by distance. userData.onion={dir,dist} for QA inspection. */
  private onionLines:LineSegments[]=[];private onionSegs:{name:string;parent:string}[]=[];
  private onionSig='';private onionStale=true;
  private raycaster=new Raycaster();private pointer=new Vector2();
  private drag?:{h:Handle;plane:Plane;offset:Vector3;key:WorkshopKey};private docDirty=true;
  private deferPelvisSchedule=false;
  /* Compiled-snapshot cache (issue #10 PR-B): one slot, keyed by document
   * identity + content version + compile origin — all three must match.
   * `docVer` is a SEPARATE counter from docDirty: docDirty flags aux-overlay
   * rebuilds, docVer invalidates the frozen sampling snapshot. Contract:
   * every doc-content mutation must reach markDirty() (which bumps docVer)
   * or an explicit bump site — a missed signal was already a latent
   * stale-trajectory bug, but the snapshot widens the blast radius to the
   * live pose itself, so the two pointer handlers below bump where doc.keys
   * changes bypass markDirty. Doc-object swaps (undo write-back, the
   * captureSheet frozen provider, selectDoc) need no bump — identity catches
   * them; a mid-sheet real-doc edit can cost ≤SHEET_MAX_TILES extra compiles
   * of the frozen doc, correctness intact. */
  private compiled?:{doc:WorkshopDoc;ver:number;c:CompiledMotion};
  private pelvis?:{doc:WorkshopDoc;ver:number;schedule:PelvisSchedule};
  private docVer=0;
  private compiledFor(doc:WorkshopDoc){
   const e=this.compiled;
   if(e&&e.doc===doc&&e.ver===this.docVer&&e.c.origin.equals(this.restRoot()))return e.c;
   const c=compileMotion(doc,this.restRoot());this.compiled={doc,ver:this.docVer,c};return c;
  }
  /** Read as "a still/sheet capture is in flight". The animate loop consults
   * it wherever it re-derives overlay visibility (rebuildAux, updateOnion,
   * updateBalance), so overlays hidden for the shot can't be resurrected
   * between the awaits of a multi-tile sheet; it also blocks a mid-capture
   * pointerdown on the canvas from starting a drag.
   *
   * Backed by a DEPTH count, not a bare boolean: a contact sheet nests its
   * per-tile captures inside one outer session, so the flag must only fall
   * when the LAST session ends — a per-tile endCapture that dropped it would
   * reopen the overlay/drag windows between tiles. */
  private captureDepth=0;
  private get capturing(){return this.captureDepth>0;}
  /** Hard re-entry gate for programmatic callers — see CaptureMutex. */
  private readonly captureMutex=new CaptureMutex();
  private latestFrame?:EffectiveFrame;
  private footGeo?:Record<Side,FootGeometry>;
  /** The wrist the racket is currently mounted on — remounted when a solve
   * carries a different gripSide than the last mount (doc edits, doc switch). */
  private racketSide:'L'|'R'='R';
  onFrame?:(f:WorkshopFrame)=>void;onReady?:(info:RigInfo)=>void;onError?:(e:Error)=>void;
  /** App hooks: begin edit = pick or auto-insert the key being dragged. */
  onBeginEdit?:(time:number,prefer?:string)=>WorkshopKey|null;
  onDocChanged?:()=>void;onSelectKey?:(id:string)=>void;onSeek?:(time:number)=>void;
  /** Fired once when a drag ends — the app persists the doc here so the final
   * pose can't be lost between pointermove re-renders. */
  onEditEnd?:()=>void;
  constructor(public host:HTMLElement,private getDoc:()=>WorkshopDoc,private platform:AppPlatform=webPlatform){
    this.renderer=new WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});
    // Mobile profile: touch-first devices render at ≤1.5× and a 1024² shadow
    // map. shortcut: chosen from GPU-fill reasoning, not a device benchmark; tune after real-device measurement.
    const coarse=this.platform.coarse;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio,coarse?1.5:2));this.renderer.outputColorSpace=SRGBColorSpace;this.renderer.toneMapping=ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.12;
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label','动作工作台三维编辑视图');this.host.appendChild(this.renderer.domElement);
    this.unbindTheme=bindSceneBackground(this.scene,this.platform);this.scene.add(new HemisphereLight(0xffffff,0x8592a6,2.5),new AmbientLight(0xffffff,.35));
    const key=new DirectionalLight(0xfff6ec,4.2);key.position.set(-3,5,4);key.castShadow=true;key.shadow.mapSize.setScalar(coarse?1024:2048);key.shadow.camera.left=-3;key.shadow.camera.right=3;key.shadow.camera.top=3;key.shadow.camera.bottom=-3;key.shadow.normalBias=.012;key.shadow.bias=-.0001;this.scene.add(key,key.target);this.keyLight=key;
    const fill=new DirectionalLight(0xc3d9ff,2);fill.position.set(3,2,-3);this.scene.add(fill);
    const floor=new Mesh(new PlaneGeometry(200,200),new MeshStandardMaterial({color:0xf4f6f9,roughness:1,metalness:0}));floor.rotation.x=-Math.PI/2;floor.position.y=-.009;floor.receiveShadow=true;this.scene.add(floor);
    const grid=new GridHelper(200,800,0xc3cbd5,0xd8dfe8);grid.position.y=-.007;(grid.material as LineBasicMaterial).transparent=true;(grid.material as LineBasicMaterial).opacity=.34;this.scene.add(grid);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=true;this.controls.dampingFactor=.08;this.controls.target.set(0,.9,0);this.controls.minDistance=.3;this.controls.maxDistance=8;this.controls.maxPolarAngle=Math.PI*.52;this.camera.position.set(0,1.15,3.4);
    this.controls.addEventListener('start',()=>{this.view='free';});
    this.scene.add(this.handleGroup);
    const dom=this.renderer.domElement;
    dom.addEventListener('pointerdown',this.onPointerDown);dom.addEventListener('pointermove',this.onPointerMove);dom.addEventListener('pointerup',this.onPointerUp);dom.addEventListener('pointercancel',this.onPointerUp);
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(host);this.resize();
    this.animate();
  }
  async load(){
    try{
      const [gltf,info,atlas]=await Promise.all([new GLTFLoader().loadAsync(this.platform.assetUrl('/models/human.glb')),this.platform.fetchAsset('/models/rig.json').then(r=>{if(!r.ok)throw new Error('人体骨架加载失败');return r.json() as Promise<RigInfo>}),loadAnatomyAtlas(this.platform)]);
      if(this.disposed){atlas.dispose();gltf.scene.traverse(o=>{if(o instanceof Mesh)o.geometry.dispose()});return;}
      this.model=gltf.scene;this.scene.add(this.model);this.rig=new HumanRig(this.model,info);applyHeroicShape(this.model);
      this.anatomy=new AnatomySelection(this.host,this.renderer.domElement,this.camera,atlas,event=>this.capturing||!this.ready||!!this.drag||!!this.pick(event));
      this.model.traverse(o=>{if(o instanceof SkinnedMesh){o.castShadow=true;o.receiveShadow=true;o.frustumCulled=false;this.anatomy!.add(o);}});
      this.skinSwap=new SkinSwap(this.model,this.platform);await this.skinSwap.set(this.skin);if(this.disposed)return;
      this.racket=attachProp(this.rig,'racket',this.getDoc().gripSide==='L'?'L':'R');this.racketSide=this.getDoc().gripSide==='L'?'L':'R';this.racket.visible=false;
      this.footGeo={L:footGeometry(this.rig.rest,'L'),R:footGeometry(this.rig.rest,'R')};
      this.makeHandles();this.makeMarkers();this.makeOnion();
      this.ready=true;this.solveCurrent();this.setView('threeQuarter');this.onReady?.(info);
    }catch(err){this.onError?.(err instanceof Error?err:new Error(String(err)));}
  }
  /* ---------- handles ---------- */
  private makeHandles(){
    const mk=(kind:DragKind,side:'L'|'R'|undefined,color:number,r:number)=>{
      const m=new Mesh(new SphereGeometry(r,16,12),new MeshStandardMaterial({color,depthTest:false,transparent:true,opacity:.92}));
      m.renderOrder=20;m.userData.handle=true;this.handleGroup.add(m);const h:Handle={kind,side,mesh:m};this.handles.push(h);m.userData.ref=h;return h;
    };
    mk('root',undefined,0x2469ee,.034);
    mk('hand','L',0xec8c39,.026);mk('hand','R',0xec8c39,.026);
    mk('foot','L',0xe2543a,.026);mk('foot','R',0xe2543a,.026);
    mk('swing','L',0x0891b2,.02);mk('swing','R',0x0891b2,.02);
    mk('poleArm','L',0x4a9e6b,.018);mk('poleArm','R',0x4a9e6b,.018);
    mk('poleLeg','L',0x4a9e6b,.018);mk('poleLeg','R',0x4a9e6b,.018);
    mk('tip',undefined,0xd23c3c,.024);
  }
  private makeMarkers(){
    this.comMarker=new Mesh(new SphereGeometry(.018,14,10),new MeshStandardMaterial({color:0x8a2be2,depthTest:false,transparent:true,opacity:.9}));this.comMarker.renderOrder=18;
    this.comLine=new Line(new BufferGeometry(),new LineDashedMaterial({color:0x8a2be2,dashSize:.03,gapSize:.02,depthTest:false}));this.comLine.renderOrder=17;this.comLine.frustumCulled=false;
    this.supportLoop=new LineLoop(new BufferGeometry(),new LineBasicMaterial({color:0x8a2be2,depthTest:false}));this.supportLoop.renderOrder=17;this.supportLoop.frustumCulled=false;
    this.scene.add(this.comMarker,this.comLine,this.supportLoop);
    for(const [id,color]of [['tip',0xd23c3c],['wrist_R',0xec8c39],['wrist_L',0xec8c39]]as const){
      const line=new Line(new BufferGeometry(),new LineBasicMaterial({color,transparent:true,opacity:.55}));line.frustumCulled=false;this.scene.add(line);this.trajectories.set(id,line);
    }
  }
  /** Ghost skeletons are plain LineSegments (never a cloned SkinnedMesh): one
   * per direction×distance slot, sharing the lab debug skeleton's segment
   * table so the bone list can't drift. Past = cool, future = warm, opacity
   * decays with distance; depthTest off, renderOrder below the handles (8 vs
   * 20), and they stay out of the pick set by living on the scene root. */
  private makeOnion(){
    if(!this.rig)return;
    this.onionSegs=skeletonSegments(this.rig.info);
    for(const dir of [-1,1]as const)for(let dist=1;dist<=ONION_MAX;dist++){
      const geo=new BufferGeometry();geo.setAttribute('position',new Float32BufferAttribute(new Float32Array(this.onionSegs.length*6),3));
      const line=new LineSegments(geo,new LineBasicMaterial({color:dir<0?0x367cff:0xe2543a,depthTest:false,transparent:true,opacity:.4*(1-(dist-1)*.25)}));
      line.renderOrder=8;line.frustumCulled=false;line.visible=false;line.userData.onion={dir,dist};
      this.scene.add(line);this.onionLines.push(line);
    }
  }
  /** Foot geometry from the loaded rig (sole offsets for lift and clearance). */
  footGeometry(side:Side){return this.footGeo?.[side];}
  /* ---------- pointer / drag ---------- */
  private pick(ev:PointerEvent){
    const rect=this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((ev.clientX-rect.left)/rect.width)*2-1,-((ev.clientY-rect.top)/rect.height)*2+1);
    this.raycaster.setFromCamera(this.pointer,this.camera);
    const hits=this.raycaster.intersectObjects([...this.handleGroup.children,...this.contactMarkers].filter(o=>o.visible),false);
    const o=hits.find(x=>!x.object.userData.ref?.passive)?.object;if(o)return o.userData.ref as Handle|undefined;
    // Touch hit proxy: a fingertip cannot land on a 2 cm sphere, so the
    // nearest active handle within 28 CSS px on screen wins. Geometry is untouched.
    if(ev.pointerType!=='touch')return undefined;
    let best:Handle|undefined,bestD=28;
    for(const obj of [...this.handleGroup.children,...this.contactMarkers]){
      const h=obj.userData.ref as Handle|undefined;if(!obj.visible||!h||h.passive)continue;
      const p=obj.getWorldPosition(new Vector3()).project(this.camera);if(p.z>1)continue;
      const d=Math.hypot((p.x+1)/2*rect.width-(ev.clientX-rect.left),(1-p.y)/2*rect.height-(ev.clientY-rect.top));
      if(d<bestD){bestD=d;best=h;}
    }
    return best;
  }
  setEditable(v:boolean){
    this.editable=v;
    if(!v&&this.drag){this.drag=undefined;this.controls.enabled=true;this.onEditEnd?.();}
    for(const m of this.contactMarkers)m.visible=v&&!this.capturing;
    if(this.latestFrame)this.updateHandles(this.latestFrame);
  }
  private onPointerDown=(ev:PointerEvent)=>{
    // Non-primary pointers (a second finger) belong to the camera gesture.
    if(ev.button!==0||!ev.isPrimary||!this.editable||!this.ready||this.capturing)return;
    const h=this.pick(ev);if(!h)return;
    const doc=this.getDoc();
    const time=h.keyId?doc.keys.find(k=>k.id===h.keyId)?.time??this.time:this.time;
    // A planted foot is one contact: its target lives on the run-start key,
    // so the drag edits that key (not an unrelated key at the current time).
    let prefer=h.keyId;
    if(h.kind==='foot'&&h.side&&this.frameAtTime(doc,this.time).constraints[h.side==='L'?'plantL':'plantR']){
      prefer=contactStartKey(doc,h.side,this.time)?.id??prefer;
    }
    const key=this.onBeginEdit?.(time,prefer);if(!key)return;
    /* onBeginEdit → ensureKey can insert a key into doc.keys in place — a
     * doc-content mutation the markDirty signal never sees (the app callback
     * saves but does not mark). Bump so the snapshot recompiles before the
     * solve below samples the new key chain. */
    this.docVer++;
    if(h.keyId){this.time=key.time;this.onSeek?.(key.time);this.onSelectKey?.(key.id);}else this.onSelectKey?.(key.id);
    this.solveCurrent();
    const origin=h.mesh.getWorldPosition(new Vector3());
    const normal=new Vector3();this.camera.getWorldDirection(normal);
    // A planted foot is a contact — dragging stays on the ground plane. An
    // unplanted foot is a swing waypoint: drag in the camera-facing plane so
    // the stored target can carry real height.
    const planted=h.kind==='foot'&&key.constraints[h.side==='L'?'plantL':'plantR'];
    const plane=planted
      ?new Plane(new Vector3(0,1,0),-origin.y)
      :new Plane().setFromNormalAndCoplanarPoint(normal,origin);
    const hit=this.raycaster.ray.intersectPlane(plane,new Vector3())??origin;
    this.drag={h,plane,offset:origin.clone().sub(hit),key};
    this.setPlaying(false); // editing a pose while playback moves time is incoherent
    this.controls.enabled=false;try{this.renderer.domElement.setPointerCapture(ev.pointerId);}catch{/* synthetic events have no pointer */}
  };
  private onPointerMove=(ev:PointerEvent)=>{
    if(!this.drag||!ev.isPrimary||!this.rig||this.capturing)return;
    const rect=this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((ev.clientX-rect.left)/rect.width)*2-1,-((ev.clientY-rect.top)/rect.height)*2+1);
    this.raycaster.setFromCamera(this.pointer,this.camera);
    const hit=this.raycaster.ray.intersectPlane(this.drag.plane,new Vector3());if(!hit)return;
    const pos=hit.add(this.drag.offset),k=this.drag.key.pose;
    switch(this.drag.h.kind){
      case 'root':{const rest=this.rig.rest.get('root')!;k.root={x:pos.x-rest.x,y:pos.y-rest.y,z:pos.z-rest.z};break;}
      case 'hand':{(this.drag.h.side==='L'?k.handL:k.handR).target={x:pos.x,y:pos.y,z:pos.z};break;}
      case 'foot':{const side=this.drag.h.side!;const f=side==='L'?k.footL:k.footR;
        const lock=this.drag.key.constraints[side==='L'?'plantL':'plantR'];
        f.target={x:pos.x,y:lock?f.target.y:this.minAnkleY(side,f,pos.y),z:pos.z};break;}
      case 'swing':{const side=this.drag.h.side!;const f=side==='L'?k.footL:k.footR;f.target={x:pos.x,y:this.minAnkleY(side,f,pos.y),z:pos.z};break;}
      case 'poleArm':{(this.drag.h.side==='L'?k.handL:k.handR).pole={x:pos.x,y:pos.y,z:pos.z};break;}
      case 'poleLeg':{(this.drag.h.side==='L'?k.footL:k.footR).pole={x:pos.x,y:pos.y,z:pos.z};break;}
      case 'tip':case 'contact':{
        if(!this.racket)break;this.solveCurrent();
        const tip=this.racket.localToWorld(RACKET_TIP_LOCAL.clone());
        const d=pos.clone().sub(tip),h=this.getDoc().gripSide==='L'?k.handL:k.handR;
        const t=h.target;h.target={x:t.x+d.x,y:t.y+d.y,z:t.z+d.z};break;}
    }
    /* Every mutating switch branch above wrote the drag key's pose in place.
     * The bump lands AFTER the tip/contact branch's own solveCurrent (which
     * must still see the pre-move snapshot to place the racket tip) and
     * BEFORE this final one; unconditional is simpler than enumerating the
     * branches and safe on a no-op move — the snapshot recompiles lazily on
     * the next frameAtTime, not here. */
    this.docVer++;
    this.solveCurrent();this.docDirty=true;this.onDocChanged?.();
  };
  private onPointerUp=(ev:PointerEvent)=>{
    if(this.drag){this.drag=undefined;this.controls.enabled=true;try{this.renderer.domElement.releasePointerCapture(ev.pointerId);}catch{/* released */}this.solveCurrent();this.onEditEnd?.();}
  };
  /* ---------- pose evaluation ---------- */
  /** Pelvis hand-frame origin: the rest root, the same origin the solver uses.
   * Public so callers sampling poses (e.g. auto-key) use the identical frame. */
  restRoot(){return this.rig?.rest.get('root')??new Vector3();}
  private frameAtTime(doc:WorkshopDoc,t:number){return frameAtCompiled(this.compiledFor(doc),t);}
  private currentFrame(){
    const doc=this.getDoc();
    return this.frameAtTime(doc,Math.max(0,Math.min(doc.duration,this.time)));
  }
  /** Shift schedule for the current document version. Rebuilt when the doc
   * content changes; admissible documents leave the historical solve untouched. */
  private scheduleFor(doc:WorkshopDoc){
    const ver=this.docVer;
    if(this.pelvis&&this.pelvis.doc===doc&&this.pelvis.ver===ver)return this.pelvis.schedule;
    const schedule=buildPelvisSchedule(this.rig!,this.compiledFor(doc));
    this.pelvis={doc,ver,schedule};
    return schedule;
  }
  /** Solve an effective frame; support fades, the grip ramp and the clavicle
   * assist come from the sampler, not the key flags. `t` selects the pelvis
   * shift on a folding document. */
  private solveFrame(f:EffectiveFrame,t:number){
    if(!this.rig)return;
    /* During a pointer transaction the current pose remains responsive, but
     * the full 120 Hz schedule is rebuilt only once the edit is committed.
     * Keep using the last schedule for this same document while it is stale:
     * dropping it mid-gesture would switch back to per-frame pelvis solving,
     * then switch forward again on pointer-up. */
    const doc=this.getDoc();
    const schedule=this.drag||this.deferPelvisSchedule
      ?(this.pelvis?.doc===doc?this.pelvis.schedule:undefined)
      :this.scheduleFor(doc);
    solveEffectiveFrame(this.rig,f,schedule&&!schedule.passthrough?schedule.at(t):undefined);
    /* Remount on side change — the frame carries the doc's gripSide, and the
     * mount is a constant per document, so this fires at most once per edit
     * (here, the one place every solve path funnels through, trajectory and
     * ghost sampling included). */
    const side=f.gripSide==='L'?'L':'R';
    if(this.racket&&side!==this.racketSide){mountRacket(this.rig,this.racket,side);this.racketSide=side;}
  }
  /** The pelvis shift the viewport solves time `t` with (undefined = argmin). */
  pelvisShiftAt(t:number){
    if(!this.rig)return undefined;
    const s=this.scheduleFor(this.getDoc());return s.passthrough?undefined:s.at(t);
  }
  /** Lowest ankle height keeping the sole on or above the rest sole plane. */
  private minAnkleY(side:Side,f:{yaw:number;pitch:number},y:number){
    const g=this.footGeo?.[side];
    return g?Math.max(y,ankleYForLift(g,0,f.yaw,f.pitch)):Math.max(0,y);
  }
  solveCurrent(){
    if(!this.rig)return;
    const doc=this.getDoc();
    const t=Math.max(0,Math.min(doc.duration,this.time));
    const f=this.frameAtTime(doc,t);
    this.solveFrame(f,t);
    this.latestFrame=f;
    if(this.racket)this.racket.visible=f.gripAmount>0;
    this.updateHandles(f);
  }
  private updateHandles(f:EffectiveFrame){
    if(!this.rig)return;
    const p=f.pose,doc=this.getDoc();
    const put=(kind:DragKind,side:'L'|'R'|undefined,where:Vector3,visible=true)=>{
      const h=this.handles.find(x=>x.kind===kind&&x.side===side);if(!h)return;h.mesh.visible=visible&&this.options.handles&&this.editable;h.mesh.position.copy(where);
    };
    put('root',undefined,this.rig.point('root'));
    put('hand','L',this.rig.point('wrist_L'));put('hand','R',this.rig.point('wrist_R'));
    put('foot','L',this.rig.point('foot_L'));put('foot','R',this.rig.point('foot_R'));
    put('poleArm','L',toV(p.handL.pole));put('poleArm','R',toV(p.handR.pole));
    put('poleLeg','L',toV(p.footL.pole));put('poleLeg','R',toV(p.footR.pole));
    put('tip',undefined,this.racket?this.racket.localToWorld(RACKET_TIP_LOCAL.clone()):new Vector3(),f.gripAmount>0);
    // Swing waypoint split: during a release interval the visible foot sits ON
    // the path contact→waypoint→landing, so the bone handle becomes display
    // only and the editable control is a separate handle bound to the release
    // key's stored target — the mid-swing waypoint the foot passes through.
    // Without it a drag would write the stored target while the handle stayed
    // glued to the inherited contact (no visual feedback).
    const keys=sortedKeys(doc),i=f.keyIndex;
    for(const [foot,side]of [['footL','L'],['footR','R']]as const){
      const release=isReleaseKey(doc,i,side);
      const bone=this.handles.find(x=>x.kind==='foot'&&x.side===side),sw=this.handles.find(x=>x.kind==='swing'&&x.side===side);
      if(bone)bone.passive=release;
      if(sw){sw.mesh.visible=release&&this.options.handles&&this.editable;if(release){sw.keyId=keys[i].id;sw.mesh.position.copy(toV(keys[i].pose[foot].target));}}
    }
  }
  private rebuildAux(){
    if(!this.rig)return;
    const doc=this.getDoc(),keys=sortedKeys(doc);
    const save=this.frameAtTime(doc,this.time);
    // Trajectory lines at 60 samples.
    const samples=60,paths:Record<string,Vector3[]>={tip:[],wrist_R:[],wrist_L:[]};
    for(let i=0;i<=samples;i++){
      const sampleT=i/samples*doc.duration;
      const f=this.frameAtTime(doc,sampleT);
      this.solveFrame(f,sampleT);
      paths.wrist_R.push(this.rig.point('wrist_R'));paths.wrist_L.push(this.rig.point('wrist_L'));
      // No grip → no racket: skipping the sample keeps non-grip stretches out
      // of the tip line instead of writing the world origin into the path.
      if(f.gripAmount>0&&this.racket)paths.tip.push(this.racket.localToWorld(RACKET_TIP_LOCAL.clone()));
    }
    for(const [id,line]of this.trajectories){
      const pts=paths[id]??[];
      line.geometry.dispose();line.geometry=new BufferGeometry().setFromPoints(pts);
      // `capturing` wins over the option: a pending docDirty rebuild during a
      // still/sheet export must not re-show editor overlays mid-capture.
      line.visible=!this.capturing&&this.options.trajectories&&(id!=='tip'||keys.some(k=>k.constraints.grip));
    }
    // Contact markers: racket-head position at each contact key.
    for(const m of this.contactMarkers){this.scene.remove(m);m.geometry.dispose();}
    this.contactMarkers=[];
    for(const k of keys.filter(k2=>k2.constraints.contact)){
      const f=this.frameAtTime(doc,k.time);this.solveFrame(f,k.time);
      const at=this.racket?this.racket.localToWorld(RACKET_TIP_LOCAL.clone()):new Vector3();
      const ball=new Mesh(new SphereGeometry(.022,16,12),new MeshStandardMaterial({color:0xf0b429,depthTest:false,transparent:true,opacity:.95}));
      ball.position.copy(at);ball.renderOrder=21;
      const ring=new Mesh(new RingGeometry(.035,.042,28),new MeshBasicMaterial({color:0xf0b429,side:DoubleSide,depthTest:false,transparent:true,opacity:.8}));
      ring.rotation.x=-Math.PI/2;ring.renderOrder=21;ball.add(ring);
      const h:Handle={kind:'contact',mesh:ball,keyId:k.id};ball.userData.ref=h;ball.userData.handle=true;
      ball.visible=!this.capturing&&this.editable; // rebuilt markers default visible — keep them out of an in-flight capture
      this.contactMarkers.push(ball);this.scene.add(ball);
    }
    /* INVARIANT (issue #10 PR-C): no reader or render can observe the rig
     * between here and the solveCurrent() that ALWAYS follows rebuildAux in
     * animate() — updateOnion is the only statement in between and it either
     * early-returns without touching the rig or re-solves ghosts itself.
     * solveCurrent re-solves this same playhead frame and re-sets
     * racket.visible/handles, so the old solveFrame(save) restore was pure
     * duplicate work. Keep latestFrame=save: nothing reads it mid-tick, but
     * the field must describe the playhead frame, not the last aux sample. */
    this.latestFrame=save;
    this.docDirty=false;
    // The document behind the ghost poses may have changed even when the
    // ghost instants did not — flag the next updateOnion to re-solve.
    this.onionStale=true;
  }
  /** Re-solve ghost poses only when their instant signature changes, or when
   * rebuildAux flagged a document edit. Every ghost goes through the same
   * frameAt+solveEffectiveFrame path as the trajectory sampler and records
   * each bone's world position; the playhead pose is restored by the
   * solveCurrent() that always follows this call in animate(). */
  private updateOnion(){
    // Captures pin ghosts hidden but keep the signature cache — the first
    // post-capture frame resumes without a needless re-solve.
    if(this.capturing){for(const l of this.onionLines)l.visible=false;return;}
    if(!this.options.onion||!this.rig){for(const l of this.onionLines)l.visible=false;this.onionSig='';this.onionStale=false;return;}
    const doc=this.getDoc(),times=onionTimes(doc,this.time,this.options);
    const sig=[this.options.onionMode,this.options.onionCount,this.options.onionStep,times.map(t=>`${t.dir}${t.dist}@${t.time.toFixed(6)}`).join(',')].join('|');
    if(sig===this.onionSig&&!this.onionStale)return;
    for(const l of this.onionLines)l.visible=false;
    for(const t of times){
      const line=this.onionLines[t.dir<0?t.dist-1:ONION_MAX+t.dist-1];if(!line)continue;
      this.solveFrame(this.frameAtTime(doc,t.time),t.time);
      const a=line.geometry.getAttribute('position');
      this.onionSegs.forEach((b,i)=>{const p=this.rig!.point(b.name),q=this.rig!.point(b.parent);a.setXYZ(i*2,p.x,p.y,p.z);a.setXYZ(i*2+1,q.x,q.y,q.z);});
      a.needsUpdate=true;line.visible=true;
    }
    /* INVARIANT (issue #10 PR-C): animate() calls solveCurrent() immediately
     * after updateOnion with nothing in between — no render, handle, or
     * analysis can observe the last ghost pose — so restoring the playhead
     * solve here was duplicate work. (PR-C removed the final solveFrame.) */
    this.onionSig=sig;this.onionStale=false;
  }
  private updateBalance(a:Analysis){
    if(!this.comMarker||!this.comLine||!this.supportLoop)return;
    const on=this.options.balance&&!this.capturing;
    this.comMarker.visible=on;this.comLine.visible=on;
    this.comMarker.position.copy(a.com);
    this.comLine.geometry.dispose();this.comLine.geometry=new BufferGeometry().setFromPoints([a.com,new Vector3(a.com.x,0,a.com.z)]);
    (this.comMarker.material as MeshStandardMaterial).color.set(a.comStable?0x8a2be2:0xd23c3c);
    this.supportLoop.visible=on&&a.support.length>=3;
    if(a.support.length>=3){this.supportLoop.geometry.dispose();this.supportLoop.geometry=new BufferGeometry().setFromPoints(a.support.map(p=>new Vector3(p.x,.002,p.z)));}
  }
  /* ---------- transport / camera ---------- */
  seek(t:number){const d=this.getDoc().duration;this.time=Math.max(0,Math.min(d,t));this.solveCurrent();this.skinSwap?.resetHair();this.notify(true);}
  beginInteractiveEdit(){this.deferPelvisSchedule=true;}
  endInteractiveEdit(){if(!this.deferPelvisSchedule)return;this.deferPelvisSchedule=false;this.solveCurrent();}
  setPlaying(v:boolean){this.playing=v;this.notify(true);}
  setSpeed(v:number){this.speed=v;}
  /* Display flags only — NOT doc content, so deliberately no docVer bump:
   * the compiled snapshot stays valid (aux overlays rebuild on docDirty). */
  skin:SkinId='default';
  async setSkin(s:SkinId){
    if(this.skinSwap){await this.skinSwap.set(s);this.skin=this.skinSwap.skin;}else this.skin=s;
    if(this.ready&&this.view!=='free')this.setView(this.view);
  }
  setOptions(patch:Partial<WorkshopOptions>){Object.assign(this.options,patch);this.docDirty=true;}
  /** The single funnel every doc-mutating app path already calls
   * (edit/applyDoc/selectDoc/createDoc/removeDoc/mirror/importDoc/
   * undo-redo/onRetime/stampVideo/addKey) — docDirty for the aux rebuild,
   * docVer for the compiled snapshot. */
  markDirty(){this.docDirty=true;this.docVer++;}
  setView(view:ViewId){
    this.view=view;const root=this.rig?.point('root')??new Vector3(0,.94,0),target=root.clone();target.y=target.y*.92+(this.skin==='ssj'?.08:0);
    if(view==='free'){const shift=target.clone().sub(this.controls.target);this.camera.position.add(shift);this.controls.target.copy(target);this.controls.update();return;}
    const distance=Math.max(this.skin==='ssj'?3.8:3.4,2.0/Math.max(.4,this.camera.aspect));
    const a={front:0,side:Math.PI/2,back:Math.PI,threeQuarter:-Math.PI/4,hand:0,free:0}[view];
    this.camera.position.copy(target).add(new Vector3(Math.sin(a)*distance,.18,Math.cos(a)*distance));
    this.controls.target.copy(target);this.camera.lookAt(target);this.controls.update();
  }
  resize(){const w=this.host.clientWidth,h=this.host.clientHeight;if(!w||!h)return;this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.renderer.setSize(w,h);}
  /* ---------- fixed-camera render export ---------- */
  /** Render the pose at `t` to a fixed-size PNG (STILL_WIDTH×STILL_HEIGHT)
   * through a fixed camera preset — deterministic output parameters: the
   * same document + time + view + skin always produce the same image, independent
   * of the live viewport and the user's orbit.
   *
   * Flow: pause → snapshot transport/camera/overlay visibility → seek(t) +
   * solve + render + toBlob inside one task → restore everything.
   * `preserveDrawingBuffer:true` is already on, so toBlob (which snapshots at
   * call time) reliably reads back the frame we just rendered.
   *
   * Overlay policy: a still is for pose review, so editor furniture — drag
   * handles, trajectory lines, contact markers, onion ghosts, CoM/support
   * gizmos — is hidden by default (`opts.overlays:true` keeps it). Hiding
   * toggles Object3D.visible directly, deliberately NOT through
   * WorkshopOptions/docDirty: an export must not trigger rebuildAux and its
   * document-level side effects. Between the awaits of a captureSheet the
   * `capturing` hold (a depth count — the sheet's outer session keeps it
   * raised through every inter-tile gap and the sheet's own toBlob) keeps
   * the animate loop from re-showing them, and the CaptureMutex refuses a
   * second programmatic capture outright instead of interleaving state. */
  async captureStill(t:number,opts:CaptureOptions={}):Promise<Blob>{
    if(!this.ready||!this.rig)throw new Error('模型尚未加载完成，无法渲染静帧');
    return this.captureMutex.run(()=>this.renderStill(t,opts));
  }
  /** captureStill's render path without the mutex — a contact sheet already
   * holds the gate, so its per-tile stills re-enter through here. */
  private async renderStill(t:number,opts:CaptureOptions):Promise<Blob>{
    const saved=this.beginCapture(opts);
    try{
      this.seek(t);this.solveCurrent();this.skinSwap?.settleHair();
      this.setView(opts.view??CAPTURE_VIEW);
      this.renderer.render(this.scene,this.camera);
      const blob=await new Promise<Blob|null>(res=>this.renderer.domElement.toBlob(res,'image/png'));
      if(!blob)throw new Error('静帧编码失败：canvas.toBlob 返回空');
      return blob;
    }finally{this.endCapture(saved);}
  }
  /** Keyframe contact sheet: one still tile per instant (default: all key
   * times, decimated by sheetTimes beyond SHEET_MAX_TILES) composed on an
   * offscreen 2D canvas as a SHEET_COLS-wide grid with a per-tile timestamp
   * caption — one deterministic PNG for whole-motion pose review. Every tile
   * shares the still's fixed camera preset, output size and overlay policy,
   * so a sheet cell is exactly what a single still would be. */
  async captureSheet(times?:number[],opts:CaptureOptions={}):Promise<Blob>{
    if(!this.ready||!this.rig)throw new Error('模型尚未加载完成，无法渲染拼图');
    return this.captureMutex.run(async()=>{
      /* Pin the document for the whole sheet: getDoc() reads the live library
       * slot, and a doc switch or in-place edit landing between the per-tile
       * awaits (toBlob/createImageBitmap yield to the event loop, where React
       * can still run) would silently mix two document versions into one
       * image. A serialized→parsed copy freezes content and identity;
       * swapping the provider makes every tile's renderStill solve through
       * it. Restored in finally so a mid-sheet failure can't leave the
       * engine on the stale doc. */
      const frozen=parseDoc(serializeDoc(this.getDoc()));
      const ts=sheetTimes(times??sortedKeys(frozen).map(k=>k.time));
      if(!ts.length)throw new Error('文档没有关键时刻，无法生成拼图');
      const cols=Math.min(SHEET_COLS,ts.length),rows=Math.ceil(ts.length/cols);
      const sheet=document.createElement('canvas');
      sheet.width=cols*STILL_WIDTH;sheet.height=rows*(STILL_HEIGHT+SHEET_LABEL_H);
      const ctx=sheet.getContext('2d');if(!ctx)throw new Error('无法创建 2D 拼图画布');
      ctx.fillStyle='#f5f7fa';ctx.fillRect(0,0,sheet.width,sheet.height);
      /* The whole sheet runs inside ONE outer capture session: `capturing`
       * is held from here through the sheet's own toBlob (the depth count
       * only falls when this last endCapture runs), so the between-tile
       * awaits can no longer drop the flag — a mid-sheet pointerdown can't
       * start a drag, and the animate loop can't re-show overlays. Per-tile
       * renderStill calls still take their own begin/end snapshots
       * (view/camera/transport — restored LIFO per tile); what stays held is
       * the flag and the frozen document provider. */
      const outer=this.beginCapture(opts);
      const restoreDoc=this.getDoc;this.getDoc=()=>frozen;
      try{
        for(let i=0;i<ts.length;i++){
          const x=(i%cols)*STILL_WIDTH,y=Math.floor(i/cols)*(STILL_HEIGHT+SHEET_LABEL_H);
          const bmp=await createImageBitmap(await this.renderStill(ts[i],opts));
          ctx.drawImage(bmp,x,y);bmp.close();
          ctx.fillStyle='#eef1f6';ctx.fillRect(x,y+STILL_HEIGHT,STILL_WIDTH,SHEET_LABEL_H);
          ctx.fillStyle='#33415c';ctx.font='600 13px "DM Sans",system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
          ctx.fillText(`t = ${ts[i].toFixed(2)} s`,x+STILL_WIDTH/2,y+STILL_HEIGHT+SHEET_LABEL_H/2);
          ctx.strokeStyle='#d6dce4';ctx.strokeRect(x+.5,y+.5,STILL_WIDTH-1,STILL_HEIGHT+SHEET_LABEL_H-1);
        }
        const blob=await new Promise<Blob|null>(res=>sheet.toBlob(res,'image/png'));
        if(!blob)throw new Error('拼图编码失败：canvas.toBlob 返回空');
        return blob;
      }finally{this.getDoc=restoreDoc;this.endCapture(outer);}
    });
  }
  /** Snapshot every piece of transport/camera/render state a capture touches
   * (the snapshot records the PRE-pause values — endCapture's restore is what
   * "the session continues where it was" means), then pin the capture
   * contract: paused transport, pixelRatio 1, fixed buffer size and aspect. */
  private beginCapture(opts:CaptureOptions):CaptureSnapshot{
    const saved:CaptureSnapshot={
      time:this.time,playing:this.playing,view:this.view,
      cam:this.camera.position.clone(),target:this.controls.target.clone(),ratio:this.renderer.getPixelRatio(),
      // Visibility is snapshotted per object so the restore is exact even for
      // layers the loop only re-derives lazily (trajectories and contact
      // markers update on docDirty rebuilds, not every frame).
      overlays:!opts.overlays?{
        handles:this.handleGroup.visible,
        trajectories:[...this.trajectories.values()].map(l=>l.visible),
        contacts:this.contactMarkers.map(m=>m.visible),
        onion:this.onionLines.map(l=>l.visible),
        balance:[this.comMarker,this.comLine,this.supportLoop].map(o=>o?.visible??false),
      }:null,
    };
    this.setPlaying(false);
    // Depth, not a flag: only the LAST endCapture (the outer session's, after
    // a sheet's own toBlob) re-opens the overlay/drag windows.
    this.captureDepth++;
    this.anatomy?.setSuspended(true);
    if(saved.overlays){
      this.handleGroup.visible=false;
      for(const l of this.trajectories.values())l.visible=false;
      for(const m of this.contactMarkers)m.visible=false;
      for(const l of this.onionLines)l.visible=false;
      for(const o of [this.comMarker,this.comLine,this.supportLoop])if(o)o.visible=false;
    }
    this.renderer.setPixelRatio(1);this.renderer.setSize(STILL_WIDTH,STILL_HEIGHT,false);
    this.camera.aspect=STILL_WIDTH/STILL_HEIGHT;this.camera.updateProjectionMatrix();
    return saved;
  }
  private endCapture(saved:CaptureSnapshot){
    this.captureDepth=Math.max(0,this.captureDepth-1);
    this.anatomy?.setSuspended(this.capturing);
    const o=saved.overlays;
    if(o){
      this.handleGroup.visible=o.handles;
      [...this.trajectories.values()].forEach((l,i)=>{l.visible=o.trajectories[i];});
      this.contactMarkers.forEach((m,i)=>{m.visible=o.contacts[i];});
      this.onionLines.forEach((l,i)=>{l.visible=o.onion[i];});
      [this.comMarker,this.comLine,this.supportLoop].forEach((m,i)=>{if(m)m.visible=o.balance[i];});
    }
    this.renderer.setPixelRatio(saved.ratio);this.resize(); // pixelRatio first — setSize multiplies by it
    this.view=saved.view;
    this.camera.position.copy(saved.cam);this.controls.target.copy(saved.target);this.controls.update();
    this.time=Math.max(0,Math.min(this.getDoc().duration,saved.time));
    this.playing=saved.playing;
    this.solveCurrent();this.skinSwap?.resetHair();this.notify(true);
  }
  private animate=()=>{
    if(this.disposed)return;this.raf=requestAnimationFrame(this.animate);
    const dt=Math.min(this.clock.getDelta(),.1);
    if(this.ready&&this.rig){
      const doc=this.getDoc();
      if(this.playing&&!this.drag){
        this.time+=dt*this.speed;
        // Loops wrap; a plain clip stops on its last frame instead of restarting.
        if(doc.loop)this.time=doc.duration>0?this.time%doc.duration:0;
        else if(this.time>=doc.duration){this.time=doc.duration;this.playing=false;this.notify(true);}
      }
      if(this.docDirty&&!this.drag)this.rebuildAux();
      // Ghosts freeze mid-drag like every other aux layer; step mode still
      // follows the playhead each frame through this same signature-gated call.
      if(!this.drag)this.updateOnion();
      this.solveCurrent();
      const a=this.rig?analyzePose(this.rig,this.latestFrame!.pose,this.latestFrame!.constraints,this.racket):undefined;
      if(a)this.updateBalance(a);
      this.lastNotify+=dt;if(this.lastNotify>.07){this.lastNotify=0;this.notify(false,a);}
    }
    if(!this.capturing)this.skinSwap?.update(dt);
    this.controls.update();this.anatomy?.update(dt);this.renderer.render(this.scene,this.camera);
  };
  private notify(force:boolean,a?:Analysis){
    const doc=this.getDoc(),keys=sortedKeys(doc);
    const label=[...keys].reverse().find(k=>k.time<=this.time)?.label??keys[0]?.label??'';
    if(force||a)this.onFrame?.({time:this.time,duration:doc.duration,playing:this.playing,label,analysis:a});
  }
  dispose(){
    this.disposed=true;this.skinSwap?.dispose();this.anatomy?.dispose();this.unbindTheme?.();cancelAnimationFrame(this.raf);this.resizeObserver.disconnect();
    const dom=this.renderer.domElement;
    dom.removeEventListener('pointerdown',this.onPointerDown);dom.removeEventListener('pointermove',this.onPointerMove);dom.removeEventListener('pointerup',this.onPointerUp);dom.removeEventListener('pointercancel',this.onPointerUp);
    // Everything in this scene was created by the workshop (handles, markers,
    // lines, racket, model materials) — release GPU resources before the
    // renderer context dies instead of relying on GC.
    this.scene.traverse(o=>{
      const g=(o as Mesh).geometry as BufferGeometry|undefined;g?.dispose();
      const m=(o as Mesh).material as {dispose():void}|{dispose():void}[]|undefined;
      if(Array.isArray(m))for(const x of m)x.dispose();else m?.dispose?.();
    });
    this.controls.dispose();this.renderer.dispose();this.host.removeChild(dom);
  }
}
