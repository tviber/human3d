import {normalizeDoc,type WorkshopDoc} from './document';
import type {DynamicsRecords,MuscleActionFile} from './muscle-action';

/** Motion-file envelope (schema v1): the asset on disk under assets/motions.
 * The trajectory carrier depends on `kind`: `document` for a workshop-motion,
 * the external `clip` asset for a clip-motion, `dynamics` for a
 * dynamics-motion. order/capabilities/description/notes are envelope
 * metadata — they must never enter the definition hash. A dynamics-motion
 * writes only identity + the dynamics payload; its display fields are derived
 * from `dynamics.action` by normalizeMotionFile, not authored on disk. */
export type MotionFileKind='workshop-motion'|'clip-motion'|'dynamics-motion';
export interface MotionCapabilities{
  /** The prop's `side` is the wrist it mounts on; absent means 'R' — the
   * pre-WP-D default every existing envelope relied on. `bevel` is the facet
   * rolled into the palm (1–8, palm-relative); absent means the canonical
   * bevel 1. */
  prop?:{kind:'racket';trail:boolean;handView:boolean;side?:'L'|'R';bevel?:number};
  camera?:{targetHeight:number;distance:number};
  locomotion?:'in-place'|'follow';
}
export interface MotionFile{
  schemaVersion:1;kind:MotionFileKind;id:string;order:number;name:string;english:string;duration:number;
  description:string;method:string;focus:string[];phases:{time:number;label:string}[];
  /** Library grouping. `basic` marks the reusable basic actions (半蹲, 弓步 …)
   * the workshop inserts at a frame; absent means a sport/legacy motion. */
  category?:'basic';
  /** Basic-action insertion metadata: the template moves its hand targets
   * too, so insertion applies the hand target/pole offsets on top of the
   * playhead state (wrist orientation still stays as authored there). Absent
   * keeps the arms exactly where the playhead found them. */
  carryHands?:boolean;
  notes?:string[];license?:string;oneShot?:boolean;capabilities?:MotionCapabilities;
  document?:WorkshopDoc;clip?:{url:string;meta?:string};
  dynamics?:{action:MuscleActionFile;records:DynamicsRecords};
}

const isStr=(v:unknown):v is string=>typeof v==='string'&&v.length>0;
const isNum=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const isObj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Top-level keys a dynamics-motion may carry: identity plus the dynamics
 * payload. Everything else is either another kind's trajectory carrier
 * (document/clip) or display metadata derived from dynamics.action — writing
 * it would be dead data shadowed at normalize. */
const DYNAMICS_KEYS=new Set(['schemaVersion','kind','id','order','dynamics']);

/** Structural check for the envelope. Required/type errors plus the kind
 * branch contract — mutually exclusive trajectory carriers: a workshop-motion
 * must carry its document inline and may not point at an external clip or a
 * dynamics payload; a clip-motion must point at an external clip and may not
 * embed a document or dynamics payload; a dynamics-motion must carry
 * `dynamics.action` (schemaVersion 1, id, display) plus `dynamics.records.
 * baseline` URLs and may not write document/clip or any display field (they
 * are derived). `document` content itself is the WorkshopDoc validator's job
 * (normalizeMotionFile runs it). */
export function validateMotionFileShape(raw:unknown):string[]{
 const e:string[]=[];
 if(!isObj(raw))return ['动作文件不是对象'];
 const f=raw as unknown as MotionFile;
 if(f.schemaVersion!==1)e.push('schemaVersion 必须为 1');
 if(f.kind!=='workshop-motion'&&f.kind!=='clip-motion'&&f.kind!=='dynamics-motion')e.push('kind 必须是 workshop-motion、clip-motion 或 dynamics-motion');
 if(!isStr(f.id))e.push('缺少 id');
 if(!isNum(f.order))e.push('order 必须是有限数');
 if(f.kind!=='dynamics-motion'){
  if(typeof f.name!=='string')e.push('缺少 name');
  if(typeof f.english!=='string')e.push('english 必须是字符串');
  if(!isNum(f.duration))e.push('duration 必须是有限数');
  if(typeof f.description!=='string')e.push('description 必须是字符串');
  if(typeof f.method!=='string')e.push('method 必须是字符串');
  if(!Array.isArray(f.focus)||f.focus.some(x=>typeof x!=='string'))e.push('focus 必须是字符串数组');
  if(!Array.isArray(f.phases)||f.phases.some(p=>!isObj(p)||!isNum(p.time)||typeof p.label!=='string'))e.push('phases 必须是 {time,label} 数组');
  // Phase markers must land inside the envelope's own duration — a marker
  // past the end would sit on the timeline forever unreached (or a negative
  // one would sort before t=0). Applies to workshop- and clip-motion alike.
  else if(isNum(f.duration)&&f.phases.some(p=>p.time<0||p.time>f.duration))e.push('phases.time 必须在 0–duration 内');
  if(f.category!==undefined&&f.category!=='basic')e.push('category 必须是 basic');
  if(f.carryHands!==undefined&&typeof f.carryHands!=='boolean')e.push('carryHands 必须是布尔值');
  if(f.notes!==undefined&&(!Array.isArray(f.notes)||f.notes.some(x=>typeof x!=='string')))e.push('notes 必须是字符串数组');
  if(f.license!==undefined&&typeof f.license!=='string')e.push('license 必须是字符串');
  if(f.oneShot!==undefined&&typeof f.oneShot!=='boolean')e.push('oneShot 必须是布尔值');
  if(f.capabilities!==undefined){
   const c=f.capabilities;
   if(!isObj(c))e.push('capabilities 必须是对象');
   else{
    if(c.prop!==undefined&&(!isObj(c.prop)||c.prop.kind!=='racket'||typeof c.prop.trail!=='boolean'||typeof c.prop.handView!=='boolean'||(c.prop.side!==undefined&&c.prop.side!=='L'&&c.prop.side!=='R')))e.push('capabilities.prop 必须是 {kind:\'racket\',trail,handView,side?}');
    else if(c.prop!==undefined&&c.prop.bevel!==undefined&&(!isNum(c.prop.bevel)||!Number.isInteger(c.prop.bevel)||c.prop.bevel<1||c.prop.bevel>8))e.push('capabilities.prop.bevel 必须是 1–8 的整数');
    if(c.camera!==undefined&&(!isObj(c.camera)||!isNum(c.camera.targetHeight)||!isNum(c.camera.distance)))e.push('capabilities.camera 必须是 {targetHeight,distance}');
    if(c.locomotion!==undefined&&c.locomotion!=='in-place'&&c.locomotion!=='follow')e.push('capabilities.locomotion 必须是 in-place 或 follow');
   }
  }
  if(f.dynamics!==undefined)e.push(`${f.kind} 不得有 dynamics（轨迹字段互斥）`);
 }
 if(f.kind==='workshop-motion'){
  if(!isObj(f.document))e.push('workshop-motion 必须有 document');
  else{
   // Cross-field parity: the envelope's display duration and the embedded
   // document's duration are two spellings of the same motion and must agree
   // exactly — both are raw JSON numbers (normalizeDoc never rewrites
   // duration, so checking the raw value here is equivalent to checking the
   // normalized one downstream).
   const dd=f.document.duration;
   if(isNum(dd)&&isNum(f.duration)&&dd!==f.duration)e.push(`document.duration ${dd} 与 envelope duration ${f.duration} 不一致`);
  }
  if(f.clip!==undefined)e.push('workshop-motion 不得有 clip（轨迹字段互斥）');
 }
 if(f.kind==='clip-motion'){
  if(!isObj(f.clip)||!isStr(f.clip.url))e.push('clip-motion 必须有 clip.url');
  if(f.document!==undefined)e.push('clip-motion 不得有 document（轨迹字段互斥）');
 }
 if(f.kind==='dynamics-motion'){
  if(!isObj(f.dynamics))e.push('dynamics-motion 必须有 dynamics');
  else{
   const action=f.dynamics.action;
   if(!isObj(action)||(action as MuscleActionFile).schemaVersion!==1||!isStr((action as MuscleActionFile).id)||!isObj((action as MuscleActionFile).display))
    e.push('dynamics.action 必须是 schemaVersion 1 且含 id/display 的动作参数对象');
   const records=f.dynamics.records;
   if(!isObj(records)||!isObj(records.baseline)||!isStr(records.baseline.meta)||!isStr(records.baseline.data))
    e.push('dynamics.records.baseline 必须有 meta/data URL');
   else if(records.weak!==undefined&&(!isObj(records.weak)||!isStr(records.weak.meta)||!isStr(records.weak.data)))
    e.push('dynamics.records.weak 必须是 {meta,data} URL 对');
  }
  if(f.document!==undefined)e.push('dynamics-motion 不得有 document（轨迹字段互斥）');
  if(f.clip!==undefined)e.push('dynamics-motion 不得有 clip（轨迹字段互斥）');
  for(const k of Object.keys(raw))if(!DYNAMICS_KEYS.has(k)&&k!=='document'&&k!=='clip')e.push(`dynamics-motion 不写 ${k}（显示字段由 dynamics.action 派生）`);
 }
 if(f.clip!==undefined&&(!isObj(f.clip)||!isStr(f.clip.url)||(f.clip.meta!==undefined&&typeof f.clip.meta!=='string')))e.push('clip 必须是 {url,meta?}');
 return e;
}

/** Validate, then normalize: the workshop-motion's embedded document goes
 * through the same upgrade/validate/canonicalize pipeline every WorkshopDoc
 * takes; a dynamics-motion has its display fields (name/english/duration/
 * description/method/focus/phases/oneShot) derived from `dynamics.action` —
 * the envelope carries only identity plus the dynamics payload. */
export function normalizeMotionFile(raw:unknown):MotionFile{
 const errs=validateMotionFileShape(raw);
 if(errs.length)throw new Error(`${errs[0]}${errs.length>1?`（共 ${errs.length} 处问题）`:''}`);
 const f={...(raw as MotionFile)};
 if(f.kind==='workshop-motion')f.document=normalizeDoc(f.document);
 if(f.kind==='dynamics-motion'){
  const action=f.dynamics!.action;
  const {leadSeconds=0,tailSeconds=0,referenceSpeedScale=1}=action.simulation;
  const last=action.reference.kind==='task-keyframes'
   ?(action.reference.keyframes?.at(-1)?.timeSeconds??0)
   :(action.reference.source.frameRangeSeconds?.[1]??0)-(action.reference.source.frameRangeSeconds?.[0]??0);
  const sourceScale=action.reference.kind==='captured-points'?referenceSpeedScale:1/referenceSpeedScale;
  const rawDuration=leadSeconds+last*sourceScale+tailSeconds;
  const samples=Math.floor((rawDuration+1e-8)*action.simulation.sampleHz)+1;
  const referenceDuration=(samples-1)/action.simulation.sampleHz;
  const duration=action.display.durationSeconds??(action.reference.kind==='task-keyframes'
   ?(Math.round(referenceDuration/action.simulation.stepSeconds)+1)*action.simulation.stepSeconds
   :rawDuration);
  const phases=(action.display.phases??action.reference.keyframes?.map(k=>({time:leadSeconds+k.timeSeconds/referenceSpeedScale,label:k.phase}))??[])
   .map(p=>({...p,time:Math.min(p.time,duration)}));
  f.name=action.title;f.english=action.display.english;f.duration=duration;
  f.description=action.display.description;f.method=action.display.method;
  f.focus=action.display.focus;f.phases=phases;f.oneShot=action.display.oneShot;
 }
 return f;
}

/** Strip the envelope for consumers that take a bare WorkshopDoc. Non-envelope
 * input passes through unchanged; a clip-motion or dynamics-motion has no
 * inline document — its trajectory lives in the clip asset / the dynamics
 * records, so unwrapping is a hard error. */
export function unwrapMotionFile(raw:unknown):unknown{
 if(!isObj(raw))return raw;
 if(raw.kind==='workshop-motion')return raw.document;
 if(raw.kind==='clip-motion')throw new Error('clip-motion 没有内嵌 document：轨迹在外部 clip 资产中');
 if(raw.kind==='dynamics-motion')throw new Error('dynamics-motion 没有内嵌 document：轨迹在动力学记录中');
 return raw;
}

/** The solved-motion definition that enters the artifact hash: document plus
 * the phases/notes/license that give the package its semantics — never the
 * display-only envelope fields. Dynamics-motion and clip-motion envelopes carry
 * no inline document, so they cannot enter the pose pipeline. */
export function motionDefinitionPayload(f:MotionFile){
 if(f.kind==='dynamics-motion')throw new Error('dynamics-motion 不进入姿态管线：没有可哈希的 document');
 return {schema:'workshop-motion/v1' as const,id:f.id,document:f.document,phases:f.phases,notes:f.notes??[],license:f.license};
}
