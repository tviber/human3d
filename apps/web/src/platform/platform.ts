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

export type StorageLock=(key:string,write:()=>void)=>Promise<void>;

export interface AppPlatform{
  /** Resolve an app asset path ("/models/rig.json") to a host-fetchable URL. */
  assetUrl(path:string):string;
  /** Fetch an app asset. Callers keep their own !ok checks and messages. */
  fetchAsset(path:string):Promise<Response>;
  /** Persistent key-value storage, or null when the host has none. */
  storage:StorageLike|null;
  storageLock:StorageLock;
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

export const webPlatform:AppPlatform={
  assetUrl:path=>path,
  fetchAsset:path=>fetch(path),
  get storage(){return safeStorage();},
  async storageLock(key,write){
    if(!globalThis.navigator?.locks)throw new Error('浏览器不支持安全的跨页面保存，请导出 JSON 备份');
    await navigator.locks.request(key,write);
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
