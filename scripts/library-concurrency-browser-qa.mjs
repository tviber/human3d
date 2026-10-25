import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import {verifyWebIdentity} from './lib/worktree-check.mjs';

// Browser plugin not available. Hold the real Web Lock to interleave actual UI writes.
const base=new URL(process.env.QA_WEB_URL??'http://127.0.0.1:5173/');
assert((await verifyWebIdentity(process.cwd(),base)).ok);
const browser=await launchQaBrowser(chromium,{...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),errors=[];
const open=async route=>{const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await p.goto(new URL(route,base).href);await p.waitForFunction(()=>window.__WS__?.ready||window.__LAB__?.ready,null,{timeout:60000});assert.match(await p.title(),/KINESIS/);assert.equal(await p.locator('vite-error-overlay').count(),0);return p;};
const file=p=>p.evaluate(()=>JSON.parse(localStorage.getItem('kinesis-workshop-library')));
const panel=async p=>{const button=p.getByTestId('sheet-left');if(await button.getAttribute('aria-expanded')!=='true')await button.click();await p.locator('.ws-left').waitFor({state:'visible'});};
// The keyframe list is a collapsed fold by default (issue #30 PR-B).
const edit=async(p,label)=>{const button=p.getByTestId('mode-edit');if(await button.getAttribute('aria-pressed')!=='true')await button.click();await panel(p);await p.evaluate(()=>{const fold=document.querySelector('details[data-fold="keys"]');if(fold)fold.open=true;});await p.locator('.ws-keyframe-select').first().click();await p.getByRole('textbox',{name:'关键帧名称',exact:true}).fill(label);};
const saved=async p=>{await panel(p);await p.getByTestId('save-to-library').click();await p.getByTestId('save-state').filter({hasText:'已保存到本机'}).waitFor();};
const hold=async p=>{await p.evaluate(()=>{window.__qaHolding=false;void navigator.locks.request('kinesis-workshop-library',()=>new Promise(resolve=>{window.__qaHolding=true;window.__qaRelease=resolve;}));});await p.waitForFunction(()=>window.__qaHolding);};
const holdPoses=async p=>{await p.evaluate(()=>{window.__qaHoldingPoses=false;void navigator.locks.request('kinesis-workshop-poses',()=>new Promise(resolve=>{window.__qaHoldingPoses=true;window.__qaReleasePoses=resolve;}));});await p.waitForFunction(()=>window.__qaHoldingPoses);};
try{
 const a=await open('/workshop.html');await saved(a);const first=await a.evaluate(()=>window.__WS__.getDoc().id);
 await a.getByRole('textbox',{name:'新动作名称',exact:true}).fill('并发第二段');
 await a.getByRole('button',{name:'新建',exact:true}).click();await saved(a);const second=await a.evaluate(()=>window.__WS__.getDoc().id);
 const b=await open(`/workshop.html?doc=${second}`),lab=await open('/');
 await a.getByTitle(first,{exact:true}).click();
 // Select by the actual document id when the seeded display name changes.
 if(await a.evaluate(()=>window.__WS__.getDoc().id)!==first)throw new Error('first document was not selected');
 await hold(lab);await edit(a,'A 独立修改');await edit(b,'B 独立修改');
 assert.notEqual((await file(lab)).docs.find(d=>d.id===first).keys[0].label,'A 独立修改');
 await lab.evaluate(()=>window.__qaRelease());await saved(a);await saved(b);
 let stored=await file(lab);assert.equal(stored.docs.find(d=>d.id===first).keys[0].label,'A 独立修改');assert.equal(stored.docs.find(d=>d.id===second).keys[0].label,'B 独立修改');
 // A page opening during the two-key restore lock must not read the old
 // IndexedDB snapshot before the writer commits and emits its storage events.
 await hold(a);
 await b.evaluate(()=>{window.__qaReadDone=false;void import('/src/platform/platform.ts').then(({webPlatform})=>webPlatform.readStorages(['kinesis-workshop-library','kinesis-workshop-poses'])).then(value=>{window.__qaReadResult=value;window.__qaReadDone=true;},error=>{window.__qaReadError=String(error);window.__qaReadDone=true;});});
 await b.waitForTimeout(250);assert.equal(await b.evaluate(()=>window.__qaReadDone),false,'multi-key read did not wait for the active writer lock');
 await a.evaluate(()=>window.__qaRelease());await b.waitForFunction(()=>window.__qaReadDone);
 assert.equal(await b.evaluate(()=>window.__qaReadError??null),null);
 // Both editors now change the same document before either is allowed to persist.
 await b.getByTitle(first,{exact:true}).click();
 await hold(lab);await edit(a,'A 冲突修改');await edit(b,'B 冲突修改');await lab.evaluate(()=>window.__qaRelease());await saved(a);await saved(b);
 stored=await file(lab);const labels=[stored.docs.find(d=>d.id===first).keys[0].label,...stored.quarantine.filter(q=>q.id===first).map(q=>q.raw.keys[0].label)];
 assert(labels.includes('A 冲突修改'));assert(labels.includes('B 冲突修改'));
 // The production quarantine export button returns the complete conflicting document.
 const download=await Promise.all([b.waitForEvent('download'),b.locator('.ws-quarantine').getByRole('button',{name:'导出',exact:true}).first().click()]);assert(download[0].suggestedFilename());
 const labLibrary=lab.getByRole('button',{name:'展开动作库面板'});if(await labLibrary.isVisible())await labLibrary.click();
 // Three pages share one context: an unfocused page gets its rAF paused, so
 // bring the lab forward before rAF-driven orbit/drag assertions.
 await lab.bringToFront();
 await lab.getByTestId(`motion-local:${first}`).click();await lab.getByRole('button',{name:'暂停',exact:true}).click();
 // The assertions here are "the drag is accepted" and "the camera is not reset
 // by later actions". Pause playback and drop orbit inertia so both are
 // observable in one or two frames: with damping, a software-rendered CI frame
 // decays too slowly to look settled, and a locomotion-follow camera keeps
 // translating while time runs.
 const sampleCamera=()=>lab.evaluate(()=>{const e=window.__LAB__;return [...e.camera.position.toArray(),...e.camera.quaternion.toArray()];});
 const settle=async(wait,label)=>{try{await wait();}catch(err){const state=await lab.evaluate(()=>{const e=window.__LAB__;return {playing:e.playing,time:e.time,view:e.view,kind:e.source?.kind,camera:[...e.camera.position.toArray(),...e.camera.quaternion.toArray()]};});throw new Error(`${label}: ${err instanceof Error?err.message:String(err)}; state ${JSON.stringify(state)}`);}};
 await lab.evaluate(()=>{window.__LAB__.setPlaying(false);window.__LAB__.controls.enableDamping=false;});
 const dragBaseline=await sampleCamera();
 const canvas=lab.locator('#lab-stage canvas'),box=await canvas.boundingBox();await lab.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await lab.mouse.down();await lab.mouse.move(box.x+box.width*.65,box.y+box.height*.6,{steps:12});await lab.mouse.up();
 await settle(()=>lab.waitForFunction(baseline=>{const e=window.__LAB__,p=[...e.camera.position.toArray(),...e.camera.quaternion.toArray()];return p.some((v,i)=>Math.abs(v-baseline[i])>1e-4);},dragBaseline,{polling:50,timeout:30000}),'camera did not respond to the drag');
 await lab.evaluate(()=>{window.__qaCamera=[...window.__LAB__.camera.position.toArray(),...window.__LAB__.camera.quaternion.toArray()];});
 await settle(()=>lab.waitForFunction(()=>{const e=window.__LAB__,p=[...e.camera.position.toArray(),...e.camera.quaternion.toArray()],previous=window.__qaCamera;window.__qaCamera=p;return previous&&p.every((v,i)=>Math.abs(v-previous[i])<1e-6);},null,{polling:50,timeout:30000}),'camera did not settle after the drag');
 const camera=()=>lab.evaluate(()=>{const e=window.__LAB__;return [e.camera.position.toArray(),e.controls.target.toArray(),e.camera.quaternion.toArray(),e.view,e.time,e.playing];});
 await a.bringToFront();
 const before=await camera();await lab.evaluate(()=>{window.__qaSource=window.__LAB__.source;});
 await edit(a,'当前播放稿更新');await saved(a);await lab.waitForFunction(()=>window.__qaSource!==window.__LAB__.source);
 const after=await camera();for(let i=0;i<3;i++)after[i].forEach((v,j)=>assert(Math.abs(v-before[i][j])<1e-8,'source refresh reset the camera'));assert.deepEqual(after.slice(3),before.slice(3));
 // Two actual capture flows queue behind the same pose lock. Their separate
 // page snapshots must merge instead of the later write replacing the first.
 for(const page of [a,b]){
  const button=page.getByTestId('mode-edit');if(await button.getAttribute('aria-pressed')!=='true')await button.click();
  await panel(page);
 }
 for(const page of [a,b])await page.evaluate(()=>{window.__qaDateNow=Date.now;Date.now=()=>123456789;});
 await holdPoses(lab);
 a.once('dialog',d=>d.accept('并发姿态 A'));b.once('dialog',d=>d.accept('并发姿态 B'));
 await a.getByTestId('pose-capture').click();await b.getByTestId('pose-capture').click();
 assert.deepEqual(await lab.evaluate(()=>JSON.parse(localStorage.getItem('kinesis-workshop-poses')??'[]')),[],'pose writes escaped the active lock');
 await lab.evaluate(()=>window.__qaReleasePoses());
 await lab.waitForFunction(()=>{const poses=JSON.parse(localStorage.getItem('kinesis-workshop-poses')??'[]');return poses.some(p=>p.name==='并发姿态 A')&&poses.some(p=>p.name==='并发姿态 B');});
 await Promise.all([a.getByRole('button',{name:'并发姿态 A',exact:true}).waitFor(),b.getByRole('button',{name:'并发姿态 B',exact:true}).waitFor()]);
 for(const page of [a,b])await page.evaluate(()=>{Date.now=window.__qaDateNow;delete window.__qaDateNow;});
 const poses=await lab.evaluate(()=>JSON.parse(localStorage.getItem('kinesis-workshop-poses')));assert.equal(new Set(poses.map(p=>p.id)).size,poses.length);
 await a.reload();await a.waitForFunction(()=>window.__WS__?.ready);stored=await file(a);assert.equal(stored.docs.find(d=>d.id===first).keys[0].label,'当前播放稿更新');assert(stored.quarantine.length>0);
 // Cross-tab replace, with A left un-synced on purpose: B saves and A commits
 // WITHOUT waiting to observe the save. The restore point is built inside A's
 // commit lock from the canonical snapshot, so B's save is captured either way;
 // the library itself must come from the file.
 await panel(a);
 const backupDownload=await Promise.all([a.waitForEvent('download'),a.getByTestId('backup-download').click()]);
 const backupText=fs.readFileSync(await backupDownload[0].path(),'utf8');
 await a.getByTestId('backup-restore').click();
 await a.locator('input[type=file][accept=".json,application/json"]').nth(1).setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(backupText)});
 await Promise.all([a.waitForEvent('download'),a.getByTestId('backup-replace').click()]);await a.getByTestId('backup-replace-ack').check();
 const aBefore=await a.evaluate(()=>JSON.stringify(window.__WS__.getDoc()));
 await b.getByTitle(first,{exact:true}).click();await edit(b,'B 在替换前保存');await saved(b);
 await a.getByTestId('backup-replace-commit').click();await a.getByTestId('backup-preview').waitFor({state:'detached'});
 assert.equal(await a.getByRole('alert').count(),0,await a.getByRole('alert').textContent().catch(()=>''));
 const point=JSON.parse(await a.evaluate(()=>import('/src/platform/platform.ts').then(({webPlatform})=>webPlatform.readStorage('kinesis-workshop-restore-point'))));
 assert(point.library.docs.find(d=>d.id===first)?.keys.some(k=>k.label==='B 在替换前保存'),'restore point lost the other tab\'s save');
 assert(point.library.docs.some(d=>JSON.stringify(d)===aBefore),'restore point lost the state A held before the replace');
 await a.getByTestId('restore-point').waitFor();
 await b.waitForFunction(id=>!JSON.stringify(window.__WS__.getDoc()).includes('B 在替换前保存')||window.__WS__.getDoc().id!==id,first);
 // Undo from A must bring back both sides: B's save and A's pre-replace state.
 a.once('dialog',d=>d.accept());await a.getByTestId('restore-point-undo').click();
 await a.getByTestId('restore-point').waitFor({state:'detached'});
 const undone=JSON.parse(await a.evaluate(()=>localStorage.getItem('kinesis-workshop-library')));
 assert(undone.docs.find(d=>d.id===first)?.keys.some(k=>k.label==='B 在替换前保存'),'undo did not restore the concurrent save');
 assert(undone.docs.some(d=>JSON.stringify(d)===aBefore),'undo did not restore A\'s pre-replace document');
 assert.deepEqual(errors,[]);console.log('Concurrent UI QA passed: exclusive locks, locked multi-key reads, two independent edits, same-document recovery/export/reload, camera continuity, concurrent pose captures, cross-tab replace with an unsynced save captured in the restore point and restored by undo.');
}finally{await context.close();await browser.close();}
