import {chromium} from 'playwright';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {resolveOutputDir,assertTrackedWriteAllowed,atomicWriteFile,ensureOutputDir} from './lib/qa-output.mjs';
import {verifyWebIdentity} from './lib/worktree-check.mjs';

// Bevel badges + finger-spread slider through the REAL workshop UI (issue #32
// review required a browser check for #33). Everything is driven by visible
// controls — display menu, the 动作属性 fold, the bevel <select>, sidebar tabs,
// the slider — never by calling engine setters, so the shipped write path is
// what gets tested. Reads of window.__WS__ only observe scene/rig state after
// a control drove it.
//
//   npm run dev &   (then)   sh scripts/check-process-limit.sh && node scripts/bevel-hand-qa.mjs
const repoRoot=process.cwd();
const output=resolveOutputDir('bevel-hand',process.argv.slice(2),repoRoot,process.env);
if(output.args.length)throw new Error(`unexpected bevel/hand QA arguments: ${output.args.join(' ')}`);
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
 /* The desktop shell starts with both side panels collapsed to 0 px, so every
  * control that lives in one must be reached by opening the panel first — the
  * same helper the library QA suites use. Without it the click lands on the
  * canvas instead (CI caught exactly that). */
 const panel=async(side)=>{
  const button=page.getByTestId(`sheet-${side}`);
  if(await button.getAttribute('aria-expanded')!=='true')await button.click();
  await page.locator(side==='left'?'.ws-left':'.ws-right').waitFor({state:'visible'});
 };
 // Review mode is the default; the pose card is inert until we switch.
 await page.getByTestId('mode-edit').click();
 await page.evaluate(()=>window.__WS__.setPlaying(false));

 // ---- 1. bevel badges: real display-menu toggle, then inspect the scene
 await panel('left');
 await page.getByTestId('racket-right').click();
 await page.waitForFunction(()=>window.__WS__.getDoc().keys.every(k=>k.constraints.grip),null,{timeout:10000});
 await page.getByTestId('display-menu').click();
 await page.getByRole('group',{name:'显示选项'}).getByText('拍柄棱面编号').click();
 await page.getByTestId('display-menu').click();
 await page.waitForFunction(()=>window.__WS__.options.bevels===true,null,{timeout:10000});
 await page.evaluate(()=>{window.__WS__.seek(0);window.__WS__.solveCurrent();});
 await page.waitForTimeout(150);
 const badge=await page.evaluate(()=>{
  const e=window.__WS__;
  const all=e.bevelLabels??[];
  const visible=all.filter(s=>s.visible);
  const selected=all.find(s=>s.userData.bevel===(e.getDoc().gripBevel??1));
  return {option:e.options.bevels,total:all.length,visible:visible.length,
   onRacket:all.every(s=>s.parent===e.racket),
   selectedVisible:selected?.visible===true,selectedScale:selected?+selected.scale.x.toFixed(4):0,
   otherScale:all.filter(s=>s!==selected&&s.visible).map(s=>+s.scale.x.toFixed(4))};
 });
 check('显示菜单可开启棱面编号（真实开关）',badge.option===true);
 check('共 8 个标签且都挂在球拍下',badge.total===8&&badge.onRacket,`${badge.total} 个`);
 check('不再 8 面同时重叠显示（朝向筛选）',badge.visible>0&&badge.visible<badge.total,`可见 ${badge.visible}/${badge.total}`);
 check('选中棱面常显并放大',badge.selectedVisible&&badge.selectedScale>.026,`scale=${badge.selectedScale}`);
 check('其余可见标签保持基础尺寸',badge.otherScale.every(s=>s<=.0261),JSON.stringify(badge.otherScale));

 // ---- 2. bevel <select> inside the 动作属性 fold drives the highlight
 const docFold=page.locator('details[data-fold="doc"]');
 if(!(await docFold.evaluate(d=>d.open)))await docFold.locator('summary').click();
 await page.getByTestId('grip-bevel').waitFor({state:'visible'});
 const follow=[];
 for(const bevel of ['4','8','1']){
  await page.getByTestId('grip-bevel').selectOption(bevel);
  await page.waitForFunction(v=>String(window.__WS__.getDoc().gripBevel??1)===v,bevel,{timeout:10000});
  await page.waitForTimeout(120);
  const r=await page.evaluate(()=>{
   const e=window.__WS__;
   return {doc:e.getDoc().gripBevel??1,
    highlighted:(e.bevelLabels??[]).filter(s=>s.visible&&s.scale.x>.026).map(s=>s.userData.bevel)};
  });
  follow.push({picked:Number(bevel),...r});
 }
 check('切换棱面下拉后高亮跟随选择',follow.every(f=>f.highlighted.includes(f.doc)&&f.doc===f.picked),
  follow.map(f=>`${f.picked}→[${f.highlighted}]`).join(' '));

 const still=await page.evaluate(async()=>{
  const blob=await window.__WS__.captureStill(window.__WS__.time,{view:'threeQuarter',overlays:true});
  const bytes=new Uint8Array(await blob.arrayBuffer());
  let bin='';for(let k=0;k<bytes.length;k+=0x8000)bin+=String.fromCharCode(...bytes.subarray(k,k+0x8000));
  return btoa(bin);
 });
 fs.writeFileSync(outFile('bevel-badges-threeQuarter.png'),Buffer.from(still,'base64'));
 check('导出带编号静帧供人工核对可读性',true,'bevel-badges-threeQuarter.png');

 // ---- 3. finger spread on the NON-gripping hand: real slider input
 await panel('right');
 await page.getByTestId('adjustment-tab-left').click();
 const leftSlider=page.getByTestId('finger-spread-L');
 await leftSlider.waitFor({state:'visible',timeout:10000});
 /* Drive the range input the way a keyboard user does: focus it, then Home /
  * End / arrow keys. A raw page.mouse click at a computed box position silently
  * lands elsewhere when the panel scrolls or an overlay shifts — CI showed the
  * value stuck at 50% with zero failures raised, so the check would have
  * "passed" while testing nothing. Focus + keys goes through the same input
  * element and fires the same input/change events, and the resulting value is
  * read back and asserted, so a no-op is caught here rather than believed. */
 const setSpread=async(slider,keys)=>{
  await slider.focus();
  for(const key of keys)await page.keyboard.press(key);
  await page.waitForTimeout(120);
 };
 const leftQuat=()=>page.evaluate(()=>{
  const e=window.__WS__,out={};
  const doc=JSON.parse(JSON.stringify(e.getDoc()));
  for(const n of ['finger2-1_L','finger2-2_L','finger3-1_L','finger5-1_L'])out[n]=e.rig.bone(n).quaternion.toArray();
  return {bones:out,stored:doc.keys[0].pose.handSpread?.L??null};
 });
 await setSpread(leftSlider,['Home']);
 for(let i=0;i<50;i++)await page.keyboard.press('ArrowRight'); // step 1 → 50%
 await page.waitForTimeout(120);
 const relaxed=await leftQuat();
 await setSpread(leftSlider,['Home']);
 const fist=await leftQuat();
 await setSpread(leftSlider,['End']);
 const open=await leftQuat();
 const leftValue=await leftSlider.inputValue();
 const delta=(a,b)=>Math.max(...Object.keys(a).map(n=>Math.hypot(...a[n].map((x,i)=>x-b[n][i]))));
 check('左侧滑块键盘归零写入握拳',fist.stored===0,`stored=${fist.stored}`);
 check('左侧滑块键盘到顶写入张开',leftValue==='100'&&open.stored===1,`${leftValue}% stored=${open.stored}`);
 check('滑块握拳使指节明显改变',delta(relaxed.bones,fist.bones)>.05,delta(relaxed.bones,fist.bones).toFixed(3));
 check('滑块张开使指节明显改变（含外展）',delta(relaxed.bones,open.bones)>.05,delta(relaxed.bones,open.bones).toFixed(3));
 check('握拳与张开不同',delta(fist.bones,open.bones)>.05,delta(fist.bones,open.bones).toFixed(3));
 check('握拍手以外不显示「握拍优先」提示',await page.getByTestId('finger-spread-wrapped-L').count()===0);

 // ---- 4. the gripping hand: honest note, and the slider really is inert
 await page.getByTestId('adjustment-tab-right').click();
 const rightSlider=page.getByTestId('finger-spread-R');
 await rightSlider.waitFor({state:'visible',timeout:10000});
 const wrappedRight=await page.getByTestId('finger-spread-wrapped-R').count();
 check('右手握拍时右手指开合面板显示「握拍优先」提示',wrappedRight>=1,`匹配 ${wrappedRight} 处`);
 const rightState=()=>page.evaluate(()=>{
  const e=window.__WS__,out=[];
  const doc=JSON.parse(JSON.stringify(e.getDoc()));
  for(let f=1;f<=5;f++)for(let j=1;j<=3;j++)out.push(...e.rig.bone(`finger${f}-${j}_R`).quaternion.toArray());
  return {bones:out,stored:doc.keys[0].pose.handSpread?.R??null};
 });
 await setSpread(rightSlider,['Home']);
 const rightFist=await rightState(),fistValue=await rightSlider.inputValue();
 await setSpread(rightSlider,['End']);
 const rightOpen=await rightState(),openValue=await rightSlider.inputValue();
 const maxDelta=Math.max(...rightFist.bones.map((v,i)=>Math.abs(v-rightOpen.bones[i])));
 check('满握持关键帧的滑块仍可写入两端手型',fistValue==='0'&&openValue==='100'&&rightFist.stored===0&&rightOpen.stored===1,
  `${fistValue}%→${openValue}% stored=${rightFist.stored}→${rightOpen.stored}`);
 check('满握持时手型确实不改变外观（提示文案的前提成立）',maxDelta<1e-6,maxDelta.toExponential(1));

 if(errors.length)throw new Error(`workshop page reported errors: ${errors.join(' | ')}`);
 const failed=checks.filter(c=>!c.ok);
 atomicWriteFile(outFile('results.json'),`${JSON.stringify({date:new Date().toISOString(),browser:await browser.version(),webIdentity:identity,checks,consoleErrors:errors},null,2)}\n`);
 console.log(`\n${checks.length-failed.length}/${checks.length} 通过 → ${output.dir}`);
 if(failed.length)process.exitCode=1;
}finally{await browser.close();}
