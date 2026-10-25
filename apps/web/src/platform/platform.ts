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

export type StorageLock=(key:string,write:(snapshot?:StorageLike)=>void|Promise<void>)=>Promise<void>;
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

async function storageSnapshot(key:string){
  storageDatabase??=new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('kinesis-workshop',1);
    request.onupgradeneeded=()=>{request.result.createObjectStore('snapshots');};
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();storageDatabase=undefined;};resolve(request.result);};
  });
  const db=await storageDatabase;
  return new Promise<string|null|undefined>((resolve,reject)=>{
    const transaction=db.transaction('snapshots','readonly'),request=transaction.objectStore('snapshots').get(key);
    transaction.oncomplete=()=>{
      const value:unknown=request.result;
      if(value!==undefined&&value!==null&&typeof value!=='string')reject(new Error('已保存动作快照格式错误'));
      else resolve(value);
    };
    transaction.onabort=()=>reject(transaction.error??new Error('读取已保存动作失败'));
  });
}

export const webPlatform:AppPlatform={
  assetUrl:path=>path,
  fetchAsset:path=>fetch(path),
  get storage(){return safeStorage();},
  async readStorage(key){const value=await storageSnapshot(key);return value===undefined?safeStorage()?.getItem(key)??null:value;},
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
  async storageLock(key,write){
    if(!globalThis.navigator?.locks)throw new Error('浏览器不支持安全的跨页面保存，请导出 JSON 备份');
    await navigator.locks.request(key,async()=>{
      const native=safeStorage();if(!native)throw new Error('浏览器存储不可用，请导出 JSON 备份');
      const committed=await storageSnapshot(key),db=await storageDatabase!;
      let value=committed===undefined?native.getItem(key):committed,changed=false;
      // localStorage caches can lag across renderers even under a Web Lock.
      await write({getItem:k=>k===key?value:native.getItem(k),setItem:(k,text)=>{if(k!==key)throw new Error('不能写入未锁定的存储键');value=text;changed=true;}});
      if(!changed)return;
      await new Promise<void>((resolve,reject)=>{
        const transaction=db.transaction('snapshots','readwrite');transaction.objectStore('snapshots').put(value,key);
        transaction.oncomplete=()=>resolve();transaction.onabort=()=>reject(transaction.error??new Error('提交动作失败'));
      });
      try{if(value===null)native.removeItem?.(key);else native.setItem(key,value);}
      catch(err){throw new Error(`动作主快照已提交，但本机 JSON 镜像更新失败；草稿仍保留：${err instanceof Error?err.message:String(err)}`);}
    });
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
