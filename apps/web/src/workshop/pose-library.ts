import type {FootTarget,PoseParams,V3,WorkshopDoc,WorkshopKey} from '@human3d/motion-core';
import {ensureKey,nearestKey,sortedKeys,WORKSHOP_LIMITS} from '@human3d/motion-core';
import type {Vector3} from 'three';
import type {StorageLock} from '../platform/platform';

/** The user's own quick poses: captured from any authored key with one click,
 * applied at the playhead with another. Persisted under its own localStorage
 * key (not the motion library) — poses are tiny, reusable across documents
 * and independent of the doc list. The injected StorageLike keeps the store
 * testable and side-effect free outside the browser. */

export interface UserPosePreset{id:string;name:string;pose:PoseParams}
export const POSE_LIBRARY_KEY='kinesis-workshop-poses';
export type StorageLike={getItem(k:string):string|null;setItem(k:string,v:string):void;removeItem?(k:string):void};

const isV3=(v:unknown):v is V3=>!!v&&typeof v==='object'&&['x','y','z'].every(k=>Number.isFinite((v as Record<string,unknown>)[k]));
const isPreset=(p:unknown):p is UserPosePreset=>!!p&&typeof p==='object'&&typeof (p as UserPosePreset).id==='string'&&typeof (p as UserPosePreset).name==='string'&&isPoseShape((p as UserPosePreset).pose);
/** A storable pose needs every channel the editor writes; partial captures
 * would silently erase channels on apply. */
export const isPoseShape=(v:unknown):v is PoseParams=>{
  if(!v||typeof v!=='object')return false;
  const p=v as Record<string,unknown>;
  const hand=(h:unknown)=>!!h&&typeof h==='object'&&isV3((h as Record<string,unknown>).target)&&isV3((h as Record<string,unknown>).pole)
   &&isV3((h as Record<string,unknown>).forward)&&isV3((h as Record<string,unknown>).normal);
  const foot=(f:unknown)=>!!f&&typeof f==='object'&&isV3((f as Record<string,unknown>).target)&&isV3((f as Record<string,unknown>).pole)
   &&Number.isFinite((f as Record<string,unknown>).yaw)&&Number.isFinite((f as Record<string,unknown>).pitch);
  return isV3(p.root)&&Number.isFinite(p.yaw)&&Number.isFinite(p.lean)&&Number.isFinite(p.chest)&&Number.isFinite(p.side)
   &&hand(p.handL)&&hand(p.handR)&&foot(p.footL)&&foot(p.footR);
};

export class PoseLibrary{
  presets:UserPosePreset[]=[];
  /** Set when the last save() failed (quota/private mode) — the UI must not
   * claim the pose was persisted when it only lives in memory. */
  lastError='';
  saved:Promise<void>=Promise.resolve();
  private pending=0;
  private baseline=new Set<string>();
  get saveState(){return this.lastError?'error':this.pending?'saving':'saved';}
  constructor(private store?:StorageLike|null,private lock?:StorageLock){}
  load({snapshotText}:{snapshotText?:string|null}={}){
    try{
      const raw=snapshotText===undefined?this.store?.getItem(POSE_LIBRARY_KEY)??null:snapshotText;
      if(raw){
        const parsed:unknown=JSON.parse(raw);
        if(Array.isArray(parsed))this.presets=parsed.filter(isPreset);
      }
    }catch{this.presets=[];}
    this.baseline=new Set(this.presets.map(p=>p.id));
    return this;
  }
  save(){
    if(!this.store){this.lastError='浏览器存储不可用，请导出备份';return this.saved;}
    const text=JSON.stringify(this.presets);
    if(this.lock){
      let committed:UserPosePreset[]=[];
      this.pending++;
      this.saved=this.saved.then(()=>this.lock!(POSE_LIBRARY_KEY,snapshot=>{
        const raw=snapshot!.getItem(POSE_LIBRARY_KEY),parsed:unknown=raw===null?[]:JSON.parse(raw);
        if(!Array.isArray(parsed)||parsed.some(p=>!isPreset(p)))throw new Error('其他页面的自建姿态已损坏，未覆盖原数据');
        const remote=parsed as UserPosePreset[],local=JSON.parse(text) as UserPosePreset[];
        const localIds=new Set(local.map(p=>p.id)),remoteById=new Map(remote.map(p=>[p.id,p] as const));
        committed=remote.filter(p=>!this.baseline.has(p.id)||localIds.has(p.id)).map(p=>structuredClone(p));
        const ids=new Set(committed.map(p=>p.id));
        for(const pose of local){
          const current=remoteById.get(pose.id);
          if(this.baseline.has(pose.id)&&!current)continue;
          if(!ids.has(pose.id)){committed.push(structuredClone(pose));ids.add(pose.id);}
          else if(!this.baseline.has(pose.id)&&current&&JSON.stringify(current)!==JSON.stringify(pose)){
            const copy=structuredClone(pose);let id=`${pose.id}-copy`,suffix=2;while(ids.has(id))id=`${pose.id}-copy-${suffix++}`;copy.id=id;
            committed.push(copy);ids.add(id);
          }
        }
        snapshot!.setItem(POSE_LIBRARY_KEY,JSON.stringify(committed));
      })).then(()=>{
        this.baseline=new Set(committed.map(p=>p.id));
        if(this.pending===1)this.presets=committed;
        this.lastError='';
      }).catch(err=>{this.lastError=err instanceof Error?err.message:String(err);}).finally(()=>{this.pending--;});
    }else{
      try{this.store.setItem(POSE_LIBRARY_KEY,text);this.baseline=new Set(this.presets.map(p=>p.id));this.lastError='';}
      catch(err){this.lastError=err instanceof Error?err.message:String(err);}
    }
    return this.saved;
  }
  /** Capture a pose under a unique name; returns the new preset. */
  add(name:string,pose:PoseParams):UserPosePreset{
    const trimmed=name.trim()||'我的姿态';
    let unique=trimmed,n=2;
    while(this.presets.some(p=>p.name===unique))unique=`${trimmed} ${n++}`;
    const preset:UserPosePreset={id:`p${Date.now().toString(36)}${this.presets.length}`,name:unique,pose:JSON.parse(JSON.stringify(pose))};
    this.presets.push(preset);this.save();return preset;
  }
  remove(id:string){const i=this.presets.findIndex(p=>p.id===id);if(i>=0){this.presets.splice(i,1);this.save();}}
}

/** What applying a pose at `time` did: the playhead key was overwritten in
 * place ('replaced') or a new key carrying the pose was inserted ('inserted').
 * `heldFoot` lists sides whose foot target/yaw/pitch were NOT written: on a
 * planted non-anchor key contactPlan pins those channels to the run anchor,
 * so writing them would promise a pose the solver keeps at the old contact.
 * `liftoffFoot` lists sides whose target WAS written as a mid-swing waypoint
 * (see footRunRole). The knee pole is never locked and always applies. */
export interface PoseApplyReport{result:'replaced'|'inserted';heldFoot:('L'|'R')[];liftoffFoot:('L'|'R')[]}
/** Write `pose` onto the key at the playhead: an existing key within the
 * insert tolerance is overwritten; otherwise a new key is inserted (undefined
 * when the time is invalid or the key limit refuses the insert). Constraints
 * and label stay the key's own — only the pose is stamped, minus the foot
 * channels contactPlan would ignore. */
export function applyPoseAt(doc:WorkshopDoc,pose:PoseParams,time:number,origin:V3|Vector3,tolerance=.02):PoseApplyReport|undefined{
  if(!Number.isFinite(time))return undefined;
  const ceiling=doc.duration-(doc.loop?WORKSHOP_LIMITS.loopGap:0);
  const t=Math.max(0,Math.min(ceiling,time));
  const existing=nearestKey(doc,t,tolerance);
  const insertedLen=doc.keys.length;
  const key=existing??ensureKey(doc,t,origin,tolerance);
  if(!key)return undefined;
  const stamp=stampPoseIntoKey(doc,key,pose);
  return {result:existing?'replaced':doc.keys.length>insertedLen?'inserted':'replaced',...stamp};
}
export interface PoseStampReport{heldFoot:('L'|'R')[];liftoffFoot:('L'|'R')[]}
/** Stamp `pose` onto an existing key. Held sides (planted run members) keep
 * their locked channels — target/yaw/pitch, the channels FOOT_CH actually
 * locks — while their knee pole still applies. Liftoff sides apply the
 * stamped target verbatim: the released key's instant is pinned to the run
 * contact, and interpolate() reads the stored target as the mid-swing
 * waypoint, so the written target shapes the swing AFTER liftoff. Returns
 * both lists so the UI can say what moved, what did not, and why. */
export function stampPoseIntoKey(doc:WorkshopDoc,key:WorkshopKey,pose:PoseParams):PoseStampReport{
  const stamped=JSON.parse(JSON.stringify(pose)) as PoseParams;
  const heldFoot:(('L'|'R'))[]=[],liftoffFoot:(('L'|'R'))[]=[];
  for(const side of ['L','R'] as const){
    const foot=side==='L'?'footL':'footR';
    const role=footRunRole(doc,key,side);
    if(role==='free')continue; // the stamped pose applies verbatim
    const f=key.pose[foot];
    const next=stamped[foot];
    // Only a real attempted move is worth reporting: a stamp that agrees
    // with the key's authored channels changes nothing anyway.
    const movesTarget=Math.abs(next.target.x-f.target.x)>1e-3||Math.abs(next.target.y-f.target.y)>1e-3||Math.abs(next.target.z-f.target.z)>1e-3;
    const movesOrientation=Math.abs(next.yaw-f.yaw)>1e-3||Math.abs(next.pitch-f.pitch)>1e-3;
    if(role==='held'){
      if(!movesTarget&&!movesOrientation)continue; // ≈ the key's own: stamp verbatim
      // Keep the key's locked channels, apply the editable pole.
      stamped[foot]={target:f.target,pole:next.pole,yaw:f.yaw,pitch:f.pitch};
      heldFoot.push(side);
    }else{
      // The mid-swing waypoint rule reads the TARGET only — yaw/pitch stay
      // the key's own (the run contact overrides them; a toe-orientation-only
      // stamp would be stored but never animated, so it is not reported).
      stamped[foot]={target:next.target,pole:next.pole,yaw:f.yaw,pitch:f.pitch};
      if(movesTarget)liftoffFoot.push(side);
    }
  }
  // Merge over the key's own pose so a held foot keeps its current channels.
  const merged=JSON.parse(JSON.stringify(key.pose)) as PoseParams;
  Object.assign(merged,stamped);
  key.pose=merged;
  return {heldFoot,liftoffFoot};
}

/** How contactPlan treats `key`'s `side` foot channels:
 * - 'free': the authored channels are effective (no run at or before the
 *   key, or the key is the run's anchor — first planted after a free one;
 *   on a fully planted loop contactPlan forces key 0 to anchor, `s<0?0:s`,
 *   so key 0 stays editable despite its planted cyclic predecessor);
 * - 'held': planted run member, previous key planted too — the run pins
 *   target/yaw/pitch to the anchor's contact; also a liftoff key on the
 *   timeline tail (last key, non-loop): the instant is pinned AND there is
 *   no following interval for the waypoint rule to steer, so nothing the
 *   stamp writes beyond the pole could take effect;
 * - 'liftoff': released key right after a planted run with a following
 *   interval — the key instant is pinned to the run contact, but the stored
 *   target survives as the mid-swing waypoint of that interval
 *   (interpolate's release-key rule), so writing the target is meaningful
 *   and visible in the swing. yaw/pitch have no waypoint mechanism. */
type FootRunRole='free'|'held'|'liftoff';
function footRunRole(doc:WorkshopDoc,key:WorkshopKey,side:'L'|'R'):FootRunRole{
  const flag=side==='L'?'plantL':'plantR';
  const keys=sortedKeys(doc),i=keys.indexOf(key);
  if(i<0)return 'free';
  const prev=doc.loop&&i===0?keys[keys.length-1]:keys[i-1];
  if(!prev||!prev.constraints[flag])return 'free';
  if(!key.constraints[flag])return !doc.loop&&i===keys.length-1?'held':'liftoff';
  const allPlanted=doc.loop&&keys.length>1&&keys.every(k=>k.constraints[flag]);
  return allPlanted&&i===0?'free':'held';
}
