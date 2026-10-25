import type {MotionSpec,WorkshopDoc} from '@human3d/motion-core';
import {blankDocument,canonicalizeHands,defaultDocument,MOTION_FILES,newDocId,normalizeDoc,parseDoc,sortedKeys} from '@human3d/motion-core';
import type {Vector3} from 'three';
import type {DraftOwner,StorageLike,StorageLock} from '../platform/platform';
export type {StorageLike} from '../platform/platform';

/** Motion library: the workshop's persistent store. Multiple named documents
 * live under one namespaced localStorage key; the injected StorageLike keeps
 * the store testable and side-effect free outside the browser.
 *
 * Stored documents that fail validation are moved to `quarantine` with the
 * reason and the original JSON. They stay in storage and can be exported, so
 * a document is never silently lost. */

/** A stored document that could not be admitted. `raw` is the original JSON value. */
export interface QuarantineEntry{id:string;name:string;reason:string;raw:unknown}
export interface LibraryFile{schemaVersion:2;activeId:string;docs:WorkshopDoc[];quarantine:QuarantineEntry[]}
export const LIBRARY_KEY='kinesis-workshop-library';
export const DRAFT_PREFIX=LIBRARY_KEY+':draft:';
export const SAVED_MOTION_PREFIX='local:';
/** Both pages play the saved document itself through the normal document source. */
export function savedMotionSpec(doc:WorkshopDoc):MotionSpec{
 return {id:SAVED_MOTION_PREFIX+doc.id,name:doc.name,english:'我的动作',duration:doc.duration,description:'在动作工作台中创建并保存的动作，可继续编辑或删除。',method:'工作台关键帧 · 本机保存',focus:['手工编辑'],oneShot:!doc.loop,
  phases:sortedKeys(doc).map(k=>({time:k.time,label:k.label||'关键帧'})),source:{kind:'document',document:doc},
  capabilities:doc.keys.some(k=>k.constraints.grip)?{prop:{kind:'racket',trail:true,handView:true,side:doc.gripSide??'R'}}:undefined};
}
/** Only bundled trajectories have editable workshop keys. */
export const WORKSHOP_PRESETS=MOTION_FILES.filter(f=>f.kind==='workshop-motion'&&f.document);
/** The library's lead group: reusable basic actions (≤3 keys each) that the
 * workshop inserts at the playhead. */
export const BASIC_PRESETS=WORKSHOP_PRESETS.filter(f=>f.category==='basic');
/** Tennis motions that declare the racket prop; the racket is a plugin they opt into. */
export const RACKET_PRESETS=WORKSHOP_PRESETS.filter(f=>f.capabilities?.prop?.kind==='racket');
/** Older bundled motions without a basic or racket tag (idle, reach, squat, ready). */
export const OTHER_PRESETS=WORKSHOP_PRESETS.filter(f=>f.category!=='basic'&&!f.capabilities?.prop);

function docIdTaken(docs:WorkshopDoc[],id:string){return docs.some(d=>d.id===id);}
const nameOf=(raw:unknown)=>{const n=raw&&typeof raw==='object'?(raw as {name?:unknown}).name:undefined;return typeof n==='string'?n:'';};
const idOf=(raw:unknown)=>{const n=raw&&typeof raw==='object'?(raw as {id?:unknown}).id:undefined;return typeof n==='string'?n:'';};
export class MotionLibrary{
  docs:WorkshopDoc[]=[];activeId='';quarantine:QuarantineEntry[]=[];
  /** Set when the last save() failed (quota/private mode) — the UI must not
   * claim the motion was persisted when it only lives in memory. */
  lastError='';
  /** Fired after a document leaves the library — the app drops the doc's
   * undo book here so a later doc re-using the id can't inherit (and undo
   * into) the deleted doc's snapshots. */
  onRemoved?:(id:string)=>void;
  private baseline=new Map<string,string>();
  private baselineOrder:string[]=[];
  private baselineQuarantine:QuarantineEntry[]=[];
  private rawText:string|null=null;
  saved:Promise<void>=Promise.resolve();
  onSaveState?:(merged:boolean)=>void;
  private pending=0;
  private draftKey='';
  private draftText='';
  private recoveredDrafts:string[]=[];
  get saveState(){return this.lastError?'error':this.pending||this.draftKey?'saving':'saved';}
  constructor(private rest:ReadonlyMap<string,Vector3>,private store?:StorageLike|null,private lock?:StorageLock,private owner?:DraftOwner){}
  private remember(){
    this.baseline=new Map(this.docs.map(d=>[d.id,JSON.stringify(d)]));
    this.baselineOrder=this.docs.map(d=>d.id);
    this.baselineQuarantine=structuredClone(this.quarantine);
  }
  private storedDocs(){
    try{const file=JSON.parse(this.rawText??'null') as LibraryFile|null;return new Map(file?.docs?.map(d=>[d.id,JSON.stringify(d)])??[]);}catch{return new Map<string,string>();}
  }
  /** Three-way merge against the last observed snapshot; conflicts stay exportable. */
  sync(incoming=new MotionLibrary(this.rest,this.store).load({readOnly:true})){
    if(incoming.lastError)throw new Error(incoming.lastError);
    if(incoming.quarantine.some(q=>q.id==='library-file'))throw new Error('其他页面的动作库无法读取，未覆盖原文');
    const before=JSON.stringify([this.docs,this.quarantine]);
    const local=new Map(this.docs.map(d=>[d.id,d])),remote=new Map(incoming.docs.map(d=>[d.id,d]));
    const quarantine=this.quarantine.filter(q=>!this.baselineQuarantine.some(b=>JSON.stringify(b)===JSON.stringify(q))||incoming.quarantine.some(b=>JSON.stringify(b)===JSON.stringify(q)));
    for(const q of incoming.quarantine)if(!this.baselineQuarantine.some(b=>JSON.stringify(b)===JSON.stringify(q))&&!quarantine.some(b=>JSON.stringify(b)===JSON.stringify(q)))quarantine.push(q);
    const stored=this.storedDocs(),received=incoming.storedDocs();
    const common=(id:string)=>this.baseline.has(id)&&local.has(id)&&remote.has(id);
    const reordered=JSON.stringify([...local.keys()].filter(common))!==JSON.stringify(this.baselineOrder.filter(common));
    const order=reordered?[...local.keys(),...remote.keys()]:[...remote.keys(),...local.keys()];
    const docs:WorkshopDoc[]=[];
    for(const id of new Set([...order,...this.baseline.keys()])){
      const a=local.get(id),b=remote.get(id),base=this.baseline.get(id);
      const aText=a&&JSON.stringify(a),bText=b&&JSON.stringify(b);
      const localChanged=aText!==base,remoteChanged=stored.get(id)!==received.get(id);
      let next=!remoteChanged||aText===bText?a:localChanged?a:b;
      if(localChanged&&remoteChanged&&aText!==bText){
        const recovery=a&&b?b:a??b;
        if(recovery)quarantine.push({id:recovery.id,name:recovery.name,reason:'跨页面保存冲突：保留的另一份修改，可导出后重新导入',raw:structuredClone(recovery)});
        // Deletion wins over a conflicting edit, whose full document is recoverable.
        if(!a||!b)next=undefined;
      }
      if(remoteChanged){if(bText)this.baseline.set(id,bText);else this.baseline.delete(id);}
      if(next)docs.push(next);
      if(a&&next!==a)this.onRemoved?.(id);
    }
    this.docs=docs;this.quarantine=quarantine;
    if(!this.docs.some(d=>d.id===this.activeId))this.activeId=this.docs[0]?.id??'';
    this.baselineOrder=incoming.docs.map(d=>d.id);
    this.baselineQuarantine=structuredClone(incoming.quarantine);this.rawText=incoming.rawText;
    return before!==JSON.stringify([this.docs,this.quarantine]);
  }
  load({readOnly=false,snapshotText}:{readOnly?:boolean;snapshotText?:string|null}={}){
    let parsed:Partial<LibraryFile>|undefined,rawText:string|null=null,corrupt=false;
    try{rawText=snapshotText===undefined?this.store?.getItem(LIBRARY_KEY)??null:snapshotText;if(rawText!=null)parsed=JSON.parse(rawText) as Partial<LibraryFile>;}catch(err){corrupt=true;if(rawText===null)this.lastError=err instanceof Error?err.message:String(err);}
    const version=(parsed as {schemaVersion?:number}|undefined)?.schemaVersion;
    const file=(!corrupt&&version===2&&parsed&&Array.isArray(parsed.docs))?parsed:undefined;
    if(file){
      this.docs=[];this.quarantine=Array.isArray(file.quarantine)?file.quarantine.filter(q=>q&&typeof q==='object'):[];
      for(const raw of file.docs!){
        try{
          const doc=normalizeDoc(raw);
          if(docIdTaken(this.docs,doc.id))throw new Error(`重复的动作编号 ${doc.id}`);
          this.docs.push(doc);
        }catch(err){
          this.quarantine.push({id:idOf(raw),name:nameOf(raw),reason:err instanceof Error?err.message:String(err),raw});
        }
      }
      // Stored docs predate the orthonormal hand-frame contract — normalize on
      // rehydrate so sampled poses reproduce stored keys exactly.
      for(const d of this.docs)for(const k of d.keys)canonicalizeHands(k.pose);
      this.activeId=this.docs.some(d=>d.id===file.activeId)?file.activeId!:this.docs[0]?.id??'';
    }else if(rawText!==null){
      // The stored file isn't a readable v2 library (corrupt JSON or an
      // unknown/future schemaVersion). Keep the raw string in quarantine and
      // skip the auto-save below — overwriting storage would destroy the only
      // copy of the user's data. It is rewritten only by an explicit save.
      this.quarantine=[{id:'library-file',name:'动作库文件',reason:corrupt?'动作库文件 JSON 无法解析':'无法识别的动作库格式（schemaVersion 不受支持）',raw:rawText}];
    }
    this.rawText=rawText;this.remember();
    this.baselineQuarantine=structuredClone(Array.isArray(file?.quarantine)?file.quarantine.filter(q=>q&&typeof q==='object'):[]);
    if(!readOnly){
      try{for(let i=0;i<(this.store?.length??0);i++){const key=this.store!.key?.(i);if(key?.startsWith(DRAFT_PREFIX))this.recoveredDrafts.push(key);}}
      catch(err){this.lastError=err instanceof Error?err.message:String(err);}
    }
    if(!this.docs.length&&!readOnly){this.docs=[file?blankDocument(this.rest,'新动作',newDocId('新动作')):defaultDocument(this.rest)];this.activeId=this.docs[0].id;}
    // Reading valid storage must not publish hand-frame normalization as a user edit.
    if(!readOnly&&!corrupt&&(this.recoveredDrafts.length||rawText===null||file&&(!file.docs!.length||this.docs.length!==file.docs!.length)))this.save();
    return this;
  }
  /** Draft keys are immutable: another page can recover one without racing its next edit. */
  checkpoint(){
    try{
      if(!this.store)throw new Error('浏览器存储不可用，请导出 JSON 备份');
      const docs=this.docs.filter(d=>JSON.stringify(d)!==this.baseline.get(d.id));
      const quarantine=this.quarantine.filter(q=>!this.baselineQuarantine.some(b=>JSON.stringify(b)===JSON.stringify(q)));
      if(!docs.length&&!quarantine.length){if(this.draftKey)this.store.removeItem?.(this.draftKey);this.draftKey='';this.draftText='';return;}
      const text=JSON.stringify({schemaVersion:2,owner:this.owner?.id,activeId:this.activeId,docs,quarantine});
      if(text===this.draftText)return;
      const key=DRAFT_PREFIX+Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16)).join('-');this.store.setItem(key,text);
      const previous=this.draftKey;this.draftKey=key;this.draftText=text;
      if(previous)this.store.removeItem?.(previous);
    }catch(err){this.lastError=err instanceof Error?err.message:String(err);}
  }
  save(){
    this.checkpoint();
    if(!this.store){this.onSaveState?.(false);return this.saved;}
    this.pending++;this.onSaveState?.(false);
    let finish:(()=>void)|undefined;
    const failed=(err:unknown)=>{this.pending--;this.lastError=err instanceof Error?err.message:String(err);this.onSaveState?.(false);};
    const write=(snapshot=this.store!)=>{
      let merged=false;
      if(snapshot.getItem(LIBRARY_KEY)!==this.rawText)merged=this.sync(new MotionLibrary(this.rest,snapshot).load({readOnly:true}));
      const stored=this.storedDocs();
      // Recheck inside the save lock: a queued editor may have saved and removed its draft.
      for(const key of this.recoveredDrafts){
        const text=this.store!.getItem(key);if(text===null)continue;
        try{
          const draft=JSON.parse(text) as LibraryFile;
          if(draft.schemaVersion!==2||!Array.isArray(draft.docs)||!Array.isArray(draft.quarantine))throw new Error('无法识别的草稿格式');
          const entries:QuarantineEntry[]=[...draft.docs.map(raw=>({id:idOf(raw),name:nameOf(raw),reason:'未完成保存的草稿：可恢复为副本或导出 JSON',raw})),...draft.quarantine];
          for(const entry of entries){
            if(!entry||typeof entry!=='object'||!('raw' in entry)||typeof entry.id!=='string'||typeof entry.name!=='string'||typeof entry.reason!=='string')throw new Error('无法识别的草稿条目');
            if(stored.get(entry.id)===JSON.stringify(entry.raw))continue;
            if(!this.quarantine.some(q=>JSON.stringify(q.raw)===JSON.stringify(entry.raw)))this.quarantine.push(entry);
          }
        }catch(err){this.quarantine.push({id:'draft-file',name:'未完成的草稿文件',reason:err instanceof Error?err.message:String(err),raw:text});}
      }
      const file:LibraryFile={schemaVersion:2,activeId:this.activeId,docs:this.docs,quarantine:this.quarantine};
      const text=JSON.stringify(file);snapshot.setItem(LIBRARY_KEY,text);
      const baseline=new Map(this.docs.map(d=>[d.id,JSON.stringify(d)])),order=this.docs.map(d=>d.id),quarantine=structuredClone(this.quarantine);
      const sources=[...this.recoveredDrafts],draft=this.draftKey;
      finish=()=>{
        this.rawText=text;this.baseline=baseline;this.baselineOrder=order;this.baselineQuarantine=quarantine;
        for(const key of [...sources,draft])if(key)this.store!.removeItem?.(key);
        this.recoveredDrafts=this.recoveredDrafts.filter(key=>!sources.includes(key));
        if(this.draftKey===draft){this.draftKey='';this.draftText='';}
        this.lastError='';this.pending--;this.onSaveState?.(merged);
      };
    };
    if(this.lock){
      const locked=()=>this.lock!(LIBRARY_KEY,this.owner?async snapshot=>{
        const inactive:string[]=[];
        for(const key of this.recoveredDrafts){
          const text=this.store!.getItem(key);let owner:unknown;
          try{owner=JSON.parse(text??'null')?.owner;}catch{/* Invalid drafts still enter quarantine. */}
          if(typeof owner==='string'&&await this.owner!.active(owner))continue;
          inactive.push(key);
        }
        this.recoveredDrafts=inactive;write(snapshot);
      }:write);
      this.saved=(this.owner?this.owner.ready.then(locked):locked()).then(()=>finish?.()).catch(failed);
    }
    else{try{write();finish?.();}catch(err){failed(err);}}
    return this.saved;
  }
  /** Export one quarantined document as JSON text, so it can be repaired by hand or re-imported. */
  async restore(file:LibraryFile,related:{key:string;text:string;previous:string}){
    await this.saved;
    if(this.saveState!=='saved')throw new Error(this.lastError||'请等待当前动作保存后再恢复');
    if(!this.store||!this.lock)throw new Error('浏览器不支持安全恢复，请保留备份文件');
    const text=JSON.stringify(file);
    await this.lock(LIBRARY_KEY,snapshot=>{
      if(snapshot!.getItem(LIBRARY_KEY)!==this.rawText||JSON.stringify(JSON.parse(snapshot!.getItem(related.key)??'[]'))!==related.previous)throw new Error('其他页面已更新动作或姿态，请刷新后重新恢复');
      snapshot!.setItem(LIBRARY_KEY,text);snapshot!.setItem(related.key,related.text);
    },[related.key]);
    for(const doc of this.docs)if(file.docs.find(d=>d.id===doc.id)!==doc)this.onRemoved?.(doc.id);
    this.docs=file.docs;this.quarantine=file.quarantine;this.activeId=file.activeId;
    this.rawText=text;this.remember();this.lastError='';this.onSaveState?.(false);
  }
  quarantineText(index:number){const q=this.quarantine[index];return q?typeof q.raw==='string'?q.raw:JSON.stringify(q.raw,null,2):'';}
  /** Remove a quarantined entry after the user has exported or repaired it. */
  discardQuarantine(index:number){if(index>=0&&index<this.quarantine.length){this.quarantine.splice(index,1);this.save();}}
  active(){return this.docs.find(d=>d.id===this.activeId)??this.docs[0];}
  select(id:string){if(docIdTaken(this.docs,id)){this.activeId=id;this.save();}return this.active();}
  /** Create a blank custom motion from the stance template and select it. */
  create(name:string){
    const trimmed=name.trim()||`新动作 ${this.docs.length+1}`;
    let id=newDocId(trimmed);while(docIdTaken(this.docs,id))id=newDocId(trimmed);
    const doc=blankDocument(this.rest,trimmed,id);
    this.docs.push(doc);this.activeId=id;this.save();return doc;
  }
  /** Start an independent manual motion without mutating the bundled preset. */
  createFromPreset(presetId:string,name=''){
    const preset=WORKSHOP_PRESETS.find(f=>f.id===presetId);
    if(!preset?.document)throw new Error('该预设没有可编辑的工作台轨迹，请选择关键帧动作。');
    const copy=structuredClone(preset.document);
    copy.name=name.trim()||`${preset.name} 副本`;
    do{copy.id=newDocId(copy.name);}while(docIdTaken(this.docs,copy.id));
    copy.keys.forEach((k,i)=>{k.id=`${copy.id}-k${i}`;});
    this.docs.push(copy);this.activeId=copy.id;this.save();return copy;
  }
  duplicate(id:string){
    const src=this.docs.find(d=>d.id===id);if(!src)return undefined;
    let nid=newDocId(`${src.name}-副本`);while(docIdTaken(this.docs,nid))nid=newDocId(`${src.name}-副本`);
    const copy=parseDoc(JSON.stringify(src)) as WorkshopDoc;
    copy.id=nid;copy.name=`${src.name} 副本`;copy.keys.forEach((k,i)=>{k.id=`${nid}-k${i}`;});
    this.docs.push(copy);this.activeId=nid;this.save();return copy;
  }
  remove(id:string,keepOne=true){
    const idx=this.docs.findIndex(d=>d.id===id);if(idx<0)return;
    const wasActive=this.activeId===id;
    this.docs.splice(idx,1);
    this.onRemoved?.(id);
    if(wasActive)this.activeId=this.docs[Math.min(idx,this.docs.length-1)]?.id??'';
    if(!this.docs.length&&keepOne)this.create('新动作');
    this.save();
  }
  rename(id:string,name:string){const d=this.docs.find(x=>x.id===id);if(d){d.name=name;this.save();}}
  /** Move `activeId` to the slot occupied by `overId`. No-op when either id is missing. */
  reorder(activeId:string, overId:string){
   const from=this.docs.findIndex(d=>d.id===activeId), to=this.docs.findIndex(d=>d.id===overId);
   if(from<0||to<0||from===to)return;
   const [doc]=this.docs.splice(from, 1);
   this.docs.splice(to, 0, doc);
   this.save();
  }
  /** Insert a parsed import; regenerates the id when it clashes. The
   * regenerated document rekeys its frames too — an import must not carry the
   * source document's key ids under a new document id. */
  add(doc:WorkshopDoc){
    if(docIdTaken(this.docs,doc.id)){
      doc.id=newDocId(doc.name);
      while(docIdTaken(this.docs,doc.id))doc.id=newDocId(doc.name);
      doc.keys.forEach((k,i)=>{k.id=`${doc.id}-k${i}`;});
    }
    this.docs.push(doc);this.activeId=doc.id;this.save();return doc;
  }
}
