import {chromium} from 'playwright';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {resolveOutputDir,assertTrackedWriteAllowed,atomicWriteFile,ensureOutputDir} from './lib/qa-output.mjs';

const repoRoot=process.cwd();
const output=resolveOutputDir('pose-validity',process.argv.slice(2),repoRoot,process.env);
if(output.args.length)throw new Error(`unexpected pose-validity QA arguments: ${output.args.join(' ')}`);
ensureOutputDir(output.dir,{root:repoRoot,updateEvidence:output.updateEvidence});
const outputFile=name=>assertTrackedWriteAllowed(path.join(output.dir,name),{root:repoRoot,updateEvidence:output.updateEvidence});
const webBase=new URL(process.env.QA_WEB_URL??`http://127.0.0.1:${process.env.HUMAN3D_WEB_PORT??5173}/`);
const webUrl=new URL('/',webBase).href;
const coreModule=name=>`/@fs/${path.resolve(repoRoot,'packages/motion-core/src',name)}`;
const appModule=name=>`/@fs/${path.resolve(repoRoot,'apps/web/src/lab',name)}`;
const threeModule=`/@fs/${path.resolve(repoRoot,'node_modules/three/build/three.module.js')}`;
const {verifyWebIdentity}=await import('./lib/worktree-check.mjs');
const webIdentity=await verifyWebIdentity(repoRoot,webBase);
if(process.env.QA_WEB_URL===undefined&&!webIdentity.ok)
 throw new Error(`dev server at ${webBase.origin} does not serve this checkout (${webIdentity.detail}); start it from this worktree or opt in explicitly with QA_WEB_URL`);

const browser=await launchQaBrowser(chromium,{...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
try{
 const page=await browser.newPage({viewport:{width:1536,height:1024},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.goto(webUrl);await page.waitForFunction(()=>window.__LAB__?.ready,{timeout:60000});await page.locator('.loading-state').waitFor({state:'hidden'});
 await page.evaluate(async({docUrl,solverUrl,checkerUrl,threeUrl})=>{
  const [documentModule,solverModule,{PoseValidityChecker},THREE]=await Promise.all([import(docUrl),import(solverUrl),import(checkerUrl),import(threeUrl)]);
  const e=window.__LAB__;let mesh;
  e.model.traverse(object=>{if(object.isSkinnedMesh)mesh=object;});
  if(!mesh)throw new Error('Lab production skinned mesh was not found');
  const checker=new PoseValidityChecker(mesh,e.rig);
  const marker=new THREE.Mesh(new THREE.SphereGeometry(.025,16,12),new THREE.MeshBasicMaterial({color:0xe43d55,wireframe:true,depthTest:false}));
  marker.renderOrder=30;marker.visible=false;e.scene.add(marker);
  e.controls.enableDamping=false;
  window.__POSE_VALIDITY_QA__={documentModule,solverModule,checker,marker};
 },{docUrl:coreModule('document.ts'),solverUrl:coreModule('solver.ts'),checkerUrl:appModule('pose-validity.ts'),threeUrl:threeModule});

 // `expect`: valid = no crossing and every joint check passes; invalid = a
 // definite crossing or a failed joint check; clear = no definite crossing and
 // every joint check passes (indeterminate axilla-skin contact is allowed).
 const fixtures=[
  {id:'crossed-arms',name:'有效交叉臂（正面投影重叠，深度分离）',kind:'crossed-arms',expect:'valid'},
  {id:'arm-through-torso',name:'合成右臂穿躯干（修复前正手随挥形态）',kind:'arm-through-torso',expect:'invalid'},
  {id:'forehand-t3.35',name:'正手挥拍 t=3.35 s（2026-10-20 随挥修复回归）',kind:'forehand',expect:'clear'},
  {id:'shoulder-direction-limit',name:'肩部方向超限',kind:'shoulder-limit',expect:'invalid'},
 ];
 const views=['front','side','back'],labels={front:'正面',side:'侧面',back:'背面'};
 const result={date:new Date().toISOString(),browser:await browser.version(),viewport:[1536,1024],webIdentity,fixtures:[],consoleErrors:[]};
 for(const fixture of fixtures){
  if(fixture.kind==='forehand'){
   await page.locator('.motion-row').filter({hasText:'正手挥拍'}).first().click();
   await page.evaluate(()=>{const e=window.__LAB__;e.setPlaying(false);e.seek(3.35);});
   await page.waitForFunction(()=>Math.abs(window.__LAB__.time-3.35)<1e-6);
  }else{
   await page.locator('.motion-row').filter({hasText:'自然站立'}).first().click();
   await page.evaluate(({kind})=>{
    const e=window.__LAB__,qa=window.__POSE_VALIDITY_QA__,doc=qa.documentModule.blankDocument(e.rig.rest,kind,`qa-${kind}`);
    if(kind==='crossed-arms'){
     for(const key of doc.keys){key.pose.handL.target={x:-.05,y:1.3,z:.3};key.pose.handL.pole={x:.2,y:1.45,z:.6};key.pose.handR.target={x:.05,y:1.3,z:.45};key.pose.handR.pole={x:-.4,y:1.45,z:-.2};}
    }else if(kind==='arm-through-torso'){
     for(const key of doc.keys){key.pose.handR.target={x:.3,y:1.38,z:.07};key.pose.handR.pole={x:-.48,y:1.15,z:.11};}
    }else{
     for(const key of doc.keys){key.pose.handR.target={x:0,y:1.4,z:-.1};key.pose.handR.pole={x:.5,y:1.6,z:-.3};}
    }
    e.setPlaying(false);e.tick=()=>{};e.time=.5;
    qa.solverModule.solveEffectiveFrame(e.rig,qa.documentModule.frameAt(doc,.5,e.rig.rest.get('root')));
    e.model.updateMatrixWorld(true);e.render();
   },{kind:fixture.kind});
  }
  const report=await page.evaluate(({kind})=>{
   const e=window.__LAB__,qa=window.__POSE_VALIDITY_QA__,poseReport=qa.checker.inspect();
   const point=poseReport.intersections.flatMap(x=>x.position?[x.position]:[])[0];
   const failed=poseReport.checks.find(check=>!check.ok);
   if(point){qa.marker.position.fromArray(point);qa.marker.visible=true;}
   else if(failed){qa.marker.position.copy(e.rig.point(failed.bones[0]));qa.marker.visible=true;}
   else qa.marker.visible=false;
   e.render();
   return {report:poseReport,witness:point??(failed?e.rig.point(failed.bones[0]).toArray():null),time:kind==='forehand'?e.time:.5};
  },{kind:fixture.kind});
  const right=report.report.intersections.find(hit=>hit.side==='R');
  if(fixture.expect==='invalid')assert.equal(report.report.status,'invalid',`${fixture.id} should be invalid`);
  else{
   assert.notEqual(report.report.status,'invalid',`${fixture.id} should not be invalid`);
   assert.deepEqual(report.report.intersections.map(hit=>hit.count),[0,0],`${fixture.id} should have no definite arm–torso crossing`);
   assert(report.report.checks.every(check=>check.ok),`${fixture.id} joint checks should pass`);
   if(fixture.expect==='valid')assert.equal(report.report.status,'valid',`${fixture.id} should be valid`);
  }
  if(fixture.kind==='arm-through-torso'){
   assert(right?.count>0,'the synthetic pose should report a right arm–torso surface crossing');
   assert(right.bones.includes('upperarm01_R')&&right.bones.some(name=>/^spine\d+$/.test(name)),'the crossing report should name the upper arm and torso bones');
  }
  if(fixture.kind==='shoulder-limit')assert(report.report.checks.some(check=>check.code==='shoulder-direction-R'&&!check.ok),'shoulder direction violation should be reported');
  const files=[],viewCaptures=[];
  for(const view of views){
   await page.evaluate(async view=>{const e=window.__LAB__;e.setView(view);e.controls.update();e.model.updateMatrixWorld(true);e.render();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},view);
   await page.waitForFunction(({view,label})=>window.__LAB__?.view===view&&[...document.querySelectorAll('.camera-toolbar button')].some(button=>button.textContent?.trim()===label&&button.getAttribute('aria-pressed')==='true'),{view,label:labels[view]});
   const capture=await page.evaluate(()=>({view:window.__LAB__.view,camera:window.__LAB__.camera.position.toArray(),wristL:window.__LAB__.rig.point('wrist_L').toArray(),wristR:window.__LAB__.rig.point('wrist_R').toArray(),time:window.__LAB__.time}));
   assert.equal(capture.view,view,`${fixture.id} camera did not settle to ${view}`);assert.equal(capture.time,report.time,`${fixture.id} playhead changed during view capture`);
   const name=`${fixture.id}-${view}.png`;await page.screenshot({path:outputFile(name)});files.push(name);viewCaptures.push({...capture,file:name});
  }
  const projection=fixture.kind==='crossed-arms'?await page.evaluate(()=>{
   const e=window.__LAB__,a0=e.rig.point('lowerarm01_L'),a1=e.rig.point('wrist_L'),b0=e.rig.point('lowerarm01_R'),b1=e.rig.point('wrist_R');
   let gap=Infinity,depth=0;
   for(let i=0;i<=200;i++)for(let j=0;j<=200;j++){
    const u=i/200,v=j/200,ax=a0.x+(a1.x-a0.x)*u,ay=a0.y+(a1.y-a0.y)*u,bx=b0.x+(b1.x-b0.x)*v,by=b0.y+(b1.y-b0.y)*v,d=Math.hypot(ax-bx,ay-by);
    if(d<gap){gap=d;depth=Math.abs((a0.z+(a1.z-a0.z)*u)-(b0.z+(b1.z-b0.z)*v));}
   }
   return {frontProjectionGapM:gap,depthSeparationM:depth};
  }):undefined;
  if(projection){assert(projection.frontProjectionGapM<.01);assert(projection.depthSeparationM>.05);}
  result.fixtures.push({id:fixture.id,name:fixture.name,status:report.report.status,time:report.time,
   violations:report.report.checks.filter(check=>!check.ok),intersections:report.report.intersections,uncertainIntersections:report.report.uncertainIntersections,
   witness:report.witness,regions:report.report.regions,limitations:report.report.limitations,projection,views:viewCaptures});
 }
 result.consoleErrors=errors;assert.deepEqual(errors,[],'Lab browser reported JavaScript errors');
 atomicWriteFile(outputFile('report.json'),`${JSON.stringify(result,null,2)}\n`);
 console.log(JSON.stringify({output:output.dir,fixtures:result.fixtures.map(({id,status,violations,intersections,projection,views})=>({id,status,violations:violations.map(v=>({code:v.code,value:v.value,limit:v.limit,unit:v.unit})),intersections:intersections.map(x=>({side:x.side,count:x.count,bones:x.bones,truncated:x.truncated})),projection,views:views.map(view=>({view:view.view,file:view.file,time:view.time}))})),consoleErrors:errors},null,2));
}finally{await browser.close();}
