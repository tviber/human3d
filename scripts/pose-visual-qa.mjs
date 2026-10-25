import {chromium} from 'playwright';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {resolveOutputDir,assertTrackedWriteAllowed,atomicWriteFile,ensureOutputDir} from './lib/qa-output.mjs';

// Pure visual sampling of bundled motions through the real Lab page: no
// checker, no markers, no debug overlays — the canvas alone, so the reviewer
// sees only the rendered body.
//   node scripts/pose-visual-qa.mjs [--quick] [动作名…]
// Motion names are the Lab list labels (`正手挥拍`, `Novak Djokovic`, …);
// the default is the forehand. Instants are the motion's envelope phase
// markers (准备/引拍/击球区/随挥/恢复), so every motion is sampled at
// semantically comparable moments. `--quick` reduces the view grid to four
// azimuths at one elevation for contact-sheet review.
const repoRoot=process.cwd();
const output=resolveOutputDir('pose-visual',process.argv.slice(2),repoRoot,process.env);
const quick=output.args.includes('--quick');
const unknown=output.args.filter(arg=>arg.startsWith('--')&&arg!=='--quick');
if(unknown.length)throw new Error(`unexpected pose-visual QA arguments: ${unknown.join(' ')}`);
const motions=output.args.filter(arg=>!arg.startsWith('--'));
if(!motions.length)motions.push('正手挥拍');
ensureOutputDir(output.dir,{root:repoRoot,updateEvidence:output.updateEvidence});
const outputFile=name=>assertTrackedWriteAllowed(path.join(output.dir,name),{root:repoRoot,updateEvidence:output.updateEvidence});
const webBase=new URL(process.env.QA_WEB_URL??`http://127.0.0.1:${process.env.HUMAN3D_WEB_PORT??5173}/`);
const {verifyWebIdentity}=await import('./lib/worktree-check.mjs');
const webIdentity=await verifyWebIdentity(repoRoot,webBase);
if(process.env.QA_WEB_URL===undefined&&!webIdentity.ok)
 throw new Error(`dev server at ${webBase.origin} does not serve this checkout (${webIdentity.detail}); start it from this worktree or opt in explicitly with QA_WEB_URL`);

const AZIMUTHS=quick?[0,90,180,270]:[0,30,60,90,120,150,180,210,240,270,300,330];
const ELEVATIONS=quick?[12]:[12,50];

const browser=await launchQaBrowser(chromium,{...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
try{
 const page=await browser.newPage({viewport:{width:1600,height:1200},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.goto(new URL('/',webBase).href);await page.waitForFunction(()=>window.__LAB__?.ready,{timeout:60000});await page.locator('.loading-state').waitFor({state:'hidden'});
 const sampled=[];
 for(const motion of motions){
  await page.locator('.motion-row').filter({hasText:motion}).first().click();
  await page.waitForFunction(label=>{const e=window.__LAB__,spec=e.specs.get(e.activeId);return !!spec&&`${spec.name}${spec.english}`.includes(label);},motion);
  const info=await page.evaluate(()=>{
   const e=window.__LAB__,spec=e.specs.get(e.activeId);
   e.setPlaying(false);e.loop=false;e.speed=1;e.setView('free');
   e.controls.enableDamping=false;e.controls.enablePan=false;e.controls.enableZoom=false;
   e.setDebug({surface:true,skeleton:false,axes:false,targets:false,trail:false,muscles:false});
   return {id:spec.id,name:spec.name,duration:spec.duration,phases:spec.phases.map(p=>({time:p.time,label:p.label}))};
  });
  assert(info.phases.length>0,`${info.id} has no phase markers to sample`);
  const images=[];
  for(const phase of info.phases){
   const time=Math.min(phase.time,info.duration);
   await page.evaluate(t=>{const e=window.__LAB__;e.setPlaying(false);e.seek(t);},time);
   await page.waitForFunction(t=>Math.abs(window.__LAB__.time-t)<1e-6,time);
   for(const elevation of ELEVATIONS)for(const azimuth of AZIMUTHS){
    await page.evaluate(({az,el})=>{
     const e=window.__LAB__,target={x:0,y:1.02,z:0},distance=3.15;
     const a=az*Math.PI/180,b=el*Math.PI/180;
     e.controls.target.set(target.x,target.y,target.z);
     e.camera.position.set(target.x+distance*Math.sin(a)*Math.cos(b),target.y+distance*Math.sin(b),target.z+distance*Math.cos(a)*Math.cos(b));
     e.camera.lookAt(target.x,target.y,target.z);e.controls.update();e.model.updateMatrixWorld(true);e.render();
    },{az:azimuth,el:elevation});
    await page.waitForTimeout(40);
    const file=`${info.id}-t${time.toFixed(2)}-az${String(azimuth).padStart(3,'0')}-el${elevation}.png`;
    await page.locator('canvas').screenshot({path:outputFile(file)});
    images.push({file,time,phase:phase.label,azimuth,elevation});
   }
  }
  sampled.push({...info,images});
 }
 assert.deepEqual(errors,[],'Lab browser reported JavaScript errors');
 atomicWriteFile(outputFile('manifest.json'),`${JSON.stringify({date:new Date().toISOString(),webIdentity,quick,azimuths:AZIMUTHS,elevations:ELEVATIONS,motions:sampled},null,2)}\n`);
 console.log(JSON.stringify({output:output.dir,motions:sampled.map(m=>({id:m.id,phases:m.phases.length,images:m.images.length}))},null,2));
}finally{await browser.close();}
