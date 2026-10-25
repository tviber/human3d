/**
 * platform.ts — the seam between the app and its host runtime.
 *
 * Every web-API call the app makes goes through this interface, so a future
 * mini-program host reimplements ONE object instead of hunting call sites
 * (port path: docs/engineering/miniapp-port.md — Taro + three-platformize
 * reuse everything else: motion-core, the pure logic modules, the zustand
 * stores and both three.js engines). `webPlatform` below is the default
 * implementation; engines take it as an optional constructor argument and
 * leaf libraries import it directly, so a host build swaps this one module.
 *
 * Deliberately NOT seams (view-layer, web-local): reactive matchMedia hooks
 * in components, keyboard shortcuts, native <dialog>, the anatomy-selection
 * DOM overlay, DEV window globals.
 */

export interface StorageLike{getItem(k:string):string|null;setItem(k:string,v:string):void;removeItem?(k:string):void;readonly length?:number;key?(index:number):string|null}

export type StorageLock=(key:string,write:(snapshot?:StorageLike)=>void|Promise<void>,relatedKeys?:readonly string[])=>Promise<void>;
export interface DraftOwner{id:string;ready:Promise<void>;active(id:string):Promise<boolean>}

export interface AppPlatform{
  /** Resolve an app asset path ("/models/rig.json") to a host-fetchable URL. */
  assetUrl(path:string):string;
  /** Fetch an app asset. Callers keep their own !ok checks and messages. */
  fetchAsset(path:string):Promise<Response>;
  /** Persistent key-value storage, or null when the host has none. */
  storage:StorageLike|null;
  storageLock:StorageLock;
  readStorage(key:string):Promise<string|null>;
  readStorages(keys:readonly string[]):Promise<(string|null)[]>;
  readonly draftOwner:DraftOwner|undefined;
  /** Hand a produced file to the user (web: anchor download). */
  download(name:string,blob:Blob):void;
  /** Encode a canvas to a PNG blob (stills, contact sheets). */
  canvasToBlob(canvas:HTMLCanvasElement):Promise<Blob|null>;
  /** Copy text; false when the host has no clipboard (callers fall back). */
  clipboardWrite(text:string):Promise<boolean>;
  /** Module worker factory, or null when the host has no workers. */
  createWorker(url:URL):Worker|null;
  /** Navigate between the app's pages (web: location.assign). */
  navigate(to:string):void;
  /** One-shot coarse-pointer probe (engine render profile). */
  coarse:boolean;
  /** Read a CSS custom property from the root element ("" when absent). */
  cssVar(name:string):string;
  confirm(message:string):boolean;
  prompt(message:string,detail?:string):string|null;
  now():number;
}

/** localStorage access itself can throw in restricted embeds (SecurityError)
 * — probe lazily and defensively: a throwing host degrades to no persistence
 * instead of failing app boot. */
function safeStorage():StorageLike|null{
  try{return globalThis.localStorage??null;}catch{return null;}
}
let draftOwner:DraftOwner|undefined;
let storageDatabase:Promise<IDBDatabase>|undefined;

async function storageSnapshots(keys:readonly string[]){
  storageDatabase??=new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('kinesis-workshop',1);
    request.onupgradeneeded=()=>{request.result.createObjectStore('snapshots');};
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();storageDatabase=undefined;};resolve(request.result);};
  });
  const db=await storageDatabase;
  return new Promise<(string|null|undefined)[]>((resolve,reject)=>{
    const transaction=db.transaction('snapshots','readonly');
    const requests=keys.map(key=>transaction.objectStore('snapshots').get(key));
    transaction.oncomplete=()=>{
      const values:unknown[]=requests.map(request=>request.result);
      if(values.some(value=>value!==undefined&&value!==null&&typeof value!=='string'))reject(new Error('已保存快照格式错误'));
      else resolve(values as (string|null|undefined)[]);
    };
    transaction.onabort=()=>reject(transaction.error??new Error('读取已保存数据失败'));
  });
}
async function storageSnapshot(key:string){return (await storageSnapshots([key]))[0];}
async function withStorageLocks<T>(keys:readonly string[],run:()=>Promise<T>):Promise<T>{
  const locks=globalThis.navigator?.locks;
  if(!locks)return run();
  const ordered=[...new Set(keys)].sort();
  const acquire=async(i:number):Promise<T>=>i===ordered.length?run():locks.request(ordered[i],()=>acquire(i+1));
  return acquire(0);
}

export const webPlatform:AppPlatform={
  assetUrl:path=>path,
  fetchAsset:path=>fetch(path),
  get storage(){return safeStorage();},
  async readStorage(key){return withStorageLocks([key],async()=>{const value=await storageSnapshot(key);return value===undefined?safeStorage()?.getItem(key)??null:value;});},
  async readStorages(keys){return withStorageLocks(keys,async()=>{const values=await storageSnapshots(keys);return values.map((value,i)=>value===undefined?safeStorage()?.getItem(keys[i])??null:value);});},
  get draftOwner(){
    if(!globalThis.navigator?.locks)return undefined;
    if(!draftOwner){
      const id='kinesis-workshop-owner:'+crypto.randomUUID();
      // The browser releases this lease even when the page closes without an unload event.
      const ready=new Promise<void>((resolve,reject)=>{void navigator.locks.request(id,()=>{resolve();return new Promise<void>(()=>{});}).catch(reject);});
      void ready.catch(()=>{});
      draftOwner={id,ready,async active(owner){const state=await navigator.locks.query();return [...state.held??[],...state.pending??[]].some(lock=>lock.name===owner);}};
    }
    return draftOwner;
  },
  async storageLock(key,write,relatedKeys=[]){
    if(!globalThis.navigator?.locks)throw new Error('浏览器不支持安全的跨页面保存，请导出 JSON 备份');
    const keys=[...new Set([key,...relatedKeys])].sort();
    const commit=async()=>{
      const native=safeStorage();if(!native)throw new Error('浏览器存储不可用，请导出 JSON 备份');
      const values=new Map<string,string|null>(),updates=new Map<string,string>(),uninitialized:string[]=[];
      for(const k of keys){const value=await storageSnapshot(k);if(value===undefined)uninitialized.push(k);values.set(k,value===undefined?native.getItem(k):value);}
      await write({getItem:k=>values.has(k)?updates.get(k)??values.get(k)!:native.getItem(k),setItem:(k,text)=>{
        if(!values.has(k))throw new Error('不能写入未锁定的存储键');updates.set(k,text);
      }});
      if(!updates.size)return;
      const previous=new Map([...updates.keys()].map(k=>[k,native.getItem(k)]));
      const db=await storageDatabase!;
      // Freeze fallback values before touching mirrors. If the page dies
      // during the later write transaction, reload still reads BOTH old keys,
      // including an explicit null for a previously absent pose library.
      if(uninitialized.length)await new Promise<void>((resolve,reject)=>{
        const transaction=db.transaction('snapshots','readwrite');
        for(const k of uninitialized)transaction.objectStore('snapshots').put(values.get(k),k);
        transaction.oncomplete=()=>resolve();transaction.onabort=()=>reject(transaction.error??new Error('初始化保存快照失败'));
      });
      await new Promise<void>((resolve,reject)=>{
        const transaction=db.transaction('snapshots','readwrite');
        let failure:unknown;
        transaction.oncomplete=()=>resolve();
        transaction.onabort=()=>{
          try{for(const [k,value] of previous){if(value===null)native.removeItem?.(k);else native.setItem(k,value);}}
          catch(err){reject(new Error(`恢复未提交，本机缓存回滚失败；请刷新读取原快照：${String(err)}`));return;}
          reject(failure??transaction.error??new Error('提交动作失败'));
        };
        try{
          for(const [k,value] of updates)transaction.objectStore('snapshots').put(value,k);
          // A quota error aborts the SAME transaction, before either canonical
          // snapshot commits. Readers wait for this transaction to complete.
          for(const [k,value] of updates)native.setItem(k,value);
        }catch(err){failure=err;transaction.abort();}
      });
    };
    await withStorageLocks(keys,commit);
  },
  download(name,blob){
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);a.download=name;a.click();
    URL.revokeObjectURL(a.href);
  },
  canvasToBlob:canvas=>new Promise(resolve=>{canvas.toBlob(resolve);}),
  clipboardWrite:async text=>{
    try{await navigator.clipboard.writeText(text);return true;}catch{return false;}
  },
  createWorker:url=>new Worker(url,{type:'module'}),
  navigate:to=>{location.assign(to);},
  coarse:typeof matchMedia==='undefined'?false:matchMedia('(pointer:coarse)').matches,
  cssVar:name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
  confirm:message=>globalThis.confirm(message),
  prompt:(message,detail='')=>globalThis.prompt(message,detail),
  now:()=>performance.now(),
};
