import {webPlatform} from '../platform/platform';
import {useMediaMatches} from '../lib/use-media';
import {useEffect,useRef,useState} from 'react';
import {Group, Panel, Separator} from 'react-resizable-panels';
import {motion, useReducedMotion} from 'motion/react';
import {Activity,ArrowUpRight,ChevronRight,Expand,Info,Layers,Pause,Play,RotateCcw,Scan,SlidersHorizontal,X} from 'lucide-react';
import {DynamicsPanel} from './DynamicsPanel';
import {workshopEditability} from './handoff';
import {HumanEngine} from './engine';
import {MOTIONS} from '@human3d/motion-core';
import {checkPosePackageShape} from '@human3d/motion-core';
import type {DebugOptions,MotionId,ViewId} from '@human3d/motion-core';
import {Button} from '../components/ui/button';
import {Switch} from '../components/ui/switch';
import {useLabUi} from './store';
const format=(time:number)=>{const tenths=Math.round(time*10);return `${Math.floor(tenths/600).toString().padStart(2,'0')}:${Math.floor(tenths/10)%60<10?'0':''}${Math.floor(tenths/10)%60}.${tenths%10}`;};
/** Mirrors the CSS breakpoint in panels.css: phones get the drawer layout
 * (viewport-first + bottom sheets) instead of the stacked scrolling page. */
const COMPACT_QUERY='(max-width: 760px)';
const useCompact=()=>useMediaMatches(COMPACT_QUERY);
function Toggle({label,checked,onChange,detail,disabled}:{label:string;checked:boolean;onChange:(v:boolean)=>void;detail?:string;disabled?:boolean}){
 return <label className="toggle-row"><span>{label}{detail?<small>{detail}</small>:null}</span><Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange}/></label>;
}
function InfoDialog({kind,onClose}:{kind:'guide'|'sources'|'kinetics';onClose:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);
 const reduce=useReducedMotion();
 useEffect(()=>{ref.current?.showModal();const dialog=ref.current;return()=>dialog?.close();},[]);
 return <dialog ref={ref} className="info-dialog" onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><motion.div initial={reduce?false:{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:reduce?0:.32,ease:[0.22,1,0.36,1]}}><div className="dialog-heading"><h2>{kind==='guide'?'使用指南':kind==='kinetics'?'动力链：依据与模型边界':'资料与许可'}</h2><Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}><X size={20}/></Button></div>{kind==='guide'?<>
  <p>拖动人体周围的画布旋转视角，滚轮或双指缩放。右键拖动可平移视图。</p>
  <div className="guide-row"><kbd>Space</kbd><span>播放 / 暂停</span></div><div className="guide-row"><kbd>1 — 8</kbd><span>切换动作</span></div><div className="guide-row"><kbd>R</kbd><span>重新播放</span></div>
  <p>点击时间轴或动作阶段可逐帧观察。持拍动作中点击「手部特写」检查握柄与手指的关系。</p>
  <p>骨骼显示的是蒙皮绑定骨架，坐标轴使用工程局部坐标；它们不是医学骨骼几何或临床关节角度。</p>
 </>:kind==='kinetics'?<>
  <p>肌肉将化学能转为机械功。地面反力改变人体整体动量；关节反力、肌肉力矩和惯性耦合各段运动，并非同一个力逐段流过身体。</p>
  <p>棒球投掷的动力链并非“一股力量沿身体流到手上”：支撑反力、下肢制动、骨盆与上躯干旋转，以及肘伸和肩内旋共同决定末端速度。<a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC9950989/" target="_blank" rel="noreferrer">临床投球生物力学综述</a>总结了落脚后膝伸展、骨盆转动、上躯干转动、肘伸展和肩内旋的时序，也指出落脚脚位会影响后续转动。</p>
  <p><a href="https://mocap.cs.cmu.edu/search.php?subjectnumber=124" target="_blank" rel="noreferrer">CMU 124_01 棒球投球</a>用于检查上手投掷的阶段顺序；原始跨步数据不直接移植到双脚固定模型。现动作由腿部加载、骨盆先启、躯干跟进、肩肘加速组成，是无球、原地的工程任务关键帧，手指在释放时张开；没有球体或飞行轨迹。</p>
  <p><a href="https://doi.org/10.18869/acadpub.aassjournal.2.2.39" target="_blank" rel="noreferrer">直拳运动学研究</a>和<a href="https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2020.598861/full" target="_blank" rel="noreferrer">cross / hook / uppercut 的三维拳击分析</a>用于检查拳路与节段参与。后手直拳以向前的直线路径和肘伸为主，研究测到的路径可有小幅上行和内收；这不是向身体外侧的横扫。左拳贴近脸侧、肘收在肋旁是本动作的工程化护架目标，不是论文直接给出的逐关节数据。</p>
  <p>动作从右拳后下方的收拳位开始，骨盆和躯干带动后手沿肩线推出；左拳保持闭合并护住下颌，左肘靠近躯干。手指 MCP、PIP、DIP 与拇指对掌姿态由连续蒙皮上的关节目标显示，左手指没有对应的 MyoSim 肌肉 DOF。</p>
  <p>力学模型派生自 <a href="https://github.com/MyoHub/myo_sim" target="_blank" rel="noreferrer">MyoSim 0.2.3（Apache-2.0）</a>，保留原有肌肉路径、质量惯性和力—长度—速度参数；<a href="https://mujoco.readthedocs.io/en/stable/computation/" target="_blank" rel="noreferrer">MuJoCo</a>负责激活延迟、重力、约束和运动积分。</p>
  <p>降阶模型含 44 个活动关节自由度和 6 个浮动根速度自由度；双侧肩肘、躯干、髋膝踝及右腕 / 前臂 / 手指可动，双脚固定支撑。球肩以三自由度球关节近似，膝以铰链近似；源数据的完整 416 个肌肉执行器仍保留。</p>
  <p>动作目标由离线有界肌肉激励优化与 MuJoCo 正向积分生成记录，网页倍速只改回放。投掷阶段参考 CMU 动捕分期并以 pelvis-relative 任务关键帧表达；直拳使用有界肩旋转向量和肘屈伸关键帧，拳路以后向前的同侧直线为主，左拳保持闭合护架。直拳坐标是依据研究设计的工程近似，不是实测拳手的动捕或逆动力学重建。</p>
  <div className="notice"><Info size={17}/><span>没有球体、投射物飞行、拳击碰撞、肌肉体积变化或肌腱弹性。手指动作和皮肤变形属于工程近似。完整来源与测试边界见 docs/DYNAMICS.md。</span></div>
 </>:<>
  <p>真实人体表面、163 根骨骼与原始蒙皮权重来自 <a href="https://static.makehumancommunity.org/about/license.html" target="_blank" rel="noreferrer">MakeHuman（核心资产 CC0）<ArrowUpRight size={13}/></a>，离线细分后转换为 glTF。</p>
  <p>行走采用 <a href="https://mocap.cs.cmu.edu/" target="_blank" rel="noreferrer">CMU Motion Capture · 35_01<ArrowUpRight size={13}/></a>，裁剪一个步态周期并重定向。数据允许用于产品，禁止单独转售数据。</p>
  <p>原有其他动作使用有约束的关键姿态与双骨 IK。网球时序参考 <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC2577481/" target="_blank" rel="noreferrer">Elliott, Biomechanics and tennis (2006)<ArrowUpRight size={13}/></a>，是工程演示，未声称来自网球运动员的实测动捕。</p>
  <p>活动范围参考 <a href="https://archive.cdc.gov/www_cdc_gov/ncbddd/jointrom/index.html" target="_blank" rel="noreferrer">CDC Joint Range of Motion Study<ArrowUpRight size={13}/></a>。保守限制不代表适用于每个人的医学标准。</p>
  <p>新增无球投掷 / 直拳使用 MyoSim（Apache-2.0）派生模型和 MuJoCo 正向仿真。CMU 124_01 用于核对投掷分期；直拳关键帧参考上述拳击运动学研究。动作坐标、左侧贴脸护架和手指闭拳姿态均为有边界的工程近似；不重新分发研究者的受试者动捕数据。</p>
  <p>采用 Three.js（MIT）/ React（MIT）/ Vite（MIT）。完整依据、资产转换步骤与已知限制见源码中的 docs/RESEARCH.md 和 docs/LICENSES.md。</p>
  <div className="notice"><Info size={17}/><span>原有六个动作为运动学演示；新增实验为降阶肌骨正向仿真回放。均未进行个体标定，不用于诊断。</span></div>
 </>}</motion.div></dialog>;
}
export function App(){
 const mount=useRef<HTMLDivElement>(null),engine=useRef<HumanEngine|null>(null),fileRef=useRef<HTMLInputElement>(null);
 const reduce=useReducedMotion();
 const compact=useCompact();
 const [sheet,setSheet]=useState<'library'|'inspector'|null>(null);
 const {id,setId,info,setInfo,error,setError,view,setView,frame,setFrame,debug,patchDebug,speed,setSpeed,loop,setLoop,dialog,setDialog,extras,setExtras}=useLabUi();
 const allMotions=[...MOTIONS,...extras],spec=allMotions.find(m=>m.id===id)??MOTIONS[0],racket=!!spec.capabilities?.prop,physics=spec.source?.kind==='dynamics';
 const editability=workshopEditability(spec);
 const openPackage=async(file:File)=>{
  try{
   const pkg:unknown=JSON.parse(await file.text());
   const rig=engine.current?.rig,problems=checkPosePackageShape(pkg,rig?new Set(rig.bones.keys()):undefined);
   if(problems.length){setError(`姿态包不可用：${problems[0]}${problems.length>1?`（共 ${problems.length} 处问题）`:''}`);return;}
   const spec=engine.current?.openPosePackage(pkg);
   // Same artifact id → the fresh spec REPLACES the stored entry: a tampered
   // package can reuse an id with different name/capabilities, and keeping
   // the old object would display the stale envelope.
   if(spec){setExtras(x=>x.some(m=>m.id===spec.id)?x.map(m=>m.id===spec.id?spec:m):[...x,spec]);setId(spec.id);setError('');setSheet(null);}
  }catch(err){setError(err instanceof Error?err.message:String(err));}
 };
 useEffect(()=>{
  if(!mount.current)return;let e:HumanEngine;
  try{e=new HumanEngine(mount.current);engine.current=e;e.onFrame=setFrame;e.onView=setView;e.onReady=setInfo;e.onError=err=>setError(err.message);void e.load();}
  catch(err){setError(err instanceof Error?err.message:String(err));return;}
  if(import.meta.env.DEV)(window as unknown as {__LAB__:HumanEngine}).__LAB__=e;
  return()=>{engine.current=null;e.dispose();};
 },[]);
 const choose=(next:MotionId)=>{setId(next);setSheet(null);const nextSpec=allMotions.find(m=>m.id===next)??MOTIONS[0];if(nextSpec.oneShot){setLoop(false);if(engine.current)engine.current.loop=false;}engine.current?.setMotion(next);if(view==='hand'){setView('threeQuarter');engine.current?.setView('threeQuarter');}};
 const toggle=(key:keyof DebugOptions,value:boolean)=>{const patch={[key]:value} satisfies Partial<DebugOptions>;patchDebug(patch);engine.current?.setDebug(patch);};
 const camera=(v:ViewId)=>{setView(v);engine.current?.setView(v);};
 useEffect(()=>{
  const key=(event:KeyboardEvent)=>{if(event.target instanceof HTMLInputElement||event.target instanceof HTMLButtonElement||dialog)return;if(event.code==='Space'){event.preventDefault();engine.current?.setPlaying(!engine.current.playing);}if(event.key.toLowerCase()==='r')engine.current?.replay();if(/^[1-8]$/.test(event.key)){const next=MOTIONS[Number(event.key)-1].id;setId(next);engine.current?.setMotion(next);}};
  window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
 },[dialog]);
 return <motion.div className={`app-shell${compact?' lab-compact':''}${sheet==='library'?' lab-sheet-library':''}${sheet==='inspector'?' lab-sheet-inspector':''}`} initial={reduce?false:{opacity:0}} animate={{opacity:1}} transition={{duration:reduce?0:.18,ease:[0.2,0.8,0.2,1]}}>
  <header className="header"><div className="brand"><Activity size={27} strokeWidth={2}/><span>KINESIS</span><i/><h1>人体运动实验室</h1></div><nav><Button variant="ghost" onClick={()=>fileRef.current?.click()}>打开姿态包</Button><input ref={fileRef} type="file" accept=".json,application/json" style={{display:'none'}} onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void openPackage(f);}}/><Button variant="ghost" onClick={()=>webPlatform.navigate(editability.url)}>动作工作台</Button><Button variant="ghost" onClick={()=>setDialog('guide')}>使用指南</Button><Button variant="ghost" onClick={()=>setDialog('sources')}>资料与许可<ArrowUpRight size={14}/></Button></nav></header>
  <Group orientation="horizontal" className="workspace" id="lab-panes">
   <Panel id="lab-library" className="motion-panel" aria-label="动作库" defaultSize={252} minSize={200} maxSize={420}><div className="panel-heading"><h2>动作库</h2><button className="pkg-import" onClick={()=>fileRef.current?.click()}>导入姿态包</button><span>{String(allMotions.length).padStart(2,'0')}</span><button className="sheet-close" aria-label="收起动作库" onClick={()=>setSheet(null)}><X size={18}/></button></div>{sheet==='library'&&error?<p className="pkg-error" role="alert">{error}</p>:null}<p className="panel-intro">探索人体，理解运动。</p>
    {editability.editable?<div className="motion-edit"><button className="motion-edit-btn" data-testid="motion-edit" onClick={()=>webPlatform.navigate(editability.url)}><SlidersHorizontal size={14}/>在动作工作台编辑</button></div>
     :<p className="motion-edit-why" data-testid="motion-edit-why">{editability.reason}</p>}
    <div className="motion-list">{allMotions.map((m,i)=><button key={m.id} className={`motion-row ${id===m.id?'selected':''}`} aria-pressed={id===m.id} onClick={()=>choose(m.id)} disabled={!info}><span className="motion-number">{String(i+1).padStart(2,'0')}</span><span className="motion-label">{m.name}<small>{m.english}</small></span>{id===m.id?<ChevronRight size={16}/>:null}</button>)}</div>
    <div className="motion-notes"><div className="mini-heading">观察重点</div><p>{spec.description}</p><div className="focus-list">{spec.focus.map(f=><span key={f}>{f}</span>)}</div></div>
    <div className="asset-note"><Layers size={17}/><div>{physics?'肌骨正向仿真 · 连续蒙皮表面':'连续蒙皮人体'}<small>{physics?'44 个关节自由度 + 6 个根速度自由度 · 416 肌肉执行器':info?`${info.bones.length} 根骨骼 · ${Math.round(info.vertices/1000*10)/10}k 顶点`:'正在读取模型…'}</small></div></div>
   </Panel>
   <Separator className="pane-resize"/>
   <Panel id="lab-stage" className="viewport" aria-label="人体三维视图" minSize={320}><div ref={mount} className="canvas-host"/>
    <div className="viewport-heading"><h2>{spec.name}</h2><p>{spec.method}</p></div>
    <div className="camera-toolbar" aria-label="快速视角">{([['front','正面'],['side','侧面'],['back','背面'],['threeQuarter','45°']] as [ViewId,string][]).map(([v,label])=><button key={v} aria-pressed={view===v} onClick={()=>camera(v)} disabled={!info}>{label}</button>)}</div>
    {spec.capabilities?.prop?.handView?<button className={`hand-view ${view==='hand'?'active':''}`} onClick={()=>camera(view==='hand'?'threeQuarter':'hand')}><Scan size={15}/>手部特写</button>:null}
    {physics&&frame.dynamics?.loading?<div className="physics-loading"><div className="loading-orbit"/><strong>读取正向仿真记录</strong><span>加载解剖骨骼、肌腱路径与力学数据</span></div>:null}
    {physics&&frame.dynamics?.error?<div className="physics-loading" role="alert"><strong>{frame.dynamics.error}</strong><button onClick={()=>choose(id)}>重新读取</button></div>:null}
    {info&&error?<div className="physics-loading" role="alert"><strong>{error}</strong><button onClick={()=>setError('')}>关闭</button></div>:null}
    {!info?<div className="loading-state">{error?<><Info size={26}/><strong>无法加载人体</strong><p>{error}</p><button onClick={()=>location.reload()}>重新加载</button></>:<><div className="loading-orbit"/><strong>正在准备人体与动作</strong><p>加载网格、骨架与蒙皮权重</p></>}</div>:null}
    <div className="canvas-hint"><span className="status-dot"/>{physics?'正向仿真记录回放':info?'模型已就绪':'加载中'}<span className="hint-divider"/>拖动旋转 · 滚轮缩放</div>
    <button className="fit-view" aria-label="完整人体适配视角" title="完整人体适配视角" onClick={()=>camera('threeQuarter')} disabled={!info}><Expand size={18}/></button>
   </Panel>
   <Separator className="pane-resize"/>
   <Panel id="lab-inspector" className="inspector" aria-label="观察设置" defaultSize={258} minSize={220} maxSize={460}><section><div className="panel-heading"><h2>观察</h2><span className="spacer"/><SlidersHorizontal size={17}/><button className="sheet-close" aria-label="收起观察" onClick={()=>setSheet(null)}><X size={18}/></button></div><div className="toggle-list">
    <Toggle label="人体表面" checked={debug.surface} onChange={v=>toggle('surface',v)}/><Toggle label={physics?"解剖骨骼与关节":"骨骼与关节"} checked={debug.skeleton} onChange={v=>toggle('skeleton',v)}/><Toggle label="关节坐标轴" checked={debug.axes} onChange={v=>toggle('axes',v)}/><Toggle label={physics?"固定支撑反力":"IK 端点"} checked={debug.targets} onChange={v=>toggle('targets',v)}/>
    {physics?<Toggle label="肌腱作用路径" checked={debug.muscles} onChange={v=>toggle('muscles',v)}/>:null}
    {spec.capabilities?.prop?.trail?<Toggle label="球拍运动轨迹" checked={debug.trail} onChange={v=>toggle('trail',v)}/>:null}
   </div></section>
   {physics&&frame.dynamics?<DynamicsPanel objectDescription={spec.objectDescription} data={frame.dynamics} onCase={v=>engine.current?.setPhysicsCase(v)} onResearch={()=>setDialog('kinetics')}/>:null}
   <section className="settings-section"><h2>运动设置</h2><label className="speed-label" htmlFor="speed">播放速度<output>{speed.toFixed(2).replace(/0$/,'')}×</output></label><input id="speed" aria-label="播放速度" type="range" min=".25" max="2" step=".25" value={speed} onChange={e=>{const v=Number(e.target.value);setSpeed(v);if(engine.current)engine.current.speed=v;}}/><div className="range-labels"><span>0.25×</span><span>1×</span><span>2×</span></div><Toggle label="循环播放" detail={spec.oneShot?'动作末端停住，可重播':''} disabled={!!spec.oneShot} checked={spec.oneShot?false:loop} onChange={v=>{setLoop(v);if(engine.current)engine.current.loop=v;}}/></section>
   <section className="data-section"><h2>当前动作</h2><div className="phase-readout"><span className="phase-dot"/>{frame.phase}</div><dl><div><dt>右膝屈曲</dt><dd>{frame.knee.toFixed(0)}<span>°</span></dd></div><div><dt>右肘屈曲</dt><dd>{frame.elbow.toFixed(0)}<span>°</span></dd></div>{racket?<div><dt>掌柄偏移</dt><dd>{(frame.gripError*1000).toFixed(2)}<span>mm</span></dd></div>:null}</dl><p className="data-caption">{physics?'源肌骨模型的关节坐标。':'骨段几何角度，仅供观察。'}</p></section>
   <div className="prototype-note"><Info size={15}/><p>{physics?'肌肉驱动降阶实验':'运动学原型'}<br/><span>{physics?(spec.objectDescription??'肩胛、腕指与双足支撑按模型约束固定；肌肉激励在 MuJoCo 中积分。数值未经个体肌电与测力台标定。'):'关节限位与任务空间 IK 的工程近似，非动捕或专业测量。'}</span></p></div>
   </Panel>
  </Group>
  <footer className="playback"><div className="lab-sheetbar"><button className="sheet-trigger" data-testid="sheet-library" aria-expanded={sheet==='library'} onClick={()=>setSheet(s=>s==='library'?null:'library')}>☰ 动作库</button><button className="sheet-trigger" data-testid="sheet-inspector" aria-expanded={sheet==='inspector'} onClick={()=>setSheet(s=>s==='inspector'?null:'inspector')}>⚙ 观察</button></div><div className="transport"><motion.button className="play-button" aria-label={frame.playing?'暂停':'播放'} onClick={()=>engine.current?.setPlaying(!frame.playing)} disabled={!info} whileTap={reduce?undefined:{scale:.96}}>{frame.playing?<Pause size={23} fill="currentColor"/>:<Play size={23} fill="currentColor"/>}</motion.button><button className="replay-button" aria-label="重播" onClick={()=>engine.current?.replay()} disabled={!info}><RotateCcw size={20}/></button></div>
   <div className="timeline-area"><div className="timeline-meta"><span><span className="meta-english">{spec.english}</span><i> / </i>{frame.phase}</span><span className="time-code">{format(frame.time)}<i> / </i>{format(frame.duration)}</span></div><input aria-label="动作进度" type="range" min="0" max={frame.duration} step=".001" value={Math.min(frame.time,frame.duration)} onChange={e=>engine.current?.seek(Number(e.target.value))} disabled={!info} style={{'--progress':`${frame.time/frame.duration*100}%`} as React.CSSProperties}/><div className="phase-markers">{spec.phases.map(p=><button key={p.time} style={{left:`${Math.min(98,p.time/frame.duration*100)}%`}} onClick={()=>engine.current?.seek(p.time)} title={`跳转到 ${p.label}`}>{p.label}</button>)}</div></div>
   <div className="playback-tail"><span>实时 3D</span><span>{physics?'MuJoCo · 回放':'glTF · WebGL'}</span></div>
  </footer>
  {dialog?<InfoDialog kind={dialog} onClose={()=>setDialog(null)}/>:null}
  {compact&&sheet?<div className="lab-scrim" onClick={()=>setSheet(null)}/>:null}
 </motion.div>;
}
