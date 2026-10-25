import {chromium} from 'playwright';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {resolveOutputDir,ensureOutputDir,assertTrackedWriteAllowed,atomicWriteFile} from './lib/qa-output.mjs';
import {verifyWebIdentity} from './lib/worktree-check.mjs';

// Real input acceptance for the shared skin: default, hover, pinned selection,
// posed picking, orbit/handle priority, touch/multitouch and read-only review.
// Engine writes are limited to playback/camera/capture, as in workshop-capture.
const root=process.cwd(),output=resolveOutputDir('anatomy',process.argv.slice(2),root,process.env);
if(output.args.length)throw new Error(`unexpected arguments: ${output.args}`);
ensureOutputDir(output.dir,{root,updateEvidence:output.updateEvidence});
const out=name=>assertTrackedWriteAllowed(path.join(output.dir,name),{root,updateEvidence:output.updateEvidence});
const base=new URL(process.env.QA_WEB_URL??`http://127.0.0.1:${process.env.HUMAN3D_WEB_PORT??5173}/`);
const identity=await verifyWebIdentity(root,base);assert(identity.ok,identity.detail);
const browser=await launchQaBrowser(chromium,{...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
const errors=[],checks={};
const watch=page=>{page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});};
const state=(page,key)=>page.evaluate(key=>window[key].anatomy.state,key);
const waitActive=(page,key,active)=>page.waitForFunction(({key,active})=>window[key].anatomy.state.active===active,{key,active});
// Read posed mesh triangles to locate a visible region, then select it ONLY
// through actual mouse/touch events. Raycast in the controller resolves hits.
async function targets(page,key,muscle){
 return page.evaluate(({key,muscle})=>{
  const e=window[key],atlas=e.anatomy.atlas;let mesh;e.model.traverse(o=>{if(o.isSkinnedMesh)mesh=o;});
  const g=mesh.geometry,uv=g.getAttribute('uv'),index=g.index,rect=e.renderer.domElement.getBoundingClientRect(),points=[];
  const a=e.camera.position.clone(),b=a.clone(),c=a.clone();
  for(let i=0;i<index.count;i+=3){
   const ia=index.getX(i),ib=index.getX(i+1),ic=index.getX(i+2),u=(uv.getX(ia)+uv.getX(ib)+uv.getX(ic))/3,v=(uv.getY(ia)+uv.getY(ib)+uv.getY(ic))/3;
   if(atlas.regionAt({x:u,y:v})?.key!==muscle)continue;
   mesh.getVertexPosition(ia,a);mesh.getVertexPosition(ib,b);mesh.getVertexPosition(ic,c);
   const normal=b.clone().sub(a).cross(c.clone().sub(a)).transformDirection(mesh.matrixWorld);
   const world=a.clone().add(b).add(c).multiplyScalar(1/3).applyMatrix4(mesh.matrixWorld);
   if(normal.dot(e.camera.position.clone().sub(world))<=0)continue;
   const p=world.project(e.camera);if(Math.abs(p.x)>.9||Math.abs(p.y)>.9)continue;
   points.push({x:rect.left+(p.x+1)*rect.width/2,y:rect.top+(1-p.y)*rect.height/2});
  }
  const stride=Math.max(1,Math.floor(points.length/12));return points.filter((_,i)=>i%stride===0).slice(0,12);
 },{key,muscle});
}
async function hover(page,key,muscle){
 for(const p of await targets(page,key,muscle)){
  await page.mouse.move(p.x,p.y);await page.waitForTimeout(450);
  if((await state(page,key)).active===muscle)return p;
 }
 throw new Error(`no visible mouse target: ${muscle}`);
}
async function tap(page,key,muscle){
 for(const p of await targets(page,key,muscle)){
  await page.touchscreen.tap(p.x,p.y);
  if((await state(page,key)).selected===muscle)return p;
 }
 throw new Error(`no visible touch target: ${muscle}`);
}
const canvasPatch=(page,key,point)=>page.evaluate(({key,point})=>{
 const canvas=window[key].renderer.domElement,r=canvas.getBoundingClientRect(),copy=document.createElement('canvas');copy.width=canvas.width;copy.height=canvas.height;
 const ctx=copy.getContext('2d');ctx.drawImage(canvas,0,0);return Array.from(ctx.getImageData(Math.floor((point.x-r.left)*canvas.width/r.width)-4,Math.floor((point.y-r.top)*canvas.height/r.height)-4,9,9).data);
},{key,point});
const snapshot=page=>page.evaluate(()=>({doc:JSON.stringify(window.__WS__.getDoc()),storage:localStorage.getItem('kinesis-workshop-library')}));
try{
 const desktop=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
 const page=await desktop.newPage();watch(page);await page.goto(new URL('/',base).href);await page.waitForFunction(()=>window.__LAB__?.ready,{timeout:60000});
 assert.match(await page.title(),/KINESIS/);assert((await page.locator('body').innerText()).includes('人体运动实验室'));assert.equal(await page.locator('vite-error-overlay').count(),0);
 await page.evaluate(()=>{window.__LAB__.setPlaying(false);window.__LAB__.seek(0);});await page.getByRole('button',{name:'正面',exact:true}).click();
 assert.deepEqual(await state(page,'__LAB__'),{hovered:null,selected:null,active:null});await page.screenshot({path:out('desktop-default.png')});checks.default=true;
 const chest=await hover(page,'__LAB__','pectoralis_L');await page.waitForTimeout(200);await page.screenshot({path:out('desktop-hover.png')});assert.match(await page.locator('.anatomy-selection').innerText(),/左胸大肌/);checks.hover=true;
 await page.mouse.move(5,5);await waitActive(page,'__LAB__',null);checks.leave=true;
 await page.mouse.click(chest.x,chest.y);await page.mouse.move(5,5);assert.equal((await state(page,'__LAB__')).selected,'pectoralis_L');checks.pin=true;
 await page.getByRole('button',{name:'清除肌肉选择'}).click();await waitActive(page,'__LAB__',null);checks.clear=true;
 await page.mouse.click(chest.x,chest.y);await page.mouse.move(chest.x,chest.y);await page.mouse.down();await page.mouse.move(chest.x+65,chest.y+12,{steps:8});await page.mouse.up();assert.equal((await state(page,'__LAB__')).selected,'pectoralis_L');checks.orbitKeepsSelection=true;
 await page.getByRole('button',{name:'清除肌肉选择'}).click();await page.getByRole('button',{name:'正面',exact:true}).click();
 // A live motion pose still resolves the UV region, after a real motion switch.
 await page.locator('.motion-row').filter({hasText:'抬手与转身'}).click();await page.evaluate(()=>{window.__LAB__.setPlaying(false);window.__LAB__.seek(1.6);});
 await hover(page,'__LAB__','biceps_L');checks.posedPicking=true;
 await page.evaluate(()=>window.__LAB__.seek(0));await page.getByRole('button',{name:'侧面',exact:true}).click();
 for(const muscle of ['masseter_L','sternocleidomastoid_L']){await hover(page,'__LAB__',muscle);await page.waitForTimeout(200);assert.equal((await state(page,'__LAB__')).active,muscle);await page.screenshot({path:out(`${muscle}.png`)});assert.equal((await state(page,'__LAB__')).active,muscle);}
 checks.faceAndNeck=true;
 await page.mouse.move(5,5);await waitActive(page,'__LAB__',null);await page.waitForTimeout(200);
 let highBit=false;
 for(const point of await targets(page,'__LAB__','fibularis_longus_L')){
  await page.mouse.move(5,5);await waitActive(page,'__LAB__',null);await page.waitForTimeout(200);
  const before=await canvasPatch(page,'__LAB__',point);await page.mouse.move(point.x,point.y);await page.waitForTimeout(250);
  if((await state(page,'__LAB__')).active!=='fibularis_longus_L')continue;
  const after=await canvasPatch(page,'__LAB__',point);await page.screenshot({path:out('high-bit-detail.png')});// A region boundary may cross the cursor pixel. Compare matching pixels in
  // a 9×9 rendered neighborhood; the state alone cannot satisfy this check.
  let tinted=0;for(let i=0;i<after.length;i+=4)if(after[i]-after[i+2]>before[i]-before[i+2]+8)tinted++;
  if(tinted>=3){highBit=true;break;}
 }
 assert(highBit,'expanded lateral calf region is visible and selectable');checks.highBitGpuHighlight=true;
 await page.screenshot({path:out('expanded-calf.png')});
 await page.goto(new URL('/workshop.html',base).href);await page.waitForFunction(()=>window.__WS__?.ready,{timeout:60000});await page.evaluate(()=>{window.__WS__.setPlaying(false);window.__WS__.seek(0);});
 await page.getByRole('button',{name:'审阅',exact:true}).click();await page.getByRole('button',{name:'正面',exact:true}).click();
 const capture=()=>page.evaluate(async()=>{const blob=await window.__WS__.captureStill(0,{view:'front'});return Array.from(new Uint8Array(await blob.arrayBuffer()));});
 const before=await snapshot(page),neutral=await capture(),target=await hover(page,'__WS__','rectus_femoris_L');await page.mouse.click(target.x,target.y);await page.mouse.move(5,5);assert.equal((await state(page,'__WS__')).selected,'rectus_femoris_L');assert.deepEqual(await snapshot(page),before);checks.reviewReadOnly=true;
 // Captures have no transient orange region and restore the pinned selection.
 const bytes=await capture();assert.deepEqual(bytes,neutral,'selection must not change exported PNG pixels');
 await import('node:fs').then(fs=>fs.writeFileSync(out('capture-neutral.png'),Buffer.from(bytes)));assert.equal((await state(page,'__WS__')).selected,'rectus_femoris_L');checks.capture=true;
 const canvas=await page.locator('canvas').boundingBox();await page.mouse.click(canvas.x+canvas.width-20,canvas.y+canvas.height/2);await waitActive(page,'__WS__',null);checks.emptyClears=true;
 await page.getByRole('button',{name:'编辑',exact:true}).click();
 const handle=await page.evaluate(()=>{const e=window.__WS__,h=e.handleGroup.children.find(o=>o.userData.ref?.kind==='hand'&&o.userData.ref?.side==='L'),v=h.getWorldPosition(e.camera.position.clone()).project(e.camera),r=e.renderer.domElement.getBoundingClientRect();return{x:r.left+(v.x+1)*r.width/2,y:r.top+(1-v.y)*r.height/2};});
 await page.mouse.click(handle.x,handle.y);assert.equal((await state(page,'__WS__')).selected,null);checks.handlePriority=true;
 await desktop.close();
 const mobile=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});const phone=await mobile.newPage();watch(phone);
 await phone.goto(new URL('/workshop.html',base).href);await phone.waitForFunction(()=>window.__WS__?.ready,{timeout:60000});await phone.evaluate(()=>{window.__WS__.setPlaying(false);window.__WS__.seek(0);});await phone.getByRole('button',{name:'正面',exact:true}).click();
 const phoneBefore=await snapshot(phone),leg=await tap(phone,'__WS__','rectus_femoris_L');await phone.waitForTimeout(250);await phone.screenshot({path:out('mobile-selected.png')});assert.deepEqual(await snapshot(phone),phoneBefore);checks.touchReadOnly=true;
 const label=await phone.locator('.anatomy-selection').boundingBox();
 for(const name of ['审阅','编辑','洋葱皮','重心']){const button=await phone.getByRole('button',{name,exact:true}).boundingBox();if(button)assert(label.x+label.width<=button.x||button.x+button.width<=label.x||label.y+label.height<=button.y||button.y+button.height<=label.y,`muscle label overlaps ${name}`);}
 checks.mobileLabelLayout=true;
 const session=await mobile.newCDPSession(phone);
 await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:leg.x,y:leg.y,id:1}]});await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:leg.x+45,y:leg.y+5,id:1}]});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.equal((await state(phone,'__WS__')).selected,'rectus_femoris_L');checks.touchDrag=true;
 await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:leg.x,y:leg.y,id:1},{x:leg.x+40,y:leg.y+30,id:2}]});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.equal((await state(phone,'__WS__')).selected,'rectus_femoris_L');checks.multitouch=true;
 await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:leg.x,y:leg.y,id:1}]});await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});assert.equal((await state(phone,'__WS__')).selected,'rectus_femoris_L');checks.cancel=true;
 await phone.getByRole('button',{name:'清除肌肉选择'}).tap();await waitActive(phone,'__WS__',null);checks.touchClear=true;
 assert.deepEqual(await snapshot(phone),phoneBefore);await mobile.close();assert.deepEqual(errors,[]);
 atomicWriteFile(out('results.json'),JSON.stringify({checks,errors,identity,browser:'Chromium; touch emulation, not real hardware',viewports:['1440×1000','390×844']},null,2)+'\n');console.log(JSON.stringify({checks,errors,outDir:output.dir},null,2));
}finally{await browser.close();}
