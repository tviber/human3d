import {SkinSwitch} from '../theme/SkinSwitch';
import {webPlatform} from '../platform/platform';
import {useMediaMatches} from '../lib/use-media';
import {useEffect,useRef,useState} from 'react';
import {Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Group,Panel,Separator,type PanelImperativeHandle,type GroupImperativeHandle} from 'react-resizable-panels';
import {Activity,ArrowDown,ArrowLeft,ArrowUp,Camera,Check,ChevronLeft,ChevronRight,ClipboardCopy,Copy,Download,Eye,FileBox,Film,FlipHorizontal2,Hand,LayoutGrid,ListVideo,MessageSquareWarning,Package,Pause,Play,Plus,Redo2,RotateCcw,Save,SlidersHorizontal,Sparkles,Trash2,Undo2,Upload,Video,X} from 'lucide-react';
import {LibraryList} from './chrome';
import {useWorkshopUi} from './ui-store';
import {WorkshopEngine} from './engine';
import type {WorkshopFrame} from './engine';
import type {HandFrame,KeyInterpolation,WorkshopDoc,WorkshopKey,V3} from '@human3d/motion-core';
import {blankDocument,contactStartKey,defaultDocument,ensureKey,isReleaseKey,keyAt,loopBlockers,mirrorDoc,mirrorKey,nearestKey,newDocId,normalizeDoc,parseDoc,retimeKeys,serializeDoc,sortedKeys} from '@human3d/motion-core';
import {BASIC_PRESETS,LIBRARY_KEY,MotionLibrary,OTHER_PRESETS,RACKET_PRESETS,WORKSHOP_PRESETS,type QuarantineEntry} from './library';
import {clearLabHandoff,handoffConsumedByCreate,handoffHasCard,resolveLabHandoff} from './lab-handoff';
import type {LabHandoff} from './lab-handoff';
import {combineMotions} from './combine-motions';
import {basicInsertRefusal,insertBasicAction,type BasicInsertion} from './basic-actions';
import {applyPoseAt,isPoseShape,PoseLibrary,POSE_LIBRARY_KEY,stampPoseIntoKey,type PoseApplyReport,type PoseStampReport,type UserPosePreset} from './pose-library';
import {MAX_BACKUP_BYTES,RESTORE_POINT_KEY,backupText,mergeBackup,parseBackup,replaceLibrary,type ParsedBackup} from './library-backup';
import {HistoryBook,RecordGate} from './history';
import {SemanticPanel,type SemanticHost} from './semantic-panel';
import {copyKeyframe,keyframeInsertSlot,keyframeTimeProblem,moveKeyframe,removeKeyframe} from './keyframes';
import {clampDuration,WORKSHOP_LIMITS} from '@human3d/motion-core';
import {ankleYForLift,footLift,type Side} from '@human3d/motion-core';
import {rotateArmJoint,rotateHandFrame} from '@human3d/motion-core';
import {unwrapMotionFile} from '@human3d/motion-core';
import {buildManifestLocal,buildPosePackageLocal} from '@human3d/motion-core';
import {exportGlb,posePackageToClip} from '@human3d/motion-core/glb';
import type {PosePackage} from '@human3d/motion-core';
import type {RigManifest} from '@human3d/motion-core';
import type {RigInfo,ViewId} from '@human3d/motion-core';
import type {ChannelGroup,MotionGenProgress} from '@human3d/motion-core';
import type {GenerateWorkerReply,MotionCandidateSummary,MotionGenSummary} from './generation-protocol';

type CandidateSession={source:WorkshopDoc;candidate:MotionCandidateSummary;result:MotionGenSummary};
type GenerationReport={source:WorkshopDoc;result:MotionGenSummary};
type GenerationProgress=MotionGenProgress|{evals:0;maxEvals:number;phase:'loading'};

/** Phone / short-landscape layout. Mirrors the CSS breakpoint in workshop.css. */
const COMPACT_QUERY='(max-width: 760px), (pointer: coarse) and (max-height: 540px)';
function useMedia(query:string){
 return useMediaMatches(query);
}
/** Session-only review note (issue #23 PR-D): never written into WorkshopDoc. */
interface ReviewNote{id:string;docId:string;keyId:string;keyLabel:string;time:number;view:string;part:string;issue:string;text:string}
const NOTE_PARTS=['右臂','左臂','右手腕','左手腕','躯干','骨盆','右腿','左腿','右脚','左脚','球拍'];
const NOTE_ISSUES=['手臂穿身','拍头方向','支撑脚漂移','关节过屈 / 反折','姿态与参考不符','时机不对','其他'];
const fmt=(t:number)=>`${Math.floor(t/60)}:${(Math.floor(t%60)).toString().padStart(2,'0')}.${Math.floor(t*100%100).toString().padStart(2,'0')}`;
const metricLabels:Record<string,string>={
 'cost.endEffectorJerk':'末端加加速度积分','cost.angularJerk':'角运动加加速度积分',
 'cost.checkViolations':'姿态检查超限','cost.footContact':'支撑脚滑动','cost.penetration':'脚底穿透',
 'cost.ikResidual':'IK 残差','cost.intentShift':'动作偏移代价',
 'bones.maxPeakW':'骨骼峰值角速度','bones.maxPeakAlpha':'骨骼峰值角加速度',
 'checks.violationFrames':'超限帧数','checks.violationFrameRatio':'超限帧比例',
 'checks.maxNormalizedExcess':'最大归一化超限','support.maxResidual':'支撑最大残差',
 'sole.penL':'左脚穿透','sole.penR':'右脚穿透','intent.maxTimeShiftS':'最大时序调整',
 'intent.maxPhaseShiftS':'最大相位调整','intent.movedKeys':'调整关键帧数','contact.tipDevMm':'触球点偏移',
};
const metricText=(value:number)=>Number.isInteger(value)?String(value):new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3}).format(value);

function Row({label,checked,onChange,detail,disabled,testId}:{label:string;checked:boolean;onChange:(v:boolean)=>void;detail?:string;disabled?:boolean;testId?:string}){
 return <label className="ws-check"><input type="checkbox" data-testid={testId} checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/><span>{label}{detail?<small>{detail}</small>:null}</span></label>;
}
function Slider({label,value,min,max,step,unit,disabled,testId,onChange}:{label:string;value:number;min:number;max:number;step:number;unit?:string;disabled?:boolean;testId?:string;onChange:(v:number)=>void}){
 return <label className="ws-slider"><span>{label}<output>{value.toFixed(unit==='m'?3:1)}{unit??'°'}</output></span><input type="range" data-testid={testId} min={min} max={max} step={step} value={value} disabled={disabled} onChange={e=>onChange(Number(e.target.value))}/></label>;
}
function VectorSliders({title,value,testPrefix,min=-2,max=2,minY=-.5,maxY=2.5,onChange}:{title:string;value:V3;testPrefix:string;min?:number;max?:number;minY?:number;maxY?:number;onChange:(axis:'x'|'y'|'z',value:number)=>void}){
 return <div className="ws-vector-control">
  <strong>{title}</strong>
  {(['x','y','z']as const).map(axis=><Slider key={axis} label={`${title} ${axis.toUpperCase()}`} value={value[axis]}
   min={axis==='y'?minY:min} max={axis==='y'?maxY:max} step={.005} unit="m" testId={`${testPrefix}-${axis}`}
   onChange={v=>onChange(axis,v)}/>) }
 </div>;
}
/** Delta sliders for the stored wrist frame: the control resets to zero each
 * key, edits rotate the key's forward/normal pair by the slider delta. */
function WristPanel({k,side,free,edit}:{k:WorkshopKey;side:Side;free:boolean;edit:(fn:(key:WorkshopKey)=>void)=>void}){
 const [v,setV]=useState({flex:0,dev:0,twist:0});
 const turn=(kind:'flex'|'dev'|'twist',next:number)=>{
  const delta=next-v[kind];setV({...v,[kind]:next});
  edit(key=>{rotateHandFrame(side==='L'?key.pose.handL:key.pose.handR,kind,delta);});
 };
 return <div className="ws-sub"><h3>{side==='L'?'左':'右'}手腕姿态 <small>屈伸 / 侧偏 / 旋转</small></h3>
  <Slider label="屈 / 伸" value={v.flex} min={free?-180:-60} max={free?180:60} step={1} testId={`wrist-${side}-flex`} onChange={x=>turn('flex',x)}/>
  <Slider label="尺桡偏" value={v.dev} min={free?-180:-60} max={free?180:60} step={1} testId={`wrist-${side}-dev`} onChange={x=>turn('dev',x)}/>
  <Slider label="旋前 / 旋后" value={v.twist} min={-180} max={180} step={1} testId={`wrist-${side}-twist`} onChange={x=>turn('twist',x)}/>
 </div>;
}
function ArmJointPanel({side,joint,disabled,onTurn}:{side:Side;joint:'upper'|'forearm';disabled:boolean;onTurn:(kind:'lift'|'swing'|'twist',delta:number)=>void}){
 const [v,setV]=useState({lift:0,swing:0,twist:0});
 const turn=(kind:'lift'|'swing'|'twist',next:number)=>{const delta=next-v[kind];setV({...v,[kind]:next});onTurn(kind,delta);};
 return <div className="ws-sub"><h3>{side==='L'?'左':'右'}{joint==='upper'?'大臂':'前臂（小臂）'}关节旋转</h3>
  {([['lift','前后摆动'],['swing','水平摆动'],['twist','轴向旋转']] as const).map(([kind,label])=><Slider key={kind} label={label} value={v[kind]} min={-180} max={180} step={1} disabled={disabled} testId={`joint-${side}-${joint}-${kind}`} onChange={next=>turn(kind,next)}/>)}
 </div>;
}
/** Commit complete numbers on blur/Enter, so typing 0.36 never writes the
 * intermediate 0 and accidentally moves a key through the whole sequence. */
function KeyframeTimeInput({time,max,disabled,onCommit}:{time:number;max:number;disabled:boolean;onCommit:(time:number)=>void}){
 const [draft,setDraft]=useState(String(time)),cancel=useRef(false);
 return <input type="number" aria-label="关键帧时间（秒）" data-testid="selected-key-time" min={0} max={max} step="any" disabled={disabled} value={draft}
  onChange={e=>setDraft(e.target.value)} onBlur={e=>{if(!cancel.current)onCommit(e.currentTarget.valueAsNumber);cancel.current=false;setDraft(String(time));}}
  onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.currentTarget.blur();}else if(e.key==='Escape'){cancel.current=true;e.currentTarget.blur();}}}/>;
}
/** Key → seek on tap; a key moves only after a 6 px horizontal drag (so a
 * fingertip tap never retimes); empty track drags scrub. Each key carries a
 * 44 px-tall invisible hit area around the 13 px diamond. */
function Timeline({doc,time,selected,retime,onSelect,onSeek,onRetime,onBeginRetime,onEndRetime}:{doc:WorkshopDoc;time:number;selected:string;retime:boolean;onSelect:(id:string)=>void;onSeek:(t:number)=>void;onRetime:(id:string,t:number)=>void;onBeginRetime:()=>void;onEndRetime:()=>void}){
 const track=useRef<HTMLDivElement>(null);
 const [dragKey,setDragKey]=useState<string|null>(null);
 const press=useRef<{x:number;id:string;moved:boolean}|null>(null),scrub=useRef(false);
 const frac=(x:number)=>{const r=track.current!.getBoundingClientRect();return Math.max(0,Math.min(1,(x-r.left)/r.width));};
 const move=(ev:{clientX:number})=>{
  if(scrub.current&&track.current){onSeek(frac(ev.clientX)*doc.duration);return;}
  if(!dragKey||!retime||!track.current)return;
  const keys=sortedKeys(doc),i=keys.findIndex(k=>k.id===dragKey);
  if(i<0||(doc.loop&&i===0))return; // the loop seam is the first key's fixed 0 s anchor
  const before=keys[i-1],after=keys[i+1];
  const p=press.current;
  if(p&&!p.moved){if(Math.abs(ev.clientX-p.x)<6)return;p.moved=true;onBeginRetime();}
  const lo=before?before.time+Math.min(.01,(keys[i].time-before.time)/2):0;
  const hi=after?after.time-Math.min(.01,(after.time-keys[i].time)/2):doc.duration-(doc.loop?WORKSHOP_LIMITS.loopGap:0);
  onRetime(dragKey,Math.max(lo,Math.min(hi,frac(ev.clientX)*doc.duration)));
 };
 const end=()=>{const moved=press.current?.moved;scrub.current=false;setDragKey(null);if(moved)onEndRetime();setTimeout(()=>{press.current=null;},0);};
 return <div className="ws-track-wrap">
  <div ref={track} className="ws-track" data-testid="timeline-track" onPointerDown={e=>{if(e.target===e.currentTarget){scrub.current=true;e.currentTarget.setPointerCapture(e.pointerId);onSeek(frac(e.clientX)*doc.duration);}}} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
   <div className="ws-progress" style={{width:`${time/doc.duration*100}%`}}/>
   <div className="ws-cursor" style={{left:`${time/doc.duration*100}%`}}/>
   {sortedKeys(doc).map(k=><button key={k.id} className={`ws-key ${k.id===selected?'sel':''} ${k.constraints.contact?'contact':''}`} style={{left:`${k.time/doc.duration*100}%`}}
     aria-label={`选择关键帧 ${k.label||fmt(k.time)}`} aria-pressed={k.id===selected}
     title={`${k.label||'关键帧'} · ${k.time.toFixed(2)}s`}
     onPointerDown={e=>{e.stopPropagation();press.current={x:e.clientX,id:k.id,moved:false};onSelect(k.id);setDragKey(k.id);(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);}}
     onPointerMove={move} onPointerUp={end} onPointerCancel={end}
     onClick={()=>{if(press.current?.moved)return;onSelect(k.id);onSeek(k.time);}}/>)}
  </div>
  <div className="ws-track-labels">{sortedKeys(doc).map(k=><button key={k.id} className={k.id===selected?'sel':''} title={`${k.label||'关键帧'} · ${k.time.toFixed(3)}s`} style={{left:`${k.time/doc.duration*100}%`}} onClick={()=>{onSelect(k.id);onSeek(k.time);}}>{k.label||fmt(k.time)}</button>)}</div>
 </div>;
}
export function WorkshopApp({info:rigInfo,initialLibrary,initialPoses,initialRestorePoint,storageError}:{info:RigInfo;initialLibrary?:string|null;initialPoses?:string|null;initialRestorePoint?:string|null;storageError?:string}){
 const mount=useRef<HTMLDivElement>(null),engine=useRef<WorkshopEngine|null>(null),video=useRef<HTMLVideoElement>(null),fileRef=useRef<HTMLInputElement>(null),importRef=useRef<HTMLInputElement>(null);
 const lib=useRef<MotionLibrary|null>(null);
 const syncLibrary=useRef<(force?:boolean)=>void>(()=>{});
 const poseLib=useRef<PoseLibrary|null>(null),poseClipboard=useRef<WorkshopDoc['keys'][number]['pose']|null>(null);
 const generationPreview=useRef<WorkshopDoc|null>(null),generationWorker=useRef<Worker|null>(null),generationLocked=useRef(false);
 if(!lib.current){
  lib.current=new MotionLibrary(new Map(rigInfo.bones.map(b=>[b.name,new Vector3().fromArray(b.head)])),webPlatform.storage,webPlatform.storageLock,webPlatform.draftOwner).load({snapshotText:initialLibrary});
  if(storageError)lib.current.lastError=storageError;
  const id=new URLSearchParams(globalThis.location?.search??'').get('doc');
  if(id&&lib.current.docs.some(d=>d.id===id))lib.current.select(id);
 }
 if(!poseLib.current)poseLib.current=new PoseLibrary(webPlatform.storage,webPlatform.storageLock).load({snapshotText:initialPoses});
 const [,bump]=useState(0);
 const [leaving,setLeaving]=useState(false);
 const selected=useWorkshopUi(s=>s.selected),setSelected=useWorkshopUi(s=>s.setSelected);
 const newName=useWorkshopUi(s=>s.newName),setNewName=useWorkshopUi(s=>s.setNewName);
 // Lab handoff: the lab navigates here with ?from=<motion id> when the motion
 // it was playing has workshop keys. The offer stays until handled so a
 // refresh doesn't lose it; the URL param is dropped on handling so a later
 // visit doesn't re-offer. Creation is always explicit — never auto-copied.
 const [handoff,setHandoff]=useState<LabHandoff|null>(()=>resolveLabHandoff(globalThis.location?.search??''));
 const [presetId,setPresetId]=useState(()=>handoff?.kind==='preset'?handoff.file.id:BASIC_PRESETS[0]?.id??'');
 const [combineTarget,setCombineTarget]=useState('preset:idle');
 const [combineKind,setCombineKind]=useState<'append'|'blend'>('append');
 const [combineTransition,setCombineTransition]=useState(.3),[combineWeight,setCombineWeight]=useState(50),[combineName,setCombineName]=useState('');
 const [basicId,setBasicId]=useState(()=>BASIC_PRESETS[0]?.id??'');
 const [adjustmentTab,setAdjustmentTab]=useState<'left'|'right'|'common'|'semantic'>('semantic');
 const [info,setInfo]=useState<RigInfo|null>(null),[error,setError]=useState('');
 const [frame,setFrame]=useState<WorkshopFrame>({time:0,duration:.8,playing:true,label:''});
 const [view,setView]=useState<ViewId>('threeQuarter');
 const books=useRef(new HistoryBook()),gate=useRef(new RecordGate()),wristEpoch=useRef(0),shortcuts=useRef<{undo:()=>void;redo:()=>void}>({undo:()=>{},redo:()=>{}});
 const [hint,setHint]=useState(()=>{const id=new URLSearchParams(globalThis.location?.search??'').get('doc');return id&&!lib.current!.docs.some(d=>d.id===id)?'所选动作已删除或不在本机动作库中，已打开当前工作区。':'';});
 useEffect(()=>{if(!hint)return;const t=setTimeout(()=>setHint(''),6000);return()=>clearTimeout(t);},[hint]);
 // Pose-package export state: fps is user-visible because it moves the
 // artifact id; the manifest is a session constant built once; pkgProblems is
 // the persistent 422 record (keyed to the doc it was rejected on).
 const [exportFps,setExportFps]=useState(40);
 const [exporting,setExporting]=useState(false);
 const [pkgProblems,setPkgProblems]=useState<{doc:string;items:string[]}|null>(null);
 // Whole-library backup/restore (issue #30 PR-C): the preview card holds a
 // fully validated backup until the user picks merge or replace.
 const [restorePreview,setRestorePreview]=useState<Extract<ParsedBackup,{ok:true}>|null>(null);
 const backupRef=useRef<HTMLInputElement>(null);
 const [restoring,setRestoring]=useState(false);const restoreBusy=useRef(false);
 // Replace is two-step: the snapshot download arms it, the user's explicit
 // acknowledgement that the file is saved enables the final confirmation.
 const [replaceArmed,setReplaceArmed]=useState<string|null>(null),[replaceAck,setReplaceAck]=useState(false);
 const [restorePoint,setRestorePoint]=useState<{savedAt:string;docs:number;poses:number}|null>(()=>{
  const point=initialRestorePoint?parseBackup(initialRestorePoint):null;
  return point?.ok?{savedAt:point.file.exportedAt,docs:point.docs.length,poses:point.poses.length}:null;
 });
 const [generationBusy,setGenerationBusy]=useState(false),[generationProgress,setGenerationProgress]=useState<GenerationProgress|null>(null);
 const [generationError,setGenerationError]=useState('');
 const [candidateSession,setCandidateSession]=useState<CandidateSession|null>(null);
 const [generationReport,setGenerationReport]=useState<GenerationReport|null>(null);
 const [previewSide,setPreviewSide]=useState<'source'|'candidate'>('candidate');
 const [adjustKinds,setAdjustKinds]=useState({time:true,phase:true});
 const manifestRef=useRef<RigManifest|null>(null);
 // crypto.subtle exists only on secure origins (https / localhost); without it
 // the digest would have to be fabricated, so the export degrades instead.
 const subtleOk=typeof globalThis.crypto?.subtle?.digest==='function';
 // Session-only display toggles (never persisted) — same convention as the
 // engine's WorkshopOptions defaults.
 const [opts,setOpts]=useState({handles:true,trajectories:false,balance:false,onion:false,onionCount:2,onionMode:'keys' as 'keys'|'step',onionStep:.1});
 const [optsOpen,setOptsOpen]=useState(false);
 // Issue #23: phone layout = viewport + bottom sheets; Review mode blocks every
 // viewport write. Same query as the CSS breakpoint in workshop.css.
 const compact=useMedia(COMPACT_QUERY);
 const [mode,setMode]=useState<'review'|'edit'>('review');
 const panelGroup=useRef<GroupImperativeHandle|null>(null);
 const libraryPanel=useRef<PanelImperativeHandle|null>(null),inspectorPanel=useRef<PanelImperativeHandle|null>(null);
 const [libraryOpen,setLibraryOpen]=useState(false),[inspectorOpen,setInspectorOpen]=useState(false);
 const [sheet,setSheet]=useState<'left'|'right'|null>(null);
 const [refLarge,setRefLarge]=useState(false);
 const [notes,setNotes]=useState<ReviewNote[]>([]);
 const [noteDraft,setNoteDraft]=useState({part:NOTE_PARTS[0],issue:NOTE_ISSUES[0],text:''});
 const [videoUrl,setVideoUrl]=useState('');const [sync,setSync]=useState(false);const syncOffset=useRef(0);const [videoPlaying,setVideoPlaying]=useState(false);
 useEffect(()=>{
  if(!mount.current)return;let e:WorkshopEngine;
  try{
   e=new WorkshopEngine(mount.current,()=>generationPreview.current??lib.current!.active());engine.current=e;
   e.onReady=setInfo;
   e.setEditable(false);e.setOptions({trajectories:false,balance:false});
   e.onError=err=>setError(err.message);
   e.onFrame=setFrame;
   e.onSelectKey=setSelected;
   let lastDragSave=0;
   // Persist drags throttled while moving and unconditionally at drag end;
   // before this, a pose edit could be lost if the page closed before the
   // next explicit save.
   e.onDocChanged=()=>{if(restoreBusy.current)return;lib.current!.checkpoint();const now=performance.now();if(now-lastDragSave>500){lastDragSave=now;lib.current!.save();}bump(v=>v+1);};
   e.onEditEnd=()=>{if(!restoreBusy.current){lib.current!.save();bump(v=>v+1);}};
   e.onBeginEdit=(time,prefer)=>{
    if(generationLocked.current||restoreBusy.current)return null;
    const d=lib.current!.active();
    // Snapshot before any key is inserted, so one drag is one undo step.
    books.current.of(d.id).record(d);gate.current.touch(d.id,performance.now());
    if(prefer){const k=keyAt(d,prefer);if(k)return k;}
    const k=ensureKey(d,time,e.restRoot());
    if(!k){setHint(`已达 ${WORKSHOP_LIMITS.maxKeys} 个关键帧上限：先删除不需要的帧，或在时间轴上选中既有帧再编辑。`);return null;}
    lib.current!.save();bump(v=>v+1);return k;
   };
   void e.load();
   if(import.meta.env.DEV)(window as unknown as {__WS__:WorkshopEngine}).__WS__=e;
  }catch(err){setError(err instanceof Error?err.message:String(err));return;}
  return()=>{generationWorker.current?.terminate();generationWorker.current=null;generationPreview.current=null;generationLocked.current=false;engine.current=null;e.dispose();};
 },[]);
 useEffect(()=>{
  if(import.meta.env.DEV){
   const debugWindow=window as Window&{__WS_GENERATOR__?:{source:()=>WorkshopDoc;preview:()=>WorkshopDoc|null;locked:()=>boolean;activeId:()=>string;history:()=>{canUndo:boolean;canRedo:boolean}}};
   debugWindow.__WS_GENERATOR__={
    source:()=>JSON.parse(JSON.stringify(lib.current!.active())) as WorkshopDoc,
    preview:()=>generationPreview.current?JSON.parse(JSON.stringify(generationPreview.current)) as WorkshopDoc:null,
    locked:()=>generationLocked.current,activeId:()=>lib.current!.activeId,
    history:()=>{const h=books.current.of(lib.current!.active().id);return{canUndo:h.canUndo(),canRedo:h.canRedo()};},
   };
  }
  return()=>{
   generationWorker.current?.terminate();generationWorker.current=null;generationPreview.current=null;generationLocked.current=false;
   if(import.meta.env.DEV)delete (window as Window&{__WS_GENERATOR__?:unknown}).__WS_GENERATOR__;
  };
 },[]);
 // Video ↔ timeline sync.
 useEffect(()=>{
  const el=video.current;if(!el||!sync)return;
  const target=frame.time+syncOffset.current;
  if(frame.playing){el.playbackRate=engine.current?.speed??1;if(Math.abs(el.currentTime-target)>.15)el.currentTime=target;if(el.paused)void el.play();}
  else if(Math.abs(el.currentTime-target)>.05)el.currentTime=target;
 },[frame,sync]);
 const L=lib.current!;
 // Deleting a document drops its undo book with it — a doc that later reuses
 // the id (re-import of the same file) must not inherit the deleted doc's
 // snapshots and have undo resurrect stale content under the new doc.
 L.onRemoved=id=>books.current.drop(id);
 /** Snapshot before an edit. Edits within 600 ms on the SAME document (a slider
  * drag) share one undo step; another document or a gap always starts a new one. */
 const recordBefore=(doc:WorkshopDoc)=>{if(gate.current.should(doc.id,performance.now()))books.current.of(doc.id).record(doc);};
 const edit=(fn:(d:WorkshopDoc)=>void)=>{if(generationLocked.current||restoreBusy.current||review)return;recordBefore(L.active());fn(L.active());L.save();engine.current?.setPlaying(false);engine.current?.markDirty();bump(v=>v+1);};
 /** Write a history-restored document back under its own id. Returns false
  * when that id no longer exists in the library (deleted meanwhile). */
 const applyDoc=(next:WorkshopDoc)=>{const i=L.docs.findIndex(x=>x.id===next.id);if(i<0)return false;L.docs[i]=next;L.save();gate.current.reset();wristEpoch.current++;const e=engine.current;e?.setPlaying(false);e?.markDirty();e?.seek(Math.min(frame.time,next.duration));if(!keyAt(next,selected))setSelected(sortedKeys(next)[0]?.id??'');bump(v=>v+1);return true;};
 /* A history step can restore a DIFFERENT library document: the mirrored
  * document's first undo step is the source document it was made from.
  * A cross-document snapshot is POINTER semantics — it only moves the
  * selection, its content is NEVER written back: the library copy may carry
  * edits newer than the moment the snapshot was taken (the mirror seeds the
  * source's state at mirror time), and writing it back would silently erase
  * those post-mirror edits. The departing doc's current state is still
  * deposited on the target book's opposite stack, keeping undo/redo
  * symmetric across the switch (the departing doc also keeps its own copy
  * of the step, pushed by DocHistory itself). applyDoc — the same-document
  * overwrite — runs only when the restored id IS the active document's own:
  * a doc's own history restoring itself is the correct write. A restored id
  * that no longer names a library document is skipped WITH a hint —
  * silently consuming it would look like undo doing nothing. */
 const undo=()=>{
  if(generationLocked.current||restoreBusy.current||review)return;
  const cur=L.active(),prev=books.current.of(cur.id).undo(cur);
  if(!prev)return;
  if(prev.id!==cur.id){
   if(!L.docs.some(x=>x.id===prev.id)){setHint(`撤销的目标文档「${prev.name}」已不在动作库中（可能已被删除），该历史步已跳过。`);return;}
   books.current.of(prev.id).pushFuture(cur);gate.current.reset();selectDoc(prev.id);return;
  }
  applyDoc(prev);
 };
 const redo=()=>{
  if(generationLocked.current||restoreBusy.current||review)return;
  const cur=L.active(),next=books.current.of(cur.id).redo(cur);
  if(!next)return;
  if(next.id!==cur.id){
   if(!L.docs.some(x=>x.id===next.id)){setHint(`重做的目标文档「${next.name}」已不在动作库中（可能已被删除），该历史步已跳过。`);return;}
   books.current.of(next.id).pushPast(cur);gate.current.reset();selectDoc(next.id);return;
  }
  applyDoc(next);
 };
 shortcuts.current={undo,redo};
 useEffect(()=>{
  // Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redoes. Text fields keep their native undo.
  const onKey=(ev:KeyboardEvent)=>{
   const t=ev.target as HTMLElement|null;
   if(t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))return;
   if(!(ev.ctrlKey||ev.metaKey))return;
   const k=ev.key.toLowerCase();
   if(k==='z'&&!ev.shiftKey){ev.preventDefault();shortcuts.current.undo();}
   else if((k==='z'&&ev.shiftKey)||k==='y'){ev.preventDefault();shortcuts.current.redo();}
  };
  window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);
 },[]);
 const exportQuarantine=(i:number)=>{const q=L.quarantine[i];if(!q)return;download(`${q.id||'quarantined'}.quarantine.json`,new Blob([L.quarantineText(i)],{type:'application/json'}));};
 const liftOf=(side:Side,k:WorkshopKey)=>{const f=side==='L'?k.pose.footL:k.pose.footR;const g=engine.current?.footGeometry(side);return g?footLift(g,f.target.y,f.yaw,f.pitch):f.target.y;};
 const setLift=(side:Side,v:number)=>editSelected(k=>{const f=side==='L'?k.pose.footL:k.pose.footR;const g=engine.current?.footGeometry(side);f.target.y=g?ankleYForLift(g,v,f.yaw,f.pitch):v;});

 const editAtKey=(k:WorkshopKey,fn:()=>void)=>{
  if(generationLocked.current)return;
  const e=engine.current;e?.setPlaying(false);e?.seek(k.time);
  edit(fn);setSelected(k.id);e?.solveCurrent();
 };
 const editSelected=(fn:(k:WorkshopKey)=>void)=>{
  const doc=L.active(),k=keyAt(doc,selected)??nearestKey(doc,frame.time,1e9);
  if(k)editAtKey(k,()=>fn(k));
 };
 const d=L.active();
 const orderedKeys=sortedKeys(d);
 const [locksByDoc,setLocksByDoc]=useState<Record<string,{extra:string[];unlockedDefaults:string[]}>>({});
 const defaultLockedIds=orderedKeys.filter((_,i)=>i===0||i===orderedKeys.length-1).map(k=>k.id);
 const contactLockedIds=orderedKeys.filter(k=>k.constraints.contact).map(k=>k.id);
 const lockOverrides=locksByDoc[d.id]??{extra:[],unlockedDefaults:[]};
 const lockedIds=[...new Set([
  ...defaultLockedIds.filter(id=>!lockOverrides.unlockedDefaults.includes(id)),
  ...lockOverrides.extra,...contactLockedIds,
 ])].filter(id=>orderedKeys.some(k=>k.id===id));
 const setKeyLocked=(id:string,checked:boolean)=>setLocksByDoc(prev=>{
  const current=prev[d.id]??{extra:[],unlockedDefaults:[]};
  const extra=new Set(current.extra),unlockedDefaults=new Set(current.unlockedDefaults);
  if(defaultLockedIds.includes(id)){
   if(checked)unlockedDefaults.delete(id);else{unlockedDefaults.add(id);extra.delete(id);}
  }else if(checked)extra.add(id);else extra.delete(id);
  return{...prev,[d.id]:{extra:[...extra],unlockedDefaults:[...unlockedDefaults]}};
 });
 const sel=keyAt(d,selected)??nearestKey(d,frame.time,1e9);
 const selectedKeyIndex=sel?orderedKeys.findIndex(k=>k.id===sel.id):-1;
 const keyTimeMax=d.duration-(d.loop?WORKSHOP_LIMITS.loopGap:0);
 const insertSlot=sel?keyframeInsertSlot(d,sel.time,orderedKeys[selectedKeyIndex+1]?.time):undefined;
 const insertDuration=insertSlot?.duration??d.duration,insertTime=insertSlot?.time;
 const nextTransitionKey=selectedKeyIndex<0?undefined:orderedKeys[selectedKeyIndex+1]??(d.loop?orderedKeys[0]:undefined);
 const transitionIsLoop=d.loop&&selectedKeyIndex===orderedKeys.length-1;
 const transitionEndTime=nextTransitionKey?nextTransitionKey.time+(transitionIsLoop?d.duration:0):undefined;
 const review=mode==='review';
 const adjustmentSide=adjustmentTab==='left'?'L':'R',adjustmentSideName=adjustmentSide==='L'?'左':'右';
 const analysis=frame.analysis;
 const previewDoc=candidateSession?(previewSide==='candidate'?candidateSession.candidate.doc:candidateSession.source):null;
 const displayDoc=previewDoc??d;
 const generationLockedUi=generationBusy||candidateSession!==null;
 const visibleReport=candidateSession?.result??(generationReport?.source.id===d.id?generationReport.result:null);
 const setPreview=(side:'source'|'candidate')=>{
  if(!candidateSession)return;
  generationPreview.current=side==='candidate'?candidateSession.candidate.doc:candidateSession.source;
  setPreviewSide(side);engine.current?.setPlaying(false);engine.current?.markDirty();
 };
 const selectDoc=(id:string)=>{if(generationLocked.current||restoreBusy.current)return;const doc=L.select(id);setSelected(sortedKeys(doc)[0].id);engine.current?.seek(0);engine.current?.setPlaying(false);engine.current?.markDirty();bump(v=>v+1);};
 const createDoc=()=>{if(generationLocked.current||restoreBusy.current)return;switchMode('edit');const doc=L.create(newName);setNewName('');setSelected(sortedKeys(doc)[0].id);engine.current?.seek(0);engine.current?.markDirty();bump(v=>v+1);};
 const duplicateDoc=(id:string)=>{if(generationLocked.current||restoreBusy.current)return;switchMode('edit');const doc=L.duplicate(id);if(doc)selectDoc(doc.id);};
 const saveToLibrary=async()=>{
  if(generationLocked.current||restoreBusy.current)return;
  if(!webPlatform.storage){setError('浏览器存储不可用，动作尚未保存，请导出 JSON 备份。');return;}
  await L.save();bump(v=>v+1);
  if(L.lastError){setError(`保存失败：${L.lastError}。请导出 JSON 备份。`);return;}
  setError('');setHint(`已保存「${L.active().name}」，返回实验室即可在动作库中播放或删除。`);
 };
 const saveCombined=async()=>{
  if(generationLocked.current||restoreBusy.current)return;
  const e=engine.current;if(!e?.ready){setHint('请等待模型加载完成。');return;}
  const target=combineTarget.startsWith('local:')?L.docs.find(doc=>doc.id===combineTarget.slice(6)):WORKSHOP_PRESETS.find(p=>`preset:${p.id}`===combineTarget)?.document;
  if(!target){setHint('请选择要组合的动作。');return;}
  if(!webPlatform.storage){setError('浏览器存储不可用，请先导出源动作 JSON 备份。');return;}
  try{
   const source=L.active();
   const combined=combineMotions(source,target,combineKind==='append'?{kind:'append',transition:combineTransition}:{kind:'blend',weight:combineWeight/100},e.restRoot(),combineName);
   const added=L.add(combined);books.current.of(added.id).record(source);
   gate.current.reset();wristEpoch.current++;setCombineName('');selectDoc(added.id);await L.saved;
   if(L.lastError){setError(`保存失败：${L.lastError}。组合结果尚未写入动作库，请导出 JSON 备份。`);return;}
   setError('');setHint(`已${combineKind==='append'?'拼接':'混合'}并保存「${added.name}」，可在动作库播放；两份源动作已保留。`);
  }catch(err){setHint(err instanceof Error?err.message:String(err));}
 };
 // Whole-library backup / restore. Export snapshots the CURRENT in-memory
 // state (never storage); restore validates and previews before anything is
 // written, replace always downloads a snapshot of the present data first.
 const exportBackup=()=>{
  download(`h3d-backup-${new Date().toISOString().slice(0,10)}.json`,new Blob([backupText(L.docs,L.quarantine,L.activeId,poseLib.current!.presets)],{type:'application/json'}));
  setHint(`已导出整库备份（${L.docs.length} 个动作 · ${poseLib.current!.presets.length} 个姿态 · ${L.quarantine.length} 条可恢复数据）。`);
 };
 const chooseRestore=async(f:File)=>{
  setRestorePreview(null);setReplaceArmed(null);setReplaceAck(false);
  try{
   if(f.size>MAX_BACKUP_BYTES){setError('备份文件过大（上限 64 MB），请确认选择了正确的备份。');return;}
   const parsed=parseBackup(await f.text(),f.size);
   if(!parsed.ok){setError(`无法恢复备份：${parsed.error}`);return;}
   if(!parsed.docs.length&&!parsed.poses.length&&!parsed.file.library.quarantine.length&&!parsed.invalidDocs.length){setError('这份备份里没有可恢复的内容。');return;}
   setError('');setRestorePreview(parsed);
  }catch(err){setError(`无法读取备份：${err instanceof Error?err.message:String(err)}`);}
 };
 const finishRestore=(report:{docsAdded:number;posesAdded:number;conflicts:string[];invalidDocs:{name:string;reason:string}[]},mode:'merge'|'replace')=>{
  const parts=[`${mode==='merge'?'已合并':'已替换'} ${report.docsAdded} 个动作、${report.posesAdded} 个自建姿态`];
  if(report.conflicts.length)parts.push(`冲突处理：${report.conflicts.join('；')}`);
  if(report.invalidDocs.length)parts.push(`${report.invalidDocs.length} 条无法识别的动作已隔离，可导出修复`);
  setRestorePreview(null);bump(v=>v+1);
  if(L.lastError){setError(`恢复已在当前页面生效，但保存失败：${L.lastError}。请立即导出 JSON 备份，刷新会丢失。`);return;}
  if(poseLib.current!.lastError){setError(`动作已恢复，但姿态保存失败：${poseLib.current!.lastError}。`);return;}
  setError('');setHint(`${parts.join('；')}。`);
 };
 const cancelRestore=()=>{setRestorePreview(null);setReplaceArmed(null);setReplaceAck(false);};
 // Step 1 of replace: download the current data and require the user to
 // acknowledge that file. A download call returning is not proof the file
 // reached disk, so the replace itself also commits an in-browser restore
 // point in the same transaction (see restoreBackup).
 const armReplace=()=>{
  if(!restorePreview||restoreBusy.current)return;
  const name=`h3d-library-before-replace-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
  download(name,new Blob([backupText(L.docs,L.quarantine,L.activeId,poseLib.current!.presets)],{type:'application/json'}));
  setReplaceArmed(name);setReplaceAck(false);
 };
 // Built INSIDE the replace's write lock from the canonical snapshot, so a save
 // from another tab that this page has not synced yet is still captured. Both
 // stores are re-parsed: unreadable documents, quarantine entries and a broken
 // pose list stay recoverable instead of being dropped from the restore point.
 const buildRestorePoint=(latest:{libraryText:string|null;relatedText:string|null})=>{
  const snapshotLib=new MotionLibrary(new Map()).load({readOnly:true,snapshotText:latest.libraryText});
  const quarantine=structuredClone(snapshotLib.quarantine);
  let poses:UserPosePreset[]=[];
  try{
   const parsed:unknown=JSON.parse(latest.relatedText??'[]');
   if(!Array.isArray(parsed))throw new Error('不是数组');
   const valid=parsed.filter((p):p is UserPosePreset=>!!p&&typeof p==='object'&&typeof (p as UserPosePreset).id==='string'&&typeof (p as UserPosePreset).name==='string'&&isPoseShape((p as UserPosePreset).pose));
   if(valid.length!==parsed.length)throw new Error(`${parsed.length-valid.length} 个条目格式不完整`);
   poses=valid;
  }catch(err){
   quarantine.push({id:'poses-file',name:'自建姿态文件',reason:`替换时的自建姿态无法读取，已保留原文：${err instanceof Error?err.message:String(err)}`,raw:latest.relatedText});
  }
  return backupText(snapshotLib.docs,quarantine,snapshotLib.activeId,poses);
 };
 const applyLibrary=(next:{schemaVersion:2;docs:WorkshopDoc[];quarantine:QuarantineEntry[];activeId:string},poses:UserPosePreset[],restorePoint?:{build:(latest:{libraryText:string|null;relatedText:string|null})=>string},concurrent:'abort'|'capture'='abort')=>
  L.restore(next,{key:POSE_LIBRARY_KEY,text:JSON.stringify(poses),previous:JSON.stringify(poseLib.current!.presets)},restorePoint?{key:RESTORE_POINT_KEY,build:restorePoint.build}:undefined,{concurrent}).then(result=>{
   poseLib.current!.load({snapshotText:JSON.stringify(poses)});
   gate.current.reset();wristEpoch.current++;
   setSelected(sortedKeys(L.active())[0].id);engine.current?.seek(0);engine.current?.markDirty();
   return result;
  });
 const withRestoreLock=async(run:()=>Promise<void>,failure:string)=>{
  restoreBusy.current=true;setRestoring(true);engine.current?.setEditable(false);engine.current?.setPlaying(false);
  try{
   await L.saved;await poseLib.current!.saved;
   if(poseLib.current!.lastError)throw new Error(`当前姿态尚未保存：${poseLib.current!.lastError}`);
   await run();
  }catch(err){setError(`${failure}：${err instanceof Error?err.message:String(err)}`);}
  finally{restoreBusy.current=false;setRestoring(false);engine.current?.setEditable(!review);}
 };
 const restoreBackup=async(mode:'merge'|'replace')=>{
  if(!restorePreview||generationLocked.current||restoreBusy.current||leaving)return;
  if(mode==='replace'&&(!replaceArmed||!replaceAck))return;
  const preview=restorePreview;
  await withRestoreLock(async()=>{
   const next={schemaVersion:2 as const,docs:[...L.docs],quarantine:structuredClone(L.quarantine),activeId:L.activeId};
   const poses=structuredClone(poseLib.current!.presets);
   const report=mode==='merge'?mergeBackup(next,poses,preview):replaceLibrary(next,poses,preview);
   if(!next.docs.length){const doc=blankDocument(new Map(rigInfo.bones.map(b=>[b.name,new Vector3().fromArray(b.head)])),'新动作',newDocId('新动作'));next.docs=[doc];next.activeId=doc.id;}
   // A replace takes its content from the file alone, so an unseen save from
   // another tab must not abort it — it is captured in the restore point
   // instead. A merge is built from this page's data and still aborts.
   const result=await applyLibrary(next,poses,mode==='replace'?{build:buildRestorePoint}:undefined,mode==='replace'?'capture':'abort');
   if(mode==='replace'){
    const stored=await webPlatform.readStorage(RESTORE_POINT_KEY);
    const point=stored&&stored===result.restorePointText?parseBackup(stored):null;
    setRestorePoint(point?.ok?{savedAt:point.file.exportedAt,docs:point.docs.length,poses:point.poses.length}:null);
    if(!point?.ok){setReplaceArmed(null);setReplaceAck(false);finishRestore(report,mode);setError('替换已完成，但浏览器内恢复点校验失败；请使用替换前下载的 JSON 快照恢复。');return;}
   }
   setReplaceArmed(null);setReplaceAck(false);finishRestore(report,mode);
   if(mode==='replace'&&result.capturedConcurrent)setHint('已替换；其他页面刚保存的修改与替换前数据一并保存在恢复点，可「撤销替换」找回。');
  },'恢复未完成，原数据已保留');
 };
 const undoReplace=async()=>{
  if(!restorePoint||generationLocked.current||restoreBusy.current||leaving)return;
  if(!webPlatform.confirm('撤销替换会把动作库与自建姿态恢复为替换前的状态；当前动作若与恢复点不同，会移入隔离区，可恢复为副本。确定撤销？'))return;
  await withRestoreLock(async()=>{
   const stored=await webPlatform.readStorage(RESTORE_POINT_KEY);
   const point=stored?parseBackup(stored):null;
   if(!point?.ok)throw new Error('浏览器内恢复点不可用，请使用替换前下载的 JSON 快照');
   const lib=point.file.library;
   // Undo must not destroy what the replace brought in or what was edited
   // since: anything not already in the restore point stays recoverable.
   const kept=new Set(point.docs.map(doc=>JSON.stringify(doc)));
   const quarantine=structuredClone(lib.quarantine),seen=new Set(quarantine.map(q=>JSON.stringify(q)));
   const keep=(q:QuarantineEntry)=>{const text=JSON.stringify(q);if(!seen.has(text)){seen.add(text);quarantine.push(q);}};
   for(const q of L.quarantine)keep(structuredClone(q));
   for(const doc of L.docs)if(!kept.has(JSON.stringify(doc)))keep({id:doc.id,name:doc.name,reason:'撤销替换时的当前动作：可恢复为副本或导出 JSON',raw:structuredClone(doc)});
   const next={schemaVersion:2 as const,docs:point.docs,quarantine,activeId:point.docs.some(d=>d.id===lib.activeId)?lib.activeId:point.docs[0]?.id??''};
   if(!next.docs.length){const doc=blankDocument(new Map(rigInfo.bones.map(b=>[b.name,new Vector3().fromArray(b.head)])),'新动作',newDocId('新动作'));next.docs=[doc];next.activeId=doc.id;}
   // Poses have no quarantine: current poses absent from the point are kept.
   const poses=structuredClone(point.poses),poseIds=new Set(poses.map(p=>p.id)),poseTexts=new Set(poses.map(p=>JSON.stringify(p)));
   for(const pose of poseLib.current!.presets){
    if(poseTexts.has(JSON.stringify(pose)))continue;
    const copy=structuredClone(pose);let suffix=2;while(poseIds.has(copy.id))copy.id=`${pose.id}-copy-${suffix++}`;
    poseIds.add(copy.id);poses.push(copy);
   }
   // Clearing the point is part of the same commit: an undone restore must not
   // leave an undo offer behind. An empty restore point already means "none"
   // for every reader, so this writes ''. 
   await applyLibrary(next,poses,{build:()=>''});
   setRestorePoint(null);bump(v=>v+1);
   if(L.lastError){setError(`撤销已在当前页面生效，但保存失败：${L.lastError}。请立即导出 JSON 备份。`);return;}
   setError('');setHint(`已撤销替换：恢复 ${next.docs.length} 个动作、${poses.length} 个自建姿态；替换后的动作已移入隔离区。`);
  },'撤销未完成，当前数据已保留');
 };
 const restoreMerge=()=>void restoreBackup('merge');
 const restoreReplace=()=>void restoreBackup('replace');
 // Handoff actions: dismissing only clears the offer and the URL parameter.
 // Creation — from the card button OR the regular 从预设开始 — goes through
 // the flow below, which reconciles the offer when it creates the offered
 // preset, so the two entry points can never leave a stale card behind.
 const dismissHandoff=()=>{setHandoff(null);clearLabHandoff();};
 const createFromPreset=(id=presetId)=>{
  if(generationLocked.current||restoreBusy.current)return undefined;
  switchMode('edit');
  const source=L.active();
  const doc=L.createFromPreset(id,newName);
  books.current.of(doc.id).record(source);
  gate.current.reset();setNewName('');selectDoc(doc.id);
  const consumed=handoffConsumedByCreate(handoff,id);
  if(consumed)dismissHandoff();
  setHint(consumed&&compact
   ?`已创建可编辑副本「${doc.name}」；当前是审阅模式，点上方「编辑」即可拖动手柄修改。`
   :`已从预设创建「${doc.name}」，可拖动手柄或调整关键帧。`);
  // Phone: the auto-raised 动作 sheet covers the 3D view — once the offered
  // preset has been created, collapse it so the copy is actually visible.
  // Review-first stays the default; the hint points at the 编辑 switch.
  if(consumed&&compact)setSheet(null);
  return doc;
 };
 const acceptHandoff=()=>{
  if(!handoff||handoff.kind!=='preset'||generationLocked.current||restoreBusy.current)return;
  const doc=createFromPreset(handoff.file.id);
  if(doc)setPresetId(handoff.file.id);
 };
 // Phone layout: the offer lives in the 动作 sheet — raise it on entry for
 // every handoff that renders a card, so a handed-over external motion
 // (walk, baseball throw…) explains itself instead of hiding the card in a
 // closed sheet. Unknown ids raise nothing.
 useEffect(()=>{if(compact&&handoffHasCard(handoff))setSheet('left');},[]);
 // Mirror across x=0 (same motion on the other side): the mirrored document
 // enters the library as a NEW doc (the source stays untouched) carrying the
 // '.mirrored'/' · 镜像' markers, and becomes the active edit target. One undo
 // step is seeded on the new document's book — its first "previous state" is
 // the source it was mirrored from, so 撤销 lands back on the source.
 const mirrorActiveDoc=()=>{
  if(generationLocked.current||restoreBusy.current)return;
  const src=L.active(),m=mirrorDoc(src);
  while(L.docs.some(x=>x.id===m.id))m.id=newDocId(m.name); // a second mirror of the same source regenerates
  const added=L.add(m);
  books.current.of(added.id).record(src); // seed under the id that actually entered the library
  setSelected(sortedKeys(added)[0]?.id??'');
  engine.current?.setPlaying(false);engine.current?.seek(0);engine.current?.markDirty();
  bump(v=>v+1);setHint(`已生成镜像动作「${added.name}」——左右互换，原文档保留在动作库中。`);
 };
 const removeDoc=(id:string)=>{if(generationLocked.current||restoreBusy.current)return;const victim=L.docs.find(x=>x.id===id);if(victim&&!webPlatform.confirm(`删除动作「${victim.name}」？此操作不可撤销。`))return;L.remove(id);setSelected(sortedKeys(L.active())[0].id);engine.current?.seek(0);engine.current?.markDirty();bump(v=>v+1);};
 const selectKey=(id:string)=>{
  if(generationLocked.current)return;
  const key=keyAt(L.active(),id);if(!key)return;
  gate.current.reset();setSelected(id);engine.current?.setPlaying(false);engine.current?.seek(key.time);
  if(video.current&&key.videoTime!==undefined)video.current.currentTime=key.videoTime;
 };
 /** Structural clicks are separate undo steps, even when made rapidly. */
 const editKeyStructure=(fn:(doc:WorkshopDoc)=>void)=>{
  if(generationLocked.current)return;
  gate.current.reset();edit(fn);gate.current.reset();wristEpoch.current++;
 };
 const insertAt=(time:number,duration=d.duration)=>{
  if(generationLocked.current||!info||!Number.isFinite(time)||!Number.isFinite(duration))return;
  const ceiling=duration-(d.loop?WORKSHOP_LIMITS.loopGap:0),t=Math.max(0,Math.min(ceiling,time));
  const existing=nearestKey(d,t,1e-6);
  if(existing){selectKey(existing.id);setHint('该时间已有关键帧，已选中；可使用“在选中帧后插入”新增。');return;}
  if(d.keys.length>=WORKSHOP_LIMITS.maxKeys){setHint(`已达 ${WORKSHOP_LIMITS.maxKeys} 个关键帧上限，请先删除不再需要的关键帧。`);return;}
  editKeyStructure(doc=>{
   doc.duration=duration;
   const key=ensureKey(doc,t,engine.current!.restRoot(),1e-6);
   if(key)key.label='新关键帧';
  });
  const added=nearestKey(d,t,1e-6);if(added)selectKey(added.id);
 };
 const addKey=()=>insertAt(engine.current?.time??frame.time);
 const insertAfterKey=()=>{if(insertTime!==undefined)insertAt(insertTime,insertDuration);};
 /** One-click basic action: the button IS the preset. One ripple edit, one
  * undo step; carry-hands templates move the hand targets on top of the
  * playhead state (wrist orientation untouched). */
 const insertBasicPreset=(p:(typeof BASIC_PRESETS)[number])=>{
  const e=engine.current,basicDoc=p.document;
  if(generationLocked.current||!info||!basicDoc||!e)return;
  const time=e.time,refusal=basicInsertRefusal(d,basicDoc,time);
  if(refusal){setHint(refusal);return;}
  const box:{value?:BasicInsertion}={};
  editKeyStructure(doc=>{box.value=insertBasicAction(doc,basicDoc,time,e.restRoot(),{carryHands:p.carryHands===true});});
  const inserted=box.value;
  if(!inserted){setHint('插入失败：请调整时刻后重试。');return;}
  selectKey(inserted.keyIds[0]);
  setHint(`已在 ${inserted.time.toFixed(2)}s 插入「${p.name}」，后续关键帧后移 ${inserted.span.toFixed(2)}s。`);
 };
 /** Quick racket: one click turns grip on for every key (the racket follows
  * the gripping hand) or takes it off; one structural undo step. */
 const setGrip=(side:'L'|'R'|null)=>{
  if(generationLocked.current)return;
  editKeyStructure(doc=>{
   if(side)doc.gripSide=side;else delete doc.gripSide;
   for(const k of doc.keys)k.constraints.grip=side!==null;
  });
  setHint(side?`已切换为${side==='L'?'左':'右'}手持拍：所有关键帧显示球拍，可撤销。`:'已卸下球拍：所有关键帧不再握拍，可撤销。');
 };
 /** 我的姿态：capture the selected key's full pose (arms included) as a
  * reusable one-click preset, Blender/Houdini pose-library style. */
 const capturePose=async()=>{
  const k=sel;if(!k||restoreBusy.current)return;
  const name=webPlatform.prompt('给这个姿态起个名字：');
  if(name===null)return;
  const preset=poseLib.current!.add(name,k.pose);
  await poseLib.current!.saved;bump(v=>v+1);
  setHint(poseLib.current!.lastError
   ?`姿态「${preset.name}」未保存（仅存于本页内存）：${poseLib.current!.lastError}`
   :`已保存姿态「${preset.name}」，之后在任何动作里一键应用。`);
 };
 /** Apply a captured pose at the playhead: an existing key there is
  * overwritten; otherwise a new key carries the pose. One structural undo.
  * The limit is prechecked BEFORE the history snapshot so a refused apply
  * never consumes an undo step. */
 const applyUserPose=(p:UserPosePreset)=>{
  const e=engine.current;
  if(generationLocked.current||restoreBusy.current||!e)return;
  const time=e.time;
  if(!nearestKey(d,time,.02)&&d.keys.length>=WORKSHOP_LIMITS.maxKeys){
   setHint(`已达 ${WORKSHOP_LIMITS.maxKeys} 个关键帧上限，且播放头处没有可覆盖的关键帧；请先删除不需要的帧。`);return;
  }
  let report:PoseApplyReport|undefined;
  editKeyStructure(doc=>{report=applyPoseAt(doc,p.pose,time,e.restRoot());});
  if(!report){setHint('应用失败：请调整时刻后重试。');return;}
  const notes=[];
  if(report.heldFoot.length)notes.push(`${report.heldFoot.map(s=>s==='L'?'左':'右').join('、')}脚在支撑锁定区间内，脚部目标保持支撑锚点、膝盖方向已更新（要移动支撑脚请先释放该帧支撑）`);
  if(report.liftoffFoot.length)notes.push(`${report.liftoffFoot.map(s=>s==='L'?'左':'右').join('、')}脚是离地边界：离地瞬间仍从原接触点起步，新目标塑造离地后的摆动路径，脚尖朝向仍跟随支撑接触`);
  setHint(`${report.result==='replaced'?`已把当前帧姿态替换为「${p.name}」（约束不变）`:`已在播放头插入「${p.name}」姿态帧`}，可撤销${notes.length?`；${notes.join('；')}`:''}。`);
 };
 const removeUserPose=async(id:string)=>{
  if(restoreBusy.current)return;
  const p=poseLib.current!.presets.find(x=>x.id===id);if(!p)return;
  if(!webPlatform.confirm(`删除姿态「${p.name}」？此操作不可撤销。`))return;
  poseLib.current!.remove(id);await poseLib.current!.saved;bump(v=>v+1);if(poseLib.current!.lastError)setError(`姿态删除未保存：${poseLib.current!.lastError}`);
 };
 /** Session pose clipboard: copy one key's full pose, paste onto another. */
 const copyPose=()=>{
  const k=sel;if(!k)return;
  poseClipboard.current=JSON.parse(JSON.stringify(k.pose));
  setHint(`已复制「${k.label||'关键帧'}」的姿态（含手臂）：换帧或换动作后可粘贴。`);
 };
 const pastePose=()=>{
  const k=sel,src=poseClipboard.current;
  if(!k||!src||generationLocked.current)return;
  const e=engine.current;
  const box:{stamp:PoseStampReport}={stamp:{heldFoot:[],liftoffFoot:[]}};
  // Locate + re-solve like editAtKey so the paste is immediately visible,
  // and one structural undo step per paste (no gate merging of rapid pastes).
  e?.setPlaying(false);e?.seek(k.time);
  editKeyStructure(doc=>{
   const key=keyAt(doc,k.id)!;
   box.stamp=stampPoseIntoKey(doc,key,src);
  });
  setSelected(k.id);e?.solveCurrent();
  const parts=[];
  if(box.stamp.heldFoot.length)parts.push(`${box.stamp.heldFoot.map(s=>s==='L'?'左':'右').join('、')}脚在支撑锁定区间内，脚部目标保持支撑锚点、膝盖方向已更新（要移动支撑脚请先释放该帧支撑）`);
  if(box.stamp.liftoffFoot.length)parts.push(`${box.stamp.liftoffFoot.map(s=>s==='L'?'左':'右').join('、')}脚是离地边界：离地瞬间仍从原接触点起步，新目标塑造离地后的摆动路径，脚尖朝向仍跟随支撑接触`);
  setHint(`已把复制的姿态粘贴到「${k.label||'关键帧'}」并定位到该帧（可撤销）${parts.length?`；${parts.join('；')}`:''}。`);
 };
 /** In-place mirror of the selected key's pose (left/right hands, feet and
  * plant flags swap) — the per-key half of 镜像动作, one undo step. Refused
  * when the two hands use different coordinate systems (the mirror would
  * reinterpret the other keys' hand targets). gripSide is a document-level
  * property: the racket stays on its current hand, because flipping it here
  * would silently re-interpret every OTHER key's grip too. */
 const mirrorSelectedPose=()=>{
  const k=sel;if(!k)return;
  if(d.handFrames.L!==d.handFrames.R){setHint('左右手坐标系不同，无法原位镜像该帧姿态；可先用「镜像动作」生成整档镜像。');return;}
  const mirrored=mirrorKey(k);
  edit(doc=>{
   const key=keyAt(doc,k.id)!;
   key.pose=mirrored.pose;
   key.constraints=mirrored.constraints;
  });
  setHint('已镜像当前帧姿态：左右手脚与支撑互换（可撤销）。球拍仍挂在原握拍侧的手上；要整档换握拍侧请用「镜像动作」。');
 };
 const duplicateKey=(id:string)=>{
  if(generationLocked.current)return;
  const source=keyAt(d,id);if(!source)return;
  if(d.keys.length>=WORKSHOP_LIMITS.maxKeys){setHint(`已达 ${WORKSHOP_LIMITS.maxKeys} 个关键帧上限，请先删除不再需要的关键帧。`);return;}
  const index=orderedKeys.findIndex(k=>k.id===id),slot=keyframeInsertSlot(d,source.time,orderedKeys[index+1]?.time);
  if(!slot){setHint('此帧后没有可用时间；请先调整关键帧时间或动作时长。');return;}
  const copy=copyKeyframe(d,source,slot.time);
  editKeyStructure(doc=>{doc.duration=slot.duration;doc.keys.push(copy);doc.keys.sort((a,b)=>a.time-b.time);});
  selectKey(copy.id);
 };
 const delKey=(id:string)=>{
  if(generationLocked.current||d.keys.length<=2||!keyAt(d,id))return;
  const index=orderedKeys.findIndex(k=>k.id===id);
  editKeyStructure(doc=>{removeKeyframe(doc,id);});
  selectKey((keyAt(d,selected)??d.keys[Math.min(index,d.keys.length-1)]).id);
 };
 const reorderKey=(id:string,to:number)=>{
  if(generationLocked.current)return;
  const from=orderedKeys.findIndex(k=>k.id===id);
  if(from<0||from===to||to<0||to>=orderedKeys.length||!Number.isInteger(to))return;
  editKeyStructure(doc=>{moveKeyframe(doc,id,to);});selectKey(id);
 };
 const changeKeyTime=(id:string,time:number,discrete=true)=>{
  if(generationLocked.current)return;
  const problem=keyframeTimeProblem(d,id,time);
  if(problem){if(discrete)setHint(problem);return;}
  const key=keyAt(d,id)!;if(key.time===time)return;
  const write=(doc:WorkshopDoc)=>{key.time=time;doc.keys.sort((a,b)=>a.time-b.time);};
  if(discrete)editKeyStructure(write);else edit(write);
  setSelected(id);engine.current?.seek(time);
 };
 const exportDoc=(doc:WorkshopDoc=d)=>download(`${doc.id}.workshop.json`,new Blob([serializeDoc(doc)],{type:'application/json'}));
 const unlockGeneration=()=>{
  generationLocked.current=false;
  const e=engine.current;e?.setOptions({handles:opts.handles});e?.setPlaying(false);e?.markDirty();
 };
 const stopGeneration=()=>{
  const worker=generationWorker.current;
  if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();generationWorker.current=null;}
  generationPreview.current=null;setCandidateSession(null);setGenerationReport(null);setGenerationBusy(false);setGenerationProgress(null);setGenerationError('');
  unlockGeneration();setHint('已取消候选生成或预览；源动作仍保持原样。');
 };
 L.onSaveState=merged=>{if(merged)syncLibrary.current(true);bump(v=>v+1);};
 syncLibrary.current=async(force=false)=>{
  if(restoreBusy.current)return;
  const rest=new Map(rigInfo.bones.map(b=>[b.name,new Vector3().fromArray(b.head)]));
  try{if(!force){const snapshotText=await webPlatform.readStorage(LIBRARY_KEY);if(restoreBusy.current)return;if(!L.sync(new MotionLibrary(rest,webPlatform.storage).load({readOnly:true,snapshotText})))return;}}catch(err){setError(err instanceof Error?err.message:String(err));return;}
  if(restoreBusy.current)return;
  if(generationLocked.current)stopGeneration();
  if(!L.docs.length){L.docs=[blankDocument(rest,'新动作',newDocId('新动作'))];L.activeId=L.docs[0].id;}
  gate.current.reset();wristEpoch.current++;setSelected(sortedKeys(L.active())[0].id);
  engine.current?.setPlaying(false);engine.current?.seek(0);engine.current?.markDirty();bump(v=>v+1);
  setHint('已同步其他页面保存或删除的动作。');
 };
 useEffect(()=>{
  const sync=async(event:StorageEvent)=>{if(restoreBusy.current)return;if(event.key===POSE_LIBRARY_KEY||event.key===null){await poseLib.current!.saved;if(restoreBusy.current)return;const snapshotText=await webPlatform.readStorage(POSE_LIBRARY_KEY);if(restoreBusy.current)return;poseLib.current!.load({snapshotText});bump(v=>v+1);}if(event.key===LIBRARY_KEY||event.key===null)syncLibrary.current();};
  const checkpoint=()=>{if(!restoreBusy.current)L.checkpoint();};
  const unload=(event:BeforeUnloadEvent)=>{if(restoreBusy.current){event.preventDefault();event.returnValue='';return;}L.checkpoint();if(L.saveState!=='saved'||poseLib.current!.saveState!=='saved'){event.preventDefault();event.returnValue='';}};
  const hidden=()=>{if(document.visibilityState==='hidden')checkpoint();};
  window.addEventListener('storage',sync);window.addEventListener('beforeunload',unload);window.addEventListener('pagehide',checkpoint);document.addEventListener('visibilitychange',hidden);
  return()=>{window.removeEventListener('storage',sync);window.removeEventListener('beforeunload',unload);window.removeEventListener('pagehide',checkpoint);document.removeEventListener('visibilitychange',hidden);L.onSaveState=undefined;};
 },[]);
 const returnToLab=async()=>{
  if(leaving||restoreBusy.current)return;L.checkpoint();
  const state=L.saveState;if(state==='saved'&&poseLib.current!.saveState==='saved'){webPlatform.navigate('/');return;}
  setLeaving(true);await L.save();
  let pending:Promise<void>;do{pending=L.saved;await pending;}while(pending!==L.saved);
  do{pending=poseLib.current!.saved;await pending;}while(pending!==poseLib.current!.saved);
  if(L.saveState!=='saved'||poseLib.current!.saveState!=='saved'){setLeaving(false);if(poseLib.current!.lastError)setError(`姿态尚未保存：${poseLib.current!.lastError}，请先备份。`);return;}
  webPlatform.navigate('/');
 };
 const recoverQuarantine=(index:number)=>{
  if(restoreBusy.current)return;
  try{
   const copy=parseDoc(L.quarantineText(index));copy.id=newDocId(copy.name);copy.name+=' 恢复副本';
   copy.keys.forEach((k,i)=>{k.id=`${copy.id}-k${i}`;});
   const added=L.add(copy);selectDoc(added.id);setHint('已恢复为独立副本；原稿仍可导出。');
  }catch(err){setError(`无法恢复，请导出后修复：${err instanceof Error?err.message:String(err)}`);}
 };
 const failGeneration=(message:string)=>{
  const worker=generationWorker.current;
  if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();generationWorker.current=null;}
  generationPreview.current=null;setCandidateSession(null);setGenerationBusy(false);setGenerationProgress(null);setGenerationError(message);unlockGeneration();
 };
 const startGeneration=()=>{
  if(generationLocked.current||restoreBusy.current)return;
  const source=JSON.parse(JSON.stringify(d)) as WorkshopDoc;
  generationLocked.current=true;generationPreview.current=null;setGenerationError('');setGenerationReport(null);setCandidateSession(null);setGenerationBusy(true);
  setGenerationProgress({evals:0,maxEvals:120,phase:'loading'});
  engine.current?.setPlaying(false);engine.current?.setOptions({handles:false});
  let worker:Worker;
  try{const w=webPlatform.createWorker(new URL('./generate.worker.ts',import.meta.url));if(!w)throw new Error('此环境不支持后台生成');worker=w;}
  catch(error){failGeneration(error instanceof Error?error.message:String(error));return;}
  generationWorker.current=worker;
  worker.onmessage=(event:MessageEvent<GenerateWorkerReply>)=>{
   if(generationWorker.current!==worker)return;
   const message=event.data;
   if(message.type==='progress'){setGenerationProgress(message.progress);return;}
   if(message.type==='error'){failGeneration(message.message);return;}
   worker.terminate();generationWorker.current=null;setGenerationBusy(false);setGenerationProgress(null);
   setGenerationReport({source,result:message.result});
   const candidate=message.result.candidates[0];
   if(candidate){
    const session={source,candidate,result:message.result};
    setCandidateSession(session);setPreviewSide('candidate');generationPreview.current=candidate.doc;
    engine.current?.setPlaying(false);engine.current?.markDirty();
   }else{
    unlockGeneration();setHint(message.result.rejected[0]?.reason??'本次搜索没有产生可审阅的候选动作。');
   }
  };
  worker.onerror=event=>{event.preventDefault();failGeneration(event.message||'优化 Worker 发生错误');};
  worker.onmessageerror=()=>failGeneration('优化 Worker 返回的数据无法读取');
  try{worker.postMessage({type:'generate',doc:source,lockedKeyIds:lockedIds,adjust:{...adjustKinds,groups:['trunk','handL','handR','footL','footR'] satisfies ChannelGroup[]}});}
  catch(error){failGeneration(error instanceof Error?error.message:String(error));}
 };
 const keepCandidate=(downloadJson=false)=>{
  if(!candidateSession||generationBusy||restoreBusy.current)return;
  const {source,candidate}=candidateSession;
  const kept=JSON.parse(JSON.stringify(candidate.doc)) as WorkshopDoc;
  kept.name=`${source.name} · 候选`;
  kept.english=`${source.english} candidate`;
  let id=newDocId(kept.name);while(L.docs.some(x=>x.id===id))id=newDocId(kept.name);
  kept.id=id;kept.keys.forEach((k,i)=>{k.id=`${id}-k${i}`;});
  const added=L.add(kept);
  books.current.of(added.id).record(source);
  generationPreview.current=null;setCandidateSession(null);setGenerationReport(null);setGenerationError('');setGenerationProgress(null);generationLocked.current=false;
  setSelected(sortedKeys(added)[0]?.id??'');engine.current?.setOptions({handles:opts.handles});engine.current?.setPlaying(false);engine.current?.seek(Math.min(frame.time,added.duration));engine.current?.markDirty();
  bump(v=>v+1);setHint(`已将候选保留为新动作「${added.name}」；源动作仍保留在动作库中。`);
  if(downloadJson)exportDoc(added);
 };
 // Solve + hash + validate locally — the same pipeline the service runs for
 // POST /v1/motions {workshop-doc}, so the downloaded bytes equal the service
 // response for this document. The builder snapshots the doc itself, but the
 // playhead is paused first so a playing frame can't move the read pose.
 // Shared by every package-derived export; returns the artifact on success and
 // reports otherwise (422 problems persist on the card until the next attempt).
 const solvePackage=async():Promise<PosePackage|null>=>{
  const e=engine.current;
  if(!e?.rig){setHint('模型尚未加载完成，无法导出。');return null;}
  e.setPlaying(false);
  manifestRef.current??=await buildManifestLocal(rigInfo);
  const res=await buildPosePackageLocal(d,exportFps,{rig:e.rig,manifest:manifestRef.current});
  if(res.status===200){setPkgProblems(null);return res.body;}
  if(res.status===422){
   // Rejected artifacts do not exist — nothing downloads. The validator's
   // problems stay listed in the card until the next export attempt.
   setPkgProblems({doc:d.id,items:res.body.error.details??[res.body.error.message]});
  }else{setPkgProblems(null);setHint(res.body.error.message);}
  return null;
 };
 // Download filenames borrow the doc/artifact ids; an imported document's id
 // can carry filesystem-hostile characters, and browsers sanitize download
 // names differently — strip the portable-hostile set here (keeps the CJK
 // slugs newDocId produces; a broader \w-class strip would mangle them).
 const safeName=(name:string)=>name.replace(/[\\/:*?"<>|]/g,'_');
 const download=(name:string,blob:Blob)=>webPlatform.download(safeName(name),blob);
 const exportPackage=async()=>{
  setExporting(true);
  try{
   const pkg=await solvePackage();if(!pkg)return;
   // Content-addressed name: the doc and the artifact id both address content.
   download(`${d.id}.${pkg.id}.pose.json`,new Blob([JSON.stringify(pkg)],{type:'application/json'}));
   setHint(`已导出姿态包 ${pkg.id}（${exportFps} fps · ${pkg.timeline.count} 帧）`);
  }catch(err){setHint(err instanceof Error?err.message:String(err));}
  finally{setExporting(false);}
 };
 // GLB is a DERIVED view of the same artifact: it carries no identity
 // contract — the clip name (animations[0].name, posePackageToClip's
 // self-describing default) and the filename both borrow the artifact id
 // for correspondence only, never as a content-addressed claim.
 const exportGlbFile=async()=>{
  setExporting(true);
  try{
   const pkg=await solvePackage();if(!pkg)return;
   // Clean re-parse of the shipped model — the live rig wears the racket prop
   // and swapped materials, so exporting it would bake editor state into the
   // file (node TRS, extra meshes). GLTFExporter itself stays out of the
   // bundle: exportGlb dynamic-imports it on demand.
   const resp=await webPlatform.fetchAsset('/models/human.glb');
   if(!resp.ok)throw new Error(`模型请求失败：${resp.status}`);
   const gltf=await new GLTFLoader().parseAsync(await resp.arrayBuffer(),'');
   const glb=await exportGlb(gltf.scene,posePackageToClip(pkg));
   download(`${d.id}.${pkg.id}.glb`,new Blob([glb],{type:'model/gltf-binary'}));
   setHint(`已导出 GLB（${exportFps} fps · ${pkg.timeline.count} 帧）——派生品不承载身份契约（动画名与文件名借用制品 id 便于对应），身份以同名 ${pkg.id} 姿态包为准`);
  }catch(err){setHint(err instanceof Error?err.message:String(err));}
  finally{setExporting(false);}
 };
 // WP-D fixed-camera render export: the engine owns the whole pause →
 // snapshot → seek+solve+render+toBlob → restore dance (captureStill /
 // captureSheet), so a render never disturbs playback, view or overlay state;
 // the app only turns the returned PNG blob into a named download. No !info
 // gate — like solvePackage, a premature click lands on the engine's own
 // readable error.
 const exportStill=async()=>{
  const e=engine.current;if(!e){setHint('模型尚未加载完成，无法导出。');return;}
  setExporting(true);
  try{
   const t=e.time;
   download(`${d.id}.t${t.toFixed(2)}.png`,await e.captureStill(t));
   setHint(`已导出静帧 t=${t.toFixed(2)}s（640×720 · 固定 45° 相机 · 无编辑器叠加物）`);
  }catch(err){setHint(err instanceof Error?err.message:String(err));}
  finally{setExporting(false);}
 };
 const exportSheet=async()=>{
  const e=engine.current;if(!e){setHint('模型尚未加载完成，无法导出。');return;}
  setExporting(true);
  try{
   download(`${d.id}.sheet.png`,await e.captureSheet());
   setHint('已导出关键帧拼图（每格 640×720 · 固定 45° 相机 · 无编辑器叠加物）');
  }catch(err){setHint(err instanceof Error?err.message:String(err));}
  finally{setExporting(false);}
 };
 // Motion-file envelopes unwrap to their embedded WorkshopDoc first — a bare
 // envelope's schemaVersion:1 is the ENVELOPE revision, not a document one;
 // clip-motion envelopes carry no document and unwrap throws a readable error.
 const importDoc=async(f:File)=>{try{if(f.size>MAX_BACKUP_BYTES)throw new Error('动作文件过大（上限 64 MB）。');const text=await f.text();if(restoreBusy.current)return;const next=normalizeDoc(unwrapMotionFile(JSON.parse(text)));const added=L.add(next);selectDoc(added.id);}catch(e){setError(e instanceof Error?e.message:String(e));}};
 const loadVideo=(f:File)=>{if(videoUrl)URL.revokeObjectURL(videoUrl);setVideoUrl(URL.createObjectURL(f));};
 const alignVideo=()=>{if(video.current)syncOffset.current=video.current.currentTime-frame.time;};
 const stampVideo=()=>{if(video.current)editSelected(k=>{k.videoTime=video.current!.currentTime;});};
 const switchMode=(next:'review'|'edit')=>{if(restoreBusy.current)return;setMode(next);engine.current?.setEditable(next==='edit');if(next==='edit'){if(compact)setSheet('right');else inspectorPanel.current?.resize('340px');}};
 const stepKey=(dir:-1|1)=>{
  const ks=sortedKeys(d),t=frame.time;
  const k=dir>0?ks.find(x=>x.time>t+1e-6)??ks[0]:[...ks].reverse().find(x=>x.time<t-1e-6)??ks.at(-1);
  if(k)selectKey(k.id);
 };
 const setOpt=(patch:Partial<typeof opts>)=>{setOpts(o=>({...o,...patch}));engine.current?.setOptions(patch);};
 /** Semantic edits preview by swapping the active document for a candidate
  * computed from one fixed base; history records the base once per transaction. */
 const semanticRecorded=useRef(false);
 const semanticHost:SemanticHost={
  context:()=>{
   const e=engine.current,k=sel;
   if(!e?.rig||!k||generationLocked.current||restoreBusy.current)return null;
   return {rig:e.rig,doc:L.active(),keyId:k.id,origin:e.restRoot(),pelvisShift:()=>e.pelvisShiftAt(k.time)};
  },
  begin:base=>{semanticRecorded.current=books.current.of(base.id).record(base);gate.current.reset();engine.current?.setPlaying(false);},
  write:next=>{
   const i=L.docs.findIndex(x=>x.id===next.id);if(i<0||generationLocked.current||restoreBusy.current)return;
   L.docs[i]=JSON.parse(JSON.stringify(next)) as WorkshopDoc;L.save();
   const e=engine.current,k=keyAt(L.docs[i],selected);
   e?.setPlaying(false);e?.markDirty();if(k)e?.seek(k.time);bump(v=>v+1);
  },
  cancel:base=>{if(restoreBusy.current)return;semanticHost.write(base);if(semanticRecorded.current)books.current.of(base.id).dropLast();semanticRecorded.current=false;bump(v=>v+1);},
  commit:()=>{if(restoreBusy.current)return;semanticRecorded.current=false;gate.current.reset();L.save();bump(v=>v+1);},
 };
 const addNote=()=>{
  if(!sel)return;
  setNotes(n=>[...n,{id:`n${Date.now().toString(36)}${n.length}`,docId:d.id,keyId:sel.id,keyLabel:sel.label||`关键帧 ${selectedKeyIndex+1}`,time:Number(sel.time.toFixed(3)),view:engine.current?.view??view,...noteDraft,text:noteDraft.text.trim()}]);
  setNoteDraft(x=>({...x,text:''}));
 };
 const docNotes=notes.filter(n=>n.docId===d.id);
 const feedbackText=()=>JSON.stringify({kind:'h3d-review-feedback',version:1,doc:{id:d.id,name:d.name,duration:d.duration},notes:docNotes.map(({docId:_,...n})=>n)},null,2);
 const copyFeedback=async()=>{
  const text=feedbackText();
  if(await webPlatform.clipboardWrite(text)){setHint(`已复制 ${docNotes.length} 条审阅反馈（JSON）。`);}else{download(`${d.id}.review.json`,new Blob([text],{type:'application/json'}));setHint('剪贴板不可用，已改为下载审阅反馈 JSON。');}
 };
 const videoEl=videoUrl?<video ref={video} src={videoUrl} muted loop playsInline onPlay={()=>setVideoPlaying(true)} onPause={()=>setVideoPlaying(false)}/>:null;
 const sheetHead=(title:string)=><div className="ws-sheet-head"><strong>{title}</strong><button type="button" aria-label="关闭面板" onClick={()=>setSheet(null)}><X size={18}/></button></div>;
 return <div inert={restoring} aria-busy={restoring} className={`ws-shell ${generationLockedUi?'ws-generation-locked':''} ${compact?'ws-compact':''} ${sheet?`ws-sheet-${sheet}`:''} ws-mode-${mode}`} data-mode={mode}>
  <header className="ws-header">
   <div className="brand"><Activity size={25} strokeWidth={2}/><span>KINESIS</span><i/><h1>动作工作台</h1><small>关键帧动作编辑器</small></div>
   <nav><a href="/" className="ws-back" aria-disabled={leaving} onClick={e=>{e.preventDefault();void returnToLab();}}><ArrowLeft size={14}/>返回实验室</a></nav>
   <div className="ws-save-state" data-testid="save-state" data-state={L.saveState} role="status" aria-live="polite"><span>{L.saveState==='error'?`保存失败：${L.lastError}`:L.saveState==='saving'?leaving?'保存中 · 完成后返回实验室…':'保存中…':'已保存到本机'}</span>{L.saveState!=='saved'?<button type="button" onClick={()=>exportDoc()}><Download size={12}/>导出当前动作 JSON</button>:null}</div>
  </header>
  <Group groupRef={panelGroup} orientation="horizontal" className="ws-main" id="workshop-panes">
   <Panel id="ws-library" panelRef={libraryPanel} collapsible collapsedSize={0} onResize={size=>setLibraryOpen(size.inPixels>1)} className="ws-library-panel" defaultSize={0} minSize={280} maxSize={420}><aside className="ws-left" aria-label="动作与关键帧">
    {sheetHead('动作 · 关键帧 · 参考')}
    {handoffHasCard(handoff)?<section className="ws-card ws-handoff" data-testid="lab-handoff" inert={generationLockedUi}>
     {handoff.kind==='preset'?<>
      <h2>来自实验室 <small>{handoff.file.english}</small></h2>
      <p className="ws-handoff-name">{handoff.file.name}</p>
      <p className="ws-note">创建一份新的可编辑副本开始调整；动作库预设与已有动作都不会被改动。</p>
      <div className="ws-row">
       <button type="button" data-testid="lab-handoff-create" onClick={acceptHandoff}><Plus size={13}/>创建可编辑副本</button>
       <button type="button" data-testid="lab-handoff-dismiss" onClick={dismissHandoff}><X size={13}/>暂不需要</button>
      </div>
     </>:handoff.kind==='external'?<>
      <h2>来自实验室 <small>{handoff.file.english}</small></h2>
      <p className="ws-handoff-name">{handoff.file.name}</p>
      <p className="ws-note">{handoff.file.kind==='dynamics-motion'?'此动作是肌骨正向仿真回放，没有工作台关键帧，暂不支持编辑；可在实验室继续观察。':'此动作是外部剪辑动画，没有工作台关键帧，暂不支持编辑。'}</p>
      <div className="ws-row"><button type="button" data-testid="lab-handoff-dismiss" onClick={dismissHandoff}>知道了</button></div>
     </>:null}
    </section>:null}
    <section className="ws-card" inert={generationLockedUi}><h2>动作库 <small>{L.docs.length} 个动作</small></h2>
     <LibraryList docs={L.docs} activeId={d.id} onSelect={selectDoc} onDuplicate={duplicateDoc} onRemove={removeDoc} onReorder={(active,over)=>{if(restoreBusy.current||generationLocked.current)return;L.reorder(active,over);bump(v=>v+1);}}/>
     <div className="ws-row">
      <input className="ws-newname" aria-label="新动作名称" value={newName} placeholder="新动作名称（可选）…" onChange={e=>setNewName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')createDoc();}}/>
      <button onClick={createDoc}><Plus size={13}/>新建</button>
     </div>
     <div className="ws-row"><button type="button" data-testid="save-to-library" onClick={saveToLibrary}><Save size={13}/>保存到动作库</button></div>
     <div className="ws-sub"><h3>导入 / 导出 / 备份</h3>
      <div className="ws-row">
       <button type="button" data-testid="motion-import" onClick={()=>importRef.current?.click()}><Upload size={13}/>导入动作</button>
       <button type="button" data-testid="motion-export" onClick={()=>exportDoc()}><Download size={13}/>导出动作</button>
       <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void importDoc(f);e.target.value='';}}/>
      </div>
      <div className="ws-row">
       <button type="button" data-testid="backup-download" onClick={exportBackup}><Package size={13}/>备份全部</button>
       <button type="button" data-testid="backup-restore" onClick={()=>backupRef.current?.click()}><Upload size={13}/>从备份恢复</button>
       <input ref={backupRef} type="file" accept=".json,application/json" hidden onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void chooseRestore(f);}}/>
      </div>
      <p className="ws-note">「导出动作」是单个可编辑 JSON；「备份全部」把动作、自建姿态和可恢复数据打包成一个文件，换设备时用它恢复。</p>
      {restorePreview?<div className="ws-restore" data-testid="backup-preview">
       <h4>恢复备份 <small>{new Date(restorePreview.file.exportedAt).toLocaleString()}</small></h4>
       <p className="ws-note">{restorePreview.docs.length} 个动作 · {restorePreview.poses.length} 个姿态 · {restorePreview.file.library.quarantine.length} 条可恢复数据{restorePreview.invalidDocs.length?` · ${restorePreview.invalidDocs.length} 条无法识别（恢复时隔离）`:''}。</p>
       <ul className="ws-restore-list">{restorePreview.docs.slice(0,6).map(doc=><li key={doc.id}>{doc.name}</li>)}{restorePreview.docs.length>6?<li>… 共 {restorePreview.docs.length} 个动作</li>:null}</ul>
       {replaceArmed?<div className="ws-replace-confirm" data-testid="backup-replace-confirm" role="group" aria-label="确认替换全部">
        <p className="ws-note">已请求下载当前数据快照 <code>{replaceArmed}</code>。浏览器可能拦截或询问保存位置，请先确认文件已出现在下载目录中。</p>
        <label className="ws-check"><input type="checkbox" data-testid="backup-replace-ack" checked={replaceAck} onChange={e=>setReplaceAck(e.target.checked)}/><span>我已确认快照文件已保存并可打开</span></label>
        <p className="ws-note">替换还会在浏览器内保留一个恢复点，可随时「撤销替换」；隔离数据始终保留。</p>
        <div className="ws-row">
         <button type="button" data-testid="backup-replace-commit" className="danger" disabled={!replaceAck} onClick={restoreReplace}>确认替换全部</button>
         <button type="button" data-testid="backup-replace-redownload" onClick={armReplace}><Download size={12}/>重新下载快照</button>
         <button type="button" data-testid="backup-cancel" onClick={cancelRestore}>取消</button>
        </div>
       </div>:<>
        <div className="ws-row">
         <button type="button" data-testid="backup-merge" onClick={restoreMerge}>合并导入（保留现有）</button>
         <button type="button" data-testid="backup-replace" onClick={armReplace}>替换全部…</button>
         <button type="button" data-testid="backup-cancel" onClick={cancelRestore}>取消</button>
        </div>
        <p className="ws-note">「替换全部」先下载当前数据的快照，确认文件已保存后才能替换；无论哪种方式，隔离数据都不会丢。</p>
       </>}
      </div>:null}
      {restorePoint&&!restorePreview?<div className="ws-restore" data-testid="restore-point">
       <h4>替换前的恢复点 <small>{new Date(restorePoint.savedAt).toLocaleString()}</small></h4>
       <p className="ws-note">{restorePoint.docs} 个动作 · {restorePoint.poses} 个姿态，已保存在本机浏览器，刷新后仍可撤销。</p>
       <div className="ws-row"><button type="button" data-testid="restore-point-undo" onClick={()=>void undoReplace()}><Undo2 size={12}/>撤销替换</button></div>
      </div>:null}
     </div>
     <p className="ws-note" style={L.lastError?{color:'var(--red)'}:undefined}>{L.lastError?`保存未完成：${L.lastError}`:'动作自动保存到本机浏览器；导出 JSON 可跨设备分享。'}</p>
     {L.quarantine.length?<div className="ws-quarantine"><p className="ws-note" style={{color:'var(--red)'}}>{L.quarantine.length} 个恢复稿或隔离项，尚未参与播放。可恢复为副本或导出后修复。</p>
      {L.quarantine.map((q,i)=><div key={`${q.id}-${i}`} className="ws-row"><small>{q.name||q.id||'未命名'}：{q.reason}</small><button onClick={()=>recoverQuarantine(i)}>恢复为副本</button><button onClick={()=>exportQuarantine(i)}><Download size={12}/>导出</button><button aria-label={`丢弃 ${q.name||q.id}`} onClick={()=>{if(restoreBusy.current||generationLocked.current)return;if(confirm('丢弃这个隔离动作？此操作不可撤销。'))L.discardQuarantine(i);bump(v=>v+1);}}><Trash2 size={12}/></button></div>)}
     </div>:null}
    </section>
    <section className="ws-card" inert={generationLockedUi||review} aria-label="快速插入"><h2>快速插入 <small>播放头一键</small></h2>
     <div className="ws-quick-poses" role="group" aria-label="快速姿态（一键插入）">
      <span className="ws-quick-label">姿态</span>
      {BASIC_PRESETS.map(p=>{
       const refusal=info&&p.document?basicInsertRefusal(d,p.document,frame.time):undefined;
       return <button key={p.id} type="button" data-testid={`basic-insert-${p.id}`} disabled={!info||!p.document||!!refusal}
        title={refusal??`在当前帧一键插入「${p.name}」：从播放头姿态开始变化，后续关键帧整体后移，可撤销`}
        onClick={()=>insertBasicPreset(p)}>{p.name}</button>;
      })}
     </div>
     <div className="ws-quick-poses" role="group" aria-label="球拍（一键持拍）">
      <span className="ws-quick-label">球拍</span>
      <button type="button" data-testid="racket-right" disabled={!info} title="所有关键帧改为右手握拍并显示球拍，可撤销" onClick={()=>setGrip('R')}>右手持拍</button>
      <button type="button" data-testid="racket-left" disabled={!info} title="所有关键帧改为左手握拍并显示球拍，可撤销" onClick={()=>setGrip('L')}>左手持拍</button>
      <button type="button" data-testid="racket-off" disabled={!info} title="所有关键帧不再握拍，可撤销" onClick={()=>setGrip(null)}>卸下球拍</button>
     </div>
     <div className="ws-quick-poses" role="group" aria-label="我的姿态（自建快速姿态）">
      <span className="ws-quick-label">我的</span>
      <button type="button" data-testid="pose-capture" disabled={!info||!sel} title="把选中关键帧的完整姿态（含手臂）存为可复用的快速姿态，保存到本机浏览器" onClick={capturePose}><Plus size={12}/>存当前姿态</button>
      {poseLib.current!.presets.map(p=><span key={p.id} className="ws-pose-chip">
       <button type="button" data-testid={`pose-apply-${p.id}`} title="把该姿态写到播放头：已有帧则替换姿态，无帧则插入新帧，可撤销" onClick={()=>applyUserPose(p)}>{p.name}</button>
       <button type="button" className="ws-pose-delete" aria-label={`删除姿态 ${p.name}`} title="删除这个自建姿态" onClick={()=>removeUserPose(p.id)}><X size={10}/></button>
      </span>)}
     </div>
    </section>
    <details className="ws-fold" data-fold="preset" inert={generationLockedUi}>
     <summary>从预设开始 <small>内置动作副本</small></summary>
     <div className="ws-fold-body">
      <div className="ws-preset-entry">
       <label className="ws-field"><span>动作预设</span><select aria-label="初始动作预设" value={presetId} onChange={e=>setPresetId(e.target.value)}>
        <optgroup label="基础动作">{BASIC_PRESETS.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
        <optgroup label="持拍动作（球拍插件）">{RACKET_PRESETS.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
        <optgroup label="其他预设">{OTHER_PRESETS.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
       </select></label>
       <button className="ws-preset-start" onClick={()=>createFromPreset()}><Plus size={14}/>从预设开始</button>
      </div>
      <p className="ws-note">复制完整预设为可编辑副本开始调整；预设本身不会被改动。外部动画与动力学动作暂不支持。</p>
     </div>
    </details>
    <details className="ws-fold" data-fold="combine" inert={generationLockedUi}>
     <summary>组合动作 <small>拼接 / 混合</small></summary>
     <div className="ws-fold-body">
     <section className="ws-card" inert={generationLockedUi}><h2>组合动作 <small>保存为新动作</small></h2>
     <p className="ws-note">当前「{d.name}」作为第一段，选择另一段动作进行拼接或混合。</p>
     <label className="ws-field"><span>另一段</span><select aria-label="组合目标动作" value={combineTarget} onChange={e=>setCombineTarget(e.target.value)}>
      <optgroup label="我的动作">{L.docs.map(doc=><option key={doc.id} value={`local:${doc.id}`}>{doc.name}</option>)}</optgroup>
      <optgroup label="内置动作">{WORKSHOP_PRESETS.map(p=><option key={p.id} value={`preset:${p.id}`}>{p.name}</option>)}</optgroup>
     </select></label>
     <label className="ws-field"><span>组合方式</span><select aria-label="组合方式" value={combineKind} onChange={e=>setCombineKind(e.target.value as 'append'|'blend')}>
      <option value="append">前后拼接</option><option value="blend">按比例混合</option>
     </select></label>
     {combineKind==='append'?<label className="ws-field"><span>过渡时长（秒）</span><input aria-label="拼接过渡时长" type="number" min={.1} max={2} step={.1} value={combineTransition} onChange={e=>setCombineTransition(e.target.valueAsNumber)}/></label>
      :<Slider label="另一段动作占比" value={combineWeight} min={0} max={100} step={1} unit="%" testId="combine-weight" onChange={setCombineWeight}/>}
     <p className="ws-note">{combineKind==='append'?'当前动作 → 过渡 → 另一段动作，总时长不超过 10 秒。':'按开始 / 结束对齐进度，时长取较长动作；双足支撑取交集，持拍和触球取占比高的动作（50% 时取另一段）。'}</p>
     <label className="ws-field"><span>新名称</span><input aria-label="组合动作名称" placeholder="留空自动命名" value={combineName} onChange={e=>setCombineName(e.target.value)}/></label>
     <div className="ws-row"><button type="button" data-testid="save-combined-motion" disabled={!info} onClick={saveCombined}><Save size={13}/>{combineKind==='append'?'拼接并保存':'混合并保存'}</button></div>
     </section>
     </div>
    </details>
    <details className="ws-fold" data-fold="keys" inert={generationLockedUi||review}>
     <summary>关键帧清单 <small>{orderedKeys.length} / {WORKSHOP_LIMITS.maxKeys} · 时间轴是主入口</small></summary>
     <div className="ws-fold-body">
     <section className="ws-card ws-keyframes" inert={generationLockedUi} aria-label="关键帧管理">
     <h2>关键帧 <small>{orderedKeys.length} / {WORKSHOP_LIMITS.maxKeys}</small></h2>
     <div className="ws-keyframe-list" role="group" aria-label="按时间排序的关键帧">
      {orderedKeys.map((key,index)=>{
       const name=key.label||`关键帧 ${index+1}`;
       return <div key={key.id} data-testid={`keyframe-row-${key.id}`} className={`ws-keyframe-row ${key.id===sel?.id?'sel':''}`}>
        <button type="button" className="ws-keyframe-select" aria-label={`编辑关键帧 ${name}`} aria-pressed={key.id===sel?.id} title={`${name} · ${key.time.toFixed(3)}s`} onClick={()=>selectKey(key.id)}>
         <span className="ws-keyframe-index">{index+1}</span><span className="ws-keyframe-name"><strong>{name}</strong><small>{key.time.toFixed(3)}s{key.constraints.contact?' · 触球':''}</small></span>
        </button>
        <button type="button" className="ws-keyframe-icon" data-testid={`keyframe-copy-${key.id}`} aria-label={`复制关键帧 ${name}`} title="复制帧并插入到后方" disabled={d.keys.length>=WORKSHOP_LIMITS.maxKeys||!keyframeInsertSlot(d,key.time,orderedKeys[index+1]?.time)} onClick={()=>duplicateKey(key.id)}><Copy size={12}/></button>
        <button type="button" className="ws-keyframe-icon" aria-label={`上移关键帧 ${name}`} title="上移：与上一帧交换时间点" disabled={index===0} onClick={()=>reorderKey(key.id,index-1)}><ArrowUp size={12}/></button>
        <button type="button" className="ws-keyframe-icon" aria-label={`下移关键帧 ${name}`} title="下移：与下一帧交换时间点" disabled={index===orderedKeys.length-1} onClick={()=>reorderKey(key.id,index+1)}><ArrowDown size={12}/></button>
        <button type="button" className="ws-keyframe-icon danger" aria-label={`删除关键帧 ${name}`} title={d.keys.length<=2?'至少保留两个关键帧':'删除关键帧（可撤销）'} disabled={d.keys.length<=2} onClick={()=>delKey(key.id)}><Trash2 size={12}/></button>
       </div>;
      })}
     </div>
     <div className="ws-row ws-keyframe-actions">
      <button type="button" data-testid="keyframe-add-current" disabled={!info||d.keys.length>=WORKSHOP_LIMITS.maxKeys} onClick={addKey}><Plus size={12}/>当前时刻添加</button>
      <button type="button" data-testid="keyframe-insert-after" disabled={!info||insertTime===undefined||d.keys.length>=WORKSHOP_LIMITS.maxKeys} title={insertTime===undefined?'选中帧后没有可用时间；可在前面的时间段添加':'在下一时间点前插入；末帧后可延长动作'} onClick={insertAfterKey}><Plus size={12}/>在选中帧后插入</button>
     </div>
     <p className="ws-note">点击帧名定位与编辑；上移 / 下移保留时间点，整帧换序。新增与复制在右侧「选中关键帧」或底部时间轴操作。</p>
     {d.keys.length>=WORKSHOP_LIMITS.maxKeys?<p className="ws-note">已达关键帧数量上限，请先删除不需要的帧。</p>:null}
     </section>
     </div>
    </details>
    <details className="ws-fold" data-fold="generator">
     <summary>约束轨迹生成 <small>实验功能 · 后台计算</small></summary>
     <div className="ws-fold-body">
     <section className="ws-card ws-generator" data-testid="generator-panel">
     <p className="ws-note">生成器会尝试小幅调整关键帧时序与通道相位。候选只在当前页面预览；按“保留”后才写入动作库。</p>
     {!generationLockedUi?<>
      <div className="ws-sub"><h3>可调整方式</h3>
       <Row label="调整关键帧时序" checked={adjustKinds.time} onChange={v=>setAdjustKinds(a=>({...a,time:v}))}/>
       <Row label="调整姿态通道相位" checked={adjustKinds.phase} onChange={v=>setAdjustKinds(a=>({...a,phase:v}))}/>
      </div>
      <div className="ws-sub"><h3>保护关键帧 <small>{lockedIds.length} 个已锁定</small></h3>
       <div className="ws-lock-list">{orderedKeys.map((k,i)=>{
        const isContact=k.constraints.contact,edge=i===0||i===orderedKeys.length-1;
        const checked=isContact||lockedIds.includes(k.id);
        return <Row key={k.id} testId={`generator-lock-${k.id}`} label={`${k.label||`关键帧 ${i+1}`} · ${k.time.toFixed(2)}s`} detail={isContact?'触球帧始终固定':edge?'端点默认固定':undefined} checked={checked} disabled={isContact} onChange={v=>setKeyLocked(k.id,v)}/>;
       })}</div>
       <div className="ws-row"><button type="button" onClick={()=>setLocksByDoc(prev=>{const next={...prev};delete next[d.id];return next;})}>恢复默认锁定</button></div>
       <p className="ws-note">触球关键帧始终固定，首尾帧默认固定；其余关键帧可勾选保护。</p>
      </div>
      <div className="ws-row"><button type="button" data-testid="generator-start" aria-label="生成优化候选" disabled={!d.inbetweens||(!adjustKinds.time&&!adjustKinds.phase)} onClick={startGeneration}><Sparkles size={13}/>生成候选</button></div>
     </>:null}
     {generationBusy?<div className="ws-generation-progress">
      <div className="ws-generation-status" data-testid="generator-status" role="status" aria-live="polite">
       {generationProgress?.phase==='loading'?'正在加载人体与骨架':generationProgress?.phase==='baseline'?'正在测量源动作':generationProgress?.phase==='report'?'正在检查候选':`搜索中 · 第 ${generationProgress?.sweep??1} 轮`}
       {generationProgress?` · ${generationProgress.evals}/${generationProgress.maxEvals}`:''}
      </div>
      <progress data-testid="generator-progress" aria-label="候选生成进度" max={generationProgress?.maxEvals??120} value={generationProgress?.evals??0}/>
      <div className="ws-row"><button type="button" data-testid="generator-cancel" aria-label="取消候选生成" onClick={stopGeneration}><X size={13}/>取消生成</button></div>
     </div>:null}
     {candidateSession?<div className="ws-candidate-review">
      <div className="ws-generation-status" data-testid="generator-status" role="status" aria-live="polite">候选已就绪 · {candidateSession.result.diagnostics.evals} 次求解 · {candidateSession.result.diagnostics.appliedMoves.length} 次调整</div>
      <div className="ws-preview-switch" role="group" aria-label="源动作与候选动作对比">
       <button type="button" data-testid="preview-source" aria-label="预览源动作 A" aria-pressed={previewSide==='source'} onClick={()=>setPreview('source')}>A · 源动作</button>
       <button type="button" data-testid="preview-candidate" aria-label="预览候选动作 B" aria-pressed={previewSide==='candidate'} onClick={()=>setPreview('candidate')}>B · 候选</button>
      </div>
      <p className={`ws-verdict ${candidateSession.candidate.verdict}`}><strong>实验性判断：{candidateSession.candidate.verdict==='improved'?'主要指标改善':candidateSession.candidate.verdict==='neutral'?'有代价下降，未达明显改善门槛':'指标退化'}</strong><small>目标比值 {candidateSession.candidate.objective.toFixed(3)} · 数值指标不代表动作自然度已获人工确认。</small></p>
      <div className="ws-metric-table-wrap"><table className="ws-metric-table" aria-label="源动作与候选指标比较"><thead><tr><th>指标</th><th>源动作</th><th>候选</th></tr></thead><tbody>
       {Object.entries(candidateSession.candidate.metrics).map(([key,row])=>{
        const delta=Math.abs(row.after-row.before),noiseFloor=Math.max(1e-9,Math.max(Math.abs(row.before),Math.abs(row.after))*1e-4);
        const better=delta<=noiseFloor?null:row.better==='down'?row.after<row.before:row.better==='up'?row.after>row.before:null;
        return <tr key={key} className={better===null?'':better?'better':'worse'}><th scope="row" title={key}>{metricLabels[key]??key}</th><td>{metricText(row.before)} <small>{row.unit}</small></td><td>{metricText(row.after)} <small>{row.unit}</small></td></tr>;
       })}
      </tbody></table></div>
      <div className="ws-gen-constraints"><h3>候选约束检查 <small>{candidateSession.candidate.constraints.filter(c=>c.ok).length}/{candidateSession.candidate.constraints.length} 通过</small></h3>
       {candidateSession.candidate.constraints.map((item,i)=><div key={`${item.code}-${i}`} className={item.ok?'ok':'fail'}><span>{item.ok?'✓':'×'} {item.code}</span><small>{item.detail}</small></div>)}
      </div>
      <div className="ws-row ws-gen-actions">
       <button type="button" data-testid="generator-cancel" aria-label="取消候选预览" onClick={stopGeneration}><X size={13}/>取消候选</button>
       <button type="button" data-testid="generator-keep" aria-label="保留候选动作" onClick={()=>keepCandidate(false)}><Check size={13}/>保留候选</button>
       <button type="button" data-testid="generator-keep-export" aria-label="保留候选并导出 JSON" onClick={()=>keepCandidate(true)}><Download size={13}/>保留并导出 JSON</button>
      </div>
      <p className="ws-note">A/B 预览共用当前视角、相机与播放时刻。取消会丢弃候选；保留后会创建独立动作和关键帧编号。</p>
     </div>:null}
     {visibleReport&&!candidateSession&&!generationBusy?<div className="ws-generation-result" data-testid="generator-status" role="status">
      <strong>未生成可预览候选</strong>
      {visibleReport.rejected.map((item,i)=><p key={`${item.code}-${i}`} className="ws-note"><b>{item.code}</b> · {item.reason}</p>)}
      <button type="button" className="ws-mini" onClick={()=>setGenerationReport(null)}>清除结果</button>
     </div>:null}
     {generationError?<div className="ws-generation-error" role="alert"><p>{generationError}</p><button type="button" className="ws-mini" onClick={()=>setGenerationError('')}>关闭</button></div>:null}
     </section>
     </div>
    </details>
    <details className="ws-fold" data-fold="doc" inert={generationLockedUi}>
     <summary>动作属性 · 高级导出 <small>时长 / 循环 / 坐标系 / GLB</small></summary>
     <div className="ws-fold-body">
     <section className="ws-card ws-doc-card" inert={generationLockedUi}><div inert={review}><h2>动作属性</h2>
     <label className="ws-field"><span>时长 s（{WORKSHOP_LIMITS.minDuration}–{WORKSHOP_LIMITS.maxDuration}）</span><input type="number" min={WORKSHOP_LIMITS.minDuration} max={WORKSHOP_LIMITS.maxDuration} step=".1" value={d.duration} onChange={e=>edit(dd=>retimeKeys(dd,clampDuration(Number(e.target.value))))}/></label>
     <p className="ws-note">{d.keys.length} 个关键帧 · {d.inbetweens?'Hermite 补间':'逐帧保持'}</p>
     <Row label="循环播放" detail={loopBlockers(d).join('；')||'首帧位于 0 s，末帧早于时长'} checked={d.loop} disabled={!d.loop&&loopBlockers(d).length>0} onChange={v=>edit(dd=>{if(v&&loopBlockers(dd).length)return;dd.loop=v;})}/>
     <label className="ws-field"><span>左手坐标系</span><select value={d.handFrames.L} onChange={e=>edit(dd=>{dd.handFrames.L=e.target.value as HandFrame;})}><option value="pelvis">骨盆坐标（推荐）</option><option value="world">世界坐标（旧版）</option></select></label>
     <label className="ws-field"><span>右手坐标系</span><select value={d.handFrames.R} onChange={e=>edit(dd=>{dd.handFrames.R=e.target.value as HandFrame;})}><option value="pelvis">骨盆坐标（推荐）</option><option value="world">世界坐标（旧版）</option></select></label>
     {/* The whole grip stage — finger wrap, wrist cone, clavicle assist and
         the racket mount — mirrors onto the selected side; 'R' stores the
         canonical absent value so serialized docs keep their legacy bytes. */}
     <label className="ws-field"><span>握拍侧</span><select value={d.gripSide??'R'} onChange={e=>edit(dd=>{dd.gripSide=e.target.value==='L'?'L':undefined;})}><option value="R">右手（默认）</option><option value="L">左手</option></select></label>
     <Row label="抬肩辅助" detail="手高于胸口时锁骨与肩部随动上抬" checked={d.clavicleLift===true} onChange={v=>edit(dd=>{dd.clavicleLift=v||undefined;})}/>
     <div className="ws-row">
      {/* x=0 平面整档镜像：同一动作换边（右手正手→左手正手）。产出入库并选
          中，原文档保留；撤销一步回到镜像前的文档。 */}
      <button onClick={mirrorActiveDoc} title="生成当前动作的左右镜像副本（换握拍侧，几何 x→−x）"><FlipHorizontal2 size={13}/>镜像动作</button>
     </div>
     </div>
     {/* Single-motion JSON import/export lives in the library card's
         导入/导出/备份 block — one entry point, not one per card. */}
     <div className="ws-sub"><h3>高级导出 <small>本地求解 · 与服务同一条管线</small></h3>
      <label className="ws-field"><span>采样率 fps</span><input type="number" min={1} max={60} step={1} value={exportFps} disabled={!subtleOk||exporting} onChange={e=>setExportFps(Math.max(1,Math.min(60,Math.round(Number(e.target.value)||40))))}/></label>
      <div className="ws-row">
       {/* During model load a click still lands on solvePackage's own !e?.rig
           guard, which answers with a readable hint — no separate !info gate. */}
       <button onClick={()=>void exportPackage()} disabled={!subtleOk||exporting} title={subtleOk?'求解并校验当前文档，下载 .pose.json':'姿态包导出需 https 或 localhost 打开'}><Package size={13}/>{exporting?'求解中…':'导出姿态包'}</button>
       <button onClick={()=>void exportGlbFile()} disabled={!subtleOk||exporting} title={subtleOk?'同一求解结果烘焙成 glTF 动画，干净模型重新解析后导出':'GLB 导出需 https 或 localhost 打开'}><FileBox size={13}/>{exporting?'导出中…':'导出 GLB'}</button>
       <button onClick={()=>void exportStill()} disabled={exporting} title="以固定 45° 相机渲染当前时刻，640×720 PNG"><Camera size={13}/>渲染静帧</button>
       <button onClick={()=>void exportSheet()} disabled={exporting} title="每个关键帧时刻渲染一格拼成单张 PNG；超过 12 帧时均匀抽 12 格"><LayoutGrid size={13}/>关键帧拼图</button>
      </div>
      <p className="ws-note" style={subtleOk?undefined:{color:'var(--red)'}}>{subtleOk?'fps 进入制品 id：同一文档不同 fps 是不同包（1–60，服务端默认 40）。GLB 是派生品，可入 DCC/播放器预览；静帧与拼图为固定相机 640×720 PNG，不含编辑器叠加物。':'姿态包导出需 https 或 localhost 打开（crypto.subtle 不可用）。'}</p>
      {pkgProblems&&pkgProblems.doc===d.id?<div className="ws-problems"><p className="ws-note" style={{color:'var(--red)'}}>上一次导出被语义校验拒绝，未生成文件：</p>
       <ul>{pkgProblems.items.map((p,i)=><li key={i}>{p}</li>)}</ul></div>:null}
     </div>
     </section>
     </div>
    </details>
    <details className="ws-fold" data-fold="video" inert={generationLockedUi}>
     <summary>参考视频 <small>需要时打开</small></summary>
     <div className="ws-fold-body">
     <section className="ws-card" inert={generationLockedUi}><h2>参考视频 <small>WHAM 自动估计待接入</small></h2>
     {videoUrl?(compact?<p className="ws-note">参考视频以画中画显示在三维视图上，可切换大图并排对照。</p>:videoEl):
      <button className="ws-video-pick" onClick={()=>fileRef.current?.click()}><Video size={18}/>载入参考视频</button>}
     <input ref={fileRef} type="file" accept="video/*" hidden onChange={e=>{const f=e.target.files?.[0];if(f)loadVideo(f);e.target.value='';}}/>
     {videoUrl?<><div className="ws-row">
       <button onClick={()=>{const el=video.current!;el.paused?void el.play():el.pause();}}>{videoPlaying?<Pause size={13}/>:<Play size={13}/>}</button>
       <button onClick={()=>{if(video.current)video.current.currentTime=Math.max(0,video.current.currentTime-1/30);}}>-1帧</button>
       <button onClick={()=>{if(video.current)video.current.currentTime+=1/30;}}>+1帧</button>
       <button onClick={alignVideo} title="把视频当前帧对齐到时间轴当前位置"><Camera size={13}/>对齐</button>
      </div>
      <Row label="与时间轴同步" checked={sync} onChange={setSync}/>
      <button className="ws-mini" onClick={stampVideo} disabled={!sel}>记录视频帧到当前关键帧</button>
      <div className="ws-vkeys">{d.keys.filter(k=>k.videoTime!==undefined).map(k=><button key={k.id} onClick={()=>{engine.current?.seek(k.time);if(video.current)video.current.currentTime=k.videoTime!;setSelected(k.id);}}><Film size={11}/>{k.label||fmt(k.time)}<small>{fmt(k.videoTime!)}</small></button>)}</div>
     </>:null}
     </section>
     </div>
    </details>
    <details className="ws-fold" data-fold="legend" inert={generationLockedUi}>
     <summary>手柄图例 <small>IK 末端与颜色</small></summary>
     <div className="ws-fold-body">
     <section className="ws-card ws-legend" inert={generationLockedUi}><h2>手柄</h2>
     <p><i style={{background:'#2469ee'}}/>髋部 / 根骨</p>
     <p><i style={{background:'#ec8c39'}}/>手腕（IK 末端）</p>
     <p><i style={{background:'#e2543a'}}/>脚踝（支撑贴地 · 离地可三维拖动）</p>
     <p><i style={{background:'#0891b2'}}/>摆动路径点（离地帧存储的脚位，摆动中点）</p>
     <p><i style={{background:'#4a9e6b'}}/>肘 / 膝极点</p>
     <p><i style={{background:'#d23c3c'}}/>拍头 · <em style={{color:'#f0b429'}}>触球点</em></p>
     <p className="ws-note">直接拖动末端，IK 自动解算整条链；在空白处拖动仍是旋转视角。</p>
     </section>
     </div>
    </details>
   </aside></Panel>
   <Separator className="pane-resize"/>
   <Panel id="ws-stage" className="ws-stage" defaultSize="auto" minSize={320}><section className="ws-viewport">
    <div ref={mount} className="ws-canvas"/>
    <div className="ws-view-heading"><h2>{displayDoc.name}</h2><p>{frame.label||'—'} · {displayDoc.inbetweens?'连续补间预览':'关键帧步进'}{candidateSession?` · ${previewSide==='source'?'A 源动作':'B 候选'}`:''}</p></div>
    <div className="ws-cameras">{([['front','正面'],['side','侧面'],['threeQuarter','45°'],['back','背面']] as [ViewId,string][]).map(([v,l])=><button key={v} aria-pressed={view===v} onClick={()=>{setView(v);engine.current?.setView(v);}}>{l}</button>)}</div>
    <div className="ws-hint" data-testid="mode-hint"><span className={`status-dot ${review?'review':''}`}/>{!info?'加载中':review?'审阅模式 · 单指旋转 · 双指缩放 / 平移 · 不会修改姿态':'编辑模式 · 拖动彩色手柄调整姿态，写入选中或自动新建的关键帧'}</div>
    <div className="ws-modebar" role="group" aria-label="交互模式">
     <button type="button" data-testid="mode-review" aria-pressed={review} onClick={()=>switchMode('review')}><Eye size={15}/>审阅</button>
     <button type="button" data-testid="mode-edit" aria-pressed={!review} onClick={()=>switchMode('edit')}><Hand size={15}/>编辑</button>
    </div>
    <div className="ws-quickbar" role="toolbar" aria-label="快捷操作">
     <button type="button" data-testid="sheet-left" aria-expanded={compact?sheet==='left':libraryOpen} onClick={()=>{if(compact)setSheet(v=>v==='left'?null:'left');else{const right=inspectorPanel.current?.getSize().asPercentage??0,left=libraryOpen?0:24;panelGroup.current?.setLayout({'ws-library':left,'ws-stage':100-left-right,'ws-inspector':right});}}}><ListVideo size={16}/>动作</button>
     <button type="button" data-testid="sheet-right" aria-expanded={compact?sheet==='right':inspectorOpen} onClick={()=>compact?setSheet(v=>v==='right'?null:'right'):inspectorOpen?inspectorPanel.current?.collapse():inspectorPanel.current?.resize('340px')}><SlidersHorizontal size={16}/>调整</button>
     <button type="button" data-testid="display-menu" aria-expanded={optsOpen} onClick={()=>setOptsOpen(v=>!v)}><Eye size={15}/>显示</button>
     <button type="button" data-testid="fit-view" onClick={()=>{setSheet(null);setView('threeQuarter');engine.current?.setView('threeQuarter');}}>全视野</button>
     {optsOpen?<><button type="button" className="ws-popscrim" aria-label="关闭显示菜单" onClick={()=>setOptsOpen(false)}/>
      <div className="ws-optmenu" role="group" aria-label="显示选项">
       <Row label="运动轨迹线" checked={opts.trajectories} onChange={v=>setOpt({trajectories:v})}/>
       <Row label="重心 / 支撑" checked={opts.balance} onChange={v=>setOpt({balance:v})}/>
       {!review?<Row label="编辑手柄" checked={opts.handles} onChange={v=>setOpt({handles:v})}/>:null}
       <Row label="洋葱皮" detail="叠加前后姿态的幽灵骨架" checked={opts.onion} onChange={v=>setOpt({onion:v})}/>
       {opts.onion?<>
        <label className="ws-field"><span>数量</span><input type="number" min={1} max={3} step={1} value={opts.onionCount} onChange={e=>{const v=Math.max(1,Math.min(3,Math.round(Number(e.target.value)||1)));setOpts(o=>({...o,onionCount:v}));engine.current?.setOptions({onionCount:v});}}/></label>
        <label className="ws-field"><span>模式</span><select value={opts.onionMode} onChange={e=>{const v=e.target.value as 'keys'|'step';setOpts(o=>({...o,onionMode:v}));engine.current?.setOptions({onionMode:v});}}><option value="keys">相邻关键帧</option><option value="step">固定步长</option></select></label>
        {opts.onionMode==='step'?<label className="ws-field"><span>步长 s</span><input type="number" min={.02} max={1} step={.02} value={opts.onionStep} onChange={e=>{const v=Math.max(.02,Math.min(1,Number(e.target.value)||.1));setOpts(o=>({...o,onionStep:v}));engine.current?.setOptions({onionStep:v});}}/></label>:null}
       </>:null}
       <SkinSwitch disabled={!info} change={s=>engine.current!.setSkin(s)}/>
       {videoUrl?<Row label="放大参考视频" checked={refLarge} onChange={v=>setRefLarge(v)}/>:null}
      </div></>:null}
    </div>
    {compact&&videoEl?<div className={`ws-ref ${refLarge?'large':''}`} data-testid="reference-pip">{videoEl}<button type="button" aria-label={refLarge?'缩小参考视频':'放大参考视频并排对照'} onClick={()=>setRefLarge(v=>!v)}/></div>:null}
    {!info?<div className="ws-loading"><div className="loading-orbit"/><strong>{error?'加载失败':'正在读取人体模型'}</strong><p>{error}</p></div>:null}
   </section></Panel>
   <Separator className="pane-resize"/>
   <Panel id="ws-inspector" panelRef={inspectorPanel} collapsible collapsedSize={0} onResize={size=>setInspectorOpen(size.inPixels>1)} className="ws-inspector-panel" defaultSize={0} minSize={320} maxSize={480} inert={generationLockedUi}><aside className="ws-right" aria-label="姿态调整与检查" inert={generationLockedUi}>
    {sheetHead('姿态调整 · 检查')}
    {review?<p className="ws-review-lock">审阅模式：姿态控件已锁定。<button type="button" data-testid="unlock-edit" onClick={()=>switchMode('edit')}><Hand size={13}/>切换到编辑</button></p>:null}
    <section className="ws-card ws-key-card" inert={review}><h2>选中关键帧 {sel?<small>@{sel.time.toFixed(2)}s</small>:null}</h2>
     {sel?<div className="ws-adjustment-tabs" role="group" aria-label="关键帧调整分类">
      {([['semantic','语义'],['left','左侧'],['right','右侧'],['common','通用']] as const).map(([tab,label])=><button key={tab} type="button" data-testid={`adjustment-tab-${tab}`} aria-pressed={adjustmentTab===tab} onClick={()=>setAdjustmentTab(tab)}>{label}</button>)}
     </div>:null}
     <div className="ws-key-panel" data-testid={`adjustment-panel-${adjustmentTab}`}>
     {sel?<>
      <div className="ws-key-metadata">
       <label className="ws-field"><span>帧名称</span><input aria-label="关键帧名称" data-testid="selected-key-name" value={sel.label} placeholder={`关键帧 ${selectedKeyIndex+1}`} onFocus={()=>gate.current.reset()} onBlur={()=>gate.current.reset()} onChange={e=>editSelected(k=>{k.label=e.target.value;})}/></label>
       <label className="ws-field"><span>时间 s</span><KeyframeTimeInput key={`${d.id}:${sel.id}:${sel.time}`} time={sel.time} max={keyTimeMax} disabled={d.loop&&selectedKeyIndex===0} onCommit={time=>changeKeyTime(sel.id,time)}/></label>
       <label className="ws-field"><span>顺序</span><select aria-label="关键帧顺序" data-testid="selected-key-order" value={selectedKeyIndex} onChange={e=>reorderKey(sel.id,Number(e.target.value))}>
        {orderedKeys.map((key,index)=><option key={key.id} value={index}>第 {index+1} 帧 · {key.time.toFixed(3)}s</option>)}
       </select></label>
       {d.loop&&selectedKeyIndex===0?<p className="ws-note">循环首帧固定在 0s；可调整顺序来更换首帧。</p>:null}
      <div className="ws-row ws-context-actions" role="group" aria-label="选中关键帧操作">
       <button type="button" data-testid="keyframe-copy-selected" disabled={insertTime===undefined||d.keys.length>=WORKSHOP_LIMITS.maxKeys} title={insertTime===undefined?'选中帧后没有可用时间':'完整复制选中帧到后方，副本可独立编辑'} onClick={()=>{if(sel)duplicateKey(sel.id);}}><Copy size={12}/>复制帧</button>
       <button type="button" data-testid="pose-copy" disabled={!sel} title="复制选中关键帧的完整姿态（含手臂），会话内有效，可粘贴到其他帧或其他动作" onClick={copyPose}><ClipboardCopy size={12}/>复制姿态</button>
       <button type="button" data-testid="pose-paste" disabled={!sel||!poseClipboard.current} title="把复制的姿态写到选中关键帧（约束不变），可撤销" onClick={pastePose}><Copy size={12}/>粘贴姿态</button>
       <button type="button" data-testid="pose-mirror" disabled={!sel} title="当前帧姿态左右镜像：手脚与支撑互换，可撤销" onClick={mirrorSelectedPose}><FlipHorizontal2 size={12}/>镜像姿态</button>
      </div>
      </div>
      {Math.abs(frame.time-sel.time)>.001?<p className="ws-note">正在预览 {frame.time.toFixed(2)}s；修改时定位到选中帧 {sel.time.toFixed(2)}s。调整当前时刻请先添加关键帧。</p>:null}
      {adjustmentTab==='semantic'?<SemanticPanel key={`${d.id}:${sel.id}:${wristEpoch.current}`} host={semanticHost} defaultSide={d.gripSide??'R'} keyLabel={sel.label||`关键帧 ${selectedKeyIndex+1}`}/>:<>
      {adjustmentTab==='common'?<>
      <label className="ws-field"><span>动作名称</span><input data-testid="active-motion-name" aria-label="动作名称" value={d.name} onChange={e=>edit(doc=>{doc.name=e.target.value;})}/></label>
      <Row label="自由手臂（全方向）" detail="允许肩、肘、腕超出人体参考范围；肘屈曲超过 145° 的姿态无法导出姿态包" testId="free-arms" checked={d.freeArms===true} onChange={v=>edit(doc=>{if(v)doc.freeArms=true;else delete doc.freeArms;})}/>
      <div className="ws-sub"><h3>帧间过渡 <small>从当前关键帧到下一帧</small></h3>
       {nextTransitionKey&&transitionEndTime!==undefined?<>
        <p className="ws-note">{sel.time.toFixed(2)}s → {transitionEndTime.toFixed(2)}s{transitionIsLoop?' · 循环接缝':''}</p>
        <label className="ws-field"><span>曲线</span><select data-testid="selected-key-interpolation" value={sel.interpolation??'hermite'} disabled={!d.inbetweens}
         onChange={e=>{const mode=e.target.value as KeyInterpolation;editSelected(k=>{if(mode==='hermite')delete k.interpolation;else k.interpolation=mode;});}}>
         <option value="hermite">平滑（Hermite）</option><option value="linear">线性</option>
        </select></label>
        <p className="ws-note">{d.inbetweens?'当前帧的曲线设置作用于整段过渡。':'请先启用“生成中间帧”，曲线设置才会生效。'}</p>
       </>:<p className="ws-note">当前是末关键帧，没有后续过渡区间；可添加下一帧，或启用循环播放形成闭环。</p>}
      </div>
      </>:null}
      {adjustmentTab==='common'?<div className="ws-sub"><h3>事件约束</h3>
       <Row label="触球 / 接触事件" detail="记录拍头位置为接触点" checked={sel.constraints.contact} onChange={v=>editSelected(k=>{k.constraints.contact=v;})}/>
      </div>:<div className="ws-sub"><h3>{adjustmentSideName}侧约束</h3>
       <Row label={`${adjustmentSideName}脚支撑锁定`} detail="离地帧的脚位会作为摆动路径点" checked={sel.constraints[adjustmentSide==='L'?'plantL':'plantR']} onChange={v=>editSelected(k=>{k.constraints[adjustmentSide==='L'?'plantL':'plantR']=v;})}/>
       {selectedKeyIndex===orderedKeys.length-1&&selectedKeyIndex>0&&isReleaseKey(d,selectedKeyIndex,adjustmentSide)?<p className="ws-note" style={{color:'var(--red)'}}>此离地帧位于动作末尾：没有后续区间，脚停在接触点；请在其后添加关键帧，抬升高度才会形成摆动轨迹。</p>:null}
       {d.gripSide===adjustmentSide?<Row label={`${adjustmentSideName}手握拍`} checked={sel.constraints.grip} onChange={v=>editSelected(k=>{k.constraints.grip=v;})}/>:null}
      </div>}
      {adjustmentTab==='common'?<><div className="ws-sub"><h3>躯干与骨盆</h3>
       <Slider label="前倾" value={sel.pose.lean} min={-50} max={60} step={.5} onChange={v=>editSelected(k=>{k.pose.lean=v;})}/>
       <Slider label="转体" value={sel.pose.chest} min={-60} max={60} step={.5} onChange={v=>editSelected(k=>{k.pose.chest=v;})}/>
       <Slider label="侧弯" value={sel.pose.side} min={-30} max={30} step={.5} onChange={v=>editSelected(k=>{k.pose.side=v;})}/>
       <Slider label="朝向" value={sel.pose.yaw} min={-180} max={180} step={1} onChange={v=>editSelected(k=>{k.pose.yaw=v;})}/>
       <Slider label="骨盆升降" value={sel.pose.root.y} min={-.45} max={.15} step={.005} unit="m" onChange={v=>editSelected(k=>{k.pose.root.y=v;})}/>
       <Slider label="骨盆前后" value={sel.pose.root.z} min={-.4} max={.4} step={.005} unit="m" onChange={v=>editSelected(k=>{k.pose.root.z=v;})}/>
       <Slider label="骨盆左右" value={sel.pose.root.x} min={-.4} max={.4} step={.005} unit="m" onChange={v=>editSelected(k=>{k.pose.root.x=v;})}/>
      </div>
      </>:null}
      {adjustmentTab!=='common'?<>
       {!d.freeArms?<p className="ws-note">当前启用人体参考限位。在“通用调整”启用“自由手臂”可使用全方向旋转。</p>:null}
       <WristPanel key={`${d.id}:${sel.id}:${adjustmentSide}:${wristEpoch.current}:${d.freeArms}`} side={adjustmentSide} free={d.freeArms===true} k={sel} edit={editSelected}/>
       {(['upper','forearm'] as const).map(joint=><ArmJointPanel key={`${d.id}:${sel.id}:${adjustmentSide}:${joint}:${wristEpoch.current}`} side={adjustmentSide} joint={joint} disabled={!info} onTurn={(kind,delta)=>editSelected(k=>{const rig=engine.current?.rig;if(rig)rotateArmJoint(rig,k.pose,adjustmentSide,joint,kind,delta);})}/>)}
      </>:null}
      {(['L','R']as const).filter(side=>adjustmentTab==='left'?side==='L':adjustmentTab==='right'?side==='R':false).map(side=>{
        const cn=side==='L'?'左':'右',handName=side==='L'?'handL':'handR',footName=side==='L'?'footL':'footR';
        const hand=sel.pose[handName],planted=sel.constraints[side==='L'?'plantL':'plantR'];
        const ks=sortedKeys(d),si=ks.findIndex(k=>k.id===sel.id);
        let footOwner:WorkshopKey|undefined;
        if(planted)footOwner=contactStartKey(d,side,sel.time);
        else if(isReleaseKey(d,si,side))footOwner=sel; // release-key target is the stored swing waypoint
        footOwner??=sel;
        const foot=footOwner.pose[footName],pole=sel.pose[footName].pole;
        const write=(target:V3,axis:'x'|'y'|'z',value:number)=>editAtKey(sel,()=>{target[axis]=value;});
        return <div className="ws-limb-side" data-testid={`limb-controls-${side}`} key={side}>
         <div className="ws-sub ws-limb-controls"><h3>{cn}侧四肢姿态精调 <small>IK 目标与弯曲方向</small></h3>
         <p className="ws-note">以下为 IK 末端与方向提示；肘部引导点不直接指定大臂角度。大臂向后摆动请使用上方关节旋转，手部末端会随之移动。</p>
         <VectorSliders title={`${cn}前臂（小臂）末端目标`} value={hand.target} testPrefix={`limb-${side}-arm-target`}
          onChange={(axis,value)=>write(hand.target,axis,value)}/>
         <VectorSliders title={`${cn}肘部弯曲引导点`} value={hand.pole} testPrefix={`limb-${side}-arm-pole`}
          onChange={(axis,value)=>write(hand.pole,axis,value)}/>
         <VectorSliders title={`${cn}小腿末端目标`} value={foot.target} testPrefix={`limb-${side}-leg-target`}
          onChange={(axis,value)=>write(foot.target,axis,value)}/>
         <VectorSliders title={`${cn}膝部弯曲引导点`} value={pole} testPrefix={`limb-${side}-leg-pole`}
          onChange={(axis,value)=>write(pole,axis,value)}/>
         {footOwner!==sel?<p className="ws-note" style={{color:'var(--amber)'}}>{cn}脚处于支撑锁定：脚踝目标写入 {footOwner.time.toFixed(2)}s 的支撑开始帧；膝部引导点仍写入当前帧。</p>:null}
         </div>
        </div>;
       })}
      {adjustmentTab!=='common'?<div className="ws-sub"><h3>{adjustmentSideName}脚部姿态 <small>离地帧的抬升高度即摆动路径点</small></h3>
       {(['L','R']as const).filter(side=>adjustmentTab==='left'?side==='L':adjustmentTab==='right'?side==='R':false).map(side=>{
        const planted=sel.constraints[side==='L'?'plantL':'plantR'],cn=side==='L'?'左':'右';
        // A contact holds (target, yaw, pitch) from the run's first key; a
        // release key inherits them at its instant. Only those two cases have
        // dead stored values — ordinary swing keys own their stored pose, so
        // they must edit sel directly (never reach back to the last plant).
        const ks=sortedKeys(d),si=ks.findIndex(k=>k.id===sel.id);
        let owner:WorkshopKey|undefined;
        if(planted)owner=contactStartKey(d,side,sel.time);
        else if(isReleaseKey(d,si,side)){const p=si>0?si-1:ks.length-1;owner=contactStartKey(d,side,ks[p].time)??ks[p];}
        owner??=sel;
        const foot=side==='L'?owner.pose.footL:owner.pose.footR;
        return <div key={side}>
         <Slider label={`${cn}脚抬升高度（脚底离地）`} value={liftOf(side,planted?owner:sel)} min={0} max={.8} step={.005} unit="m" disabled={planted} onChange={v=>setLift(side,v)}/>
         <Slider label={`${cn}脚俯仰`} value={foot.pitch} min={-40} max={40} step={1} onChange={v=>editAtKey(sel,()=>{foot.pitch=v;})}/>
         <Slider label={`${cn}脚朝向`} value={foot.yaw} min={-90} max={90} step={1} onChange={v=>editAtKey(sel,()=>{foot.yaw=v;})}/>
         {owner!==sel?<p className="ws-note" style={{color:'var(--amber)'}}>{cn}脚此帧由 {owner.time.toFixed(2)}s 的支撑开始帧锁定：俯仰与朝向的修改写入该帧。</p>:null}
        </div>;
       })}
      </div>:null}
      </>}
      <button className="ws-mini danger" onClick={()=>delKey(sel.id)} disabled={d.keys.length<=2} title={d.keys.length<=2?'至少保留两个关键帧':'可通过撤销恢复'}><Trash2 size={12}/>删除此关键帧</button>
     </>:<p className="ws-note">时间轴上选择或新建关键帧。</p>}
     </div>
    </section>
    <details className="ws-fold" data-fold="inspect">
     <summary>检查 · 反馈 <small>按需展开</small></summary>
     <div className="ws-fold-body">
     <section className="ws-card"><h2>合理性检查 <small>运动学 · 非动力学</small></h2>
     {analysis?<div className="ws-checks">{analysis.items.map((it,i)=><div key={i} className={it.ok?'':'warn'}>{it.ok?<Check size={12}/>:<X size={12}/>}<span>{it.label}</span><small>{it.detail}</small></div>)}</div>:<p className="ws-note">求解后显示关节限位、支撑与重心。</p>}
     <p className="ws-note">限位使用工程关节范围；重心为分段质量近似，支撑多边形来自锁定脚位。</p>
    </section>
    <section className="ws-card ws-notes" id="ws-notes" data-testid="review-notes"><h2>审阅反馈 <small>会话内 · 不写入动作</small></h2>
     {sel?<>
      <p className="ws-note">标记「{sel.label||`关键帧 ${selectedKeyIndex+1}`}」@{sel.time.toFixed(2)}s 的问题：</p>
      <label className="ws-field"><span>部位</span><select value={noteDraft.part} onChange={e=>setNoteDraft(x=>({...x,part:e.target.value}))}>{NOTE_PARTS.map(p=><option key={p}>{p}</option>)}</select></label>
      <label className="ws-field"><span>问题</span><select data-testid="note-issue" value={noteDraft.issue} onChange={e=>setNoteDraft(x=>({...x,issue:e.target.value}))}>{NOTE_ISSUES.map(p=><option key={p}>{p}</option>)}</select></label>
      <label className="ws-field"><span>描述</span><input data-testid="note-text" value={noteDraft.text} placeholder="可选：补充说明…" onChange={e=>setNoteDraft(x=>({...x,text:e.target.value}))} onKeyDown={e=>{if(e.key==='Enter')addNote();}}/></label>
      <div className="ws-row"><button type="button" data-testid="note-add" onClick={addNote}><MessageSquareWarning size={13}/>标记问题</button>
       <button type="button" data-testid="note-copy" disabled={!docNotes.length} onClick={()=>void copyFeedback()}><ClipboardCopy size={13}/>复制反馈 JSON</button></div>
     </>:null}
     {docNotes.length?<ul className="ws-note-list">{docNotes.map(n=><li key={n.id}>
      <button type="button" onClick={()=>selectKey(n.keyId)}><b>{n.keyLabel}</b> {n.time.toFixed(2)}s · {n.part} · {n.issue}{n.text?<small>{n.text}</small>:null}</button>
      <button type="button" aria-label={`删除反馈 ${n.keyLabel} ${n.issue}`} onClick={()=>setNotes(all=>all.filter(x=>x.id!==n.id))}><X size={12}/></button>
     </li>)}</ul>:<p className="ws-note">尚无反馈；结构化 JSON 可直接交给 agent 修复。</p>}
    </section>
     </div>
    </details>
   </aside></Panel>
  </Group>
  {info&&(error||hint)?<div className={`ws-feedback${error?' ws-feedback-error':''}`} role={error?'alert':'status'}><span>{error||hint}</span><button type="button" aria-label="关闭提示" onClick={()=>{setError('');setHint('');}}><X size={16}/></button></div>:null}
  {compact&&sheet?<button type="button" className="ws-scrim" aria-label="关闭面板，返回三维视图" onClick={()=>setSheet(null)}/>:null}
  <footer className="ws-footer" inert={generationLockedUi}>
   <div className="ws-transport">
    <button className="ws-play" aria-label={frame.playing?'暂停':'播放'} onClick={()=>engine.current?.setPlaying(!frame.playing)} disabled={!info}>{frame.playing?<Pause size={21} fill="currentColor"/>:<Play size={21} fill="currentColor"/>}</button>
    <button aria-label="上一关键帧" data-testid="key-prev" onClick={()=>stepKey(-1)} disabled={!info}><ChevronLeft size={19}/></button>
    <button aria-label="下一关键帧" data-testid="key-next" onClick={()=>stepKey(1)} disabled={!info}><ChevronRight size={19}/></button>
    <button aria-label="回到开头" onClick={()=>engine.current?.seek(0)}><RotateCcw size={17}/></button>
    <button aria-label="撤销" title="撤销 (Ctrl+Z)" disabled={review||!books.current.of(d.id).canUndo()} onClick={undo}><Undo2 size={17}/></button>
    <button aria-label="重做" title="重做 (Ctrl+Shift+Z)" disabled={review||!books.current.of(d.id).canRedo()} onClick={redo}><Redo2 size={17}/></button>
    <span className="ws-time">{fmt(frame.time)}<i>/</i>{fmt(d.duration)}</span>
   </div>
   <Timeline doc={displayDoc} time={frame.time} selected={sel?.id??''} retime={!review} onSelect={selectKey} onSeek={t=>engine.current?.seek(t)} onRetime={(id,t)=>changeKeyTime(id,t,false)} onBeginRetime={()=>engine.current?.beginInteractiveEdit()} onEndRetime={()=>engine.current?.endInteractiveEdit()}/>
   <div className="ws-actions" inert={review}>
    <button onClick={addKey} disabled={!info||d.keys.length>=WORKSHOP_LIMITS.maxKeys}><Plus size={13}/>添加关键帧</button>
    <button aria-pressed={d.inbetweens} className={d.inbetweens?'on':''} onClick={()=>edit(dd=>{dd.inbetweens=!dd.inbetweens;})}><Sparkles size={13}/>{d.inbetweens?'中间帧已生成':'生成中间帧'}</button>
   </div>
  </footer>
 </div>;
}
