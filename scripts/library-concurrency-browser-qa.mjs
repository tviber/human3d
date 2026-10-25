import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {verifyWebIdentity} from './lib/worktree-check.mjs';

// Browser plugin not available. Hold the real Web Lock to interleave actual UI writes.
const base=new URL(process.env.QA_WEB_URL??'http://127.0.0.1:5173/');
assert((await verifyWebIdentity(process.cwd(),base)).ok);
const browser=await chromium.launch({headless:true,...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),errors=[];
const open=async route=>{const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await p.goto(new URL(route,base).href);await p.waitForFunction(()=>window.__WS__?.ready||window.__LAB__?.ready,null,{timeout:60000});assert.match(await p.title(),/KINESIS/);assert.equal(await p.locator('vite-error-overlay').count(),0);return p;};
const file=p=>p.evaluate(()=>JSON.parse(localStorage.getItem('kinesis-workshop-library')));
const edit=async(p,label)=>{await p.locator('.ws-keyframe-select').first().click();await p.getByRole('textbox',{name:'关键帧名称',exact:true}).fill(label);};
const saved=p=>p.getByTestId('save-to-library').click().then(()=>p.getByTestId('save-state').filter({hasText:'已保存到本机'}).waitFor());
const hold=async p=>{await p.evaluate(()=>{window.__qaHolding=false;void navigator.locks.request('kinesis-workshop-library',()=>new Promise(resolve=>{window.__qaHolding=true;window.__qaRelease=resolve;}));});await p.waitForFunction(()=>window.__qaHolding);};
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
 // Both editors now change the same document before either is allowed to persist.
 await b.getByTitle(first,{exact:true}).click();
 await hold(lab);await edit(a,'A 冲突修改');await edit(b,'B 冲突修改');await lab.evaluate(()=>window.__qaRelease());await saved(a);await saved(b);
 stored=await file(lab);const labels=[stored.docs.find(d=>d.id===first).keys[0].label,...stored.quarantine.filter(q=>q.id===first).map(q=>q.raw.keys[0].label)];
 assert(labels.includes('A 冲突修改'));assert(labels.includes('B 冲突修改'));
 // The production quarantine export button returns the complete conflicting document.
 const download=await Promise.all([b.waitForEvent('download'),b.locator('.ws-quarantine').getByRole('button',{name:'导出',exact:true}).first().click()]);assert(download[0].suggestedFilename());
 await lab.getByTestId(`motion-local:${first}`).click();await lab.getByRole('button',{name:'暂停',exact:true}).click();
 const canvas=lab.locator('#lab-stage canvas'),box=await canvas.boundingBox();await lab.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await lab.mouse.down();await lab.mouse.move(box.x+box.width*.65,box.y+box.height*.6,{steps:12});await lab.mouse.up();await lab.waitForFunction(()=>{const e=window.__LAB__,p=[...e.camera.position.toArray(),...e.camera.quaternion.toArray()],previous=window.__qaCamera;window.__qaCamera=p;return previous&&p.every((v,i)=>Math.abs(v-previous[i])<1e-10);},null,{polling:'raf',timeout:60000});
 const camera=()=>lab.evaluate(()=>{const e=window.__LAB__;return [e.camera.position.toArray(),e.controls.target.toArray(),e.camera.quaternion.toArray(),e.view,e.time,e.playing];});
 const before=await camera();await lab.evaluate(()=>{window.__qaSource=window.__LAB__.source;});
 await edit(a,'当前播放稿更新');await saved(a);await lab.waitForFunction(()=>window.__qaSource!==window.__LAB__.source);
 const after=await camera();for(let i=0;i<3;i++)after[i].forEach((v,j)=>assert(Math.abs(v-before[i][j])<1e-8,'source refresh reset the camera'));assert.deepEqual(after.slice(3),before.slice(3));
 await a.reload();await a.waitForFunction(()=>window.__WS__?.ready);stored=await file(a);assert.equal(stored.docs.find(d=>d.id===first).keys[0].label,'当前播放稿更新');assert(stored.quarantine.length>0);
 assert.deepEqual(errors,[]);console.log('Concurrent UI QA passed: exclusive lock, two independent edits, same-document recovery/export/reload, current-source refresh preserves orbit/playhead/pause.');
}finally{await context.close();await browser.close();}
