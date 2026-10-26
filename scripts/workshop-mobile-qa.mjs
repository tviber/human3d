import {chromium} from 'playwright';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {resolveOutputDir,assertTrackedWriteAllowed,atomicWriteFile,ensureOutputDir} from './lib/qa-output.mjs';
import {verifyWebIdentity} from './lib/worktree-check.mjs';

// Issue #23 acceptance through the real UI: phone review gestures never write
// the document, key stepping / timeline / camera presets work by touch, the
// semantic panel delivers a measured change with one undo step and survives
// reload, clamps are reported, review feedback exports, and the landscape /
// tablet / desktop layouts keep working. Engine access is READ-ONLY.
// Playwright mobile emulation is NOT a real-device result (see docs/QA.md).
//   node scripts/workshop-mobile-qa.mjs [--out-dir <dir>]
const repoRoot=process.cwd();
const output=resolveOutputDir('workshop-mobile',process.argv.slice(2),repoRoot,process.env);
if(output.args.length)throw new Error(`unexpected arguments: ${output.args.join(' ')}`);
ensureOutputDir(output.dir,{root:repoRoot,updateEvidence:output.updateEvidence});
const outputFile=name=>assertTrackedWriteAllowed(path.join(output.dir,name),{root:repoRoot,updateEvidence:output.updateEvidence});
const webBase=new URL(process.env.QA_WEB_URL??`http://127.0.0.1:${process.env.HUMAN3D_WEB_PORT??5173}/`);
const identity=await verifyWebIdentity(repoRoot,webBase);
assert(identity.ok,`dev server does not serve this checkout: ${identity.detail}`);
const url=new URL('/workshop.html',webBase).href;
// One context at a time, DPR 1: each context runs a full WebGL skin; stacking them exhausted a dev laptop.
const browser=await launchQaBrowser(chromium,{...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
const checks={},errors=[];
const watch=page=>{page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});};
const ready=page=>page.waitForFunction(()=>window.__WS__?.ready,{timeout:60000});
const read=page=>page.evaluate(()=>{
 const e=window.__WS__;
 return {doc:JSON.parse(JSON.stringify(e.getDoc())),time:e.time,playing:e.playing,view:e.view,cam:e.camera.position.toArray(),
  storage:localStorage.getItem('kinesis-workshop-library'),selected:document.querySelector('.ws-key.sel')?.getAttribute('aria-label')??''};
});
const elbowAngle=(page,side)=>page.evaluate(s=>{
 const r=window.__WS__.rig,a=r.point(`upperarm01_${s}`),b=r.point(`lowerarm01_${s}`),c=r.point(`wrist_${s}`);
 return 180-a.clone().sub(b).angleTo(c.clone().sub(b))*180/Math.PI;
},side);
// Same comparison as workshop-preset-qa: history/rehydrate re-normalise hand
// frames, which can move a direction by one ULP; every other field is exact.
function sameDoc(actual,expected,label){
 const a=structuredClone(actual);
 a.keys.forEach((key,i)=>{for(const hand of ['handL','handR'])for(const f of ['forward','normal'])for(const x of ['x','y','z']){
  const v=expected.keys[i].pose[hand][f][x];assert(Math.abs(key.pose[hand][f][x]-v)<1e-12,`${label}: ${hand}.${f}.${x}`);key.pose[hand][f][x]=v;}});
 assert.deepEqual(a,expected,label);
}
const noOverflow=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight+1);
try{
 /* ---------- phone portrait 390×844 ---------- */
 const phone=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true,permissions:['clipboard-read','clipboard-write']});
 const page=await phone.newPage();watch(page);
 await page.goto(url);await ready(page);await page.waitForTimeout(400);
 const cdp=await phone.newCDPSession(page);
 const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([x,y],id)=>({x,y,id}))});
 assert.equal(await page.locator('.ws-shell').getAttribute('data-mode'),'review');
 assert(await noOverflow(page),'390 px phone layout overflows');
 checks.phoneLayout=true;
 // Review: a one-finger drag starting ON the wrist handle orbits, never edits.
 await page.getByRole('button',{name:'正面',exact:true}).tap();
 const before=await read(page);
 const spot=await page.evaluate(()=>{const e=window.__WS__,r=e.renderer.domElement.getBoundingClientRect(),p=e.rig.point('wrist_L').project(e.camera);return [r.left+(p.x+1)*r.width/2,r.top+(1-p.y)*r.height/2];});
 await touch('touchStart',[spot]);for(let i=1;i<=8;i++)await touch('touchMove',[[spot[0]+i*8,spot[1]-i*5]]);await touch('touchEnd',[]);
 await touch('touchStart',[[150,350],[240,450]]);for(let i=1;i<=8;i++)await touch('touchMove',[[150-i*6,350-i*4],[240+i*6,450+i*8]]);await touch('touchEnd',[]);
 await page.waitForTimeout(300);
 const afterGesture=await read(page);
 assert.equal(afterGesture.storage,before.storage,'review gesture wrote the document');
 assert.notDeepEqual(afterGesture.cam,before.cam,'review gesture did not move the camera');
 checks.reviewGesturesReadOnly=true;
 await page.getByRole('button',{name:'侧面',exact:true}).tap();
 assert.equal((await read(page)).view,'side');
 await page.getByTestId('fit-view').tap();
 assert.equal((await read(page)).view,'threeQuarter');
 checks.cameraPresets=true;
 // Key stepping, play/pause, and a review-mode key drag that must not retime.
 await page.getByTestId('key-prev').tap();
 const k1=await read(page);
 assert(k1.doc.keys.some(k=>Math.abs(k.time-k1.time)<1e-9),'key-prev did not land on a key');
 await page.getByTestId('key-next').tap();
 const k2=await read(page);
 assert.notEqual(k2.selected,k1.selected,'key-next did not change the selected key');
 await page.getByRole('button',{name:'回到开头',exact:true}).tap();
 await page.getByRole('button',{name:'播放',exact:true}).tap();
 assert.equal((await read(page)).playing,true);
 await page.getByRole('button',{name:'暂停',exact:true}).tap();
 assert.equal((await read(page)).playing,false);
 const keyBox=await page.locator('.ws-key').nth(2).boundingBox();
 const kc=[keyBox.x+keyBox.width/2,keyBox.y+keyBox.height/2];
 await touch('touchStart',[kc]);for(let i=1;i<=6;i++)await touch('touchMove',[[kc[0]+i*6,kc[1]]]);await touch('touchEnd',[]);
 assert.equal((await read(page)).storage,before.storage,'review timeline drag retimed a key');
 checks.timelineTouch=true;
 await page.getByTestId('display-menu').tap();
 const onion=page.locator('.ws-optmenu .ws-check').filter({hasText:'洋葱皮'}).locator('input');
 await onion.check();assert(await onion.isChecked());
 await page.getByRole('button',{name:'关闭显示菜单'}).tap({position:{x:2,y:2}});
 assert.equal((await read(page)).storage,before.storage);
 checks.quickToggles=true;
 await page.screenshot({path:outputFile('phone-review.png')});

 // Semantic edit on the selected key through the real buttons.
 await page.getByTestId('sheet-right').tap();
 await page.getByTestId('unlock-edit').tap();
 assert.equal(await page.locator('.ws-shell').getAttribute('data-mode'),'edit');
 const base=await read(page),keyIndex=base.doc.keys.findIndex(k=>Math.abs(k.time-base.time)<1e-9);
 assert(keyIndex>=0,'playhead is not on the selected key');
 const rotationValues=prefix=>page.locator(`[data-testid^="${prefix}"]`).evaluateAll(inputs=>inputs.map(input=>Number(input.value)));
 await page.getByTestId('adjustment-tab-right').tap();
 const forearmBefore=await rotationValues('joint-R-forearm-');
 await page.getByTestId('adjustment-tab-semantic').tap();
 const angle0=await elbowAngle(page,'R');
 await page.getByTestId('semantic-part-elbow').tap();await page.getByTestId('semantic-side-R').tap();
 await page.getByTestId('semantic-plus').tap();await page.getByTestId('semantic-plus').tap();
 await page.getByTestId('semantic-minus').tap();await page.getByTestId('semantic-plus').tap(); // previews never stack
 assert.match(await page.getByTestId('semantic-report').innerText(),/请求 10\.0° · 实际 10\.0°/);
 await page.getByTestId('semantic-commit').tap();
 const edited=await read(page),angle1=await elbowAngle(page,'R');
 assert(Math.abs(angle1-angle0-10)<.5,`elbow changed ${angle1-angle0}°`);
 edited.doc.keys.forEach((k,i)=>{if(i!==keyIndex)assert.deepEqual(k,base.doc.keys[i],`key ${i} changed`);});
 await page.getByTestId('adjustment-tab-right').tap();
 const forearmAfter=await rotationValues('joint-R-forearm-'),wristAfterElbow=await rotationValues('wrist-R-');
 // The forearm panel is the elbow hinge only, so its single readout must
 // equal the solved elbow angle — not merely "differ from before".
 assert(Math.abs(forearmAfter[0]-angle1)<.3,`forearm slider read ${forearmAfter[0]}° but the solved elbow is ${angle1}°`);
 assert.notDeepEqual(forearmAfter,forearmBefore,'semantic elbow edit was not reflected in the forearm slider');
 await page.getByTestId('adjustment-tab-semantic').tap();
 await page.getByTestId('semantic-part-wrist').tap();await page.getByTestId('semantic-side-R').tap();
 await page.getByTestId('semantic-motion-flexion').tap();await page.getByTestId('semantic-plus').tap();
 assert.match(await page.getByTestId('semantic-report').innerText(),/掌屈：请求 5\.0°/);
 await page.getByTestId('semantic-commit').tap();
 const wristDoc=await read(page);
 assert.notDeepEqual(wristDoc.doc.keys[keyIndex].pose.handR.forward,edited.doc.keys[keyIndex].pose.handR.forward);
 await page.getByTestId('adjustment-tab-right').tap();
 const wristAfter=await rotationValues('wrist-R-');
 assert.notDeepEqual(wristAfter,wristAfterElbow,'semantic wrist edit was not reflected in parent-relative wrist sliders');
 // Drag each upper-arm slider through the real control and require the SOLVED
 // shoulder→upper-arm rotation to be the YXZ triple the three sliders show.
 // Plain quaternion math in the page (no THREE import needed): the sliders must
 // describe the bone, not a local component state.
 for(const [channel,target]of [['lift',40],['swing',55],['twist',-45]]){
  const slider=page.getByTestId(`joint-R-upper-${channel}`);
  await slider.fill(String(target));
  await page.waitForTimeout(120);
  const shown=await page.locator('[data-testid^="joint-R-upper-"]').evaluateAll(inputs=>inputs.map(input=>Number(input.value)));
  assert(Math.abs(Number(await slider.inputValue())-target)<.2,`${channel} slider did not hold ${target}°`);
  const errorDeg=await page.evaluate(([lift,swing,twist])=>{
   const r=window.__WS__.rig,q=()=>r.bone('upperarm01_R').quaternion.clone();
   const shoulder=r.bone('shoulder01_R').getWorldQuaternion(q()),upper=r.bone('upperarm01_R').getWorldQuaternion(q());
   // relative = inverse(shoulder) * upper
   const [sx,sy,sz,sw]=[-shoulder.x,-shoulder.y,-shoulder.z,shoulder.w];
   const [ax,ay,az,aw]=[upper.x,upper.y,upper.z,upper.w];
   const rel=[sw*ax+sx*aw+sy*az-sz*ay,sw*ay-sx*az+sy*aw+sz*ax,sw*az+sx*ay-sy*ax+sz*aw,sw*aw-sx*ax-sy*ay-sz*az];
   // YXZ: R = Ry(y)·Rx(x)·Rz(z)
   const mul=([ax,ay,az,aw],[bx,by,bz,bw])=>[aw*bx+ax*bw+ay*bz-az*by,aw*by-ax*bz+ay*bw+az*bx,aw*bz+ax*by-ay*bx+az*bw,aw*bw-ax*bx-ay*by-az*bz];
   const half=d=>d*Math.PI/360;
   const [hx,hy,hz]=[half(lift),half(swing),half(twist)];
   const want=mul(mul([0,Math.sin(hy),0,Math.cos(hy)],[Math.sin(hx),0,0,Math.cos(hx)]),[0,0,Math.sin(hz),Math.cos(hz)]);
   const dot=Math.abs(want[0]*rel[0]+want[1]*rel[1]+want[2]*rel[2]+want[3]*rel[3]);
   return 2*Math.acos(Math.min(1,dot))*180/Math.PI;
  },shown);
  assert(errorDeg<.3,`upper-arm sliders ${JSON.stringify(shown)} describe the bone with ${errorDeg.toFixed(2)}° error`);
 }
 checks.rotationRoundTrip=true;
 await page.getByTestId('adjustment-tab-semantic').tap();
 checks.semanticArmAndWrist=true;
 // Thigh forward on a planted key: only the hip moves — knee and ankle angles hold.
 const legAngles=()=>page.evaluate(()=>{const r=window.__WS__.rig,ang=(a,b,c)=>{const p=r.point(a),q=r.point(b),w=r.point(c);return 180-p.clone().sub(q).angleTo(w.clone().sub(q))*180/Math.PI;};
  return {knee:ang('upperleg01_R','lowerleg01_R','foot_R'),thigh:r.point('lowerleg01_R').sub(r.point('root')).toArray()};});
 const leg0=await legAngles();
 await page.getByTestId('semantic-part-hip').tap();await page.getByTestId('semantic-side-R').tap();
 await page.getByTestId('semantic-motion-flexion').tap();
 await page.getByRole('button',{name:'15°',exact:true}).tap();await page.getByTestId('semantic-plus').tap();
 assert.match(await page.getByTestId('semantic-report').innerText(),/向前（屈髋）：请求 15\.0° · 实际 15\.0°/);
 const leg1=await legAngles();
 assert(Math.abs(leg1.knee-leg0.knee)<.6,`thigh forward bent the knee by ${leg1.knee-leg0.knee}°`);
 assert(leg1.thigh[2]-leg0.thigh[2]>.08,'the thigh itself did not swing forward');
 await page.getByTestId('semantic-cancel').tap();
 sameDoc((await read(page)).doc,wristDoc.doc,'cancelled thigh edit changed the document');
 checks.thighForwardKeepsKnee=true;
 // 落地: lift with a small thigh move, confirm, then ground it — one undo step each.
 await page.getByRole('button',{name:'5°',exact:true}).tap();
 await page.getByTestId('semantic-part-hip').tap();await page.getByTestId('semantic-side-R').tap();
 await page.getByTestId('semantic-motion-flexion').tap();await page.getByTestId('semantic-plus').tap();
 await page.getByTestId('semantic-commit').tap();
 const soleR=()=>page.evaluate(()=>{const r=window.__WS__.rig;let low=Infinity;for(const [n] of r.bones)if(n==='foot_R'||(n.startsWith('toe')&&n.endsWith('_R')))low=Math.min(low,r.point(n).y);
  let rest=Infinity;for(const [n,v] of r.rest)if(n==='foot_R'||(n.startsWith('toe')&&n.endsWith('_R')))rest=Math.min(rest,v.y);return (low-rest)*1000;});
 const liftedDoc=(await read(page)).doc;
 assert(Math.abs(await soleR())>3,'the thigh edit did not move the foot off the floor');
 await page.getByTestId('semantic-ground').tap();
 const groundText=await page.getByTestId('semantic-ground-result').innerText();
 assert.match(groundText,/右脚落到地面/,groundText);
 assert(Math.abs(await soleR())<2,`sole still ${await soleR()} mm from the floor`);
 await page.getByRole('button',{name:'关闭面板',exact:true}).last().tap();
 await page.getByRole('button',{name:'撤销',exact:true}).tap();
 sameDoc((await read(page)).doc,liftedDoc,'undo of 落地 is not one step');
 await page.getByRole('button',{name:'撤销',exact:true}).tap();
 sameDoc((await read(page)).doc,wristDoc.doc,'undo of the thigh edit');
 await page.getByTestId('sheet-right').tap();
 checks.groundButton=true;
 // Both thighs apart: angle readback, no side selector.
 await page.getByRole('button',{name:'5°',exact:true}).tap();
 await page.getByTestId('semantic-part-legs').tap();
 assert.equal(await page.getByTestId('semantic-side-R').count(),0,'双腿 must not show a side selector');
 await page.getByTestId('semantic-plus').tap();
 assert.match(await page.getByTestId('semantic-report').innerText(),/分开：请求 5\.0° · 实际 5\.0°/);
 await page.getByTestId('semantic-cancel').tap();
 sameDoc((await read(page)).doc,wristDoc.doc,'cancelled spread changed the document');
 checks.legsSpread=true;
 const undo=page.getByRole('button',{name:'撤销',exact:true}),redo=page.getByRole('button',{name:'重做',exact:true});
 await page.getByRole('button',{name:'关闭面板',exact:true}).last().tap();
 await undo.tap();sameDoc((await read(page)).doc,edited.doc,'first undo is not the wrist step');
 await undo.tap();sameDoc((await read(page)).doc,base.doc,'second undo is not the elbow step');
 await redo.tap();await redo.tap();
 sameDoc((await read(page)).doc,wristDoc.doc,'redo');
 await page.reload();await ready(page);
 sameDoc((await read(page)).doc,wristDoc.doc,'reload changed the document');
 const keyLabel=wristDoc.doc.keys[keyIndex].label;
 await page.locator('.ws-track-labels button').filter({hasText:keyLabel}).first().tap();
 assert(Math.abs(await elbowAngle(page,'R')-angle1)<.05,'reload changed the solved elbow');
 checks.undoRedoReload=true;
 // Clamp honesty: request +90° flexion, beyond the 145° limit.
 await page.getByTestId('mode-edit').tap();
 await page.getByTestId('semantic-part-elbow').tap();await page.getByTestId('semantic-side-R').tap();
 await page.getByRole('button',{name:'15°',exact:true}).tap();
 // +15° steps until the 145° flexion cap: the panel must report the clamp, not success.
 for(let i=0;i<12&&!(await page.getByTestId('semantic-reason').count());i++)await page.getByTestId('semantic-plus').tap();
 assert.match(await page.getByTestId('semantic-report').innerText(),/未完全执行：肘屈曲上限 145°/);
 await page.getByTestId('semantic-cancel').tap();
 sameDoc((await read(page)).doc,wristDoc.doc,'cancel did not restore the base');
 checks.clampReported=true;
 await page.screenshot({path:outputFile('phone-semantic.png')});
 await page.locator('[data-fold=inspect] summary').tap();
 await page.getByTestId('note-issue').selectOption('手臂穿身');
 await page.getByTestId('note-text').fill('右肘贴进躯干');
 await page.getByTestId('note-add').tap();
 await page.getByTestId('note-copy').tap();
 const feedback=JSON.parse(await page.evaluate(()=>navigator.clipboard.readText()));
 assert.equal(feedback.kind,'h3d-review-feedback');assert.equal(feedback.notes[0].issue,'手臂穿身');assert.equal(feedback.notes[0].keyLabel,keyLabel);
 sameDoc((await read(page)).doc,wristDoc.doc,'review notes touched the document');
 checks.reviewFeedback=true;
 await phone.close();

 /* ---------- other sizes ---------- */
 const sizes=[[375,667],[844,390],[768,1024],[1024,768]];
 for(const [width,height] of sizes){
  const ctx=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,isMobile:true,hasTouch:true});
  const p=await ctx.newPage();watch(p);await p.goto(url);await ready(p);
  assert(await noOverflow(p),`${width}×${height} overflows`);
  await p.screenshot({path:outputFile(`layout-${width}x${height}.png`)});
  await ctx.close();
 }
 checks.layouts=sizes.map(([w,h])=>`${w}x${h}`);
 /* ---------- desktop regression ---------- */
 const deskCtx=await browser.newContext({viewport:{width:1536,height:1024},deviceScaleFactor:1});const desk=await deskCtx.newPage();watch(desk);
 await desk.goto(url);await ready(desk);
 assert.equal(await desk.locator('.ws-shell').getAttribute('data-mode'),'review');
 await desk.getByTestId('sheet-left').click();await desk.locator('[data-fold=preset] summary').click();
 assert(await desk.getByRole('combobox',{name:'初始动作预设'}).isVisible());
 await desk.getByTestId('mode-edit').click();
 await desk.getByTestId('adjustment-tab-semantic').click();
 assert(await desk.getByTestId('semantic-panel').isVisible());
 await desk.getByTestId('adjustment-tab-left').click();
 assert(await desk.getByTestId('wrist-L-flex').isVisible());
 checks.desktopPanels=true;
 await desk.screenshot({path:outputFile('desktop.png')});await deskCtx.close();
 assert.deepEqual(errors,[]);
 const result={url,browser:await browser.version(),identity,emulation:'playwright isMobile/hasTouch — not a real device',checks};
 atomicWriteFile(outputFile('result.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
