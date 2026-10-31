import {chromium} from 'playwright';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {resolveOutputDir,assertTrackedWriteAllowed,atomicWriteFile,ensureOutputDir} from './lib/qa-output.mjs';
import {verifyWebIdentity} from './lib/worktree-check.mjs';

// Knee-handle drags, the per-key racket toggle and the leg-pole opt-in
// through the REAL workshop UI (issue #37). Everything is driven by visible
// controls and real pointer events — 新建, the constraint checkboxes, the
// display menu, the quick-action buttons, undo — never by calling engine
// setters, so the shipped write path is what gets tested. Reads of
// window.__WS__ only observe scene/rig state after a control drove it.
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
 await openFold('[data-fold="doc"]');
 const durationInput=page.locator('.ws-doc-card input[type="number"]');
 await durationInput.fill('0.2');await durationInput.press('Enter');await page.waitForTimeout(100);
 await openFold('[data-fold="keys"]');
 await page.getByTestId('keyframe-insert-after').click();
 await page.waitForFunction(()=>window.__WS__?.getDoc().keys.length===3,{timeout:10000});

 const kneeSpot=()=>page.evaluate(()=>{
  const e=window.__WS__,h=e.handles.find(x=>x.kind==='knee'&&x.side==='L');
  const p=h.mesh.position.clone().project(e.camera),r=e.renderer.domElement.getBoundingClientRect();
  return {x:r.left+(p.x+1)/2*r.width,y:r.top+(1-p.y)/2*r.height,visible:h.mesh.visible===true,
   atJoint:h.mesh.position.distanceTo(e.rig.point('lowerleg01_L'))};
 });
 const keyState=()=>page.evaluate(()=>{
  const e=window.__WS__,ks=[...e.getDoc().keys].sort((a,b)=>a.time-b.time);
  const u=e.rig.point('upperleg01_L').sub(e.rig.point('lowerleg01_L'));
  const w=e.rig.point('foot_L').sub(e.rig.point('lowerleg01_L'));
  const internal=Math.acos(Math.max(-1,Math.min(1,u.dot(w)/(u.length()*w.length()))))*180/Math.PI;
  return {grips:ks.map(k=>k.constraints.grip===true),
   keys:ks.map(k=>({id:k.id,time:k.time,pole:{...k.pose.footL.pole},target:{...k.pose.footL.target},yaw:k.pose.footL.yaw,pitch:k.pose.footL.pitch})),
   kneeFlex:180-internal,
   hip:e.rig.point('upperleg01_L').toArray(),knee:e.rig.point('lowerleg01_L').toArray(),ankle:e.rig.point('foot_L').toArray()};
 });
 const poleLegVis=()=>page.evaluate(()=>window.__WS__.handles.filter(x=>x.kind==='poleLeg').map(h=>h.mesh.visible===true));

 // ---- 1. knee handles ride the solved joints; pole floats hidden by default
 const spot0=await kneeSpot();
 check('膝盖拖点显示且贴在左膝关节上',spot0.visible&&spot0.atJoint<1e-6,`dist=${spot0.atJoint.toFixed(4)}`);
 check('膝极点浮点默认隐藏（显示菜单可开）',(await poleLegVis()).every(v=>v===false));

 // ---- 2. a planted knee can be adjusted precisely, then dragged toward straight
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
 const straightTarget=await page.evaluate(()=>{
  const e=window.__WS__,hip=e.rig.point('upperleg01_L'),ankle=e.rig.point('foot_L'),knee=e.rig.point('lowerleg01_L');
  const axis=hip.clone().sub(ankle),along=axis.lengthSq()>1e-10?Math.max(0,Math.min(1,knee.clone().sub(ankle).dot(axis)/axis.lengthSq())):0;
  const closest=ankle.clone().addScaledVector(axis,along),toward=closest.sub(knee),view=e.camera.getWorldDirection(axis.clone());
  toward.addScaledVector(view,-toward.dot(view));
  const distance=toward.length();if(distance<.005)return null;
  const end=knee.clone().addScaledVector(toward,1.5),project=p=>{const q=p.project(e.camera),r=e.renderer.domElement.getBoundingClientRect();return {x:r.left+(q.x+1)*r.width/2,y:r.top+(1-q.y)*r.height/2};};
  return {start:project(knee),end:project(end),distance};
 });
 if(!straightTarget)throw new Error('planted knee bend does not project to a usable straightening drag direction');
 await page.mouse.move(bentSpot.x,bentSpot.y);await page.mouse.down();
 await page.mouse.move(straightTarget.end.x,straightTarget.end.y,{steps:8});await page.mouse.up();
 await page.waitForTimeout(150);
 const planted1=await keyState();
 const moved3=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
 check('沿伸直方向拖动支撑膝球会减小膝屈曲',planted1.kneeFlex<planted0.kneeFlex-10,
  `${planted0.kneeFlex.toFixed(1)}°→${planted1.kneeFlex.toFixed(1)}°`);
 check('拖动支撑膝球保持脚目标与朝向',JSON.stringify(planted1.keys[1].target)===JSON.stringify(planted0.keys[1].target)&&
   planted1.keys[1].yaw===planted0.keys[1].yaw&&planted1.keys[1].pitch===planted0.keys[1].pitch);
 check('拖动支撑膝球保持脚踝世界位置',moved3(planted1.ankle,planted0.ankle)<.001,
  `Δankle=${(moved3(planted1.ankle,planted0.ankle)*1000).toFixed(2)}mm`);

 // ---- 3. free leg: unplant both keys' left foot through the real constraint
 // row, then the knee drag takes the rigid-FK branch (key 0 is free, not a
 // release key, once key 1 is also unplanted)
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
 const free1=await page.evaluate(async({url})=>{
  const e=window.__WS__,k=[...e.getDoc().keys].sort((a,b)=>a.time-b.time)[0];
  const {footLift}=await import(url);
  return {target:{...k.pose.footL.target},
   lift:footLift(e.footGeometry('L'),k.pose.footL.target.y,k.pose.footL.yaw,k.pose.footL.pitch),
   hip:e.rig.point('upperleg01_L').toArray(),knee:e.rig.point('lowerleg01_L').toArray(),ankle:e.rig.point('foot_L').toArray()};
 },{url:coreModule('foot.ts')});
 const flex=s=>{const u=[s.hip[0]-s.knee[0],s.hip[1]-s.knee[1],s.hip[2]-s.knee[2]],w=[s.ankle[0]-s.knee[0],s.ankle[1]-s.knee[1],s.ankle[2]-s.knee[2]];const c=(u[0]*w[0]+u[1]*w[1]+u[2]*w[2])/(Math.hypot(...u)*Math.hypot(...w));return Math.acos(Math.max(-1,Math.min(1,c)))*57.2958;};
 check('离地拖膝移动脚目标（刚性 FK 分支）',moved3(free1.target,free0.keys[0].target)>.005,`Δ=${moved3(free1.target,free0.keys[0].target).toFixed(3)}m`);
 check('离地拖膝保持膝屈曲角',Math.abs(flex(free1)-flex({hip:free0.hip,knee:free0.knee,ankle:free0.ankle}))<.5,
  `${flex({hip:free0.hip,knee:free0.knee,ankle:free0.ankle}).toFixed(1)}°→${flex(free1).toFixed(1)}°`);
 check('离地拖膝脚底不越触地容差带',free1.lift>=-0.02-1e-6,`lift=${free1.lift.toFixed(4)}`);

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

 // ---- 5. 膝极点 opt-in through the display menu
 await page.getByTestId('display-menu').click();
 await page.locator('.ws-check').filter({hasText:'膝极点'}).locator('input').check();
 await page.waitForTimeout(150);
 check('开启膝极点选项后浮点可见',(await poleLegVis()).every(v=>v===true));
 await page.locator('.ws-check').filter({hasText:'膝极点'}).locator('input').uncheck();
 await page.getByRole('button',{name:'关闭显示菜单'}).click();
 await page.waitForTimeout(150);
 check('关闭膝极点选项后浮点再次隐藏',(await poleLegVis()).every(v=>v===false));

 if(errors.length)throw new Error(`workshop page reported errors: ${errors.join(' | ')}`);
 const failed=checks.filter(c=>!c.ok);
 atomicWriteFile(outFile('results.json'),`${JSON.stringify({date:new Date().toISOString(),browser:await browser.version(),webIdentity:identity,checks,consoleErrors:errors},null,2)}\n`);
 console.log(`\n${checks.length-failed.length}/${checks.length} 通过 → ${output.dir}`);
 if(failed.length)process.exitCode=1;
}finally{await browser.close();}
