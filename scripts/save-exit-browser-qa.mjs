import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {resolveOutputDir,ensureOutputDir,assertTrackedWriteAllowed} from './lib/qa-output.mjs';
import {verifyWebIdentity} from './lib/worktree-check.mjs';

// Browser plugin not available. Exercise native Web Locks, unload, storage and UI.
const root=process.cwd(),output=resolveOutputDir('save-exit',process.argv.slice(2),root,process.env);
assert.equal(output.args.length,0);ensureOutputDir(output.dir,{root,updateEvidence:output.updateEvidence});
const out=name=>assertTrackedWriteAllowed(path.join(output.dir,name),{root,updateEvidence:output.updateEvidence});
const base=new URL(process.env.QA_WEB_URL??'http://127.0.0.1:5173/');assert((await verifyWebIdentity(root,base)).ok);
const browser=await chromium.launch({headless:true,...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),errors=[];
const ready=async p=>{await p.waitForFunction(()=>window.__WS__?.ready||window.__LAB__?.ready,null,{timeout:60000});assert.match(await p.title(),/KINESIS/);assert.equal(await p.locator('vite-error-overlay').count(),0);};
const open=async(ctx,route)=>{const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await p.goto(new URL(route,base).href);await ready(p);return p;};
const saved=p=>p.getByTestId('save-state').filter({hasText:'已保存到本机'}).waitFor();
const file=p=>p.evaluate(()=>JSON.parse(localStorage.getItem('kinesis-workshop-library')));
const edit=async(p,label)=>{await p.locator('.ws-keyframe-select').first().click();await p.getByRole('textbox',{name:'关键帧名称',exact:true}).fill(label);};
const hold=async p=>{await p.evaluate(()=>{window.__qaHolding=false;void navigator.locks.request('kinesis-workshop-library',()=>new Promise(resolve=>{window.__qaHolding=true;window.__qaRelease=resolve;}));});await p.waitForFunction(()=>window.__qaHolding);};
const draftLabels=p=>p.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('kinesis-workshop-library:draft:')).flatMap(k=>JSON.parse(localStorage.getItem(k)).docs.flatMap(d=>d.keys.map(k=>k.label))));
try{
 const holder=await open(context,'/'),clean=await open(context,'/workshop.html');await saved(clean);
 await hold(holder);await clean.getByRole('link',{name:'返回实验室'}).click();await clean.waitForURL(base.href);await ready(clean);await holder.evaluate(()=>window.__qaRelease());
 const active=await open(context,'/workshop.html');await saved(active);await hold(holder);await edit(active,'活跃页面等待保存');
 // Retain an earlier real checkpoint so only owner liveness (not matching main bytes) can exclude it.
 const owner=await holder.evaluate(()=>{const key=Object.keys(localStorage).find(k=>k.startsWith('kinesis-workshop-library:draft:')),text=localStorage.getItem(key);localStorage.setItem('kinesis-workshop-library:draft:qa-active',text);return JSON.parse(text).owner;});
 assert.equal(typeof owner,'string');assert(await holder.evaluate(async owner=>(await navigator.locks.query()).held.some(lock=>lock.name===owner),owner));
 const newcomer=await open(context,'/workshop.html');assert.equal(await newcomer.locator('.ws-quarantine').count(),0);
 await edit(active,'活跃页面继续编辑');await holder.evaluate(()=>window.__qaRelease());await saved(active);await saved(newcomer);
 assert.equal(await newcomer.locator('.ws-quarantine').count(),0);assert.deepEqual((await file(holder)).quarantine,[]);assert.equal(await holder.evaluate(()=>localStorage.getItem('kinesis-workshop-library:draft:qa-active')!==null),true);
 await holder.evaluate(()=>localStorage.removeItem('kinesis-workshop-library:draft:qa-active'));assert.deepEqual(await draftLabels(holder),[]);
 await newcomer.reload();await ready(newcomer);assert.equal(await newcomer.locator('.ws-quarantine').count(),0);
 const liveDoc=await active.evaluate(()=>window.__WS__.getDoc().id);assert.equal((await file(holder)).docs.find(d=>d.id===liveDoc).keys[0].label,'活跃页面继续编辑');await active.close();await newcomer.close();assert.equal(await holder.evaluate(async owner=>(await navigator.locks.query()).held.some(lock=>lock.name===owner),owner),false);
 // The same real host adapter must serialize committed values across renderer caches.
 await holder.evaluate(()=>localStorage.setItem('qa-counter',JSON.stringify({a:0,b:0})));
 await Promise.all([holder,clean].map((p,i)=>p.evaluate(async i=>{const {webPlatform}=await import('/src/platform/platform.ts');for(let n=0;n<100;n++)await webPlatform.storageLock('qa-counter',snapshot=>{const value=JSON.parse(snapshot.getItem('qa-counter'));value[i?'b':'a']++;snapshot.setItem('qa-counter',JSON.stringify(value));});},i)));
 const counter=await holder.evaluate(async()=>{const {webPlatform}=await import('/src/platform/platform.ts');return JSON.parse(await webPlatform.readStorage('qa-counter'));});assert.deepEqual(counter,{a:100,b:100});
 const workshop=await open(context,'/workshop.html');await saved(workshop);
 const id=await workshop.evaluate(()=>window.__WS__.getDoc().id);
 await hold(holder);await edit(workshop,'等待后返回');assert((await draftLabels(holder)).includes('等待后返回'));
 assert.notEqual((await file(holder)).docs.find(d=>d.id===id).keys[0].label,'等待后返回');
 await workshop.getByRole('link',{name:'返回实验室'}).click();
 await workshop.getByTestId('save-state').filter({hasText:'完成后返回实验室'}).waitFor();assert(new URL(workshop.url()).pathname==='/workshop.html');
 await edit(workshop,'返回等待期间继续编辑');await workshop.screenshot({path:out('waiting-navigation.png')});
 await holder.evaluate(()=>window.__qaRelease());await workshop.waitForURL(base.href);await ready(workshop);
 assert.equal((await file(holder)).docs.find(d=>d.id===id).keys[0].label,'返回等待期间继续编辑');assert.deepEqual(await draftLabels(holder),[]);
 const pending=await open(context,`/workshop.html?doc=${id}`);await saved(pending);await hold(holder);await edit(pending,'强制关页仍可恢复');
 // A normal reload warns; rejecting it keeps the editable document alive.
 const dialogEvent=pending.waitForEvent('dialog'),reload=pending.reload({timeout:5000}).catch(e=>e);
 const dialog=await dialogEvent;assert.equal(dialog.type(),'beforeunload');await dialog.dismiss();await reload;
 assert.equal(await pending.getByRole('textbox',{name:'关键帧名称',exact:true}).inputValue(),'强制关页仍可恢复');
 await pending.close({runBeforeUnload:false});assert((await draftLabels(holder)).includes('强制关页仍可恢复'));
 const recovered=await open(context,'/workshop.html'),entry=recovered.locator('.ws-quarantine .ws-row').filter({hasText:'未完成保存的草稿'}).first();
 assert.equal(await entry.count(),0);await holder.evaluate(()=>window.__qaRelease());await saved(recovered);await entry.waitFor();
 const [download]=await Promise.all([recovered.waitForEvent('download'),entry.getByRole('button',{name:'导出',exact:true}).click()]);
 assert.equal(JSON.parse(await fs.readFile(await download.path(),'utf8')).keys[0].label,'强制关页仍可恢复');
 await entry.getByRole('button',{name:'恢复为副本'}).click();assert.equal(await recovered.evaluate(()=>window.__WS__.getDoc().keys[0].label),'强制关页仍可恢复');
 const copy=await recovered.evaluate(()=>window.__WS__.getDoc().id);assert.notEqual(copy,id);
 await saved(recovered);
 assert.equal((await file(holder)).docs.find(d=>d.id===copy).keys[0].label,'强制关页仍可恢复');assert.deepEqual(await draftLabels(holder),[]);
 await recovered.reload();await ready(recovered);assert.equal(await recovered.evaluate(()=>window.__WS__.getDoc().keys[0].label),'强制关页仍可恢复');await recovered.screenshot({path:out('recovered-draft.png')});
 // Abort a real native transaction before commit; keep the previous main and recovery source.
 const stable=await file(holder),primary=await holder.evaluate(async()=>{const {webPlatform}=await import('/src/platform/platform.ts');return webPlatform.readStorage('kinesis-workshop-library');});
 await recovered.evaluate(()=>{const native=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){const transaction=native.apply(this,args);if(this.name==='kinesis-workshop'&&args[1]==='readwrite')queueMicrotask(()=>transaction.abort());return transaction;};});
 await edit(recovered,'事务中止后可恢复');await recovered.getByTestId('save-state').filter({hasText:'保存失败'}).waitFor();assert.deepEqual(await file(holder),stable);assert.equal(await holder.evaluate(async()=>{const {webPlatform}=await import('/src/platform/platform.ts');return webPlatform.readStorage('kinesis-workshop-library');}),primary);assert((await draftLabels(holder)).includes('事务中止后可恢复'));
 await recovered.close({runBeforeUnload:false});const afterAbort=await open(context,'/workshop.html');await saved(afterAbort);
 const aborted=afterAbort.locator('.ws-quarantine .ws-row').filter({hasText:'未完成保存的草稿'});assert(await aborted.count()>0);
 const [abortBackup]=await Promise.all([afterAbort.waitForEvent('download'),aborted.last().getByRole('button',{name:'导出',exact:true}).click()]);assert(JSON.parse(await fs.readFile(await abortBackup.path(),'utf8')).keys.some(k=>k.label==='事务中止后可恢复'));
 // Real capability absence, rather than a replacement save implementation.
 const unsupported=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await unsupported.addInitScript(()=>Object.defineProperty(navigator,'locks',{configurable:true,value:undefined}));
 const mobile=await open(unsupported,'/workshop.html');
 await mobile.getByTestId('mode-edit').click();await mobile.getByTestId('sheet-right').click();
 await mobile.getByRole('textbox',{name:'关键帧名称',exact:true}).fill('手机自动保存失败仍有草稿');
 await mobile.locator('#ws-inspector .ws-sheet-head button').click();
 assert((await draftLabels(mobile)).includes('手机自动保存失败仍有草稿'));
 await mobile.getByTestId('save-state').filter({hasText:'保存失败'}).waitFor();
 assert(await mobile.getByTestId('save-state').isVisible());assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await mobile.getByRole('button',{name:'导出当前动作 JSON'}).waitFor();
 const [backup]=await Promise.all([mobile.waitForEvent('download'),mobile.getByRole('button',{name:'导出当前动作 JSON'}).click()]);assert(JSON.parse(await fs.readFile(await backup.path(),'utf8')).keys.length>0);
 await mobile.getByRole('link',{name:'返回实验室'}).click();await mobile.getByTestId('save-state').filter({hasText:'保存失败'}).waitFor();assert.equal(new URL(mobile.url()).pathname,'/workshop.html');
 await mobile.locator('#ws-inspector').waitFor({state:'hidden'});await mobile.screenshot({path:out('mobile-save-failure.png')});await unsupported.close();
 assert.deepEqual(errors,[]);console.log(`Save/exit QA passed: cross-renderer 100+100 atomic updates and native transaction-abort recovery; active queued editor is not recovered by a newly opened page; clean navigation bypasses busy lock, lock-blocked navigation with continued editing, native unload warning, forced close and durable recovery/export/copy/reload, unsupported Web Locks visible on phone with JSON backup and blocked navigation. Screenshots: ${output.dir}`);
}catch(err){for(const [i,p]of browser.contexts().flatMap(c=>c.pages()).entries())await p.screenshot({path:out(`failure-${i}.png`)}).catch(()=>{});throw err;}finally{await context.close();await browser.close();}
