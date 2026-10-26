import {chromium} from 'playwright';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {resolveOutputDir,assertTrackedWriteAllowed,atomicWriteFile,ensureOutputDir} from './lib/qa-output.mjs';
import {verifyWebIdentity} from './lib/worktree-check.mjs';

// Rehydration canonicalizes hand directions; allow only roundoff there,
// while requiring all other stored document fields to survive exactly.
function assertRestoredDoc(actual,expected){
 const copy=structuredClone(actual);
 copy.keys.forEach((key,i)=>{
  for(const hand of ['handL','handR'])for(const field of ['forward','normal'])for(const axis of ['x','y','z']){
   const value=expected.keys[i].pose[hand][field][axis];
   assert(Math.abs(key.pose[hand][field][axis]-value)<1e-12,`${hand}.${field}.${axis} changed on reload`);
   key.pose[hand][field][axis]=value;
  }
 });
 assert.deepEqual(copy,expected);
}
/** Strict-equality comparison for undo/redo round trips. Every stored number
 * must come back IDENTICAL except the hand frames, which the library projects
 * onto an orthonormal pair both on rehydrate and in its history snapshots; that
 * projection is not a bit-exact fixed point of decimal JSON round-tripping, so
 * a direction can move by one ULP (~1e-16). Bundled presets carry the same
 * property at HEAD, so the tolerance belongs to the comparison, not to the
 * documents: everything else is compared exactly. */
function assertSameDoc(actual,expected,label){
 const a=structuredClone(actual),b=structuredClone(expected);
 a.keys.forEach((key,i)=>{
  for(const hand of ['handL','handR'])for(const field of ['forward','normal'])for(const axis of ['x','y','z']){
   const v=b.keys[i].pose[hand][field][axis],got=key.pose[hand][field][axis];
   assert(Math.abs(got-v)<1e-12,`${label}: ${hand}.${field}.${axis} changed`);
   key.pose[hand][field][axis]=v;
  }
 });
 assert.deepEqual(a,b,label);
}

// Real UI regression: preset -> independent document -> pointer edit ->
// undo/redo -> reload. Engine access below is read-only except playback/view.
const repoRoot=process.cwd();
const output=resolveOutputDir('workshop-preset',process.argv.slice(2),repoRoot,process.env);
if(output.args.length)throw new Error(`unexpected arguments: ${output.args.join(' ')}`);
ensureOutputDir(output.dir,{root:repoRoot,updateEvidence:output.updateEvidence});
const outputFile=name=>assertTrackedWriteAllowed(path.join(output.dir,name),{root:repoRoot,updateEvidence:output.updateEvidence});
const webBase=new URL(process.env.QA_WEB_URL??`http://127.0.0.1:${process.env.HUMAN3D_WEB_PORT??5173}/`);
const identity=await verifyWebIdentity(repoRoot,webBase);
assert(identity.ok,`dev server does not serve this checkout: ${identity.detail}`);
const browser=await launchQaBrowser(chromium,{...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
try{
 const page=await browser.newPage({viewport:{width:1536,height:1024},deviceScaleFactor:1});
 const errors=[],warnings=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(m.type()==='warning')warnings.push(m.text());});
 await page.goto(new URL('/workshop.html',webBase).href);
 const ready=()=>page.waitForFunction(()=>window.__WS__?.ready,{timeout:60000});
 await ready();
 assert.match(await page.title(),/KINESIS/);
 assert.equal(new URL(page.url()).pathname,'/workshop.html');
 assert.equal(await page.getByRole('heading',{name:'动作工作台',exact:true}).count(),1);
 assert.equal(await page.locator('vite-error-overlay').count(),0);
 // The workshop starts in review mode with both side panels collapsed (低密度
 // default) — every authoring control below lives behind those three states.
 // Restore them through the real toggles; after a reload the app resets, so
 // every reload site calls this again before touching panel content.
 const reopenPanels=async()=>{
  if(await page.getByTestId('mode-edit').getAttribute('aria-pressed')!=='true')await page.getByTestId('mode-edit').click();
  const sheetLeft=page.getByTestId('sheet-left');
  if(await sheetLeft.getAttribute('aria-expanded')!=='true')await sheetLeft.click();
 };
 await reopenPanels();
 const read=()=>page.evaluate(()=>{
  const e=window.__WS__,doc=e.getDoc();
  return {doc:JSON.parse(JSON.stringify(doc)),playing:e.playing,time:e.time,
   wrist:e.rig.point('wrist_L').toArray(),
   storage:JSON.parse(localStorage.getItem('kinesis-workshop-library'))};
 });
 const presets=await page.evaluate(async url=>{
  const {MOTION_FILES}=await import(url);
  return MOTION_FILES.map(p=>({id:p.id,name:p.name,kind:p.kind,category:p.category,capabilities:p.capabilities,document:p.document}));
 },`/@fs/${path.resolve(repoRoot,'packages/motion-core/src/motion-files.ts')}`);
 // Issue #30 PR-B: user motions lead the panel; the preset entry lives in a
 // collapsed fold below it and opens on demand.
 const presetFold=page.locator('[data-fold="preset"]');
 await presetFold.evaluate(el=>{el.open=true;});
 const select=page.getByRole('combobox',{name:'初始动作预设'});
 const startButton=page.getByRole('button',{name:'从预设开始',exact:true});
 const presetBox=await startButton.boundingBox(),firstMotionBox=await page.locator('.ws-lib-row').first().boundingBox();
 assert(presetBox&&firstMotionBox&&presetBox.y>firstMotionBox.y,
  'preset start fold must sit below the user motion list (user data first)');
 const presetIds=presets.filter(p=>p.kind==='workshop-motion'&&p.document);
 const expectedPresetIds=[
  ...presetIds.filter(p=>p.category==='basic'),
  ...presetIds.filter(p=>p.capabilities?.prop?.kind==='racket'),
  ...presetIds.filter(p=>p.category!=='basic'&&!p.capabilities?.prop),
 ].map(p=>p.id);
 assert.deepEqual(await select.locator('option').evaluateAll(opts=>opts.map(o=>o.value)),expectedPresetIds);
 const before=(await read()).doc;
 const preset=presets.find(p=>p.id==='forehand');
 await select.selectOption(preset.id);
 await page.getByRole('textbox',{name:'新动作名称',exact:true}).fill('QA 预设调整');
 await startButton.click();
 const created=await read();
 assert.notEqual(created.doc.id,preset.document.id);
 assert.equal(created.doc.name,'QA 预设调整');
 assert.equal(created.playing,false);assert.equal(created.time,0);
 assert.deepEqual({...created.doc,id:preset.document.id,name:preset.document.name,
  keys:created.doc.keys.map((k,i)=>({...k,id:preset.document.keys[i].id}))},preset.document);
 // The creation save is async — wait for it to reach storage, then compare a
 // FRESH read (the snapshot above was taken before the flush).
 await page.waitForFunction(id=>{
  const stored=JSON.parse(localStorage.getItem('kinesis-workshop-library')??'null');
  return stored?.docs?.length===2&&stored.docs.some(d=>d.id===id)&&stored.activeId===id;
 },created.doc.id,{timeout:5000});
 const createdStored=await read();
 assert.equal(createdStored.storage.docs.length,2);
 assert.deepEqual(createdStored.storage.docs.find(d=>d.id===before.id),before);
 assert.equal(createdStored.storage.activeId,created.doc.id);
 assert(created.doc.keys.every(k=>!preset.document.keys.some(s=>s.id===k.id)));
 assert.equal(await page.locator('.ws-key.sel').count(),1);
 await page.getByRole('button',{name:'撤销',exact:true}).click();
 assert.deepEqual((await read()).doc,before);
 await page.getByRole('button',{name:'重做',exact:true}).click();
 assert.equal((await read()).doc.id,created.doc.id);
 // The motion name and the per-key interpolation live on the 通用 tab.
 await page.getByTestId('adjustment-tab-common').click();
 const motionName=page.getByTestId('active-motion-name');
 await motionName.fill('重命名后的预设副本');
 assert.equal((await read()).doc.name,'重命名后的预设副本');
 await page.getByRole('button',{name:'撤销',exact:true}).click();
 assert.equal((await read()).doc.name,'QA 预设调整');
 await page.getByRole('button',{name:'重做',exact:true}).click();
 assert.equal((await read()).doc.name,'重命名后的预设副本');

 // Drag the visible LEFT wrist on the copied player motion (right hand has
 // a racket/tip handle). Screen coordinates come from the actual handle.
 await page.locator('.ws-cameras').getByRole('button',{name:'正面',exact:true}).click();
 await page.waitForFunction(()=>window.__WS__.view==='front');
 const targetBefore=(await read()).doc.keys[0].pose.handL.target;
 const spot=await page.evaluate(()=>{
  const e=window.__WS__,h=e.handles.find(h=>h.kind==='hand'&&h.side==='L');
  const p=h.mesh.position.clone().project(e.camera),r=e.renderer.domElement.getBoundingClientRect();
  return {x:r.left+(p.x+1)*r.width/2,y:r.top+(1-p.y)*r.height/2};
 });
 await page.mouse.move(spot.x,spot.y);await page.mouse.down();
 await page.mouse.move(spot.x+45,spot.y-35,{steps:10});await page.mouse.up();
 const edited=await read(),targetAfter=edited.doc.keys[0].pose.handL.target;
 assert(Math.hypot(targetAfter.x-targetBefore.x,targetAfter.y-targetBefore.y,targetAfter.z-targetBefore.z)>.005,'pointer drag did not adjust the preset copy');
 // The library persists asynchronously (throttled during the drag, flushed at
 // drag end), so wait for the dragged value to reach storage instead of racing
 // the save with an immediate read.
 await page.waitForFunction(([id,want])=>{
  const stored=JSON.parse(localStorage.getItem('kinesis-workshop-library')??'null');
  const t=stored?.docs?.find(d=>d.id===id)?.keys?.[0]?.pose?.handL?.target;
  return !!t&&Math.abs(t.x-want[0])<1e-12&&Math.abs(t.y-want[1])<1e-12&&Math.abs(t.z-want[2])<1e-12;
 },[edited.doc.id,[targetAfter.x,targetAfter.y,targetAfter.z]],{timeout:5000});
 await page.getByRole('button',{name:'撤销',exact:true}).click();
 assert.deepEqual((await read()).doc.keys[0].pose.handL.target,targetBefore);
 await page.getByRole('button',{name:'重做',exact:true}).click();
 assert.deepEqual((await read()).doc.keys[0].pose.handL.target,targetAfter);
 // The selected key owns the curve from its time to the next key. Change it
 // through the real select control and verify save, undo, redo, and reload.
 await page.waitForTimeout(600); // start a distinct history transaction from the pointer drag
 const interpolation=page.getByTestId('selected-key-interpolation');
 assert(await interpolation.isEnabled(),'interpolation selector should be enabled when in-betweens are on');
 await interpolation.selectOption('linear');
 assert.equal((await read()).doc.keys[0].interpolation,'linear');
 await page.getByRole('button',{name:'撤销',exact:true}).click();
 assert.equal((await read()).doc.keys[0].interpolation,undefined);
 await page.getByRole('button',{name:'重做',exact:true}).click();
 assert.equal((await read()).doc.keys[0].interpolation,'linear');
 await interpolation.scrollIntoViewIfNeeded();
 await page.screenshot({path:outputFile('segment-interpolation.png')});
 // Exercise the new coordinate controls through real keyboard input. Each
 // side's forearm/lower-leg target and elbow/knee pole must write its own key data.
 assert.equal(await page.getByTestId('limb-controls-L').count(),0,'common tab should not contain left-only controls');
 assert.equal(await page.getByTestId('limb-controls-R').count(),0,'common tab should not contain right-only controls');
 const limbEdits=[];
 let sideTabsAndScroll=false;
 for(const side of ['L','R'])for(const [kind,field,axis] of [
  ['arm','target','x'],['arm','pole','z'],['leg','target','x'],['leg','pole','z'],
 ]){
  await page.getByTestId(`adjustment-tab-${side==='L'?'left':'right'}`).click();
  const section=page.getByTestId(`limb-controls-${side}`);
  if(kind==='arm'&&field==='target'){
   const other=side==='L'?'R':'L';
   assert.equal(await page.getByTestId(`limb-controls-${other}`).count(),0,'only the selected side should be mounted');
   assert.equal(await page.getByText('躯干与骨盆',{exact:true}).count(),0,'common controls should stay on the common tab');
   const panel=await page.getByTestId(`adjustment-panel-${side==='L'?'left':'right'}`).evaluate(el=>({overflow:getComputedStyle(el).overflowY,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight}));
   assert.equal(panel.overflow,'auto');
   assert(panel.scrollHeight>panel.clientHeight,`side adjustment container should scroll: ${JSON.stringify(panel)}`);
   sideTabsAndScroll=true;
  }
  const testId=`limb-${side}-${kind}-${field}-${axis}`;
  const key=kind==='arm'?(side==='L'?'handL':'handR'):(side==='L'?'footL':'footR');
  const beforeValue=(await read()).doc.keys[0].pose[key][field][axis];
  const control=page.getByTestId(testId);
  await control.focus();await control.press('ArrowRight');
  const afterValue=(await read()).doc.keys[0].pose[key][field][axis];
  assert.notEqual(afterValue,beforeValue,`${testId} did not update the selected key`);
  limbEdits.push(testId);
 }
 await page.getByTestId('adjustment-tab-left').click();
 const limbControls=page.getByTestId('limb-controls-L');
 await limbControls.scrollIntoViewIfNeeded();
 await page.screenshot({path:outputFile('limb-controls.png')});
 const finalEdited=await read();
 // Creating the same preset again must stay independent of the edited copy.
 await startButton.click();
 const repeated=await read();
 assert.notEqual(repeated.doc.id,created.doc.id);
 assert.equal(repeated.doc.name,`${preset.name} 副本`);
 assert.deepEqual(repeated.doc.keys[0].pose.handL.target,targetBefore);
 // The creation save is async — wait for the third document to reach storage,
 // then assert on a fresh read.
 await page.waitForFunction(id=>{
  const stored=JSON.parse(localStorage.getItem('kinesis-workshop-library')??'null');
  return stored?.docs?.length===3&&stored.docs.some(d=>d.id===id);
 },repeated.doc.id,{timeout:5000});
 assert.equal((await read()).storage.docs.length,3);
 await page.getByRole('button',{name:'撤销',exact:true}).click();
 const saved=await read();
 assert.equal(saved.doc.id,edited.doc.id);
 assert.deepEqual(saved.doc,finalEdited.doc);
 await page.reload();await ready();
 await reopenPanels(); // reload resets review mode and collapses the panels
 // Playback/seek is allowed; no direct document or engine edit writes.
 await page.evaluate(()=>{window.__WS__.setPlaying(false);window.__WS__.seek(0);});
 const restored=await read();
 assert.equal(restored.doc.id,edited.doc.id);
 assert.deepEqual(restored.doc,saved.doc);
 assert.equal(restored.storage.quarantine.length,0);
 assertRestoredDoc(restored.storage.docs.find(d=>d.id===before.id),before);
 assertRestoredDoc(restored.doc,saved.doc);
 assert(restored.wrist.every((v,i)=>Math.abs(v-saved.wrist[i])<1e-9),'solved pose changed across reload');
 assert.deepEqual(await page.evaluate(async url=>{
  const {motionFileById}=await import(url);return motionFileById('forehand').document;
 },`/@fs/${path.resolve(repoRoot,'packages/motion-core/src/motion-files.ts')}`),preset.document);
 // The old initial selection was a hard-coded id absent from preset copies:
 // after reload the wrist sliders moved locally without writing any key.
 // Exercise every wrist axis AFTER reload, and inspect actual solved bones.
 const readArm=()=>page.evaluate(()=>{
  const r=window.__WS__.rig,b=r.bone('upperarm01_R');
  const shoulder=r.point('upperarm01_R'),elbow=r.point('lowerarm01_R'),wrist=r.point('wrist_R');
  return {elbow:elbow.toArray(),wrist:wrist.toArray(),
   elbowBody:elbow.clone().sub(shoulder).applyQuaternion(b.parent.getWorldQuaternion(b.quaternion.clone()).invert()).toArray(),
   quaternion:r.bone('wrist_R').getWorldQuaternion(b.quaternion.clone()).toArray()};
 });
 await page.getByTestId('adjustment-tab-common').click();
 await page.getByTestId('free-arms').check();
 assert.equal((await read()).doc.freeArms,true);
 await page.getByTestId('adjustment-tab-right').click();
 for(const axis of ['flex','dev','twist']){
  const beforeWrist=await readArm(),beforeHand=(await read()).doc.keys[0].pose.handR;
  await page.getByTestId(`wrist-R-${axis}`).press('PageUp');
  const afterWrist=await readArm(),afterRead=await read();
  assert.notDeepEqual(afterRead.doc.keys[0].pose.handR,beforeHand,`${axis} wrist slider did not write after reload`);
  const dot=Math.abs(afterWrist.quaternion.reduce((sum,v,i)=>sum+v*beforeWrist.quaternion[i],0));
  assert(dot<.999,`${axis} wrist slider did not rotate the rendered wrist`);
  assert.equal(afterRead.time,afterRead.doc.keys[0].time,'editing must preview the key actually written');
  assert.deepEqual(afterRead.storage.docs.find(d=>d.id===afterRead.doc.id).keys[0].pose.handR,afterRead.doc.keys[0].pose.handR);
 }
 await page.waitForTimeout(600); // one arm rotation = one history transaction
 const armBefore=await readArm(),docBeforeArm=(await read()).doc;
 // Absolute control: pressing End requests swing = +180° and the solved bone
 // must read back that value. The old assertion assumed delta semantics
 // (mirroring the elbow vector), which this control no longer has.
 const swingSlider=page.getByTestId('joint-R-upper-swing');
 await swingSlider.press('End');
 const armAfter=await readArm(),docAfterArm=(await read()).doc;
 assert.equal(Number(await swingSlider.inputValue()),180,'upper-arm slider did not hold the requested 180°');
 assert(Math.hypot(...armAfter.wrist.map((v,i)=>v-armBefore.wrist[i]))>.01,'upper arm rotation must carry the wrist');
 await page.getByRole('button',{name:'撤销',exact:true}).click();
 assertSameDoc((await read()).doc,docBeforeArm,'undo of an arm-joint rotation');
 await page.getByRole('button',{name:'重做',exact:true}).click();
 assertSameDoc((await read()).doc,docAfterArm,'redo of an arm-joint rotation');
 // The forearm panel is the elbow hinge: its slider must equal the solved elbow
 // angle, and changing it must leave the shoulder and elbow pivots in place.
 const flexion=page.getByTestId('joint-R-forearm-flexion');
 const elbowBefore=Number(await flexion.inputValue());
 await flexion.press('PageUp');
 const forearmAfter=await readArm(),elbowRead=Number(await flexion.inputValue());
 assert(Math.hypot(...forearmAfter.elbow.map((v,i)=>v-armAfter.elbow[i]))<2e-5,'elbow rotation moved the elbow pivot');
 assert(Math.hypot(...forearmAfter.wrist.map((v,i)=>v-armAfter.wrist[i]))>.001,'elbow rotation did not move the wrist');
 assert(elbowRead>elbowBefore,`elbow flex slider did not increase (${elbowBefore} → ${elbowRead})`);
 // The rotation sliders read the pose at the PLAYHEAD but write the SELECTED
 // key. Off the selected key the readout would describe a pose the drag does
 // not edit, so the controls must be disabled until the two are aligned — the
 // note's button is the only way back, never a silent edit at the wrong time.
 const onKey=await read(),nextTime=onKey.doc.keys.map(k=>k.time).filter(t=>t>onKey.time+1e-6).sort((a,b)=>a-b)[0];
 const offTime=nextTime===undefined?Math.max(0,onKey.time-.2):(onKey.time+nextTime)/2;
 assert(Math.abs(offTime-onKey.time)>1e-3,'could not pick an off-key preview instant');
 await page.evaluate(t=>{const e=window.__WS__;e.setPlaying(false);e.seek(t);},offTime);
 await page.waitForTimeout(120);
 const offKeyNote=page.getByTestId('rotation-preview-offkey');
 assert(await offKeyNote.isVisible(),'off-key preview note should be visible while the playhead is between keys');
 assert.equal(await swingSlider.isEnabled(),false,'upper-arm slider must be disabled while the playhead is off the selected key');
 assert.equal(await flexion.isEnabled(),false,'elbow slider must be disabled while the playhead is off the selected key');
 const offKeyDoc=(await read()).doc;
 const offKeyValue=await swingSlider.inputValue();
 const offKeyWrist=page.getByTestId('wrist-R-twist'),offKeyWristValue=await offKeyWrist.inputValue();
 await swingSlider.press('PageUp');
 await offKeyWrist.press('PageUp');
 assert.equal(await swingSlider.inputValue(),offKeyValue,'disabled upper-arm slider accepted keyboard input');
 assert.equal(await offKeyWrist.inputValue(),offKeyWristValue,'disabled wrist slider accepted keyboard input');
 assert.deepEqual((await read()).doc,offKeyDoc,'a disabled rotation slider still wrote the document');
 await offKeyNote.getByRole('button',{name:'跳到该关键帧'}).click();
 await page.waitForTimeout(120);
 assert.equal(await offKeyNote.count(),0,'jumping to the selected key should clear the off-key note');
 assert(await swingSlider.isEnabled(),'upper-arm slider should be enabled back on the selected key');
 assert.equal((await read()).time,onKey.time,'jump-to-key did not land on the selected key');
 const authored=(await read()).doc;
 await page.reload();await ready();
 await reopenPanels(); // reload resets review mode and collapses the panels
 assertRestoredDoc((await read()).doc,authored);
 await page.getByTestId('adjustment-tab-right').click();
 await page.getByTestId('joint-R-upper-swing').scrollIntoViewIfNeeded();
 await page.screenshot({path:outputFile('free-arm-authoring.png')});
 // The generator fold ships closed; open it the way a user does.
 await page.locator('[data-fold="generator"] summary').click();
 const beforeGeneration=await read();
 await page.getByTestId('generator-start').click();
 await page.waitForFunction(()=>window.__WS_GENERATOR__.locked());
 assert(await select.evaluate(el=>el.closest('[inert]')!==null),'preset controls remain interactive during generation');
 await assert.rejects(startButton.click({timeout:500}),{name:'TimeoutError'});
 await page.getByTestId('generator-cancel').click();
 await page.waitForFunction(()=>!window.__WS_GENERATOR__.locked());
 assert.deepEqual((await read()).storage,beforeGeneration.storage,'generation lock allowed a preset write');
 await select.scrollIntoViewIfNeeded();
 await page.screenshot({path:outputFile('desktop.png')});
 await page.setViewportSize({width:390,height:844});
 // Compact layout turns the library panel into a hidden bottom sheet; the
 // preset select only exists inside it, so open the sheet the way a user does.
 await page.getByTestId('sheet-left').click();
 await page.waitForFunction(()=>document.querySelector('.ws-shell')?.classList.contains('ws-sheet-left'));
 assert(await select.isVisible());
 await page.screenshot({path:outputFile('mobile.png')});
 assert.equal(await page.locator('vite-error-overlay').count(),0);
 assert.deepEqual(errors,[]);
 const result={url:page.url(),browser:await browser.version(),identity,
  checks:{presetList:true,copyParity:true,sourceUnchanged:true,creationUndoRedo:true,presetCopyRename:true,pointerEdit:true,editUndoRedo:true,segmentInterpolation:true,sideTabsAndScroll,limbCoordinateEdits:limbEdits,repeatedCopy:true,reloadSolvedPose:true,wristAxesAfterReload:true,upperArmBehindTorso:true,forearmPivot:true,armUndoRedo:true,freeArmReload:true,generationLock:true,consoleErrors:errors},warnings,
  screenshots:['segment-interpolation.png','limb-controls.png','free-arm-authoring.png','desktop.png','mobile.png']};
 atomicWriteFile(outputFile('result.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
