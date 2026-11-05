import {Euler,Quaternion} from 'three';

export type Vec3=[number,number,number];
export type Quat=[number,number,number,number];
export interface ManualPose{root:Vec3;bones:Record<string,Quat>}
export interface ManualKey{id:string;time:number;label:string;pose:ManualPose}
export interface ManualMotion{format:'h3d-manual-motion';version:1;id:string;name:string;duration:number;loop:boolean;keys:ManualKey[]}

export const IDENTITY:Quat=[0,0,0,1];
export const LIBRARY_STORAGE_KEY='human3d-manual-motion-library:v1';
export const makeId=()=>globalThis.crypto?.randomUUID?.()??`motion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;
export const cloneMotion=<T,>(value:T):T=>structuredClone(value);

export function emptyPose():ManualPose{return{root:[0,0,0],bones:{}};}
export function createMotion(name='未命名动作',pose:ManualPose=emptyPose()):ManualMotion{
 return{format:'h3d-manual-motion',version:1,id:makeId(),name,duration:2,loop:false,keys:[{id:makeId(),time:0,label:'起始姿势',pose:cloneMotion(pose)}]};
}

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function finiteVector(value:unknown,length:number,label:string):number[]{
 if(!Array.isArray(value)||value.length!==length||!value.every(Number.isFinite))throw new Error(`${label} 必须包含 ${length} 个有限数字`);
 return value as number[];
}
function normalizeQuaternion(value:unknown,label:string):Quat{
 const [x,y,z,w]=finiteVector(value,4,label);const length=Math.hypot(x,y,z,w);
 if(length<1e-8)throw new Error(`${label} 不能是零四元数`);
 return[x/length,y/length,z/length,w/length];
}
function normalizePose(value:unknown,label:string):ManualPose{
 if(!object(value)||!object(value.bones))throw new Error(`${label} 缺少 bones 姿势数据`);
 const root=finiteVector(value.root,3,`${label}.root`) as Vec3;
 const bones:Record<string,Quat>={};
 for(const [name,rotation]of Object.entries(value.bones)){
  if(!name.trim())throw new Error(`${label} 包含空关节名称`);
  bones[name]=normalizeQuaternion(rotation,`${label}.bones.${name}`);
 }
 return{root,bones};
}

/** Validate and canonicalize a file at the import boundary. It stores direct
 * local joint rotations and root translation; no solver or rig manifest is needed. */
export function parseMotion(value:unknown):ManualMotion{
 if(!object(value)||value.format!=='h3d-manual-motion'||value.version!==1)throw new Error('文件不是受支持的手工动作格式');
 if(typeof value.id!=='string'||typeof value.name!=='string')throw new Error('动作缺少 id 或名称');
 if(!Number.isFinite(value.duration)||Number(value.duration)<.1||Number(value.duration)>60)throw new Error('动作时长必须在 0.1–60 秒之间');
 if(typeof value.loop!=='boolean'||!Array.isArray(value.keys)||value.keys.length<1||value.keys.length>120)throw new Error('关键帧数量必须在 1–120 之间');
 const ids=new Set<string>();
 const keys=value.keys.map((item,index)=>{
  if(!object(item)||typeof item.id!=='string'||typeof item.label!=='string'||!Number.isFinite(item.time))throw new Error(`第 ${index+1} 帧结构无效`);
  if(ids.has(item.id))throw new Error(`关键帧 id 重复：${item.id}`);ids.add(item.id);
  const time=Number(item.time);
  if(time<0||time>Number(value.duration))throw new Error(`第 ${index+1} 帧超出动作时长`);
  return{id:item.id,time,label:item.label,pose:normalizePose(item.pose,`第 ${index+1} 帧`)};
 }).sort((a,b)=>a.time-b.time);
 for(let i=1;i<keys.length;i++)if(keys[i].time-keys[i-1].time<.001)throw new Error('关键帧时间必须至少相隔 0.001 秒');
 if(value.loop&&keys.length>1&&keys[keys.length-1].time>=Number(value.duration)-.001)throw new Error('循环动作的最后一帧必须早于结束时间');
 return{format:'h3d-manual-motion',version:1,id:value.id,name:value.name.trim()||'未命名动作',duration:Number(value.duration),loop:value.loop,keys};
}

const toQuaternion=(value:Quat)=>new Quaternion(value[0],value[1],value[2],value[3]);
const fromQuaternion=(value:Quaternion):Quat=>[value.x,value.y,value.z,value.w];
function interpolatePose(a:ManualPose,b:ManualPose,t:number):ManualPose{
 const root:Vec3=[0,1,2].map(i=>a.root[i]+(b.root[i]-a.root[i])*t) as Vec3;
 const bones:Record<string,Quat>={};
 for(const name of new Set([...Object.keys(a.bones),...Object.keys(b.bones)])){
  const qa=toQuaternion(a.bones[name]??IDENTITY),qb=toQuaternion(b.bones[name]??IDENTITY);
  bones[name]=fromQuaternion(qa.slerp(qb,t).normalize());
 }
 return{root,bones};
}

/** Sample authored bone rotations. Between keys each bone follows a shortest
 * quaternion arc; there is no inverse-kinematics or contact-chain correction. */
export function sampleMotion(motion:ManualMotion,time:number):ManualPose{
 const keys=[...motion.keys].sort((a,b)=>a.time-b.time);
 if(keys.length===1)return cloneMotion(keys[0].pose);
 let t=Math.max(0,Math.min(motion.duration,time));
 if(motion.loop)t=((t%motion.duration)+motion.duration)%motion.duration;
 if(!motion.loop&&t<=keys[0].time)return cloneMotion(keys[0].pose);
 if(!motion.loop&&t>=keys[keys.length-1].time)return cloneMotion(keys[keys.length-1].pose);
 for(let i=0;i<keys.length-1;i++){
  const a=keys[i],b=keys[i+1];
  if(t>=a.time&&t<=b.time)return interpolatePose(a.pose,b.pose,(t-a.time)/(b.time-a.time));
 }
 if(!motion.loop)return cloneMotion(keys[keys.length-1].pose);
 const last=keys[keys.length-1],first=keys[0];
 if(t<first.time)t+=motion.duration;
 const end=first.time+motion.duration;
 return interpolatePose(last.pose,first.pose,(t-last.time)/(end-last.time));
}

export function rotationFromDegrees(x:number,y:number,z:number):Quat{
 const r=Math.PI/180;return fromQuaternion(new Quaternion().setFromEuler(new Euler(x*r,y*r,z*r,'XYZ')).normalize());
}

export function readLibrary():{activeId:string;docs:ManualMotion[]}{
 try{
  const text=localStorage.getItem(LIBRARY_STORAGE_KEY);if(text){
   const saved=JSON.parse(text) as unknown;
   if(object(saved)&&Array.isArray(saved.docs)){
    const docs=saved.docs.map(parseMotion);if(docs.length)return{docs,activeId:typeof saved.activeId==='string'&&docs.some(d=>d.id===saved.activeId)?saved.activeId:docs[0].id};
   }
  }
 }catch{/* A damaged or old library should not prevent a fresh manual session. */}
 return{docs:[],activeId:''};
}
