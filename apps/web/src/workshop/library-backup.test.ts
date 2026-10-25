import {describe,it,expect,beforeAll} from 'vitest';
import fs from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig,normalizeDoc} from '@human3d/motion-core';
import type {WorkshopDoc} from '@human3d/motion-core';
import {LIBRARY_KEY,MotionLibrary,type StorageLike} from './library';
import {PoseLibrary} from './pose-library';
import {BACKUP_KIND,MAX_BACKUP_BYTES,RESTORE_POINT_KEY,backupText,mergeBackup,parseBackup,replaceLibrary} from './library-backup';

let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);

const memStorage=():StorageLike&{map:Map<string,string>}=>{const map=new Map<string,string>();return {map,get length(){return map.size;},key:i=>[...map.keys()][i]??null,removeItem:k=>{map.delete(k);},getItem:k=>map.get(k)??null,setItem:(k,v)=>{map.set(k,v);}};};
const lib=(s?:StorageLike)=>new MotionLibrary(rig.rest,s).load();
const poseOf=(name:string)=>({id:`p-${name}`,name,pose:JSON.parse(JSON.stringify(lib().active().keys[0].pose))});

describe('backup file',()=>{
 it('round-trips docs, quarantine and poses byte-faithfully through text',()=>{
  const store=memStorage(),l=lib(store);
  l.create('第一个');l.duplicate(l.activeId);
  l.quarantine.push({id:'q1',name:'坏档',reason:'测试隔离',raw:{name:'坏档'}});
  const poseLib=new PoseLibrary(memStorage()).load();poseLib.add('压膝',l.active().keys[0].pose);
  const before=JSON.stringify([l.docs,l.quarantine,poseLib.presets]);
  const text=backupText(l.docs,l.quarantine,l.activeId,poseLib.presets);
  expect(JSON.stringify([l.docs,l.quarantine,poseLib.presets])).toBe(before);
  const parsed=parseBackup(text);
  expect(parsed.ok).toBe(true);
  if(!parsed.ok)return;
  // parseBackup runs every doc through normalizeDoc (the import path), whose
  // re-orthonormalization may move a float by one ulp — compare against the
  // expected docs after the SAME single normalize pass over byte-identical
  // input (normalizeDoc is not idempotent at the last ulp).
  const expected=l.docs.map(d=>normalizeDoc(JSON.parse(JSON.stringify(d))));
  expect(JSON.stringify(parsed.docs)).toBe(JSON.stringify(expected));
  expect(parsed.file.library.quarantine).toEqual(l.quarantine);
  expect(parsed.poses).toEqual(poseLib.presets);
  expect(parsed.file.library.activeId).toBe(l.activeId);
  expect(parsed.file.exportedAt).toBeTruthy();
 });
 it('rejects non-JSON, wrong kind, future versions and a corrupt library section with readable errors',()=>{
  expect(parseBackup('not json{').ok).toBe(false);
  const oversized=parseBackup('not json',MAX_BACKUP_BYTES+1);
  expect(oversized.ok).toBe(false);if(oversized.ok)return;expect(oversized.error).toContain('64 MB');
  const wrong=parseBackup(JSON.stringify({kind:'something-else',schemaVersion:1}));
  expect(wrong.ok).toBe(false);if(wrong.ok)return;expect(wrong.error).toContain('不是 H3D 动作备份');
  const future=parseBackup(JSON.stringify({kind:BACKUP_KIND,schemaVersion:99}));
  expect(future.ok).toBe(false);if(future.ok)return;expect(future.error).toContain('更新版本');
  const corrupt=parseBackup(JSON.stringify({kind:BACKUP_KIND,schemaVersion:1,exportedAt:'2026-10-25T00:00:00Z',library:{schemaVersion:2,activeId:'',docs:'nope',quarantine:[]},poses:[]}));
  expect(corrupt.ok).toBe(false);if(corrupt.ok)return;expect(corrupt.error).toContain('docs');
 });
 it('isolates unreadable docs as quarantine entries instead of dropping or half-importing',()=>{
  const store=memStorage(),l=lib(store);
  const good=parseBackup(backupText([l.active()],[],l.activeId,[]));
  expect(good.ok).toBe(true);if(!good.ok)return;
  const mixed=parseBackup(JSON.stringify({kind:BACKUP_KIND,schemaVersion:1,exportedAt:'2026-10-25T00:00:00Z',
   library:{schemaVersion:2,activeId:'',docs:[good.docs[0],{id:'bad',name:'坏档',keys:'garbage'}],quarantine:[]},poses:[]}));
  expect(mixed.ok).toBe(true);if(!mixed.ok)return;
  expect(mixed.docs).toHaveLength(1);
  expect(mixed.invalidDocs).toEqual([{name:'坏档',reason:expect.any(String),raw:{id:'bad',name:'坏档',keys:'garbage'}}]);
  replaceLibrary(l,[],mixed);
  expect(l.docs).toHaveLength(1);
  expect(l.quarantine.some(q=>q.name==='坏档'&&q.reason.includes('备份中的动作无法识别'))).toBe(true);
 });
});

describe('restore modes',()=>{
 const fixture=()=>{const l=lib(memStorage());const base=l.active();return {l,base};};
 it('merge keeps existing data; a clashing id becomes an independent rekeyed copy',()=>{
  const {l,base}=fixture();
  const incomingText=backupText([JSON.parse(JSON.stringify(base)) as WorkshopDoc],[],'',[]);
  const parsed=parseBackup(incomingText);expect(parsed.ok).toBe(true);if(!parsed.ok)return;
  const poses:typeof parsed.poses=[];
  const report=mergeBackup(l,poses,parsed);
  expect(report.docsAdded).toBe(1);expect(report.conflicts).toHaveLength(1);
  expect(l.docs).toHaveLength(2);
  expect(l.docs[1].id).not.toBe(base.id);
  expect(l.docs[1].keys.map(k=>k.id).every(id=>id.startsWith(`${l.docs[1].id}-k`))).toBe(true);
  expect(l.activeId).toBe(base.id); // merge never jumps the selection
 });
 it('merge dedupes pose ids but keeps both entries',()=>{
  const {l}=fixture();
  const parsed=parseBackup(backupText([],[],'',[poseOf('深蹲')]));
  expect(parsed.ok).toBe(true);if(!parsed.ok)return;
  const poses=[JSON.parse(JSON.stringify(parsed.poses[0]))];
  const report=mergeBackup(l,poses,parsed);
  expect(report.posesAdded).toBe(1);expect(poses).toHaveLength(2);
  expect(poses[0].id).not.toBe(poses[1].id);
 });
 it('replace swaps docs and poses, keeps the current quarantine and appends the backup one',()=>{
  const {l,base}=fixture();
  l.quarantine.push({id:'current-q',name:'当前隔离',reason:'r',raw:{}});
  const other=lib(memStorage());other.create('备份里的动作');
  const backupQuarantine=[{id:'backup-q',name:'备份隔离',reason:'r2',raw:{}}];
  const parsed=parseBackup(backupText(other.docs,backupQuarantine,other.activeId,[poseOf('备份姿态')]));
  expect(parsed.ok).toBe(true);if(!parsed.ok)return;
  const poses=[poseOf('当前姿态')];
  const report=replaceLibrary(l,poses,parsed);
  expect(report.docsAdded).toBe(2);expect(report.posesAdded).toBe(1);
  expect(l.docs.map(d=>d.name)).toEqual([base.name,'备份里的动作']);
  expect(l.activeId).toBe(other.activeId);
  expect(poses.map(p=>p.name)).toEqual(['备份姿态']);
  expect(l.quarantine.map(q=>q.id)).toEqual(expect.arrayContaining(['current-q','backup-q']));
  expect(l.docs[0]).not.toBe(base); // the pre-restore library was replaced, not mutated in place
 });
 it('replace falls back to the first doc when the backup activeId is unknown',()=>{
  const {l}=fixture();
  const other=lib(memStorage());other.create('另一个');
  const parsed=parseBackup(backupText(other.docs,[],'不存在的id',[]));
  expect(parsed.ok).toBe(true);if(!parsed.ok)return;
  replaceLibrary(l,[],parsed);
  expect(l.activeId).toBe(l.docs[0].id);
 });
});

describe('MotionLibrary.add on import clash',()=>{
 it('regenerates the document id and rebuilds key ids so no stale references survive',()=>{
  const l=lib(memStorage()),src=JSON.parse(JSON.stringify(l.active())) as WorkshopDoc;
  const added=l.add(src);
  expect(added.id).not.toBe(l.docs[0].id);
  expect(added.keys.map(k=>k.id).every(id=>id.startsWith(`${added.id}-k`))).toBe(true);
 });
 it('stores through the real save path and reloads from storage',()=>{
  const store=memStorage(),l=lib(store),src=JSON.parse(JSON.stringify(l.active())) as WorkshopDoc;
  const added=l.add(src);
  const reloaded=new MotionLibrary(rig.rest,store).load({readOnly:true});
  expect(reloaded.docs.map(d=>d.id)).toContain(added.id);
  expect(reloaded.docs.find(d=>d.id===added.id)!.keys.map(k=>k.id)).toEqual(added.keys.map(k=>k.id));
  expect(store.getItem(LIBRARY_KEY)).toContain(added.id);
 });
});

describe('restore point commits with the replace',()=>{
 // Same contract as webPlatform.storageLock: writes go to a staged snapshot
 // and land only when the callback returns; snapshotOnly keys skip the mirror.
 const lockOver=(store:StorageLike&{map:Map<string,string>},canonical:Map<string,string>)=>{
  const calls:{keys:string[];snapshotOnly:readonly string[]}[]=[];
  const lock=async(key:string,write:(s?:StorageLike)=>void|Promise<void>,related:readonly string[]=[],options?:{snapshotOnly?:readonly string[]})=>{
   const keys=[key,...related],snapshotOnly=options?.snapshotOnly??[],updates=new Map<string,string>();
   calls.push({keys,snapshotOnly});
   await write({getItem:k=>updates.get(k)??canonical.get(k)??store.getItem(k),setItem:(k,v)=>{if(!keys.includes(k))throw new Error('unlocked key');updates.set(k,v);}});
   for(const [k,v] of updates){canonical.set(k,v);if(!snapshotOnly.includes(k))store.setItem(k,v);}
  };
  return {lock,calls};
 };
 it('writes the pre-replace backup in the same locked commit, outside the localStorage mirror',async()=>{
  const store=memStorage(),canonical=new Map<string,string>(),{lock,calls}=lockOver(store,canonical);
  const l=new MotionLibrary(rig.rest,store,lock).load();await l.saved;
  const before=backupText(l.docs,l.quarantine,l.activeId,[]);
  const blank=lib(memStorage()).active();
  const originalLibrary=store.map.get(LIBRARY_KEY)??null;
  let builtFrom:unknown;
  const result=await l.restore({schemaVersion:2,docs:[blank],quarantine:[],activeId:blank.id},{key:'kinesis-workshop-poses',text:'[]',previous:'[]'},
   {key:RESTORE_POINT_KEY,build:latest=>{builtFrom=latest;return before;}});
  const commit=calls.at(-1)!;
  expect(commit.keys).toEqual(expect.arrayContaining([LIBRARY_KEY,'kinesis-workshop-poses',RESTORE_POINT_KEY]));
  expect(commit.snapshotOnly).toEqual([RESTORE_POINT_KEY]);
  expect(canonical.get(RESTORE_POINT_KEY)).toBe(before);
  expect(store.map.has(RESTORE_POINT_KEY)).toBe(false);
  // The builder sees the state just before the restore, with pose writes not
  // yet applied, so its backup describes exactly what the restore overwrote.
  expect(builtFrom).toEqual({libraryText:originalLibrary,relatedText:null});
  expect(result).toEqual({capturedConcurrent:false,restorePointText:before});
  const point=parseBackup(canonical.get(RESTORE_POINT_KEY)!);
  expect(point.ok&&point.docs.map(d=>d.id)).toEqual(JSON.parse(before).library.docs.map((d:WorkshopDoc)=>d.id));
 });
 it('aborts a merge, writing neither the library nor the restore point, when another page changed storage',async()=>{
  const store=memStorage(),canonical=new Map<string,string>(),{lock}=lockOver(store,canonical);
  const l=new MotionLibrary(rig.rest,store,lock).load();await l.saved;
  canonical.set(LIBRARY_KEY,JSON.stringify({schemaVersion:2,activeId:'',docs:[],quarantine:[]}));
  const libraryBefore=canonical.get(LIBRARY_KEY);
  await expect(l.restore({schemaVersion:2,docs:l.docs,quarantine:[],activeId:l.activeId},{key:'kinesis-workshop-poses',text:'[]',previous:'[]'},{key:RESTORE_POINT_KEY,build:()=>'x'})).rejects.toThrow('其他页面');
  expect(canonical.get(LIBRARY_KEY)).toBe(libraryBefore);
  expect(canonical.has(RESTORE_POINT_KEY)).toBe(false);
 });
 // The review's race: B saves after A armed the replace, and A has not yet
 // processed B's storage event when it commits.
 it('captures an unsynced save from another page in the restore point instead of aborting the replace',async()=>{
  const store=memStorage(),canonical=new Map<string,string>(),{lock}=lockOver(store,canonical);
  const a=new MotionLibrary(rig.rest,store,lock).load();await a.saved;
  const other=lib(memStorage());other.docs[0].keys[0].label='B 未同步的保存';
  canonical.set(LIBRARY_KEY,JSON.stringify({schemaVersion:2,activeId:other.activeId,docs:other.docs,quarantine:[]}));
  const bText=canonical.get(LIBRARY_KEY)!;
  const blank=lib(memStorage()).active();
  const result=await a.restore({schemaVersion:2,docs:[blank],quarantine:[],activeId:blank.id},{key:'kinesis-workshop-poses',text:'[]',previous:'[]'},
   {key:RESTORE_POINT_KEY,build:({libraryText})=>backupText(new MotionLibrary(rig.rest).load({readOnly:true,snapshotText:libraryText}).docs,[],'',[])},{concurrent:'capture'});
  expect(result.capturedConcurrent).toBe(true);
  const point=parseBackup(canonical.get(RESTORE_POINT_KEY)!);
  expect(point.ok&&point.docs[0].keys[0].label).toBe('B 未同步的保存');
  expect(JSON.parse(canonical.get(LIBRARY_KEY)!).docs.map((d:WorkshopDoc)=>d.id)).toEqual([blank.id]);
 });
 it('refuses a capture replace without a restore point, so no concurrent save can be dropped',async()=>{
  const store=memStorage(),canonical=new Map<string,string>(),{lock}=lockOver(store,canonical);
  const l=new MotionLibrary(rig.rest,store,lock).load();await l.saved;
  await expect(l.restore({schemaVersion:2,docs:l.docs,quarantine:[],activeId:l.activeId},{key:'kinesis-workshop-poses',text:'[]',previous:'[]'},undefined,{concurrent:'capture'})).rejects.toThrow('恢复点');
 });
 // Undo clears the point inside its own commit; an empty point must read as
 // "no undo offer", never as a corrupt one.
 it('clears the restore point in the same commit as the undo',async()=>{
  const store=memStorage(),canonical=new Map<string,string>(),{lock}=lockOver(store,canonical);
  const l=new MotionLibrary(rig.rest,store,lock).load();await l.saved;
  const blank=lib(memStorage()).active();
  await l.restore({schemaVersion:2,docs:[blank],quarantine:[],activeId:blank.id},{key:'kinesis-workshop-poses',text:'[]',previous:'[]'},{key:RESTORE_POINT_KEY,build:()=>'point'},{concurrent:'capture'});
  expect(canonical.get(RESTORE_POINT_KEY)).toBe('point');
  const result=await l.restore({schemaVersion:2,docs:l.docs,quarantine:[],activeId:l.activeId},{key:'kinesis-workshop-poses',text:'[]',previous:'[]'},{key:RESTORE_POINT_KEY,build:()=>''});
  expect(canonical.get(RESTORE_POINT_KEY)).toBe('');
  expect(result.restorePointText).toBe('');
  expect(parseBackup('').ok).toBe(false);
 });
});

describe('restore preserves recovery material and identities',()=>{
 it('merge keeps both quarantine and invalid documents without changing the parsed preview',()=>{
  const l=lib(memStorage()),file=JSON.parse(backupText([l.active()],[{id:'q',name:'raw',reason:'r',raw:'{broken'}],l.activeId,[]));
  file.library.docs.push({id:'bad',name:'坏动作'});
  const parsed=parseBackup(JSON.stringify(file));expect(parsed.ok).toBe(true);if(!parsed.ok)return;
  const before=JSON.stringify(parsed);
  mergeBackup(l,[],parsed);
  expect(l.quarantine).toHaveLength(2);
  expect(l.quarantine.find(q=>q.id==='q')?.raw).toBe('{broken');
  expect(l.quarantine.find(q=>q.id==='bad')?.raw).toEqual({id:'bad',name:'坏动作'});
  expect(JSON.stringify(parsed)).toBe(before);
 });
 it('rejects corrupt poses or quarantine instead of dropping entries during replace',()=>{
  const l=lib(memStorage());
  for(const patch of [{poses:[{id:'p',name:'bad',pose:{}}]},{quarantine:null},{quarantine:[{id:'bad'}]}]){
   const file=JSON.parse(backupText(l.docs,[],l.activeId,[]));
   if('poses' in patch)file.poses=patch.poses;else file.library.quarantine=patch.quarantine;
   expect(parseBackup(JSON.stringify(file)).ok).toBe(false);
  }
 });
 it('replace rekeys duplicate ids inside the backup and leaves the preview reusable',()=>{
  const l=lib(memStorage()),doc=l.active();
  const parsed=parseBackup(backupText([doc,doc],[],doc.id,[poseOf('姿态'),poseOf('姿态')]));
  expect(parsed.ok).toBe(true);if(!parsed.ok)return;
  const before=JSON.stringify(parsed),poses:typeof parsed.poses=[];
  replaceLibrary(l,poses,parsed);
  expect(new Set(l.docs.map(d=>d.id)).size).toBe(2);
  expect(new Set(poses.map(p=>p.id)).size).toBe(2);
  expect(JSON.stringify(parsed)).toBe(before);
  const store=memStorage(),copy=lib(store);copy.docs=l.docs;copy.save();expect(lib(store).quarantine).toHaveLength(0);
 });
});
