import {POSE_PACKAGE_KIND,POSE_PACKAGE_SCHEMA_VERSION} from './package-const';
import {RIG_ID} from './protocol';
import {RACKET_BEVELS} from './props/racket';
import type {PosePackage} from './pose-package';
import type {MotionCapabilities} from './motion-file';
import {motionFileById} from './motion-files';
import type {MotionId,MotionSpec} from './types';

/** Inspection of a DELIVERED pose package: the structural gate the lab applies
 * before decoding, the rig-identity check, and the display-spec derivation.
 * Pure — no three, no DOM, no node — so the browser import path, the Node CLIs
 * (scripts/package-to-glb.mts) and the service-side tests share one spelling of
 * the delivered-package contract. */

const isObj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const isVec=(v:unknown):v is number[]=>Array.isArray(v)&&v.every(Number.isFinite);
/** The events enum of spec/pose-package.schema.json — keep in lockstep. */
const PACKAGE_EVENT_TYPES=new Set<string>(['phase','keyframe','contact','support-start','support-end']);
/** Absolute sample bound for a delivered package: 200_000 samples ≈ 13.9 min
 * at the service's 240 fps ceiling — far past any real take. A giant count
 * multiplies into every per-track allocation and decode loop at import, so
 * the bound is a memory-DoS gate, not a motion-quality judgement. */
export const MAX_PACKAGE_SAMPLES=200_000;

/** Structural self-check for a delivered pose package: wire constants, the
 * timestamp contract (strictly increasing, `timestamps.at(-1) === duration`),
 * count consistency and track shapes; `validBones` additionally binds rotation
 * tracks to the local rig's bone set. Human-readable problems; empty = decodable. */
export function checkPosePackageShape(pkg:unknown,validBones?:ReadonlySet<string>):string[]{
  const e:string[]=[];
  if(!isObj(pkg))return ['姿态包不是对象'];
  const p=pkg as unknown as PosePackage;
  if(p.kind!==POSE_PACKAGE_KIND)e.push(`kind 必须是 ${POSE_PACKAGE_KIND}`);
  if(p.schemaVersion!==POSE_PACKAGE_SCHEMA_VERSION)e.push(`schemaVersion 必须是 ${POSE_PACKAGE_SCHEMA_VERSION}`);
  if(!isObj(p.units)||p.units.length!=='meter'||p.units.angle!=='radian'||p.units.time!=='second')e.push('units 必须是 meter/radian/second');
  if(!isObj(p.frame)||p.frame.handedness!=='right'||p.frame.up!=='+Y'||p.frame.forward!=='+Z')e.push('frame 必须是 right/+Y/+Z');
  if(p.poseMode!=='local-trs'||p.quaternionOrder!=='xyzw')e.push('poseMode/quaternionOrder 必须是 local-trs/xyzw');
  const count=p.timeline?.count,timestamps=p.timeline?.timestamps;
  if(typeof count!=='number'||count<1||!Number.isFinite(p.timeline?.duration)||!Array.isArray(timestamps)||timestamps.length!==count)e.push('timeline 畸形：需要 count≥1、有限 duration、timestamps 长度等于 count');
  else if(timestamps.every(Number.isFinite)){
    for(let i=1;i<timestamps.length;i++)if(!(timestamps[i]>timestamps[i-1])){e.push(`timestamps 未严格递增（第 ${i} 项）`);break;}
    if(timestamps[timestamps.length-1]!==p.timeline.duration)e.push('末时间戳不等于 duration');
  }else e.push('timestamps 含非有限数');
  /* Declared fps is validated here because the density cap below consumes
   * it: our builders always emit it, and the validator tolerates up to 240 —
   * anything outside (0,240] is corrupt. */
  const fpsDecl=p.timeline?.fps;
  if(fpsDecl!==undefined&&!(typeof fpsDecl==='number'&&Number.isFinite(fpsDecl)&&fpsDecl>0&&fpsDecl<=240))
    e.push('timeline.fps 必须在 (0,240] 内');
  /* Resource caps on the DECLARED count. The producers' real grid is uniform
   * 1/fps steps PLUS the appended exact endpoint (pose-package.ts capture()),
   * so the largest honest count is ⌈duration·fps⌉+1 — a flat duration·fps+1
   * bound off-by-ones whenever duration·fps is not a whole number (e.g.
   * 0.502 s @240fps legitimately carries 122 samples). The package's own
   * declared fps tightens the bound when present; absent, the 240 outer
   * bound stands. The absolute cap bounds the same work when duration itself
   * is inflated (MAX_PACKAGE_SAMPLES ≈ 13.9 min @240fps). */
  if(typeof count==='number'&&Number.isFinite(count)){
    const fpsBound=typeof fpsDecl==='number'&&Number.isFinite(fpsDecl)&&fpsDecl>0?Math.min(fpsDecl,240):240;
    if(count>MAX_PACKAGE_SAMPLES)e.push(`timeline.count=${count} 超过绝对上限 ${MAX_PACKAGE_SAMPLES}`);
    else if(Number.isFinite(p.timeline?.duration)&&count>Math.ceil(p.timeline!.duration*fpsBound-1e-6)+1)
      e.push(`timeline.count=${count} 超出采样密度上限（⌈${p.timeline!.duration} s × ${fpsBound} fps⌉+1）`);
  }
  const T=p.tracks?.translation,c=typeof count==='number'?count:-1;
  if(!T||T.bone!=='root'||!isVec(T.values)||T.values.length!==c*3)e.push('root 位移轨缺失或长度不是 count×3');
  if(!Array.isArray(p.tracks?.rotations))e.push('tracks.rotations 缺失');
  else{
    const rotations=p.tracks.rotations;
    if(validBones&&rotations.length>validBones.size)e.push(`旋转轨数量 ${rotations.length} 超过 rig 骨骼数 ${validBones.size}`);
    // One track per bone: a duplicate name decodes last-write-wins with no
    // warning — ambiguity must be refused, never resolved silently.
    const seen=new Set<string>();
    for(const tr of rotations){
      if(typeof tr?.bone==='string'){if(seen.has(tr.bone))e.push(`骨骼 ${tr.bone} 有重复旋转轨`);else seen.add(tr.bone);}
      if(validBones&&!validBones.has(tr?.bone))e.push(`旋转轨引用了 rig 外的骨骼 ${tr?.bone}`);
      if(!Array.isArray(tr?.values)||tr.values.length!==c*4){e.push(`${tr?.bone??'?'} 的旋转值长度不是 count×4`);continue;}
      // Every delivered quaternion must be unit — the same 1e-3 tolerance
      // the service validator applies (validate.ts). NaN, all-zero and
      // non-unit samples are reported with bone + frame and refuse the
      // package: decoding them would silently produce garbage poses.
      for(let i=0;i<c;i++){
        const o=i*4,q=[tr.values[o],tr.values[o+1],tr.values[o+2],tr.values[o+3]];
        // Per-component Number.isFinite (non-coercing) — Math.hypot alone
        // would ToNumber strings like "0.5" into a passable quaternion.
        if(!q.every(Number.isFinite)){e.push(`${tr.bone}: 第 ${i} 帧四元数含非有限分量`);break;}
        const l=Math.hypot(q[0],q[1],q[2],q[3]);
        if(Math.abs(l-1)>1e-3){e.push(`${tr.bone}: 第 ${i} 帧四元数非单位（|q|=${l.toFixed(4)}）`);break;}
      }
    }
  }
  // The rig block the package claims to be solved against (schema requires id
  // + manifestSHA256 + bones). A foreign rig id is refused here; the manifest
  // hash itself is verified by the caller (rigMatches) where the local hash
  // is known — the shape check can only insist it is a string.
  if(!isObj(p.rig))e.push('rig 必须是对象');
  else{
    if(p.rig.id!==RIG_ID)e.push(`rig.id 必须是 ${RIG_ID}`);
    if(typeof p.rig.manifestSHA256!=='string')e.push('rig.manifestSHA256 必须是字符串');
    if(!Number.isInteger(p.rig.bones)||p.rig.bones<1)e.push('rig.bones 必须是 ≥1 的整数');
  }
  // events is optional to the DECODER, but a present-but-malformed array would
  // silently lose timeline markers — reject loudly instead. Element shape
  // mirrors spec/pose-package.schema.json's events enum plus the validator's
  // support-event side rule (validate.ts).
  if(p.events!==undefined){
    if(!Array.isArray(p.events))e.push('events 必须是数组');
    else for(const ev of p.events){
      if(!isObj(ev)){e.push('events 元素必须是对象');continue;}
      if(!PACKAGE_EVENT_TYPES.has(ev.type as string)){e.push(`events 元素 type 非法：${String(ev.type)}`);continue;}
      if(!Number.isFinite(ev.time)||ev.time<0)e.push(`events.${ev.type} 的 time 必须是 ≥0 的有限数`);
      if(typeof ev.label!=='string')e.push(`events.${ev.type} 的 label 必须是字符串`);
      if((ev.type==='support-start'||ev.type==='support-end')&&ev.side!=='L'&&ev.side!=='R')
        e.push(`events.${ev.type} 需要 side 'L'|'R'`);
    }
  }
  // Minimum shape of the consumed metadata fields — posePackageSpec already
  // filters defensively; flagging them here makes a malformed package refuse
  // at the door rather than degrade quietly at render time.
  if(p.action!==undefined){
    if(!isObj(p.action))e.push('action 必须是对象');
    else if(p.action.id!==undefined&&typeof p.action.id!=='string')e.push('action.id 必须是字符串');
  }
  if(p.quality!==undefined){
    if(!isObj(p.quality))e.push('quality 必须是对象');
    else if(p.quality.warnings!==undefined&&(!Array.isArray(p.quality.warnings)||p.quality.warnings.some(w=>typeof w!=='string')))
      e.push('quality.warnings 必须是字符串数组');
  }
  if(p.provenance!==undefined){
    if(!isObj(p.provenance))e.push('provenance 必须是对象');
    else for(const k of ['solver','solverRevision','source']as const)
      if(p.provenance[k]!==undefined&&typeof p.provenance[k]!=='string')e.push(`provenance.${k} 必须是字符串`);
  }
  return [...new Set(e)];
}

/** Rig identity gate for a delivered package, used by engine.openPosePackage.
 * When the engine computed the local manifest hash at load (WebCrypto needs a
 * secure context — undefined means unknowable, not absent), the package's
 * declared manifestSHA256 must equal it: a package solved for another rig
 * would decode its local rotations against the wrong skeleton. An unknown
 * local hash degrades to "true" — the caller then notes the unverified rig in
 * the spec description, and the bone-name subset check inside
 * checkPosePackageShape remains the only line of defence. */
export const rigMatches=(p:PosePackage,manifestHash:string|undefined)=>
  manifestHash===undefined||p.rig?.manifestSHA256===manifestHash;

/** Derive the lab's MotionSpec for a delivered pose package — the inverse of
 * what solveWorkshop + workshopMeta stamped at solve time. Field priority:
 * the bundled envelope (`action.id` matching motionFileById) > the ad-hoc
 * `action.parameters` channel (`documentName` + `presentation.{prop,loop}`,
 * written by both builders — see protocol.ts) > the bare action id.
 * `phases` always come from the package's own events: 'phase' events first,
 * else 'keyframe' events as timeline markers, so markers reflect delivered
 * data rather than whatever the action id claims. The description is the
 * honesty surface: solver provenance, the quality warnings the package
 * carries, and the constant-prop caveat (a v2 package cannot express the
 * document's per-frame grip ramp, so the prop is constantly shown).
 * `trust(actionId)` gates envelope restore: the engine recomputes each
 * bundled envelope's definition hash at load and passes a closure that
 * accepts only when the package's `action.definitionSHA256` equals it — a
 * forged or stale action.id then plays through the ad-hoc parameters channel
 * instead of wearing foreign capabilities/name/phases. The description says
 * which refusal it was: 'definitionSHA256 与当前内置定义不符' when the package
 * carried a hash that failed the check, '缺失/无法核验' when no check could
 * run (no hash in the package, a non-workshop-motion envelope, or no local
 * hashing at all). Callers with nothing
 * to check against may omit `trust` (bare id-match, the pre-gate behaviour).
 * `rigVerified=false` marks the degraded path where no local manifest hash
 * exists to compare (recorded on the description, honestly). */
export function posePackageSpec(p:PosePackage,id:MotionId,trust?:(actionId:string)=>boolean,rigVerified=true):MotionSpec{
 const actionId=typeof p.action?.id==='string'&&p.action.id?p.action.id:'pose-package';
 const hit=motionFileById(actionId);
 const trusted=hit!==undefined&&(trust===undefined||trust(actionId));
 const envelope=trusted?hit:undefined;
 // A hit that stays untrusted splits honestly: the package proved the WRONG
 // definition ('与当前内置定义不符') only when a check could actually run —
 // the package carries a definitionSHA256, the matched envelope is a
 // workshop-motion (the only kind with a definition hash), and local hashing
 // existed (rigVerified=false ⇒ no WebCrypto ⇒ envelopeDefHash is empty).
 // Everything else is '缺失/无法核验': nothing was verifiable, nothing forged.
 const declaredHash=typeof p.action?.definitionSHA256==='string'&&p.action.definitionSHA256!=='';
 const provenMismatch=declaredHash&&hit?.kind==='workshop-motion'&&rigVerified;
 const params=isObj(p.action?.parameters)?p.action.parameters:{};
 const pres=isObj(params.presentation)?params.presentation:{};
 // 'racket' is the only prop kind the lab can mount — the ad-hoc hint maps to
 // the same capability record the bundled racket envelopes declare. When an
 // envelope exists it is authoritative: its absence of a prop is also truth,
 // so a forged presentation channel cannot add a prop to a bundled id.
 const prop=envelope?envelope.capabilities?.prop
  :(pres.prop==='racket'?{kind:'racket' as const,trail:true,handView:true,
    // Ad-hoc packages carry the document's grip side and bevel as
    // package-level constants (v2 has no per-frame prop channel); absent
    // means 'R' and bevel 1.
    ...(pres.gripSide==='L'?{side:'L' as const}:{}),
    ...(typeof pres.bevel==='number'&&Number.isInteger(pres.bevel)&&pres.bevel>=1&&pres.bevel<=RACKET_BEVELS?{bevel:pres.bevel}:{})}:undefined);
 const capabilities:MotionCapabilities|undefined=envelope?envelope.capabilities:(prop?{prop}:undefined);
 // Loop semantics are authored in the document, not the package: bundled
 // envelopes carry the document, ad-hoc packages carry presentation.loop.
 const authoredLoop=envelope?envelope.document?.loop:(typeof pres.loop==='boolean'?pres.loop:undefined);
 // isObj + field types is belt-and-suspenders: the shape check already
 // rejects malformed events when it ran, but this function is also called
 // standalone — a half-baked `{type:'phase'}` must not leak undefined
 // time/label into the spec's phases.
 const events=(Array.isArray(p.events)?p.events:[]).filter(e=>isObj(e)&&typeof e.time==='number'&&typeof e.label==='string');
 const phases=events.filter(e=>e.type==='phase').map(({time,label})=>({time,label}));
 const keys=events.filter(e=>e.type==='keyframe').map(({time,label})=>({time,label}));
 const warnings=(Array.isArray(p.quality?.warnings)?p.quality.warnings:[]).filter((w):w is string=>typeof w==='string');
 const solver=typeof p.provenance?.solver==='string'?p.provenance.solver:'';
 const solverRev=typeof p.provenance?.solverRevision==='string'&&p.provenance.solverRevision?`@${p.provenance.solverRevision}`:'';
 const source=typeof p.provenance?.source==='string'&&p.provenance.source?`来源 ${p.provenance.source}`:'';
 const description=[
  '外部姿态包（pose-json）回放',
  solver?`求解器 ${solver}${solverRev}`:'',
  source,
  warnings.length?`质量警告 ${warnings.length} 条：${warnings.slice(0,3).join('；')}${warnings.length>3?' …':''}`:'质量警告 0 条',
  prop?`v2 姿态包不携带逐帧握拍量，道具按包级 hint 全程常量显示${prop.side==='L'?'（左手持拍）':''}`:'',
  hit&&!trusted?(provenMismatch
   ?'action.id 命中本地信封但 definitionSHA256 与当前内置定义不符，按外部包回放（信封能力未采用）'
   :'action.id 命中本地信封但 definitionSHA256 缺失/无法核验，按 ad-hoc 处理（信封能力未采用）'):'',
  rigVerified?'':'rig 未验证：本地 manifest 哈希不可知，降级为骨骼名匹配',
 ].filter(Boolean).join(' · ');
 const documentName=typeof params.documentName==='string'&&params.documentName?params.documentName:undefined;
 return {id,name:envelope?.name||documentName||actionId,
  english:envelope?.english||'POSE PACKAGE',duration:p.timeline.duration,
  description,method:envelope?.method??'服务交付轨迹 · FK 采样重放',
  focus:envelope?.focus??['姿态包回放'],phases:phases.length?phases:keys,
  capabilities,oneShot:authoredLoop===undefined?undefined:!authoredLoop,
  source:{kind:'pose-package',package:p}};
}
