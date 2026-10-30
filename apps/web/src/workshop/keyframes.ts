import {contactStartKey,sortedKeys,WORKSHOP_LIMITS,type WorkshopDoc,type WorkshopKey} from '@human3d/motion-core';

/** Shared insertion policy for a sampled new key and an exact key copy. */
export function keyframeInsertSlot(doc:Pick<WorkshopDoc,'duration'|'loop'>,time:number,nextTime?:number){
 const gap=doc.loop?WORKSHOP_LIMITS.loopGap:0;
 const duration=nextTime===undefined&&doc.duration-gap-time<2e-6
  ?Math.min(WORKSHOP_LIMITS.maxDuration,doc.duration+.2):doc.duration;
 const end=nextTime??duration-gap;
 if(end-time<=2e-6)return undefined;
 return {duration,time:nextTime!==undefined||duration===doc.duration?(time+end)/2:end};
}

/** Copy stored authoring data independently; never resample the source or
 * share its nested pose/constraint objects with the new key.
 *
 * Planted feet need more than a clone: the copy always lands right after its
 * source, so a copied `plant` would silently join the source's contact run —
 * the sampler anchors a run at its first key, the copy's stored foot is dead
 * data, and every foot edit retargets the run-start key. The copy therefore
 * declares `replant` (its own contact) and stores the EFFECTIVE contact it
 * displays — the run anchor's foot, not the source's ignored stored values —
 * so the inserted copy samples the identical pose while owning its foot. */
export function copyKeyframe(doc:WorkshopDoc,source:WorkshopKey,time:number){
 const copy=structuredClone(source),base=`${source.id}-copy`;let id=base,suffix=2;
 while(doc.keys.some(k=>k.id===id))id=`${base}-${suffix++}`;
 copy.id=id;copy.time=time;copy.label=`${source.label||'关键帧'} 副本`;
 for(const side of ['L','R']as const){
  const flag=side==='L'?'plantL':'plantR';
  if(!source.constraints[flag])continue;
  copy.constraints.replant=true;
  const anchor=contactStartKey(doc,side,source.time)??source;
  const from=anchor.pose[side==='L'?'footL':'footR'],to=copy.pose[side==='L'?'footL':'footR'];
  to.target={...from.target};to.yaw=from.yaw;to.pitch=from.pitch;
 }
 return copy;
}

/** Move the whole key through the existing time slots. Labels, constraints,
 * outgoing curves and video references belong to the key, not the slot. */
export function moveKeyframe(doc:WorkshopDoc,id:string,to:number){
 const keys=sortedKeys(doc),from=keys.findIndex(k=>k.id===id);
 if(from<0||!Number.isInteger(to)||to<0||to>=keys.length||from===to)return false;
 const times=keys.map(k=>k.time),[key]=keys.splice(from,1);
 keys.splice(to,0,key);keys.forEach((k,i)=>{k.time=times[i];});doc.keys=keys;
 return true;
}

/** Keep a loop anchored at zero when its first key is deleted. */
export function removeKeyframe(doc:WorkshopDoc,id:string){
 if(doc.keys.length<=2)return undefined;
 const keys=sortedKeys(doc),index=keys.findIndex(k=>k.id===id);
 if(index<0)return undefined;
 keys.splice(index,1);
 if(doc.loop&&index===0)keys[0].time=0;
 doc.keys=keys;
 return keys[Math.min(index,keys.length-1)];
}

/** A committed time edit may cross other keys, but must never create equal
 * timestamps or move a loop's zero anchor. Return a user-facing refusal. */
export function keyframeTimeProblem(doc:WorkshopDoc,id:string,time:number){
 const keys=sortedKeys(doc),key=keys.find(k=>k.id===id);
 if(!key)return '关键帧已不存在，请重新选择。';
 if(!Number.isFinite(time))return '请输入有效的关键帧时间。';
 const max=doc.duration-(doc.loop?WORKSHOP_LIMITS.loopGap:0);
 if(time<0||time>max)return `关键帧时间须在 0–${max.toFixed(3)}s 之间。`;
 if(doc.loop&&keys[0].id===id&&time!==0)return '循环动作的首帧须保持在 0s；可用顺序调整更换首帧。';
 if(keys.some(k=>k.id!==id&&Math.abs(k.time-time)<1e-6))return '该时间已有关键帧，请调整时间或使用顺序调整。';
 return '';
}
