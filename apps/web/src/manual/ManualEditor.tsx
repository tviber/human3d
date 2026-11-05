import {useEffect,useMemo,useRef,useState} from 'react';
import {Download,FilePlus2,Pause,Play,Plus,Redo2,Repeat,RotateCcw,Trash2,Undo2,Upload,X} from 'lucide-react';
import {Euler,Quaternion} from 'three';
import {createMotion,cloneMotion,emptyPose,LIBRARY_STORAGE_KEY,makeId,parseMotion,readLibrary,rotationFromDegrees,sampleMotion,type ManualKey,type ManualMotion,type ManualPose} from './document';
import {ManualEditorEngine} from './editor-engine';
import './editor.css';

const GROUPS=[
 {id:'torso',label:'躯干',test:(name:string)=>['Hip','Pelvis','Waist','Spine01','Spine02','NeckTwist01','NeckTwist02','Head','FacialBone','L_Eye','R_Eye'].includes(name)},
 {id:'left-arm',label:'左臂',test:(name:string)=>name.startsWith('L_')&&!/Thumb|Index|Mid|Ring|Pinky/.test(name)&&/(Clavicle|Upperarm|Forearm|ElbowShare|Hand)/.test(name)},
 {id:'right-arm',label:'右臂',test:(name:string)=>name.startsWith('R_')&&!/Thumb|Index|Mid|Ring|Pinky/.test(name)&&/(Clavicle|Upperarm|Forearm|ElbowShare|Hand)/.test(name)},
 {id:'hands',label:'手指',test:(name:string)=>/^(L|R)_(Thumb|Index|Mid|Ring|Pinky)/.test(name)},
 {id:'legs',label:'腿部',test:(name:string)=>/^(L|R)_(Thigh|Calf|Foot|Toe|Knee)/.test(name)},
 {id:'other',label:'其他',test:()=>false},
] as const;
const LABELS:Record<string,string>={BoneRoot:'根节点',Hip:'骨盆',Pelvis:'下腹',Waist:'腰部',Spine01:'腰椎',Spine02:'胸椎',NeckTwist01:'颈部',NeckTwist02:'颈部上段',Head:'头部',FacialBone:'面部',L_Eye:'左眼',R_Eye:'右眼',L_Clavicle:'左锁骨',R_Clavicle:'右锁骨',L_Upperarm:'左上臂',R_Upperarm:'右上臂',L_Forearm:'左前臂',R_Forearm:'右前臂',L_Hand:'左手腕',R_Hand:'右手腕',L_Thigh:'左大腿',R_Thigh:'右大腿',L_Calf:'左小腿',R_Calf:'右小腿',L_Foot:'左脚',R_Foot:'右脚',L_ToeBase:'左脚趾',R_ToeBase:'右脚趾',L_ElbowShareBone:'左肘辅助',R_ElbowShareBone:'右肘辅助',L_KneeShareBone:'左膝辅助',R_KneeShareBone:'右膝辅助'};
const AXES=['X','Y','Z'] as const;
const axisNames=['前后','左右','扭转'] as const;
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
const download=(name:string,text:string)=>{const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);};

function boneLabel(name:string){return LABELS[name]??name.replace(/^(L|R)_/,'$1 ').replaceAll('_',' ');}
function readRotation(pose:ManualPose,name:string){const q=pose.bones[name]??[0,0,0,1];const e=new Euler().setFromQuaternion(new Quaternion(q[0],q[1],q[2],q[3]),'XYZ'),degrees=180/Math.PI;return[e.x*degrees,e.y*degrees,e.z*degrees] as [number,number,number];}

export function ManualEditor(){
 const host=useRef<HTMLDivElement>(null),engine=useRef<ManualEditorEngine|null>(null),fileInput=useRef<HTMLInputElement>(null);
 const [library,setLibrary]=useState(readLibrary),[time,setTime]=useState(0),[playing,setPlaying]=useState(false),[boneNames,setBoneNames]=useState<string[]>([]);
 const [group,setGroup]=useState<string>('torso'),[selectedBone,setSelectedBone]=useState('R_Upperarm'),[selectedKeyId,setSelectedKeyId]=useState('');
 const [error,setError]=useState(''),[storageError,setStorageError]=useState('');
 const activeDoc=useMemo(()=>library.docs.find(doc=>doc.id===library.activeId)??library.docs[0],[library]);
 const selectedKey=activeDoc?.keys.find(key=>key.id===selectedKeyId)??activeDoc?.keys[0];
 const undoStack=useRef(new Map<string,ManualMotion[]>()),redoStack=useRef(new Map<string,ManualMotion[]>()),gesture=useRef<string|null>(null);

 useEffect(()=>{
  if(!host.current)return;
  let next:ManualEditorEngine;
  try{next=new ManualEditorEngine(host.current);}catch(reason){setError(`无法创建 3D 画布：${reason instanceof Error?reason.message:String(reason)}`);return;}
  engine.current=next;
  next.onReady=names=>{setBoneNames(names);setGroup('right-arm');setSelectedBone(names.includes('R_Upperarm')?'R_Upperarm':names[0]??'');};
  next.onTick=(nextTime,nextPlaying)=>{setTime(current=>Math.abs(current-nextTime)>.035?nextTime:current);setPlaying(current=>current===nextPlaying?current:nextPlaying);};
  next.onError=reason=>setError(`模型加载失败：${reason.message}`);void next.load();
  return()=>{next.dispose();engine.current=null;};
 },[]);
 useEffect(()=>{
  if(!activeDoc)return;
  engine.current?.update(activeDoc,time,playing);
 },[activeDoc,time,playing]);
 useEffect(()=>{
  try{localStorage.setItem(LIBRARY_STORAGE_KEY,JSON.stringify(library));setStorageError('');}
  catch(reason){setStorageError(reason instanceof Error?reason.message:'浏览器存储空间不足');}
 },[library]);
 useEffect(()=>{if(activeDoc?.keys.length&&!activeDoc.keys.some(key=>key.id===selectedKeyId))setSelectedKeyId(activeDoc.keys[0].id);},[activeDoc,selectedKeyId]);
 useEffect(()=>{if(activeDoc)engine.current?.seek(time);},[time,activeDoc]);

 const remember=(doc:ManualMotion)=>{
  const stack=undoStack.current.get(doc.id)??[];stack.push(cloneMotion(doc));if(stack.length>80)stack.shift();undoStack.current.set(doc.id,stack);redoStack.current.set(doc.id,[]);
 };
 const replaceDoc=(next:ManualMotion)=>setLibrary(current=>({...current,docs:current.docs.map(doc=>doc.id===next.id?next:doc)}));
 const editDoc=(change:(next:ManualMotion)=>void,record=true)=>{
  if(!activeDoc)return;const next=cloneMotion(activeDoc);if(record)remember(activeDoc);change(next);replaceDoc(next);
 };
 const beginGesture=()=>{if(!activeDoc||gesture.current===activeDoc.id)return;remember(activeDoc);gesture.current=activeDoc.id;};
 const endGesture=()=>{gesture.current=null;};
 const editKey=(change:(key:ManualKey)=>void,record=true)=>editDoc(doc=>{const key=doc.keys.find(item=>item.id===selectedKey?.id);if(key)change(key);},record);
 const selectDoc=(id:string)=>{
  const doc=library.docs.find(item=>item.id===id);if(!doc)return;
  setLibrary(current=>({...current,activeId:id}));setTime(0);setPlaying(false);setSelectedKeyId(doc.keys[0]?.id??'');
 };
 const addMotion=()=>{const doc=createMotion(`新动作 ${library.docs.length+1}`);setLibrary(current=>({...current,docs:[...current.docs,doc],activeId:doc.id}));setSelectedKeyId(doc.keys[0].id);setTime(0);setPlaying(false);};
 const duplicateMotion=()=>{
  if(!activeDoc)return;const copy=cloneMotion(activeDoc);copy.id=makeId();copy.name=`${activeDoc.name} 副本`;copy.keys=copy.keys.map(key=>({...key,id:makeId()}));
  setLibrary(current=>({...current,docs:[...current.docs,copy],activeId:copy.id}));setSelectedKeyId(copy.keys[0]?.id??'');setTime(0);setPlaying(false);
 };
 const deleteMotion=()=>{
  if(!activeDoc||library.docs.length<2)return;
  const docs=library.docs.filter(doc=>doc.id!==activeDoc.id);setLibrary({...library,docs,activeId:docs[0].id});setSelectedKeyId(docs[0].keys[0].id);setTime(0);
 };
 const addKey=()=>{
  if(!activeDoc||activeDoc.keys.length>=120)return;
  if(activeDoc.loop&&time>=activeDoc.duration-.001){setError('循环动作的最后一帧需要早于循环结束时间。');return;}
  const existing=activeDoc.keys.find(key=>Math.abs(key.time-time)<.015);
  if(existing){setSelectedKeyId(existing.id);setTime(existing.time);return;}
  const pose=sampleMotion(activeDoc,time);const key:ManualKey={id:makeId(),time,label:`姿势 ${activeDoc.keys.length+1}`,pose};
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
 const grouped=useMemo(()=>{
  const known=new Set<string>();const result=GROUPS.map(item=>{const bones=boneNames.filter(item.test);bones.forEach(name=>known.add(name));return{...item,bones};});
  result[result.length-1].bones=boneNames.filter(name=>!known.has(name));return result;
 },[boneNames]);
 const selectedGroup=grouped.find(item=>item.id===group)??grouped[0];
 const boneAngles=selectedKey?readRotation(selectedKey.pose,selectedBone):[0,0,0] as [number,number,number];

 const updateBone=(axis:number,value:number,record=false)=>editKey(key=>{key.pose.bones[selectedBone]=rotationFromDegrees(axis===0?value:boneAngles[0],axis===1?value:boneAngles[1],axis===2?value:boneAngles[2]);},record);
 const updateRoot=(axis:number,value:number,record=false)=>editKey(key=>{key.pose.root[axis]=value;},record);
 const importFile=async(file?:File)=>{
  if(!file)return;try{const incoming=parseMotion(JSON.parse(await file.text()));incoming.id=makeId();incoming.name=incoming.name||file.name.replace(/\.json$/i,'');incoming.keys=incoming.keys.map(key=>({...key,id:makeId()}));
   setLibrary(current=>({...current,docs:[...current.docs,incoming],activeId:incoming.id}));setSelectedKeyId(incoming.keys[0]?.id??'');setTime(0);setPlaying(false);setError('');
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
 const changeKeyTime=(value:number)=>{
  if(!activeDoc||!selectedKey)return;const next=clamp(value||0,0,activeDoc.duration);
  if(activeDoc.loop&&next>=activeDoc.duration-.001){setError('循环动作的最后一帧需要早于循环结束时间。');return;}
  if(activeDoc.keys.some(key=>key.id!==selectedKey.id&&Math.abs(key.time-next)<.001)){setError('两个关键帧至少要相隔 0.001 秒。');return;}
  editDoc(doc=>{const key=doc.keys.find(item=>item.id===selectedKey.id);if(key)key.time=next;doc.keys.sort((a,b)=>a.time-b.time);});setTime(next);setError('');
 };
 const changeLoop=(loop:boolean)=>{
  if(!activeDoc)return;
  if(loop&&activeDoc.keys.length>1&&activeDoc.keys[activeDoc.keys.length-1].time>=activeDoc.duration-.001){setError('循环动作的最后一帧需要早于循环结束时间。');return;}
  editDoc(doc=>{doc.loop=loop;});setError('');
 };

 return <main className="manual-app">
  <header className="topbar">
   <div className="brand"><div className="brand-mark">H<span>3</span>D</div><div><div className="eyebrow">MOTION / AUTHORING</div><h1>手作间</h1></div></div>
   <div className="document-title"><span>当前动作</span><input aria-label="动作名称" value={activeDoc?.name??''} onChange={event=>editDoc(doc=>{doc.name=event.target.value;})}/></div>
   <div className="top-actions">
    <button className="quiet-button" onClick={undo} title="撤销"><Undo2 size={16}/><span>撤销</span></button>
    <button className="quiet-button" onClick={redo} title="重做"><Redo2 size={16}/><span>重做</span></button>
    <button className="quiet-button" onClick={()=>fileInput.current?.click()}><Upload size={16}/><span>导入</span></button>
    <button className="primary-button" onClick={exportMotion}><Download size={16}/><span>导出动作</span></button>
    <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={event=>void importFile(event.target.files?.[0])}/>
   </div>
  </header>
  <div className="editor-grid">
   <aside className="library-panel">
    <div className="panel-heading"><div><span className="eyebrow">LOCAL LIBRARY</span><h2>动作库 <small>{library.docs.length.toString().padStart(2,'0')}</small></h2></div><button className="icon-button" aria-label="新建动作" onClick={addMotion}><FilePlus2 size={18}/></button></div>
    <div className="library-list">
     {library.docs.map((doc,index)=><button key={doc.id} className={`motion-card${doc.id===activeDoc?.id?' active':''}`} onClick={()=>selectDoc(doc.id)}>
      <span className="card-index">{String(index+1).padStart(2,'0')}</span><span className="card-copy"><strong>{doc.name||'未命名动作'}</strong><small>{doc.keys.length} 帧 · {doc.duration.toFixed(1)} 秒</small></span><span className="card-dot"/>
     </button>)}
    </div>
    <div className="library-footer"><button className="text-action" onClick={duplicateMotion} disabled={!activeDoc}><Plus size={14}/>复制动作</button><button className="text-action danger" onClick={deleteMotion} disabled={library.docs.length<2}><Trash2 size={14}/>删除</button></div>
    <div className="storage-note"><span className="status-light"/>{storageError?'本地空间不足，导出备份':`本机自动保存${storageError?'失败':''}`}</div>
   </aside>

   <section className="stage-column">
    <div className="stage-toolbar"><div className="stage-label"><span className="live-dot"/><span>POSE STAGE</span><span className="stage-divider"/> <span>{boneNames.length} 个关节</span></div><div className="camera-hint"><RotateCcw size={13}/> 拖动旋转 · 滚轮缩放</div></div>
    <div ref={host} className="viewport"><div className="stage-badge"><strong>H3D / 01</strong><span>DIRECT POSE</span></div><div className="stage-watermark">手工姿势 · 原生关节</div>{!boneNames.length&&!error?<div className="loading-model">正在载入角色…</div>:null}{error?<div className="stage-error" role="alert">{error}<button onClick={()=>setError('')} aria-label="关闭"><X size={15}/></button></div>:null}</div>
    <div className="transport">
     <div className="transport-buttons"><button className="play-button" onClick={togglePlay} aria-label={playing?'暂停':'播放'}>{playing?<Pause size={18} fill="currentColor"/>:<Play size={18} fill="currentColor"/>}</button><button className="icon-button" onClick={()=>{setTime(0);engine.current?.seek(0);setPlaying(false);}} aria-label="回到开头"><RotateCcw size={17}/></button><span className="time-readout"><b>{time.toFixed(2)}</b><small> / {activeDoc?.duration.toFixed(2)} s</small></span></div>
     <label className="loop-toggle"><input type="checkbox" checked={activeDoc?.loop??false} onChange={event=>changeLoop(event.target.checked)}/><Repeat size={15}/>循环</label>
     <div className="transport-end"><button className="icon-button" aria-label="添加关键帧" onClick={addKey}><Plus size={18}/></button><span>ADD FRAME</span></div>
    </div>
    <div className="timeline-panel">
     <div className="timeline-head"><div><span className="eyebrow">TIMELINE</span><strong>{activeDoc?.keys.length??0} 个关键帧</strong></div><label className="duration-field">时长 <input type="number" min=".1" max="60" step=".1" value={activeDoc?.duration??2} onChange={event=>changeDuration(Number(event.target.value))}/> 秒</label></div>
     <div className="timeline-track"><div className="track-grid"><i/><i/><i/><i/><i/></div><input aria-label="时间轴" className="time-scrubber" type="range" min="0" max={activeDoc?.duration??2} step=".01" value={time} onChange={event=>{const nextTime=Number(event.target.value);setTime(nextTime);engine.current?.seek(nextTime);}}/>
      <div className="key-markers">{activeDoc?.keys.map(key=><button key={key.id} className={`key-marker${selectedKey?.id===key.id?' selected':''}`} style={{left:`${(key.time/(activeDoc.duration||1))*100}%`}} title={`${key.label} · ${key.time.toFixed(2)}s`} onClick={()=>keyAtTime(key)}><i/><span>{key.label}</span></button>)}</div>
     </div>
     <div className="timeline-foot"><span>00:00</span><span>{(activeDoc?.duration??2).toFixed(2)} s</span><div className="timeline-edit"><button className="text-action" onClick={addKey}><Plus size={13}/>添加姿势</button><button className="text-action danger" disabled={!selectedKey||activeDoc?.keys.length===1} onClick={removeKey}><Trash2 size={13}/>删除选中帧</button></div></div>
    </div>
   </section>

   <aside className="inspector-panel">
    <div className="panel-heading inspector-heading"><div><span className="eyebrow">JOINT EDITOR</span><h2>关节调整</h2></div><span className="direct-tag">DIRECT</span></div>
    <p className="inspector-intro">直接旋转模型关节。时间轴只记录手工姿势，不做骨链求解。</p>
    <div className="group-tabs" role="tablist" aria-label="身体区域">{grouped.filter(item=>item.bones.length).map(item=><button key={item.id} role="tab" aria-selected={group===item.id} onClick={()=>{setGroup(item.id);setSelectedBone(item.bones[0]);}}>{item.label}</button>)}</div>
    <div className="joint-list" aria-label="选择关节">{selectedGroup?.bones.map(name=><button key={name} className={selectedBone===name?'selected':''} onClick={()=>setSelectedBone(name)}><span className="joint-axis"/>{boneLabel(name)}<small>{name}</small></button>)}</div>
    <div className="selected-joint"><span className="eyebrow">EDITING JOINT</span><strong>{boneLabel(selectedBone)||'选择关节'}</strong></div>
    <div className="rotation-controls">
     {AXES.map((axis,index)=><label className="rotation-row" key={axis}><span className={`axis-chip axis-${axis.toLowerCase()}`}>{axis}</span><span className="rotation-label">{axis} 轴 <small>{axisNames[index]}</small></span><input aria-label={`${selectedBone} ${axis} 轴旋转`} type="range" min="-180" max="180" step="1" value={Math.round(boneAngles[index]??0)} onPointerDown={beginGesture} onPointerUp={endGesture} onKeyDown={beginGesture} onKeyUp={endGesture} onChange={event=>updateBone(index,Number(event.target.value),gesture.current!==activeDoc?.id)}/><output>{Math.round(boneAngles[index]??0)}°</output></label>)}
    </div>
    <div className="root-controls"><div className="root-heading"><strong>整体位移</strong><button className="text-action" onClick={()=>editKey(key=>{key.pose={...emptyPose(),bones:{}};})}>重置姿势</button></div>
     {(['X','Y','Z'] as const).map((axis,index)=><label className="root-row" key={axis}><span>{axis}</span><input aria-label={`整体${axis}轴位移`} type="range" min="-.5" max=".5" step=".01" value={selectedKey?.pose.root[index]??0} onPointerDown={beginGesture} onPointerUp={endGesture} onChange={event=>updateRoot(index,Number(event.target.value),gesture.current!==activeDoc?.id)}/><output>{(selectedKey?.pose.root[index]??0).toFixed(2)} m</output></label>)}
    </div>
    <div className="key-inspector"><label>姿势名称<input value={selectedKey?.label??''} onChange={event=>editKey(key=>{key.label=event.target.value;})}/></label><label>时间 <div className="key-time"><input type="number" min="0" max={activeDoc?.duration??2} step=".01" value={selectedKey?.time??0} onChange={event=>changeKeyTime(Number(event.target.value))}/><span>秒</span></div></label></div>
   </aside>
  </div>
  {storageError?<div className="toast" role="status">自动保存失败，请先导出动作文件。{storageError}</div>:null}
 </main>;
}
