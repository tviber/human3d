import {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,Check,Minus,Plus,X} from 'lucide-react';
import type {GroundReport,HumanRig,SemanticEdit,SemanticPart,SemanticReport,Side,WorkshopDoc} from '@human3d/motion-core';
import {applySemanticEdit,frameAt,groundFoot,measureSemantic,SIDELESS_PARTS,SEMANTIC_CARRIES,SEMANTIC_KEEPS,SEMANTIC_MOTIONS,SEMANTIC_PART_LABELS,solveEffectiveFrame} from '@human3d/motion-core';

export interface SemanticHost{
 /** Solved rig, document and selected key; null when the model is not ready. */
 context:()=>{rig:HumanRig;doc:WorkshopDoc;keyId:string;origin:import('three').Vector3;pelvisShift:()=>number|undefined}|null;
 /** Begin one undo transaction on the base document (record its snapshot). */
 begin:(base:WorkshopDoc)=>void;
 /** Swap the active document content (preview or commit) — never re-records history. */
 write:(next:WorkshopDoc)=>void;
 /** Cancel: restore the base and drop the transaction's history step. */
 cancel:(base:WorkshopDoc)=>void;
 commit:()=>void;
 highlightPart:(part:SemanticPart,side?:Side)=>void;
 clearMuscleHighlight:()=>void;
}
const STEPS=[1,5,15];
const PARTS=Object.keys(SEMANTIC_MOTIONS) as SemanticPart[];

/** Part → side → motion → amount. Every preview recomputes from the SAME
 * base document captured when the transaction began, so slider moves,
 * repeated +/- taps and React re-renders can never stack an increment twice;
 * "确认" ends the transaction (one undo step), "取消" restores the base. */
export function SemanticPanel({host,defaultSide,keyLabel}:{host:SemanticHost;defaultSide:Side;keyLabel:string}){
 const [part,setPart]=useState<SemanticPart>('elbow');
 const [side,setSide]=useState<Side>(defaultSide);
 const [motion,setMotion]=useState(SEMANTIC_MOTIONS.elbow[0].motion);
 const [amount,setAmount]=useState(0),[kneeValue,setKneeValue]=useState(0),[kneeTarget,setKneeTarget]=useState<number|null>(null);
 const [step,setStep]=useState(5);
 const [report,setReport]=useState<SemanticReport|null>(null);
 const [error,setError]=useState('');
 const [ground,setGround]=useState<GroundReport|null>(null);
 const base=useRef<{doc:WorkshopDoc;keyId:string;shift?:number;kneeAngle?:number}|null>(null);
 const hostRef=useRef(host);hostRef.current=host;
 const kneeStateKey=part==='knee'?(()=>{
  const ctx=hostRef.current.context(),key=ctx?.doc.keys.find(k=>k.id===ctx.keyId);
  return key?JSON.stringify([key.pose.root,key.pose.yaw,key.pose.footL,key.pose.footR,key.constraints.plantL,key.constraints.plantR]):'';
 })():'';
 useEffect(()=>{
  if(part!=='knee')return;
  const ctx=hostRef.current.context();if(!ctx)return;
  const key=ctx.doc.keys.find(k=>k.id===ctx.keyId);if(!key)return;
  solveEffectiveFrame(ctx.rig,frameAt(ctx.doc,key.time,ctx.origin),ctx.pelvisShift());
  setKneeValue(measureSemantic(ctx.rig,'knee','flexion',side));
 },[part,side,keyLabel,kneeStateKey]);
 const hoveredPart=useRef<SemanticPart|null>(null);
 const info=SEMANTIC_MOTIONS[part].find(m=>m.motion===motion)??SEMANTIC_MOTIONS[part][0];
 const captureBase=(ctx:NonNullable<ReturnType<SemanticHost['context']>>)=>{
  if(base.current?.keyId===ctx.keyId)return;
  const doc=JSON.parse(JSON.stringify(ctx.doc)) as WorkshopDoc;
  const key=doc.keys.find(k=>k.id===ctx.keyId);if(!key)throw new Error(`关键帧 ${ctx.keyId} 不存在`);
  const shift=ctx.pelvisShift();
  let kneeAngle:number|undefined;
  if(part==='knee'){
   solveEffectiveFrame(ctx.rig,frameAt(doc,key.time,ctx.origin),shift);
   kneeAngle=measureSemantic(ctx.rig,'knee','flexion',side);setKneeValue(kneeAngle);
  }
  base.current={doc,keyId:ctx.keyId,shift,kneeAngle};host.begin(doc);
 };
 const preview=(degrees:number)=>{
  setGround(null);
  const ctx=host.context();if(!ctx){setError('模型尚未加载完成');return;}
  try{captureBase(ctx);}catch(err){setError(err instanceof Error?err.message:String(err));return;}
  setAmount(degrees);setKneeTarget(null);setError('');
  if(degrees===0){host.write(base.current!.doc);if(base.current!.kneeAngle!==undefined)setKneeValue(base.current!.kneeAngle);setReport(null);return;}
  const edit:SemanticEdit={part,side:SIDELESS_PARTS.includes(part)?undefined:side,motion:info.motion,degrees};
  try{
   const out=applySemanticEdit(ctx.rig,base.current!.doc,ctx.keyId,edit,ctx.origin,base.current!.shift);
   host.write(out.doc);setReport(out.report);
   if(part==='knee'&&base.current!.kneeAngle!==undefined)setKneeValue(base.current!.kneeAngle+out.report.actual);
  }catch(err){setError(err instanceof Error?err.message:String(err));}
 };
 const previewKnee=(degrees:number)=>{
  setGround(null);
  const ctx=host.context();if(!ctx){setError('模型尚未加载完成');return;}
  try{captureBase(ctx);}catch(err){setError(err instanceof Error?err.message:String(err));return;}
  const initial=base.current!.kneeAngle??kneeValue,delta=degrees-initial;
  setKneeTarget(degrees);setAmount(delta);setError('');
  if(Math.abs(delta)<.01){host.cancel(base.current!.doc);reset();setKneeValue(initial);return;}
  try{
   const out=applySemanticEdit(ctx.rig,base.current!.doc,ctx.keyId,{part:'knee',side,motion:'flexion',degrees:delta},ctx.origin,base.current!.shift);
   if(!out.report.ok){
    host.cancel(base.current!.doc);reset();setKneeValue(initial);setAmount(delta);setReport(out.report);return;
   }
   host.write(out.doc);setReport(out.report);setKneeValue(initial+out.report.actual);setKneeTarget(initial+out.report.actual);
  }catch(err){setError(err instanceof Error?err.message:String(err));}
 };
 const reset=()=>{base.current=null;setAmount(0);setKneeTarget(null);setReport(null);setError('');};
 const LEG_PARTS:SemanticPart[]=['hip','legs','knee','ankle'];
 /** 落地: confirm any running preview first, then ground the edited leg's
  * free foot as its own one-step undo transaction. A refusal writes nothing. */
 const land=()=>{
  if(pending)commit();
  const ctx=host.context();if(!ctx){setError('模型尚未加载完成');return;}
  try{
   const base0=JSON.parse(JSON.stringify(ctx.doc)) as WorkshopDoc;
   const out=groundFoot(ctx.rig,base0,ctx.keyId,part==='legs'?'both':side,ctx.origin,ctx.pelvisShift());
   setGround(out.report);setError('');
   if(!out.report.ok||out.report.dropMm===0)return;
   host.begin(base0);host.write(out.doc);host.commit();
  }catch(err){setError(err instanceof Error?err.message:String(err));}
 };
 const commit=()=>{if(base.current)host.commit();reset();};
 const cancel=()=>{const restore=base.current?.kneeAngle;if(base.current)host.cancel(base.current.doc);reset();if(restore!==undefined)setKneeValue(restore);};
 const pending=base.current!==null&&(amount!==0||(part==='knee'&&kneeTarget!==null));
 const highlightPart=(p:SemanticPart,s=side)=>hostRef.current.highlightPart(p,SIDELESS_PARTS.includes(p)?undefined:s);
 const stopMuscleHighlight=()=>{hoveredPart.current=null;hostRef.current.clearMuscleHighlight();};
 const enterPart=(p:SemanticPart)=>{hoveredPart.current=p;highlightPart(p);};
 const leavePart=(p:SemanticPart)=>{if(hoveredPart.current===p){hoveredPart.current=null;hostRef.current.clearMuscleHighlight();}};
 // Unmount (key switch, undo remount) ends a running transaction: the
 // previewed pose is already in the document and its undo step recorded.
 useEffect(()=>{
  return()=>{stopMuscleHighlight();if(base.current){base.current=null;hostRef.current.commit();}};
 },[]);
 // Changing what is being edited commits the running preview first, so a
 // stale base can never be applied to a different part/side/motion.
 const switchTo=(fn:()=>void)=>{if(pending)commit();else reset();stopMuscleHighlight();setGround(null);fn();};
 const dir=amount>0?info.positive:amount<0?info.negative:'';
 return <div className="ws-semantic" data-testid="semantic-panel">
  <p className="ws-note">关键帧「{keyLabel}」 · 解剖学方向，求解后读回真实变化。</p>
  <div className="ws-chip-row" role="group" aria-label="部位">{PARTS.map(p=><button key={p} type="button" aria-pressed={part===p} data-testid={`semantic-part-${p}`}
   onPointerEnter={e=>{if(e.pointerType==='mouse')enterPart(p);}} onPointerLeave={e=>{if(e.pointerType==='mouse')leavePart(p);}}
   onClick={()=>{const keepHovered=hoveredPart.current===p;switchTo(()=>{setPart(p);setMotion(SEMANTIC_MOTIONS[p][0].motion);});if(keepHovered)enterPart(p);}}>{SEMANTIC_PART_LABELS[p]}</button>)}</div>
  {!SIDELESS_PARTS.includes(part)?<div className="ws-chip-row" role="group" aria-label="侧别">{(['L','R'] as const).map(s=><button key={s} type="button" aria-pressed={side===s} data-testid={`semantic-side-${s}`} onClick={()=>switchTo(()=>setSide(s))}>{s==='L'?'左侧':'右侧'}</button>)}</div>:null}
  <div className="ws-chip-row" role="group" aria-label="动作方向">{SEMANTIC_MOTIONS[part].map(m=><button key={m.motion} type="button" aria-pressed={info.motion===m.motion} data-testid={`semantic-motion-${m.motion}`} onClick={()=>switchTo(()=>setMotion(m.motion))}>{m.label}</button>)}</div>
  {part==='knee'?<div className="ws-semantic-knee">
   <label><span>膝屈曲角</span><output>{(kneeTarget??kneeValue).toFixed(1)}°</output></label>
   <input type="range" min={0} max={135} step={1} value={kneeTarget??kneeValue} data-testid="semantic-knee-angle" aria-label="膝屈曲角" onChange={e=>previewKnee(Number(e.target.value))}/>
   <small>0° 为伸直，135° 为参考上限。支撑脚的位置与朝向保持锁定，骨盆沿腿轴随动；若另一只支撑腿无法够到接触点，调整会被拒绝。</small>
  </div>:null}
  {part!=='knee'?<div className="ws-semantic-amount">
   <button type="button" aria-label={`${info.negative} ${step}°`} data-testid="semantic-minus" onClick={()=>preview(amount-step)}><Minus size={16}/></button>
   <label><span className="sr-only">调整幅度（度）</span>
    <input type="range" min={-90} max={90} step={1} value={amount} data-testid="semantic-amount" aria-valuetext={`${dir} ${Math.abs(amount)}°`} onChange={e=>preview(Number(e.target.value))}/>
   </label>
   <button type="button" aria-label={`${info.positive} ${step}°`} data-testid="semantic-plus" onClick={()=>preview(amount+step)}><Plus size={16}/></button>
  </div>:null}
  {part!=='knee'?<div className="ws-semantic-steps" role="group" aria-label="步长">{STEPS.map(s=><button key={s} type="button" aria-pressed={step===s} onClick={()=>setStep(s)}>{s}°</button>)}</div>:null}
  <div className={`ws-semantic-report ${report&&!report.ok?'warn':''}`} role="status" aria-live="polite" data-testid="semantic-report">
   {report?<>
    <strong>{dir}：请求 {Math.abs(report.requested).toFixed(1)}° · 实际 {report.actual*Math.sign(report.requested||1)>=0?'':'反向 '}{Math.abs(report.actual).toFixed(1)}°</strong>
    <small>残差 {report.residual.toFixed(2)}°{report.targetResidualMm!==undefined?` · 腕目标残差 ${report.targetResidualMm.toFixed(1)} mm`:''} · 支撑脚位移 {report.footDriftMm.toFixed(1)} mm</small>
    {report.reason?<small data-testid="semantic-reason">未完全执行：{report.reason}</small>:null}
   </>:<small>{amount===0?'选择方向后用 +/- 或滑块预览。':''}</small>}
   {error?<small role="alert">{error}</small>:null}
  </div>
  {LEG_PARTS.includes(part)?<div className="ws-semantic-ground">
   <button type="button" data-testid="semantic-ground" onClick={land} title="整体平移本帧身体，让离地的脚底落到地面；调整过的关节角不变，支撑腿重新求解">
    <ArrowDownToLine size={14}/>落地{part==='legs'?'（较低的脚）':side==='L'?'（左脚）':'（右脚）'}</button>
   {ground?<small data-testid="semantic-ground-result" className={ground.ok?'':'warn'} role="status">{ground.ok?ground.detail:`未落地：${ground.reason}`}</small>:null}
  </div>:null}
  <p className="ws-note" data-testid="semantic-carries">{report?.carries??SEMANTIC_CARRIES[part]}。{report?.keeps??SEMANTIC_KEEPS}。</p>
  <div className="ws-row">
   <button type="button" data-testid="semantic-cancel" disabled={!pending} onClick={cancel}><X size={13}/>取消</button>
   <button type="button" data-testid="semantic-commit" disabled={!pending} onClick={commit}><Check size={13}/>确认（一步撤销）</button>
  </div>
 </div>;
}
