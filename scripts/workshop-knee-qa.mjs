import {chromium} from 'playwright';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {resolveOutputDir,assertTrackedWriteAllowed,atomicWriteFile,ensureOutputDir} from './lib/qa-output.mjs';
import {verifyWebIdentity} from './lib/worktree-check.mjs';

// Knee-angle handle drags, double-support balance drags, the per-key racket
// toggle, and removal of raw knee-pole editing through the REAL workshop UI.
// Everything is driven by visible controls and real pointer events — 新建,
// preset selection, the constraint checkboxes, quick-action buttons, undo —
// never by calling engine setters, so the shipped write path is what gets
// tested. Reads of window.__WS__ only observe scene/rig state after a control
// drove it.
//
//   npm run dev &   (then)   sh scripts/check-process-limit.sh && node scripts/workshop-knee-qa.mjs
const coreModule=p=>`/@fs/${path.resolve('packages/motion-core/src',p)}`;
const repoRoot=process.cwd();
const output=resolveOutputDir('workshop-knee',process.argv.slice(2),repoRoot,process.env);
if(output.args.length)throw new Error(`unexpected knee QA arguments: ${output.args.join(' ')}`);
ensureOutputDir(output.dir,{root:repoRoot,updateEvidence:output.updateEvidence});
const outFile=name=>assertTrackedWriteAllowed(path.join(output.dir,name),{root:repoRoot,updateEvidence:output.updateEvidence});
const webBase=new URL(process.env.QA_WEB_URL??`http://127.0.0.1:${process.env.HUMAN3D_WEB_PORT??5173}/`);
const identity=await verifyWebIdentity(repoRoot,webBase);
if(process.env.QA_WEB_URL===undefined&&!identity.ok)
 throw new Error(`dev server at ${webBase.origin} does not serve this checkout (${identity.detail})`);

const browser=await launchQaBrowser(chromium,{...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
const checks=[];
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(`${ok?'✓':'✗'} ${name}${detail?` — ${detail}`:''}`);};
try{
 const page=await browser.newPage({viewport:{width:1536,height:1024},deviceScaleFactor:1});
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(new URL('/workshop.html',webBase).href);
 await page.waitForFunction(()=>window.__WS__?.ready,{timeout:60000});
 const panel=async(side)=>{
  const button=page.getByTestId(`sheet-${side}`);
  if(await button.getAttribute('aria-expanded')!=='true')await button.click();
  await page.locator(side==='left'?'.ws-left':'.ws-right').waitFor({state:'visible'});
 };
 const openFold=async(selector)=>{const fold=page.locator(selector);if(!(await fold.evaluate(el=>el.open)))await fold.locator('summary').click();};
 // Review mode is the default; viewport writes need Edit mode.
 await page.getByTestId('mode-edit').click();
 await page.evaluate(()=>window.__WS__.setPlaying(false));

 // ---- setup: a fresh two-key document through the real 新建 button
 await panel('left');
 await page.locator('.ws-newname').fill('QA 膝盖与持拍');
 await page.getByRole('button',{name:'新建',exact:true}).click();
 await page.waitForFunction(()=>window.__WS__.getDoc().name==='QA 膝盖与持拍',null,{timeout:10000});
 await page.evaluate(()=>{const e=window.__WS__;e.setPlaying(false);e.seek(0);e.solveCurrent();});

 // ---- 0. toe/heel pitch through the real foot slider and solve path
 await page.locator('.ws-key').first().click();
 await page.getByTestId('adjustment-tab-left').click();
 const footPitch=page.locator('.ws-slider').filter({hasText:'左脚俯仰'}).locator('input');
 const footPitchState=()=>page.evaluate(async url=>{
  const e=window.__WS__,k=[...e.getDoc().keys].sort((a,b)=>a.time-b.time)[0];
  const {footLift}=await import(url),geo=e.footGeometry('L');
  e.setPlaying(false);e.seek(k.time);e.solveCurrent();
  return {pitch:k.pose.footL.pitch,lift:footLift(geo,k.pose.footL.target.y,k.pose.footL.yaw,k.pose.footL.pitch),
   rootY:e.rig.bone('root').position.y};
 },coreModule('foot.ts'));
 const pitchBase=await footPitchState();
 const movePitch=async(direction,count)=>{for(let i=0;i<count;i++)await footPitch.press(direction);};
 await movePitch('ArrowRight',12);
 await page.waitForTimeout(100);
 const toeState=await footPitchState();
 check('脚俯仰滑块写入支撑帧并保持脚底高度',toeState.pitch===12&&Math.abs(toeState.lift)<.001,
  `pitch=${toeState.pitch}°, lift=${(toeState.lift*1000).toFixed(1)}mm`);
 check('踮脚通过真实求解抬高身体约 25mm',toeState.rootY-pitchBase.rootY>.024&&toeState.rootY-pitchBase.rootY<=.025001,
  `ΔrootY=${((toeState.rootY-pitchBase.rootY)*1000).toFixed(1)}mm`);
 await movePitch('ArrowLeft',24);
 await page.waitForTimeout(100);
 const heelState=await footPitchState();
 check('后跟支撑保持脚底高度且不改变身体高度',heelState.pitch===-12&&Math.abs(heelState.lift)<.001&&
  Math.abs(heelState.rootY-pitchBase.rootY)<1e-6,
  `pitch=${heelState.pitch}°, lift=${(heelState.lift*1000).toFixed(1)}mm, ΔrootY=${((heelState.rootY-pitchBase.rootY)*1000).toFixed(2)}mm`);
 await movePitch('ArrowRight',12);
 await page.waitForTimeout(100);
 check('脚俯仰回到平放时身体恢复原高度',Math.abs((await footPitchState()).rootY-pitchBase.rootY)<1e-6);
 const durationInput=page.getByRole('spinbutton',{name:'动作总时长（秒）'});
 await durationInput.fill('0.2');await durationInput.press('Enter');await page.waitForTimeout(100);
 await openFold('[data-fold="keys"]');
 await page.getByTestId('keyframe-insert-after').click();
 await page.waitForFunction(()=>window.__WS__?.getDoc().keys.length===3,{timeout:10000});

 const kneeSpot=(side='L')=>page.evaluate(side=>{
  const e=window.__WS__,h=e.handles.find(x=>x.kind==='knee'&&x.side===side);
  const p=h.mesh.position.clone().project(e.camera),r=e.renderer.domElement.getBoundingClientRect();
  return {x:r.left+(p.x+1)/2*r.width,y:r.top+(1-p.y)/2*r.height,visible:h.mesh.visible===true,
   atJoint:h.mesh.position.distanceTo(e.rig.point(`lowerleg01_${side}`))};
 },side);
 const keyState=()=>page.evaluate(async url=>{
  const {measureSemantic}=await import(url);
  const e=window.__WS__,ks=[...e.getDoc().keys].sort((a,b)=>a.time-b.time);
  const u=e.rig.point('upperleg01_L').sub(e.rig.point('lowerleg01_L'));
  const w=e.rig.point('foot_L').sub(e.rig.point('lowerleg01_L'));
  const internal=Math.acos(Math.max(-1,Math.min(1,u.dot(w)/(u.length()*w.length()))))*180/Math.PI;
  return {grips:ks.map(k=>k.constraints.grip===true),
   keys:ks.map(k=>({id:k.id,time:k.time,pole:{...k.pose.footL.pole},target:{...k.pose.footL.target},yaw:k.pose.footL.yaw,pitch:k.pose.footL.pitch})),
   kneeFlex:180-internal,ankleFlex:measureSemantic(e.rig,'ankle','flexion','L'),
   hip:e.rig.point('upperleg01_L').toArray(),knee:e.rig.point('lowerleg01_L').toArray(),ankle:e.rig.point('foot_L').toArray()};
 },coreModule('semantic-edit.ts'));

 // ---- 1. knee handles ride the solved joints; raw pole editing is absent
 const spot0=await kneeSpot();
 check('膝盖拖点显示且贴在左膝关节上',spot0.visible&&spot0.atJoint<1e-6,`dist=${spot0.atJoint.toFixed(4)}`);
 await page.getByTestId('adjustment-tab-left').click();
 check('膝极点手柄和膝部 XYZ 输入已移除',!(await page.evaluate(()=>window.__WS__.handles.some(h=>h.kind==='poleLeg')))&&
  await page.getByTestId('limb-L-leg-pole-x').count()===0&&await page.getByTestId('limb-L-leg-pole-y').count()===0&&await page.getByTestId('limb-L-leg-pole-z').count()===0);

 // ---- 2. a planted knee uses the angle slider and the same one-axis drag path
 const sliderBase=await keyState();
 await page.getByTestId('adjustment-tab-semantic').click();
 await page.getByTestId('semantic-part-knee').click();
 await page.getByTestId('semantic-side-L').click();
 const kneeSlider=page.getByTestId('semantic-knee-angle');
 await page.waitForTimeout(100);
 const startingSliderAngle=Math.round(Number(await kneeSlider.inputValue()));
 const requestedBendTarget=Math.min(120,Math.max(100,startingSliderAngle+50));
 const sliderBox=await kneeSlider.boundingBox();
 const thumbWidth=await kneeSlider.evaluate(el=>{const value=Number.parseFloat(getComputedStyle(el,'::-webkit-slider-thumb').width);return Number.isFinite(value)?value:16;});
 if(!sliderBox)throw new Error('knee angle slider is not visible');
 await page.mouse.click(sliderBox.x+thumbWidth/2+(sliderBox.width-thumbWidth)*requestedBendTarget/135,sliderBox.y+sliderBox.height/2);
 await page.waitForTimeout(150);
 const bendTarget=Math.round(Number(await kneeSlider.inputValue()));
 const bent0=await keyState();
 check('支撑脚锁定时语义滑块可增加膝屈曲',bent0.kneeFlex>=bendTarget-1&&bent0.kneeFlex>startingSliderAngle+10,
  `${startingSliderAngle}°→${bent0.kneeFlex.toFixed(1)}°（目标 ${bendTarget}°）`);
 const scheduleFitEvidence=await page.evaluate(async({documentUrl,solverUrl})=>{
  const e=window.__WS__,d=e.getDoc(),key=[...d.keys].sort((a,b)=>a.time-b.time)[1];
  const scheduled=e.pelvisShiftAt(key.time),{compileMotion,frameAtCompiled}=await import(documentUrl),{solveEffectiveFrame}=await import(solverUrl);
  const natural=solveEffectiveFrame(e.rig,frameAtCompiled(compileMotion(d,e.restRoot()),key.time)).pelvisShift;
  e.setPlaying(false);e.seek(key.time);e.solveCurrent();
  return {time:key.time,scheduled,natural,delta:scheduled===undefined?0:Math.abs(scheduled-natural)};
 },{documentUrl:coreModule('document.ts'),solverUrl:coreModule('solver.ts')});
 check('支撑膝角验收使用非透传骨盆排程',scheduleFitEvidence.scheduled!==undefined,JSON.stringify(scheduleFitEvidence));
 check('该中间帧排程修正与自然修正相差超过 1mm',scheduleFitEvidence.delta>.001,JSON.stringify(scheduleFitEvidence));
 check('语义调膝保持脚目标与朝向',JSON.stringify(bent0.keys[1].target)===JSON.stringify(sliderBase.keys[1].target)&&
   bent0.keys[1].yaw===sliderBase.keys[1].yaw&&bent0.keys[1].pitch===sliderBase.keys[1].pitch);
 check('语义调膝保持脚踝世界位置',Math.hypot(bent0.ankle[0]-sliderBase.ankle[0],bent0.ankle[1]-sliderBase.ankle[1],bent0.ankle[2]-sliderBase.ankle[2])<.001);
 await page.getByTestId('semantic-commit').click();
 await page.waitForTimeout(150);
 await page.evaluate(()=>{const e=window.__WS__;e.setPlaying(false);e.solveCurrent();});
 const planted0=await keyState();
 const bentSpot=await kneeSpot();
 await page.mouse.move(bentSpot.x,bentSpot.y);await page.mouse.down();
 await page.mouse.move(bentSpot.x,bentSpot.y-50,{steps:8});await page.mouse.up();
 await page.waitForTimeout(150);
 const planted1=await keyState();
 const moved3=(a,b)=>Math.hypot(...['x','y','z'].map((axis,i)=>(a[axis]??a[i])-(b[axis]??b[i])));
 check('向上拖动支撑膝球会增加膝屈曲',planted1.kneeFlex>planted0.kneeFlex+10,
  `${planted0.kneeFlex.toFixed(1)}°→${planted1.kneeFlex.toFixed(1)}°`);
 check('角度拖动支撑膝球保持脚目标与朝向',JSON.stringify(planted1.keys[1].target)===JSON.stringify(planted0.keys[1].target)&&
   planted1.keys[1].yaw===planted0.keys[1].yaw&&planted1.keys[1].pitch===planted0.keys[1].pitch);
 check('角度拖动支撑膝球保持脚踝世界位置',moved3(planted1.ankle,planted0.ankle)<.001,
  `Δankle=${(moved3(planted1.ankle,planted0.ankle)*1000).toFixed(2)}mm`);

 // ---- 3. free leg: unplant both keys and verify a drag changes only knee flexion
 const keyCount=await page.locator('.ws-key').count();
 for(let i=0;i<keyCount;i++){
  await page.locator('.ws-key').nth(i).click();
  await page.getByTestId('adjustment-tab-left').click();
  const box=page.locator('.ws-check').filter({hasText:'左脚支撑锁定'}).locator('input');
  if(await box.isChecked())await box.uncheck();
 }
 await page.evaluate(()=>{const e=window.__WS__;e.setPlaying(false);e.seek(0);e.solveCurrent();});
 const free0=await keyState();
 const spot1=await kneeSpot();
 await page.mouse.move(spot1.x,spot1.y);await page.mouse.down();
 await page.mouse.move(spot1.x-50,spot1.y-60,{steps:8});await page.mouse.up();
 await page.waitForTimeout(150);
 const free1=await keyState();
 check('离地膝球向上拖动也只增加屈曲角',free1.kneeFlex>free0.kneeFlex+10,
  `${free0.kneeFlex.toFixed(1)}°→${free1.kneeFlex.toFixed(1)}°`);
 check('离地膝铰链拖动保持踝屈伸角',Math.abs(free1.ankleFlex-free0.ankleFlex)<.5,
  `${free0.ankleFlex.toFixed(1)}°→${free1.ankleFlex.toFixed(1)}°`);

 // ---- 4. 本帧持拍/本帧放下 toggles the selected key only; one undo restores
 await page.locator('.ws-key').nth(0).click();
 await page.getByTestId('racket-key').click();
 await page.waitForTimeout(150);
 let st=await keyState();
 const noGrip=Array.from({length:keyCount},()=>false),onlyFirstGrip=noGrip.map((_,i)=>i===0);
 check('本帧持拍只写选中关键帧',JSON.stringify(st.grips)===JSON.stringify(onlyFirstGrip),JSON.stringify(st.grips));
 check('握拍后按钮改为「本帧放下」',/本帧放下/.test(await page.getByTestId('racket-key').textContent()));
 await page.getByTestId('racket-key').click();
 await page.waitForTimeout(150);
 st=await keyState();
 check('本帧放下恢复该帧空手',JSON.stringify(st.grips)===JSON.stringify(noGrip),JSON.stringify(st.grips));
 // Toggle on once more, then undo: one step must revert the flag without
 // swallowing the earlier free-leg drag write.
 await page.getByTestId('racket-key').click();
 await page.waitForTimeout(150);
 await page.getByRole('button',{name:'撤销',exact:true}).click();
 await page.waitForTimeout(200);
 st=await keyState();
 check('一次撤销整步还原持拍切换',JSON.stringify(st.grips)===JSON.stringify(noGrip),JSON.stringify(st.grips));
 check('撤销不吞并此前的膝盖拖拽写入',JSON.stringify(st.keys[0].target)===JSON.stringify(free1.target));

 // ---- 5. finish-frame bilateral knee drags lower the body and rebalance
 // from the bundled forehand through the visible preset-copy flow. The test
 // uses the same solved rig to identify which knee is forward/back, then
 // drags those visible knee handles with actual pointer events.
 await openFold('[data-fold="preset"]');
 await page.getByLabel('初始动作预设').selectOption('forehand');
 await page.getByLabel('新动作名称').fill('QA 收拍膝盖联动');
 await page.locator('.ws-preset-start').click();
 await page.waitForFunction(()=>window.__WS__?.getDoc().name==='QA 收拍膝盖联动',null,{timeout:10000});
 const finishIndex=await page.evaluate(()=>[...window.__WS__.getDoc().keys].sort((a,b)=>a.time-b.time).findIndex(k=>Math.abs(k.time-5.2)<.001));
 if(finishIndex<0)throw new Error('forehand preset copy is missing its 5.2s finish frame');
 await page.locator('.ws-key').nth(finishIndex).click();
 await page.getByTestId('adjustment-tab-semantic').click();
 const balanceState=()=>page.evaluate(async({semanticUrl,documentUrl,solverUrl})=>{
  const [{kneeBalanceSides,measureSemantic},{compileMotion,frameAtCompiled},{analyzePose}]=await Promise.all([
   import(semanticUrl),import(documentUrl),import(solverUrl)]);
  const e=window.__WS__,doc=e.getDoc(),keys=[...doc.keys].sort((a,b)=>a.time-b.time),key=keys.at(-1);
  const compiled=compileMotion(doc,e.restRoot()),frame=frameAtCompiled(compiled,e.time);
  const analysis=analyzePose(e.rig,frame.pose,frame.constraints,e.racket);
  const balancePose=structuredClone(key.pose);balancePose.root.y=0;balancePose.lean=0;
  const vec=v=>[v.x,v.y,v.z],targetResidual=(side)=>{
   const actual=e.rig.point(`wrist_${side}`),target=frame.pose[`hand${side}`].target;
   return Math.hypot(actual.x-target.x,actual.y-target.y,actual.z-target.z);
  };
  return {time:e.time,plants:{L:key.constraints.plantL,R:key.constraints.plantR},grip:frame.constraints.grip===true,
   racketPresent:!!e.racket,sides:kneeBalanceSides(e.rig,frame,key.constraints),
   rootY:e.rig.point('root').y,comY:analysis.com.y,lean:frame.pose.lean,racketTip:vec(analysis.racketTip),
   otherPoseChannels:balancePose,
   feet:{L:vec(e.rig.point('foot_L')),R:vec(e.rig.point('foot_R'))},
   targets:{L:targetResidual('L'),R:targetResidual('R')},
   kneeFlex:{L:measureSemantic(e.rig,'knee','flexion','L'),R:measureSemantic(e.rig,'knee','flexion','R')},
   supportSlip:Object.fromEntries(analysis.items.filter(x=>x.code.startsWith('support-slip-')).map(x=>[x.code,x.value]))};
 },{semanticUrl:coreModule('semantic-edit.ts'),documentUrl:coreModule('document.ts'),solverUrl:coreModule('solver.ts')});
 const dragKneeDown=async(side,pixels=80)=>{
  const spot=await kneeSpot(side);
  if(!spot.visible||spot.atJoint>.002)throw new Error(`${side} knee handle is unavailable or detached`);
  // Grab just outside the tiny 2 cm sphere to cover the mouse hit margin,
  // then drag by real pointer events like an imprecise everyday interaction.
  const grabX=spot.x+14;
  await page.mouse.move(grabX,spot.y);await page.mouse.down();
  await page.mouse.move(grabX,spot.y+pixels,{steps:8});await page.mouse.up();
  await page.waitForTimeout(150);
 };
 const stance0=await balanceState();
 check('正手收拍末帧左右脚均锁定支撑',stance0.time===5.2&&stance0.plants.L===true&&stance0.plants.R===true,
  `t=${stance0.time}, plantL=${stance0.plants.L}, plantR=${stance0.plants.R}`);
 check('收拍握拍目标仍挂接球拍',stance0.grip&&stance0.racketPresent,`grip=${stance0.grip}, racket=${stance0.racketPresent}`);
 check('按身体前后方向识别收拍的后膝与前膝',stance0.sides?.back==='R'&&stance0.sides?.front==='L',JSON.stringify(stance0.sides));
 if(!stance0.sides)throw new Error('forehand finish does not qualify for the double-support balance gesture');
 await dragKneeDown(stance0.sides.back);
 const backKneeDown=await balanceState();
 const drift3=(a,b)=>Math.hypot(...['x','y','z'].map((axis,i)=>(a[axis]??a[i])-(b[axis]??b[i])));
 check('下拖后膝降低骨盆与整体重心并带动躯干后倾',backKneeDown.rootY<stance0.rootY-.005&&
  backKneeDown.comY<stance0.comY-.003&&backKneeDown.lean<stance0.lean-2,
  `rootY ${stance0.rootY.toFixed(3)}→${backKneeDown.rootY.toFixed(3)}, COM ${stance0.comY.toFixed(3)}→${backKneeDown.comY.toFixed(3)}, lean ${stance0.lean.toFixed(1)}°→${backKneeDown.lean.toFixed(1)}°`);
 check('后膝下拖保持双脚锚点、支撑状态和手部目标',
  backKneeDown.plants.L===true&&backKneeDown.plants.R===true&&
  drift3(backKneeDown.feet.L,stance0.feet.L)<.001&&drift3(backKneeDown.feet.R,stance0.feet.R)<.001&&
  ['L','R'].every(side=>backKneeDown.targets[side]<=stance0.targets[side]+.01)&&drift3(backKneeDown.racketTip,stance0.racketTip)<.01&&
  JSON.stringify(backKneeDown.otherPoseChannels)===JSON.stringify(stance0.otherPoseChannels),
  `脚漂 ${(Math.max(drift3(backKneeDown.feet.L,stance0.feet.L),drift3(backKneeDown.feet.R,stance0.feet.R))*1000).toFixed(2)}mm`);
 await dragKneeDown(stance0.sides.front);
 const frontKneeDown=await balanceState();
 check('再下拖前膝使躯干从后倾回到直立方向且重心仍低',
  frontKneeDown.lean>backKneeDown.lean+2&&Math.abs(frontKneeDown.lean-stance0.lean)<3&&frontKneeDown.comY<stance0.comY-.003,
  `lean ${backKneeDown.lean.toFixed(1)}°→${frontKneeDown.lean.toFixed(1)}°（基准 ${stance0.lean.toFixed(1)}°），COM=${frontKneeDown.comY.toFixed(3)}`);
 check('前膝下拖仍保持双脚锚点、支撑状态、手部目标和膝关节限位',
  frontKneeDown.plants.L===true&&frontKneeDown.plants.R===true&&
  drift3(frontKneeDown.feet.L,stance0.feet.L)<.001&&drift3(frontKneeDown.feet.R,stance0.feet.R)<.001&&
  ['L','R'].every(side=>frontKneeDown.targets[side]<=stance0.targets[side]+.01)&&
  drift3(frontKneeDown.racketTip,stance0.racketTip)<.01&&
  JSON.stringify(frontKneeDown.otherPoseChannels)===JSON.stringify(stance0.otherPoseChannels)&&
  Object.values(frontKneeDown.kneeFlex).every(a=>a>=0&&a<=135),
  `最大脚漂 ${(Math.max(drift3(frontKneeDown.feet.L,stance0.feet.L),drift3(frontKneeDown.feet.R,stance0.feet.R))*1000).toFixed(2)}mm, knees=${JSON.stringify(frontKneeDown.kneeFlex)}`);

 if(errors.length)throw new Error(`workshop page reported errors: ${errors.join(' | ')}`);
 const failed=checks.filter(c=>!c.ok);
 atomicWriteFile(outFile('results.json'),`${JSON.stringify({date:new Date().toISOString(),browser:await browser.version(),webIdentity:identity,checks,consoleErrors:errors},null,2)}\n`);
 console.log(`\n${checks.length-failed.length}/${checks.length} 通过 → ${output.dir}`);
 if(failed.length)process.exitCode=1;
}finally{await browser.close();}
