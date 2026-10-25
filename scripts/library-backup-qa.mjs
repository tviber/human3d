import {chromium} from 'playwright';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {resolveOutputDir,ensureOutputDir,atomicWriteFile} from './lib/qa-output.mjs';
import {verifyWebIdentity} from './lib/worktree-check.mjs';

// Issue #30: real UI writes, portable backups, failure atomicity, clean first
// screen and responsive panels. One browser/context/page at a time; engine
// access below only reads state. Fault injection throws at the real browser
// storage boundary; parsing, restoration and IDB transactions remain real.
const output=resolveOutputDir('library-backup',process.argv.slice(2),process.cwd(),process.env);
assert.equal(output.args.length,0);
ensureOutputDir(output.dir,{root:process.cwd(),updateEvidence:output.updateEvidence});
const base=new URL(process.env.QA_WEB_URL??'http://127.0.0.1:5173/');
assert((await verifyWebIdentity(process.cwd(),base)).ok,'wrong checkout dev server');
const browser=await launchQaBrowser(chromium,{...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
const checks=new Proxy({},{set(target,key,value){target[key]=value;console.log('PASS',key);return true;}}),errors=[];
let context;
const ready=page=>page.waitForFunction(()=>window.__WS__?.ready,null,{timeout:60000});
const saved=page=>page.waitForFunction(()=>document.querySelector('[data-testid=save-state]')?.getAttribute('data-state')==='saved');
const read=page=>page.evaluate(()=>({doc:structuredClone(window.__WS__.getDoc()),library:localStorage.getItem('kinesis-workshop-library'),poses:localStorage.getItem('kinesis-workshop-poses')}));
const panel=async(page,side)=>{const button=page.getByTestId(`sheet-${side}`);if(await button.getAttribute('aria-expanded')!=='true')await button.click();await page.locator(side==='left'?'.ws-left':'.ws-right').waitFor({state:'visible'});};
const closeMobile=async page=>{const close=page.getByRole('button',{name:'关闭面板，返回三维视图'});if(await close.isVisible())await page.locator('.ws-sheet-head button:visible').click();};
const upload=async(page,file)=>{
 await panel(page,'left');
 await page.getByTestId('backup-restore').click();
 await page.locator('input[type=file][accept=".json,application/json"]').nth(1).setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(file))});
};
const download=async(page,testId)=>{const pending=page.waitForEvent('download');await page.getByTestId(testId).click();const file=await pending;return fs.readFileSync(await file.path(),'utf8');};
const launch=async(viewport,isMobile=false)=>{
 context=await browser.newContext({viewport,deviceScaleFactor:1,isMobile,hasTouch:isMobile,acceptDownloads:true});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(new URL('/workshop.html',base).href);await ready(page);await saved(page);return page;
};
try{
 let page=await launch({width:1440,height:1000});
 assert.match(await page.title(),/KINESIS/);
 assert.equal(await page.locator('vite-error-overlay').count(),0);
 const initial=await page.evaluate(()=>({mode:document.querySelector('.ws-shell').dataset.mode,editable:window.__WS__.editable,options:window.__WS__.options,width:document.querySelector('#ws-stage').clientWidth,library:document.querySelector('#ws-library').clientWidth,inspector:document.querySelector('#ws-inspector').clientWidth}));
 assert.equal(initial.mode,'review');assert.equal(initial.editable,false);assert.equal(initial.options.trajectories,false);assert.equal(initial.options.balance,false);assert(initial.width>1300);assert.equal(initial.library,0);assert.equal(initial.inspector,0);
 await page.screenshot({path:path.join(output.dir,'workshop-desktop.png')});checks.cleanDesktop=true;
 await panel(page,'left');
 await page.getByRole('textbox',{name:'新动作名称'}).fill('备份回归动作');
 await page.getByRole('button',{name:'新建',exact:true}).click();await saved(page);
 assert.equal((await read(page)).doc.name,'备份回归动作');
 await panel(page,'right');
 await page.getByTestId('selected-key-name').fill('备份里的帧');await saved(page);
 await panel(page,'left');
 page.once('dialog',d=>d.accept('备份姿态'));
 await page.getByTestId('pose-capture').click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('kinesis-workshop-poses')??'[]').some(p=>p.name==='备份姿态'));
 const backup=JSON.parse(await download(page,'backup-download'));
 assert(backup.poses.some(p=>p.name==='备份姿态'));assert(backup.library.docs.some(d=>d.name==='备份回归动作'));
 const action=await download(page,'motion-export');assert.equal(JSON.parse(action).name,'备份回归动作');
 await page.reload();await ready(page);await saved(page);assert.equal((await read(page)).doc.name,'备份回归动作');checks.editRefreshExport=true;
 await page.getByTestId('mode-edit').click();await panel(page,'right');
 await page.getByTestId('selected-key-name').fill('恢复前新编辑');await saved(page);
 assert.equal(await page.getByRole('button',{name:'撤销',exact:true}).isEnabled(),true);
 await upload(page,backup);await page.getByTestId('backup-preview').waitFor();
 const snap=page.waitForEvent('download');page.once('dialog',d=>d.accept());await page.getByTestId('backup-replace').click();await snap;
 await page.getByTestId('backup-preview').waitFor({state:'detached'});await saved(page);
 assert.equal((await read(page)).doc.keys[0].label,'备份里的帧');assert.equal(await page.getByRole('button',{name:'撤销',exact:true}).isDisabled(),true);checks.replaceClearsHistory=true;
 // An import started before restore must not commit after the restore lock is held.
 const lateImport=structuredClone(backup.library.docs[0]);lateImport.id='late-import';lateImport.name='恢复期间延迟导入';lateImport.keys.forEach((key,i)=>{key.id=`late-import-k${i}`;});
 await page.evaluate(()=>{const original=File.prototype.text;File.prototype.text=function(){return this.name==='late-import.workshop.json'?new Promise(resolve=>{window.__releaseImportText=()=>void original.call(this).then(resolve);}):original.call(this);};});
 await page.locator('input[type=file][accept=".json,application/json"]').first().setInputFiles({name:'late-import.workshop.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(lateImport))});
 await page.waitForFunction(()=>typeof window.__releaseImportText==='function');
 await page.evaluate(()=>new Promise(ready=>{void navigator.locks.request('kinesis-workshop-library',()=>{ready();return new Promise(release=>{window.__releaseRestoreLock=release;});});}));
 await upload(page,backup);await page.getByTestId('backup-merge').click();
 await page.waitForFunction(()=>document.querySelector('.ws-shell')?.getAttribute('aria-busy')==='true');
 await page.evaluate(()=>window.__releaseImportText());await page.waitForTimeout(150);
 assert.equal(await page.locator('.ws-lib-name').filter({hasText:'恢复期间延迟导入'}).count(),0);
 await page.evaluate(()=>window.__releaseRestoreLock());await page.waitForFunction(()=>document.querySelector('.ws-shell')?.getAttribute('aria-busy')!=='true');await saved(page);
 assert.equal(JSON.parse((await read(page)).library).docs.some(d=>d.name==='恢复期间延迟导入'),false);checks.importCannotRaceRestore=true;
 const recovery={id:'recovery',name:'隔离原文',reason:'corrupt',raw:'{broken-json'};
 const mixed=structuredClone(backup);mixed.library.quarantine.push(recovery);mixed.library.docs.push({id:'bad',name:'坏动作',keys:'bad'});
 await upload(page,mixed);await page.getByTestId('backup-merge').click();await page.getByTestId('backup-preview').waitFor({state:'detached'});await saved(page);
 let restored=JSON.parse((await read(page)).library);
 assert.equal(restored.docs.length,backup.library.docs.length*2);assert.equal(new Set(restored.docs.map(d=>d.id)).size,restored.docs.length);
 assert(restored.quarantine.some(q=>q.id==='recovery'&&q.raw==='{broken-json'));assert(restored.quarantine.some(q=>q.id==='bad'));
 assert.equal(new Set(JSON.parse((await read(page)).poses).map(p=>p.id)).size,backup.poses.length*2);checks.mergeConflictsAndQuarantine=true;
 const restoredPose=JSON.parse((await read(page)).poses)[0];
 page.once('dialog',d=>d.accept());
 await page.getByTestId(`pose-apply-${restoredPose.id}`).locator('xpath=..').locator('.ws-pose-delete').click();
 await page.getByTestId(`pose-apply-${restoredPose.id}`).waitFor({state:'detached'});
 await page.waitForFunction(id=>!JSON.parse(localStorage.getItem('kinesis-workshop-poses')??'[]').some(p=>p.id===id),restoredPose.id);
 checks.restoredPoseCanBeDeleted=true;
 for(const change of ['poses','quarantine']){
  const corrupt=structuredClone(backup);if(change==='poses')corrupt.poses.push({id:'bad',name:'bad',pose:{}});else corrupt.library.quarantine=null;
  const before=await read(page);await upload(page,corrupt);await page.getByRole('alert').waitFor();assert.equal(await page.getByTestId('backup-preview').count(),0);
  const after=await read(page);assert.equal(after.library,before.library);assert.equal(after.poses,before.poses);
  await page.getByRole('button',{name:'关闭提示'}).click();
 }
 checks.corruptBackupRejected=true;
 // Two different failures: actual IDB transaction abort, and a localStorage
 // quota exception on the SECOND key. Both must leave both stores unchanged.
 for(const fault of ['quota','idb']){
  await upload(page,backup);const before=await read(page);
  await page.evaluate(fault=>{
   if(fault==='quota'){
    const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='kinesis-workshop-poses'&&!window.__quotaThrown){window.__quotaThrown=true;throw new DOMException('QA quota exceeded','QuotaExceededError');}return original.call(this,key,value);};window.__restoreFault=()=>{Storage.prototype.setItem=original;};
   }else{
    const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){const request=original.apply(this,args);if(this.name==='snapshots'&&!window.__abortThrown){window.__abortThrown=true;this.transaction.abort();}return request;};window.__restoreFault=()=>{IDBObjectStore.prototype.put=original;};
   }
  },fault);
  await page.getByTestId('backup-merge').click();await page.getByRole('alert').filter({hasText:'恢复未完成'}).waitFor();
  const after=await read(page);assert.deepEqual(after,before,`${fault} changed in-memory or cached data`);
  await page.evaluate(()=>window.__restoreFault());await page.reload();await ready(page);await saved(page);
  const reloaded=await read(page);assert.equal(reloaded.library,before.library);assert.equal(reloaded.poses,before.poses);
 }
 checks.atomicQuotaAndIdbFailures=true;
 const posesOnly={...backup,library:{schemaVersion:2,activeId:'',docs:[],quarantine:[]}};
 await upload(page,posesOnly);const snapshot=page.waitForEvent('download');page.once('dialog',d=>d.accept());await page.getByTestId('backup-replace').click();await snapshot;
 await page.getByTestId('backup-preview').waitFor({state:'detached'});await saved(page);
 assert.equal((await read(page)).doc.keys.length>0,true);assert.deepEqual(JSON.parse((await read(page)).poses),backup.poses);checks.posesOnlyReplace=true;
 const badOnly={...backup,poses:[],library:{schemaVersion:2,activeId:'',docs:[{id:'only-bad',name:'无法解析'}],quarantine:[]}};
 await upload(page,badOnly);await page.getByTestId('backup-merge').click();await page.getByTestId('backup-preview').waitFor({state:'detached'});await saved(page);assert(JSON.parse((await read(page)).library).quarantine.some(q=>q.id==='only-bad'));checks.invalidOnlyBackup=true;
 // Saving a pose and immediately leaving must wait for the real pose lock.
 await page.getByTestId('mode-edit').click();await panel(page,'left');
 await page.evaluate(()=>new Promise(ready=>{void navigator.locks.request('kinesis-workshop-poses',()=>{ready();return new Promise(release=>{window.__releasePoseLock=release;});});}));
 page.once('dialog',d=>d.accept('离页等待姿态'));await page.getByTestId('pose-capture').click();
 await page.getByRole('link',{name:'返回实验室'}).click();
 await page.waitForFunction(()=>document.querySelector('.ws-back')?.getAttribute('aria-disabled')==='true');
 assert(new URL(page.url()).pathname==='/workshop.html');
 await page.evaluate(()=>window.__releasePoseLock());await page.waitForURL(base.href);
 await page.goto(new URL('/workshop.html',base).href);await ready(page);
 assert(JSON.parse((await read(page)).poses).some(p=>p.name==='离页等待姿态'));checks.poseSaveBeforeNavigation=true;
 await context.close();
 // New browser storage imports the editable single action through the UI.
 page=await launch({width:1440,height:1000});await panel(page,'left');
 await page.locator('input[type=file][accept=".json,application/json"]').first().setInputFiles({name:'action.workshop.json',mimeType:'application/json',buffer:Buffer.from(action)});
 await page.waitForFunction(()=>window.__WS__.getDoc().name==='备份回归动作');await page.getByTestId('mode-edit').click();await panel(page,'right');await page.getByTestId('selected-key-name').fill('新浏览器继续编辑');await saved(page);await panel(page,'left');
 assert.equal(JSON.parse(await download(page,'motion-export')).keys[0].label,'新浏览器继续编辑');checks.freshBrowserActionRoundTrip=true;
 await context.close();
 page=await launch({width:390,height:844},true);
 assert.equal(await page.locator('.ws-shell').getAttribute('data-mode'),'review');
 await page.screenshot({path:path.join(output.dir,'workshop-mobile.png')});
 const before=await read(page);await page.locator('.ws-canvas').tap({position:{x:180,y:170}});assert.deepEqual((await read(page)).doc,before.doc);
 await panel(page,'left');assert(await page.getByTestId('backup-download').isVisible());await closeMobile(page);
 await page.getByTestId('mode-edit').click();await page.getByTestId('semantic-panel').waitFor({state:'visible'});await page.screenshot({path:path.join(output.dir,'workshop-mobile-edit.png')});checks.mobileReviewAndPanels=true;
 await page.goto(new URL('/',base).href);await page.waitForFunction(()=>window.__LAB__?.ready,null,{timeout:60000});await page.screenshot({path:path.join(output.dir,'lab-mobile.png')});await page.getByTestId('sheet-library').click();assert(await page.locator('.motion-row').first().isVisible());checks.labMobile=true;
 await context.close();
 context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();await page.goto(base.href);await page.waitForFunction(()=>window.__LAB__?.ready,null,{timeout:60000});await page.getByRole('button',{name:'展开动作库面板'}).waitFor();await page.screenshot({path:path.join(output.dir,'lab-desktop.png')});await page.getByRole('button',{name:'展开动作库面板'}).click();await page.locator('.motion-row').first().waitFor({state:'visible'});checks.labDesktop=true;
 assert.deepEqual(errors,[]);
 const result={checks,errors,browser:await browser.version(),viewports:[[1440,1000],[390,844]],browserPlugin:'not available; repository Playwright used'};
 atomicWriteFile(path.join(output.dir,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await context?.close();await browser.close();}
