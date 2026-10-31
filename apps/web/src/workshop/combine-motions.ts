import {buildModel,frameFromModel,newDocId,normalizeDoc,samplePose,sortedKeys,WORKSHOP_LIMITS} from '@human3d/motion-core';
import type {EffectiveFrame,KeyConstraints,PoseParams,V3,WorkshopDoc,WorkshopKey} from '@human3d/motion-core';

export type CombineOptions={kind:'append';transition:number}|{kind:'blend';weight:number};
const free:KeyConstraints={plantL:false,plantR:false,grip:false,contact:false};
const copy=<T,>(value:T):T=>structuredClone(value);
const uniqueTimes=(times:number[])=>[...new Set(times)].sort((a,b)=>a-b).filter((t,i,all)=>i===0||t-all[i-1]>1e-8);

/** Reuse the production shortest-angle / SO(3) interpolation, without contacts. */
function mixPose(a:PoseParams,b:PoseParams,weight:number,origin:V3):PoseParams{
 return samplePose({duration:1,loop:false,handFrames:{L:'world',R:'world'},keys:[
  {id:'a',time:0,label:'',pose:a,constraints:free,interpolation:'linear'},
  {id:'b',time:1,label:'',pose:b,constraints:free,interpolation:'linear'},
 ]},weight,origin);
}

/** Author a new document; the two sources are never changed. */
export function combineMotions(a:WorkshopDoc,b:WorkshopDoc,options:CombineOptions,origin:V3,name=''):WorkshopDoc{
 // Validate before building sampling models, including their CPU/memory limits.
 a=normalizeDoc(copy(a));b=normalizeDoc(copy(b));
 if(options.kind==='blend'&&(!Number.isFinite(options.weight)||options.weight<0||options.weight>1))throw new Error('混合比例必须在 0–100% 之间。');
 if(options.kind==='append'&&(!Number.isFinite(options.transition)||options.transition<.1||options.transition>2))throw new Error('过渡时长必须在 0.1–2 秒之间。');
 const title=name.trim()||`${a.name} ${options.kind==='append'?'接':'混合'} ${b.name}`;
 const id=newDocId(title);
 const identify=(doc:WorkshopDoc)=>{
  doc.id=id;doc.name=title;doc.english='COMBINED MOTION';
  if(doc.gripSide===undefined)delete doc.gripSide;
  doc.keys.forEach((k,i)=>{k.id=`${id}-k${i}`;delete k.videoTime;});
  return normalizeDoc(doc);
 };
 if(options.kind==='blend'&&(options.weight===0||options.weight===1))return identify(copy(options.weight===0?a:b));
 if(!!a.freeArms!==!!b.freeArms||!!a.clavicleLift!==!!b.clavicleLift)throw new Error('两段动作的「自由手臂 / 锁骨辅助」设置不同，请先在工作台中统一设置。');
 const grips=(d:WorkshopDoc)=>d.keys.some(k=>k.constraints.grip);
 if(grips(a)&&grips(b)&&(a.gripSide??'R')!==(b.gripSide??'R'))throw new Error('两段动作持拍侧不同，请先镜像其中一段或统一持拍侧。');
 const duration=options.kind==='append'?a.duration+options.transition+b.duration:Math.max(a.duration,b.duration);
 if(duration>WORKSHOP_LIMITS.maxDuration)throw new Error(`组合后时长 ${duration.toFixed(2)} 秒，超过 ${WORKSHOP_LIMITS.maxDuration} 秒上限。请先缩短源动作。`);
 const ka=sortedKeys(a),kb=sortedKeys(b);
 const shift=options.kind==='append'?a.duration+options.transition:0;
 const timesA=ka.map(k=>options.kind==='append'?k.time:k.time/a.duration*duration);
 const timesB=kb.map(k=>options.kind==='append'?shift+k.time:k.time/b.duration*duration);
 const boundaries=options.kind==='append'?[a.duration,shift]:[];
 let times=uniqueTimes([0,duration,...timesA,...timesB,...boundaries]);
 if(times.length>WORKSHOP_LIMITS.maxKeys){
  const events=(keys:WorkshopKey[],mapped:number[])=>mapped.filter((_,i)=>{
   const k=keys[i],previous=keys[i-1];
   return i===0||i===keys.length-1||k.constraints.contact||previous&&(['plantL','plantR','grip','replant'] as const).some(flag=>k.constraints[flag]!==previous.constraints[flag]);
  });
  times=uniqueTimes([0,duration,...boundaries,...events(ka,timesA),...events(kb,timesB)]);
  if(times.length>WORKSHOP_LIMITS.maxKeys)throw new Error(`组合的支撑 / 握拍切换与触球时刻超过 ${WORKSHOP_LIMITS.maxKeys} 个，请先简化源动作。`);
 }
 // shortcut: sampled authoring at up to 12 Hz; use clip blending if exact continuous trajectories become necessary.
 const steps=Math.min(Math.ceil(duration*12),WORKSHOP_LIMITS.maxKeys-times.length+1);
 times=uniqueTimes([...times,...Array.from({length:Math.max(0,steps-1)},(_,i)=>(i+1)/steps*duration)]);
 const ma=buildModel(a,origin),mb=buildModel(b,origin);
 const readA=(t:number)=>frameFromModel(ma,a,t),readB=(t:number)=>frameFromModel(mb,b,t);
 const end=readA(a.duration),start=readB(0);
 const contact=(keys:WorkshopKey[],t:number)=>keys.some(k=>Math.abs(k.time-t)<1e-8&&k.constraints.contact);
 const stationary=(side:'L'|'R')=>{
  const foot=side==='L'?'footL':'footR',flag=side==='L'?'plantL':'plantR';
  const x=end.pose[foot],y=start.pose[foot];
  return end.constraints[flag]&&start.constraints[flag]&&['x','y','z'].every(axis=>Math.abs(x.target[axis as keyof V3]-y.target[axis as keyof V3])<1e-8)&&Math.abs(x.yaw-y.yaw)<1e-8&&Math.abs(x.pitch-y.pitch)<1e-8;
 };
 const read=(t:number):EffectiveFrame=>{
  if(options.kind==='blend'){
   const ta=t/duration*a.duration,tb=t/duration*b.duration,fa=readA(ta),fb=readB(tb),dominant=options.weight<.5?fa:fb;
   return {...dominant,pose:mixPose(fa.pose,fb.pose,options.weight,origin),constraints:{...dominant.constraints,
    plantL:fa.constraints.plantL&&fb.constraints.plantL,plantR:fa.constraints.plantR&&fb.constraints.plantR,
    contact:options.weight<.5?contact(ka,ta):contact(kb,tb)}};
  }
  if(t<a.duration-1e-9){const f=readA(t);return {...f,constraints:{...f.constraints,contact:contact(ka,t)}};}
  if(t>=shift-1e-9){const local=Math.max(0,t-shift),f=readB(local);return {...f,constraints:{...f.constraints,contact:contact(kb,local)}};}
  const u=(t-a.duration)/options.transition;
  return {...end,pose:mixPose(end.pose,start.pose,u*u*(3-2*u),origin),constraints:{plantL:stationary('L'),plantR:stationary('R'),grip:end.constraints.grip,contact:contact(ka,t)}};
 };
 const keys:WorkshopKey[]=times.map(time=>{
  const f=read(time),ia=timesA.findIndex(t=>Math.abs(time-t)<1e-8),ib=timesB.findIndex(t=>Math.abs(time-t)<1e-8);
  const label=ia>=0?ka[ia].label:ib>=0?kb[ib].label:options.kind==='append'&&time>=a.duration&&time<shift?'过渡':'融合';
  return {id:'',time,label,pose:f.pose,constraints:f.constraints,interpolation:'linear'};
 });
 // A release key stores the NEXT interval's swing midpoint, not its visible foot position.
 for(let i=1;i<keys.length-1;i++)for(const side of ['L','R'] as const){
  const flag=side==='L'?'plantL':'plantR',foot=side==='L'?'footL':'footR';
  if(keys[i-1].constraints[flag]&&!keys[i].constraints[flag])keys[i].pose[foot].target=copy(read((keys[i].time+keys[i+1].time)/2).pose[foot].target);
 }
 const policy=options.kind==='blend'&&options.weight>=.5?b:a;
 // The bevel follows the same doc the grip side comes from: it is a display
 // property of the held prop (never a solve input), so mixing two sources with
 // different bevels is resolved rather than refused — the surviving grip's
 // facet wins, exactly like gripSide above.
 const gripDoc=grips(a)?a:grips(b)?b:policy;
 const combined:WorkshopDoc={...policy,id,name:title,duration,loop:false,inbetweens:true,handFrames:{L:'world',R:'world'},
  gripSide:grips(a)?a.gripSide:grips(b)?b.gripSide:policy.gripSide,keys};
 // The bevel follows the source whose grip side wins. Clear policy's inherited
 // bevel when that source uses the canonical default (represented by absence).
 if(gripDoc.gripBevel===undefined)delete combined.gripBevel;
 else combined.gripBevel=gripDoc.gripBevel;
 if(gripDoc.gripTilt===undefined)delete combined.gripTilt;
 else combined.gripTilt=gripDoc.gripTilt;
 return identify(combined);
}
