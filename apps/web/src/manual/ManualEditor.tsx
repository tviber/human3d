import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowLeft,Copy,Download,FilePlus2,Pause,Play,Plus,Redo2,Repeat,RotateCcw,Trash2,Undo2,Upload,X} from 'lucide-react';
import {Euler,Quaternion} from 'three';
import {createMotion,cloneMotion,emptyPose,LIBRARY_STORAGE_KEY,makeId,parseMotion,readLibrary,rotationFromDegrees,sampleMotion,type ManualKey,type ManualMotion,type ManualPose} from './document';
import {ManualEditorEngine} from './editor-engine';
import './editor.css';

const EDITABLE_JOINTS=['Hip','Pelvis','Waist','Spine01','Spine02','NeckTwist01','Head','L_Clavicle','R_Clavicle','L_Upperarm','R_Upperarm','L_Forearm','R_Forearm','L_Hand','R_Hand','L_Thigh','R_Thigh','L_Calf','R_Calf','L_Foot','R_Foot'];
const LABELS:Record<string,string>={BoneRoot:'根节点',Hip:'骨盆',Pelvis:'下腹',Waist:'腰部',Spine01:'腰椎',Spine02:'胸椎',NeckTwist01:'颈部',NeckTwist02:'颈部上段',Head:'头部',L_Clavicle:'左锁骨',R_Clavicle:'右锁骨',L_Upperarm:'左上臂',R_Upperarm:'右上臂',L_Forearm:'左前臂',R_Forearm:'右前臂',L_Hand:'左手腕',R_Hand:'右手腕',L_Thigh:'左大腿',R_Thigh:'右大腿',L_Calf:'左小腿',R_Calf:'右小腿',L_Foot:'左脚',R_Foot:'右脚'};
const AXES=['X','Y','Z'] as const;
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
const download=(name:string,text:string)=>{const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);};

function boneLabel(name:string){return LABELS[name]??name.replace(/^(L|R)_/,'$1 ').replaceAll('_',' ');}
function readRotation(pose:ManualPose,name:string){const q=pose.bones[name]??[0,0,0,1];const e=new Euler().setFromQuaternion(new Quaternion(q[0],q[1],q[2],q[3]),'XYZ'),degrees=180/Math.PI;return[e.x*degrees,e.y*degrees,e.z*degrees] as [number,number,number];}

export function ManualEditor(){
 const host=useRef<HTMLDivElement>(null),engine=useRef<ManualEditorEngine|null>(null),fileInput=useRef<HTMLInputElement>(null);
 const [library,setLibrary]=useState(readLibrary),[screen,setScreen]=useState<'library'|'editor'>('library');
 const [time,setTime]=useState(0),[playing,setPlaying]=useState(false),[boneNames,setBoneNames]=useState<string[]>([]);
 const [selectedBone,setSelectedBone]=useState('R_Upperarm'),[selectedKeyId,setSelectedKeyId]=useState('');
 const [error,setError]=useState(''),[storageError,setStorageError]=useState('');
 const activeDoc=useMemo(()=>library.docs.find(doc=>doc.id===library.activeId)??library.docs[0],[library]);
 const selectedKey=activeDoc?.keys.find(key=>key.id===selectedKeyId)??activeDoc?.keys[0];
 const editState=useRef({library,activeDoc,selectedKey});editState.current={library,activeDoc,selectedKey};
 const jointOptions=useMemo(()=>{const available=EDITABLE_JOINTS.filter(name=>boneNames.includes(name));return available.length?available:boneNames;},[boneNames]);
 const undoStack=useRef(new Map<string,ManualMotion[]>()),redoStack=useRef(new Map<string,ManualMotion[]>()),gesture=useRef<string|null>(null);
 const dragBase=useRef<{docId:string;keyId:string;bone:string;angles:[number,number,number];moved:boolean}|null>(null);

 useEffect(()=>{
  if(screen!=='editor'||!host.current)return;
  let next:ManualEditorEngine;
  try{next=new ManualEditorEngine(host.current);}catch(reason){setError(`无法创建 3D 画布：${reason instanceof Error?reason.message:String(reason)}`);return;}
  engine.current=next;
  next.onReady=names=>{setBoneNames(names);setSelectedBone(names.includes('R_Upperarm')?'R_Upperarm':EDITABLE_JOINTS.find(name=>names.includes(name))??names[0]??'');};
  next.onTick=(nextTime,nextPlaying)=>{setTime(current=>Math.abs(current-nextTime)>.035?nextTime:current);setPlaying(current=>current===nextPlaying?current:nextPlaying);};
  next.onError=reason=>setError(`模型加载失败：${reason.message}`);
  next.onJointSelect=name=>setSelectedBone(name);
  next.onJointDragStart=name=>{
   const {activeDoc,selectedKey}=editState.current;
   const key=activeDoc?.keys.find(item=>item.id===selectedKey?.id)??activeDoc?.keys[0];
   if(!activeDoc||!key)return;
   setPlaying(false);next.setPlaying(false);
   setSelectedBone(name);dragBase.current={docId:activeDoc.id,keyId:key.id,bone:name,angles:readRotation(key.pose,name),moved:false};
  };
  next.onJointDrag=(name,deltaX,deltaY)=>{
   const base=dragBase.current;if(!base||base.bone!==name)return;
   if(Math.abs(deltaX)+Math.abs(deltaY)<2)return;
   if(!base.moved){const doc=editState.current.library.docs.find(item=>item.id===base.docId);if(doc)remember(doc);base.moved=true;}
   const rotation=rotationFromDegrees(base.angles[0]-deltaY*.45,base.angles[1]+deltaX*.45,base.angles[2]);
   setLibrary(current=>({...current,docs:current.docs.map(doc=>{
    if(doc.id!==base.docId)return doc;
    const changed=cloneMotion(doc),key=changed.keys.find(item=>item.id===base.keyId);if(key)key.pose.bones[base.bone]=rotation;return changed;
   })}));
  };
  next.onJointDragEnd=()=>{dragBase.current=null;endGesture();};
  void next.load();
  return()=>{next.dispose();engine.current=null;dragBase.current=null;gesture.current=null;setBoneNames([]);};
 },[screen]);
 useEffect(()=>{if(activeDoc)engine.current?.update(activeDoc,time,playing);},[activeDoc,time,playing]);
 useEffect(()=>{
  try{localStorage.setItem(LIBRARY_STORAGE_KEY,JSON.stringify(library));setStorageError('');}
  catch(reason){setStorageError(reason instanceof Error?reason.message:'浏览器存储空间不足');}
 },[library]);
 useEffect(()=>{if(activeDoc?.keys.length&&!activeDoc.keys.some(key=>key.id===selectedKeyId))setSelectedKeyId(activeDoc.keys[0].id);},[activeDoc,selectedKeyId]);
 useEffect(()=>{if(activeDoc)engine.current?.seek(time);},[time,activeDoc]);
 useEffect(()=>{engine.current?.setSelectedBone(selectedBone);},[selectedBone,boneNames]);

 const remember=(doc:ManualMotion)=>{
  const stack=undoStack.current.get(doc.id)??[];stack.push(cloneMotion(doc));if(stack.length>80)stack.shift();undoStack.current.set(doc.id,stack);redoStack.current.set(doc.id,[]);
 };
 const replaceDoc=(next:ManualMotion)=>setLibrary(current=>({...current,docs:current.docs.map(doc=>doc.id===next.id?next:doc)}));
 const editDoc=(change:(next:ManualMotion)=>void,record=true)=>{
  if(!activeDoc)return;const next=cloneMotion(activeDoc);if(record)remember(activeDoc);change(next);replaceDoc(next);
 };
 const beginGesture=()=>{if(!activeDoc)return;setPlaying(false);engine.current?.setPlaying(false);if(gesture.current===activeDoc.id)return;remember(activeDoc);gesture.current=activeDoc.id;};
 function endGesture(){gesture.current=null;}
 const editKey=(change:(key:ManualKey)=>void,record=true)=>editDoc(doc=>{const key=doc.keys.find(item=>item.id===selectedKey?.id);if(key)change(key);},record);
 const selectDoc=(id:string)=>{
  const doc=library.docs.find(item=>item.id===id);if(!doc)return;
  setLibrary(current=>({...current,activeId:id}));setTime(0);setPlaying(false);setSelectedKeyId(doc.keys[0]?.id??'');setScreen('editor');setError('');
 };
 const addMotion=()=>{const doc=createMotion(`新动作 ${library.docs.length+1}`);setLibrary(current=>({...current,docs:[...current.docs,doc],activeId:doc.id}));setSelectedKeyId(doc.keys[0].id);setTime(0);setPlaying(false);setScreen('editor');setError('');};
 const duplicateMotion=(sourceId:string)=>{
  const source=library.docs.find(doc=>doc.id===sourceId);if(!source)return;
  const copy=cloneMotion(source);copy.id=makeId();copy.name=`${source.name} 副本`;copy.keys=copy.keys.map(key=>({...key,id:makeId()}));
  setLibrary(current=>({...current,docs:[...current.docs,copy],activeId:copy.id}));setSelectedKeyId(copy.keys[0]?.id??'');setTime(0);setPlaying(false);setScreen('editor');
 };
 const deleteMotion=(id:string)=>setLibrary(current=>{const docs=current.docs.filter(doc=>doc.id!==id);return{docs,activeId:docs.some(doc=>doc.id===current.activeId)?current.activeId:docs[0]?.id??''};});
 const addKey=()=>{
  if(!activeDoc||activeDoc.keys.length>=120)return;
  if(activeDoc.loop&&time>=activeDoc.duration-.001){setError('循环动作的最后一帧需要早于循环结束时间。');return;}
  const existing=activeDoc.keys.find(key=>Math.abs(key.time-time)<.015);
  if(existing){setSelectedKeyId(existing.id);setTime(existing.time);return;}
  const key:ManualKey={id:makeId(),time,label:`姿势 ${activeDoc.keys.length+1}`,pose:sampleMotion(activeDoc,time)};
  editDoc(doc=>{doc.keys.push(key);doc.keys.sort((a,b)=>a.time-b.time);});setSelectedKeyId(key.id);setPlaying(false);
 };
 const removeKey=()=>{
  if(!activeDoc||!selectedKey||activeDoc.keys.length<=1)return;
  editDoc(doc=>{doc.keys=doc.keys.filter(key=>key.id!==selectedKey.id);});
  const next=activeDoc.keys.filter(key=>key.id!==selectedKey.id).sort((a,b)=>a.time-b.time)[0];if(next){setSelectedKeyId(next.id);setTime(next.time);}
 };
 const undo=()=>{
  if(!activeDoc)return;const stack=undoStack.current.get(activeDoc.id);const previous=stack?.pop();if(!previous)return;
  const redo=redoStack.current.get(activeDoc.id)??[];redo.push(cloneMotion(activeDoc));redoStack.current.set(activeDoc.id,redo);replaceDoc(previous);setSelectedKeyId(previous.keys[0]?.id??'');
 };
 const redo=()=>{
  if(!activeDoc)return;const stack=redoStack.current.get(activeDoc.id);const next=stack?.pop();if(!next)return;
  const past=undoStack.current.get(activeDoc.id)??[];past.push(cloneMotion(activeDoc));undoStack.current.set(activeDoc.id,past);replaceDoc(next);setSelectedKeyId(next.keys[0]?.id??'');
 };
 const boneAngles=selectedKey?readRotation(selectedKey.pose,selectedBone):[0,0,0] as [number,number,number];
 const updateBone=(axis:number,value:number,record=false)=>editKey(key=>{key.pose.bones[selectedBone]=rotationFromDegrees(axis===0?value:boneAngles[0],axis===1?value:boneAngles[1],axis===2?value:boneAngles[2]);},record);
 const updateRoot=(axis:number,value:number,record=false)=>editKey(key=>{key.pose.root[axis]=value;},record);
 const importFile=async(file?:File)=>{
  if(!file)return;
  try{const incoming=parseMotion(JSON.parse(await file.text()));incoming.id=makeId();incoming.name=incoming.name||file.name.replace(/\.json$/i,'');incoming.keys=incoming.keys.map(key=>({...key,id:makeId()}));
   setLibrary(current=>({...current,docs:[...current.docs,incoming],activeId:incoming.id}));setSelectedKeyId(incoming.keys[0]?.id??'');setTime(0);setPlaying(false);setScreen('editor');setError('');
  }catch(reason){setError(reason instanceof Error?`无法导入：${reason.message}`:'无法读取动作文件');}finally{if(fileInput.current)fileInput.current.value='';}
 };
 const exportMotion=()=>{if(activeDoc)download(`${activeDoc.name.replace(/[\\/:*?"<>|]/g,'_')}.h3d-motion.json`,JSON.stringify(activeDoc,null,2));};
 const togglePlay=()=>{const value=!playing;setPlaying(value);engine.current?.setPlaying(value);};
 const keyAtTime=(key:ManualKey)=>{setSelectedKeyId(key.id);setTime(key.time);setPlaying(false);};
 const changeDuration=(value:number)=>{
  if(!activeDoc)return;const lastKey=Math.max(...activeDoc.keys.map(key=>key.time),0);
  const duration=Math.max(clamp(value||.1,.1,60),lastKey+(activeDoc.loop ? 0.01 : 0));
  if(duration>60){setError('关键帧位置不能超过 60 秒。');return;}
  editDoc(doc=>{doc.duration=duration;});setTime(current=>Math.min(current,duration));
 };
 const changeLoop=(loop:boolean)=>{
  if(!activeDoc)return;
  if(loop&&activeDoc.keys.length>1&&activeDoc.keys[activeDoc.keys.length-1].time>=activeDoc.duration-.001){setError('循环动作的最后一帧需要早于循环结束时间。');return;}
  editDoc(doc=>{doc.loop=loop;});setError('');
 };

 if(screen==='library'||!activeDoc)return <main className="manual-app library-screen">
  <header className="topbar library-topbar">
   <div className="brand"><div className="brand-mark">H<span>3</span>D</div><div><div className="eyebrow">MOTION / AUTHORING</div><h1>我的动作</h1></div></div>
   <div className="library-actions"><button className="quiet-button" onClick={()=>fileInput.current?.click()}><Upload size={16}/><span>导入动作</span></button><button className="primary-button" onClick={addMotion}><FilePlus2 size={16}/><span>新建动作</span></button><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={event=>void importFile(event.target.files?.[0])}/></div>
  </header>
  <section className="collection-content">
   <div className="collection-heading"><div><span className="eyebrow">YOUR CREATIONS</span><h2>动作作品 <small>{library.docs.length}</small></h2></div><span className="storage-note"><i className="status-light"/>{storageError?'本地空间不足，请导出备份':'自动保存在本机'}</span></div>
   {error?<div className="collection-error" role="alert">{error}<button onClick={()=>setError('')} aria-label="关闭"><X size={15}/></button></div>:null}
   {library.docs.length?<div className="collection-grid">{library.docs.map((doc,index)=><article className="collection-card" key={doc.id}>
    <button className="collection-open" onClick={()=>selectDoc(doc.id)}><span className="collection-index">{String(index+1).padStart(2,'0')}</span><span className="collection-symbol">H<span>3</span>D</span><strong>{doc.name||'未命名动作'}</strong><small>{doc.keys.length} 帧 · {doc.duration.toFixed(1)} 秒</small></button>
    <div className="collection-card-actions"><button className="icon-button" title="复制动作" aria-label={`复制${doc.name}`} onClick={()=>duplicateMotion(doc.id)}><Copy size={15}/></button><button className="icon-button danger-icon" title="删除动作" aria-label={`删除${doc.name}`} onClick={()=>deleteMotion(doc.id)}><Trash2 size={15}/></button></div>
   </article>)}</div>:<div className="empty-library"><div className="empty-mark">H<span>3</span>D</div><h2>从一个姿势开始</h2><p>创建动作后，选中关节、调整姿势，再添加关键帧。</p><button className="primary-button" onClick={addMotion}><Plus size={17}/>新建动作</button></div>}
  </section>
  {storageError?<div className="toast" role="status">自动保存失败，请先导出动作文件。{storageError}</div>:null}
 </main>;

 return <main className="manual-app editor-screen">
  <header className="topbar editor-topbar">
   <button className="back-button" onClick={()=>{setPlaying(false);setScreen('library');}} aria-label="返回我的动作"><ArrowLeft size={18}/><span>我的动作</span></button>
   <div className="document-title"><input aria-label="动作名称" value={activeDoc.name} onChange={event=>editDoc(doc=>{doc.name=event.target.value;})}/></div>
   <div className="top-actions"><button className="quiet-button" onClick={undo} title="撤销"><Undo2 size={16}/><span>撤销</span></button><button className="quiet-button" onClick={redo} title="重做"><Redo2 size={16}/><span>重做</span></button><button className="primary-button" onClick={exportMotion}><Download size={16}/><span>导出</span></button></div>
  </header>
  <div className="editor-grid">
   <section className="stage-column">
    <div className="stage-toolbar"><div className="stage-label"><span className="live-dot"/><span>POSE STAGE</span></div><div className="camera-hint"><RotateCcw size={13}/> 点选关节 · 拖动调整 · 空白处转视角</div></div>
    <div ref={host} className="viewport"><div className="stage-badge"><strong>H3D / 01</strong><span>DIRECT POSE</span></div>{!boneNames.length&&!error?<div className="loading-model">正在载入角色…</div>:null}{error?<div className="stage-error" role="alert">{error}<button onClick={()=>setError('')} aria-label="关闭"><X size={15}/></button></div>:null}</div>
    <div className="transport">
     <div className="transport-buttons"><button className="play-button" onClick={togglePlay} aria-label={playing?'暂停':'播放'}>{playing?<Pause size={18} fill="currentColor"/>:<Play size={18} fill="currentColor"/>}</button><button className="icon-button" onClick={()=>{setTime(0);engine.current?.seek(0);setPlaying(false);}} aria-label="回到开头"><RotateCcw size={17}/></button><span className="time-readout"><b>{time.toFixed(2)}</b><small> / {activeDoc.duration.toFixed(2)} s</small></span></div>
     <div className="transport-end"><button className="icon-button" aria-label="添加关键帧" onClick={addKey}><Plus size={18}/></button><span>关键帧</span></div>
    </div>
    <div className="timeline-panel">
     <div className="timeline-head"><strong>{activeDoc.keys.length} 个关键帧</strong><span className="duration-readout">{activeDoc.duration.toFixed(1)} 秒</span></div>
     <div className="timeline-track"><div className="track-grid"><i/><i/><i/><i/><i/></div><input aria-label="时间轴" className="time-scrubber" type="range" min="0" max={activeDoc.duration} step=".01" value={time} onChange={event=>{const nextTime=Number(event.target.value);setTime(nextTime);engine.current?.seek(nextTime);}}/>
      <div className="key-markers">{activeDoc.keys.map((key,index)=><button key={key.id} className={`key-marker${selectedKey?.id===key.id?' selected':''}`} style={{left:`${(key.time/(activeDoc.duration||1))*100}%`}} title={`${index+1} · ${key.time.toFixed(2)}s`} onClick={()=>keyAtTime(key)}><i/><span>{index+1}</span></button>)}</div>
     </div>
     <div className="timeline-foot"><span>00:00</span><span>{activeDoc.duration.toFixed(2)} s</span><div className="timeline-edit"><button className="text-action" onClick={addKey}><Plus size={13}/>添加</button><button className="text-action danger" disabled={!selectedKey||activeDoc.keys.length===1} onClick={removeKey}><Trash2 size={13}/>删除选中帧</button></div></div>
    </div>
   </section>
   <aside className="inspector-panel">
    <div className="inspector-heading"><div><span className="eyebrow">SELECTED JOINT</span><h2>调整姿势</h2></div><span className="direct-tag">直接旋转</span></div>
    <label className="joint-picker">关节<select value={selectedBone} onChange={event=>setSelectedBone(event.target.value)}>{jointOptions.map(name=><option key={name} value={name}>{boneLabel(name)}</option>)}</select></label>
    <div className="rotation-controls">{AXES.map((axis,index)=><label className="rotation-row" key={axis}><span className={`axis-chip axis-${axis.toLowerCase()}`}>{axis}</span><span className="rotation-label">{axis} 轴</span><input aria-label={`${selectedBone} ${axis} 轴旋转`} type="range" min="-180" max="180" step="1" value={Math.round(boneAngles[index]??0)} onPointerDown={beginGesture} onPointerUp={endGesture} onKeyDown={beginGesture} onKeyUp={endGesture} onChange={event=>updateBone(index,Number(event.target.value),gesture.current!==activeDoc.id)}/><output>{Math.round(boneAngles[index]??0)}°</output></label>)}</div>
    <div className="joint-actions"><button className="text-action" onClick={()=>editKey(key=>{key.pose.bones[selectedBone]=[0,0,0,1];})}><RotateCcw size={13}/>重置关节</button><button className="text-action danger" onClick={()=>editKey(key=>{delete key.pose.bones[selectedBone];})}><X size={13}/>清除旋转</button></div>
    <details className="advanced-timing"><summary>时间轴设置</summary><label className="duration-field">动作时长<input type="number" min=".1" max="60" step=".1" value={activeDoc.duration} onChange={event=>changeDuration(Number(event.target.value))}/>秒</label><label className="loop-toggle"><input type="checkbox" checked={activeDoc.loop} onChange={event=>changeLoop(event.target.checked)}/><Repeat size={15}/>循环播放</label></details>
    <details className="root-details"><summary>整体位置</summary><div className="root-controls">{(['X','Y','Z'] as const).map((axis,index)=><label className="root-row" key={axis}><span>{axis}</span><input aria-label={`整体${axis}轴位移`} type="range" min="-.5" max=".5" step=".01" value={selectedKey?.pose.root[index]??0} onPointerDown={beginGesture} onPointerUp={endGesture} onChange={event=>updateRoot(index,Number(event.target.value),gesture.current!==activeDoc.id)}/><output>{(selectedKey?.pose.root[index]??0).toFixed(2)} m</output></label>)}</div><button className="text-action" onClick={()=>editKey(key=>{key.pose={...emptyPose(),bones:{}};})}>重置整帧姿势</button></details>
   </aside>
  </div>
  <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={event=>void importFile(event.target.files?.[0])}/>
  {storageError?<div className="toast" role="status">自动保存失败，请先导出动作文件。{storageError}</div>:null}
 </main>;
}
