import type {WorkshopDoc} from '@human3d/motion-core';
import {newDocId,normalizeDoc} from '@human3d/motion-core';
import type {QuarantineEntry} from './library';
import type {UserPosePreset} from './pose-library';
import {isPoseShape} from './pose-library';

/** Whole-library backup & restore (issue #30 PR-C): one portable JSON file
 * covering the motion library (docs + quarantine), the user's captured poses
 * and version metadata. Pure data transformations — the callers own storage,
 * confirmation flows and the replace-time snapshot download, so a restore can
 * never silently overwrite the only copy of the user's data. */

export const BACKUP_KIND='h3d-library-backup';
export const BACKUP_SCHEMA_VERSION=1;
/** A guard against pathological files, not a real limit: storage itself
 * rejects oversized libraries long before this (localStorage ~5 MB/origin). */
export const MAX_BACKUP_BYTES=64*1024*1024;

export interface BackupFile{
 kind:string;schemaVersion:number;exportedAt:string;
 library:{schemaVersion:2;activeId:string;docs:WorkshopDoc[];quarantine:QuarantineEntry[]};
 poses:UserPosePreset[];
}

/** Snapshot the CURRENT in-memory state; never touches storage. */
export function buildBackup(docs:readonly WorkshopDoc[],quarantine:readonly QuarantineEntry[],activeId:string,poses:readonly UserPosePreset[]):BackupFile{
 return {
  kind:BACKUP_KIND,schemaVersion:BACKUP_SCHEMA_VERSION,
  exportedAt:new Date().toISOString(),
  library:{schemaVersion:2,activeId,docs:JSON.parse(JSON.stringify(docs)) as WorkshopDoc[],quarantine:JSON.parse(JSON.stringify(quarantine)) as QuarantineEntry[]},
  poses:JSON.parse(JSON.stringify(poses)) as UserPosePreset[],
 };
}
export const backupText=(docs:readonly WorkshopDoc[],quarantine:readonly QuarantineEntry[],activeId:string,poses:readonly UserPosePreset[]):string=>JSON.stringify(buildBackup(docs,quarantine,activeId,poses),null,2);

export type ParsedBackup={ok:true;file:BackupFile;docs:WorkshopDoc[];invalidDocs:{name:string;reason:string;raw:unknown}[];poses:UserPosePreset[]}
 |{ok:false;error:string};

/** Validate shape, version and every entry BEFORE anything is written:
 * a restore previews exactly what would land (docs / invalid docs / poses). */
export function parseBackup(text:string):ParsedBackup{
 let parsed:unknown;
 try{parsed=JSON.parse(text);}catch(err){return {ok:false,error:`文件不是有效的 JSON：${err instanceof Error?err.message:String(err)}`};}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {ok:false,error:'文件结构不是 H3D 动作备份（缺少对象根节点）。'};
 const raw=parsed as Record<string,unknown>;
 if(raw.kind!==BACKUP_KIND)return {ok:false,error:'这不是 H3D 动作备份文件（单动作请用「导入动作」，姿态包请用实验室的打开姿态包）。'};
 const version=raw.schemaVersion;
 if(version!==BACKUP_SCHEMA_VERSION){
  if(typeof version==='number'&&version>BACKUP_SCHEMA_VERSION)return {ok:false,error:`备份来自更新版本的应用（schemaVersion ${version}），请先升级后再恢复。`};
  return {ok:false,error:'备份文件版本无法识别，可能已损坏。'};
 }
 if(typeof raw.exportedAt!=='string')return {ok:false,error:'备份缺少导出时间，可能已损坏。'};
 const lib=raw.library;
 if(!lib||typeof lib!=='object'||Array.isArray(lib)||(lib as {schemaVersion?:unknown}).schemaVersion!==2)return {ok:false,error:'备份中的动作库格式无法识别（schemaVersion ≠ 2）。'};
 const docsRaw=(lib as {docs?:unknown}).docs;
 if(!Array.isArray(docsRaw))return {ok:false,error:'备份中的动作列表已损坏（docs 不是数组）。'};
 const quarantineRaw=(lib as {quarantine?:unknown}).quarantine;
 const posesRaw=raw.poses;
 if(!Array.isArray(posesRaw))return {ok:false,error:'备份中的自建姿态列表已损坏（poses 不是数组）。'};
 const activeIdRaw=(lib as {activeId?:unknown}).activeId;
 const docs:WorkshopDoc[]=[],invalidDocs:{name:string;reason:string;raw:unknown}[]=[];
 for(const item of docsRaw){
  try{docs.push(normalizeDoc(item));}
  catch(err){const name=item&&typeof item==='object'&&typeof (item as {name?:unknown}).name==='string'?(item as {name:string}).name:'未命名';invalidDocs.push({name,reason:err instanceof Error?err.message:String(err),raw:item});}
 }
 const poses:UserPosePreset[]=[];
 for(const item of posesRaw){
  if(item&&typeof item==='object'&&typeof (item as UserPosePreset).id==='string'&&typeof (item as UserPosePreset).name==='string'&&isPoseShape((item as UserPosePreset).pose))poses.push(item as UserPosePreset);
 }
 const quarantine:QuarantineEntry[]=Array.isArray(quarantineRaw)?quarantineRaw.filter((q):q is QuarantineEntry=>!!q&&typeof q==='object'&&typeof (q as QuarantineEntry).id==='string'&&typeof (q as QuarantineEntry).name==='string'&&typeof (q as QuarantineEntry).reason==='string'&&'raw' in (q as QuarantineEntry)):[];
 return {ok:true,file:{kind:BACKUP_KIND,schemaVersion:BACKUP_SCHEMA_VERSION,exportedAt:raw.exportedAt,
  library:{schemaVersion:2,activeId:typeof activeIdRaw==='string'?activeIdRaw:'',docs,quarantine},poses},
  docs,invalidDocs,poses};
}

export interface RestoreReport{docsAdded:number;posesAdded:number;conflicts:string[];invalidDocs:{name:string;reason:string}[]}
/** Rebuild key ids to match a regenerated document id, so a restored copy
 * never carries another document's key ids. */
const rekey=(doc:WorkshopDoc)=>{doc.keys.forEach((k,i)=>{k.id=`${doc.id}-k${i}`;});return doc;};

/** Merge: existing data stays; conflicting ids become independent copies.
 * The active document and the current quarantine are left untouched. */
export function mergeBackup(lib:{docs:WorkshopDoc[]},poses:UserPosePreset[],parsed:Extract<ParsedBackup,{ok:true}>):RestoreReport{
 const report:RestoreReport={docsAdded:0,posesAdded:0,conflicts:[],invalidDocs:parsed.invalidDocs.map(({name,reason})=>({name,reason}))};
 for(const doc of parsed.docs){
  if(lib.docs.some(d=>d.id===doc.id)){
   report.conflicts.push(`「${doc.name}」与现有动作编号相同 → 已存为独立副本`);
   doc.id=newDocId(doc.name);while(lib.docs.some(d=>d.id===doc.id))doc.id=newDocId(doc.name);
   rekey(doc);
  }
  lib.docs.push(doc);report.docsAdded++;
 }
 for(const pose of parsed.poses){
  if(poses.some(p=>p.id===pose.id)){
   report.conflicts.push(`姿态「${pose.name}」已存在同名同编号条目 → 保留双方，副本换新编号`);
   pose.id=`p${Date.now().toString(36)}${poses.length}${Math.floor(Math.random()*1e4).toString(36)}`;
  }
  poses.push(JSON.parse(JSON.stringify(pose)) as UserPosePreset);report.posesAdded++;
 }
 return report;
}

/** Replace: the backup becomes the library; poses swap wholesale. Recovery
 * material is NEVER destroyed by a replace — the current quarantine stays and
 * the backup's own quarantine plus its unreadable docs are appended, so every
 * pre-restore document remains exportable from the library page. */
export function replaceLibrary(lib:{docs:WorkshopDoc[];quarantine:QuarantineEntry[];activeId:string},poses:UserPosePreset[],parsed:Extract<ParsedBackup,{ok:true}>):RestoreReport{
 const report:RestoreReport={docsAdded:0,posesAdded:0,conflicts:[],invalidDocs:parsed.invalidDocs.map(({name,reason})=>({name,reason}))};
 lib.docs=parsed.docs.map(doc=>JSON.parse(JSON.stringify(doc)) as WorkshopDoc);
 report.docsAdded=lib.docs.length;
 for(const item of parsed.invalidDocs)lib.quarantine.push({id:item.raw&&typeof item.raw==='object'&&typeof (item.raw as {id?:unknown}).id==='string'?(item.raw as {id:string}).id:'unknown',name:item.name,reason:`备份中的动作无法识别，已隔离：${item.reason}`,raw:item.raw});
 for(const q of parsed.file.library.quarantine)lib.quarantine.push(q);
 lib.activeId=lib.docs.some(d=>d.id===parsed.file.library.activeId)?parsed.file.library.activeId:lib.docs[0]?.id??'';
 poses.length=0;
 for(const pose of parsed.poses){poses.push(JSON.parse(JSON.stringify(pose)) as UserPosePreset);report.posesAdded++;}
 return report;
}
