import {chromium} from 'playwright';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {resolveOutputDir,assertTrackedWriteAllowed,atomicWriteFile,ensureOutputDir} from './lib/qa-output.mjs';

const repoRoot=process.cwd();
const output=resolveOutputDir('dynamics-browser-qa',process.argv.slice(2),repoRoot,process.env);
if(output.args.length)throw new Error(`unexpected dynamics QA arguments: ${output.args.join(' ')}`);
ensureOutputDir(output.dir,{root:repoRoot,updateEvidence:output.updateEvidence});
const outputFile=name=>assertTrackedWriteAllowed(path.join(output.dir,name),{root:repoRoot,updateEvidence:output.updateEvidence});
const webUrl=process.env.QA_WEB_URL??`http://127.0.0.1:${process.env.HUMAN3D_WEB_PORT??5173}/`;
// Same checkout-identity rule as browser-qa.mjs (issue #11 WP-0C): refuse a
// foreign worktree's dev server on the default port; QA_WEB_URL opt-in only
// warns when the identity probe cannot verify it.
const {verifyWebIdentity}=await import('./lib/worktree-check.mjs');
const webIdentity=await verifyWebIdentity(repoRoot,webUrl);
if(process.env.QA_WEB_URL!==undefined){
 if(!webIdentity.ok)console.warn(`QA_WEB_URL is an explicit opt-in: web checkout identity NOT verified (${webIdentity.detail})`);
}else if(!webIdentity.ok){
 throw new Error(`dev server at ${webUrl} does not serve this checkout (${webIdentity.detail}); start it from this worktree (npm run dev) or opt in explicitly with QA_WEB_URL`);
}
const envelope=id=>JSON.parse(fs.readFileSync(`assets/motions/${id}.json`,'utf8'));
const throwEnv=envelope('baseball-throw'),punchEnv=envelope('punch');
assert.equal(throwEnv.kind,'dynamics-motion');assert.equal(punchEnv.kind,'dynamics-motion');
const throwSpec=throwEnv.dynamics.action;
// The envelope's records URLs are the runtime contract: assert each file
// actually exists under public/ so path drift fails before the browser run.
for(const env of [throwEnv,punchEnv])
 for(const [profile,ref] of Object.entries(env.dynamics.records))
  for(const url of [ref.meta,ref.data])
   assert.ok(fs.existsSync(`public${url}`),`${env.id}: dynamics.records.${profile} target missing: ${url}`);
const throwTime=(phase)=>throwSpec.simulation.leadSeconds+throwSpec.reference.keyframes.find(frame=>frame.phase===phase).timeSeconds/throwSpec.simulation.referenceSpeedScale;

const browser=await launchQaBrowser(chromium,{...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
try{
 const context=await browser.newContext({viewport:{width:1536,height:1024},deviceScaleFactor:1,acceptDownloads:true});
 const page=await context.newPage();
 const errors=[],warnings=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(m.type()==='warning')warnings.push(m.text());});
 await page.goto(webUrl);
 await page.waitForFunction(()=>window.__LAB__?.ready,{timeout:60000});
 await page.locator('.loading-state').waitFor({state:'hidden'});
 assert.equal(new URL(page.url()).pathname,'/');
 assert.match(await page.title(),/人体运动实验室/);
 const initialText=await page.locator('body').innerText();
 assert.ok(initialText.includes('自然站立')&&initialText.includes('动作库'),'app should render meaningful content');
 assert.equal(await page.locator('vite-error-overlay, #webpack-dev-server-client-overlay').count(),0);
 assert.equal(await page.locator('.motion-row').count(),8,'action catalog should include six authored and two muscle-driven actions');
 const result={date:'2026-10-17',browser:await browser.version(),viewport:[1536,1024],action:'baseball-throw',poses:[],checks:{pageIdentity:true,notBlank:true,noFrameworkOverlay:true}};
 const throwRow=page.locator('.motion-row').filter({hasText:'原地棒球式上手投掷'});
 await throwRow.click();
 await page.waitForFunction(()=>window.__LAB__?.physics?.ready&&!window.__LAB__.physicsLoading,{timeout:60000});
 await page.waitForTimeout(300);
 assert.equal(await page.locator('.viewport-heading h2').textContent(),'原地棒球式上手投掷');
 assert.match(await page.locator('.dynamics-panel').innerText(),/416|MyoSim/);
 async function pose(name,time,view='threeQuarter'){
  await page.evaluate(({time,view})=>{const e=window.__LAB__;e.setPlaying(false);e.seek(time);e.setView(view);}, {time,view});
  await page.waitForTimeout(150);
  const metrics=await page.evaluate(()=>{
   const e=window.__LAB__,r=e.physics,rig=e.rig;
   const toeOut=(side)=>{const f=rig.point(`foot_${side}`),t=rig.point(`toe2-1_${side}`),d=t.sub(f).normalize();return Math.atan2(side==='R'?-d.x:d.x,d.z)*180/Math.PI;};
   return {time:r.time,phase:document.querySelector('.phase-readout')?.textContent?.trim(),loadedMass:r.model.mass,
    hand:r.point('lunate_r').toArray(),support:r.diagnostics().support,power:r.diagnostics().power,audit:r.record.meta.audit,
    wristFlexionDeg:r.jointAngle('flexion_r'),
    fingerCurlDeg:['mcp2_flexion_r','pm2_flexion_r','md2_flexion_r','mcp3_flexion_r','pm3_flexion_r','md3_flexion','mcp4_flexion_r','pm4_flexion','md4_flexion_r','mcp5_flexion_r','pm5_flexion_r','md5_flexion_r'].reduce((sum,name)=>sum+r.jointAngle(name),0),
    toeOutRightDeg:toeOut('R'),toeOutLeftDeg:toeOut('L'),hasCarriedObject:!!r.model.carriedObject,
    activeSceneProps:r.root.children.filter(o=>/ball|sphere/i.test(o.name)).map(o=>o.name)};
  });
  await page.screenshot({path:outputFile(`${name}.png`)});result.poses.push({name,time,view,file:`${name}.png`,...metrics});
 }
 await pose('baseball-throw-front',0,'front');
 await pose('baseball-throw-side',0,'side');
 await pose('baseball-throw-back',0,'back');
 await pose('baseball-throw-three-quarter',0,'threeQuarter');
 const times=[['baseball-throw-ready','ready'],['baseball-throw-load','coil'],['baseball-throw-max-cock','maximum-cocking'],['baseball-throw-pelvis-drive','pelvis-drive'],['baseball-throw-trunk-follow','trunk-follow'],['baseball-throw-release','release'],['baseball-throw-follow-through','follow-through'],['baseball-throw-recovery','recovery']].map(([name,phase])=>[name,throwTime(phase)]);
 for(const [name,time] of times)await pose(name,time,'threeQuarter');
 await pose('baseball-throw-release-front',throwTime('release'),'front');
 await pose('baseball-throw-release-side',throwTime('release'),'side');
 await pose('baseball-throw-follow-through-side',throwTime('follow-through'),'side');
 await pose('baseball-throw-release-hand-close',throwTime('release'),'hand');
 result.checks.noVisibleOrCarriedBall=result.poses.every(p=>!p.hasCarriedObject&&p.activeSceneProps.length===0);
 result.checks.toesPointOut=result.poses.every(p=>p.toeOutRightDeg>0&&p.toeOutLeftDeg>0);
 result.checks.withinSoftLimitTolerance=result.poses.every(p=>p.audit.maxScalarJointLimitViolationRad<.035);
 const throwAudit=await page.evaluate(()=>window.__LAB__.physics.record.meta.audit);
 result.checks.throwHandTracking=throwAudit.maxReferenceHandErrorM<.35;
 result.checks.supportDrift=throwAudit.maxSupportDriftM<.001;
 result.checks.forearmClearance=result.poses.every(p=>p.audit.minimumForearmClearanceM>0);
 assert.equal(result.checks.noVisibleOrCarriedBall,true);assert.equal(result.checks.toesPointOut,true);
 assert.equal(result.checks.withinSoftLimitTolerance,true);assert.equal(result.checks.throwHandTracking,true);
 assert.equal(result.checks.supportDrift,true);assert.equal(result.checks.forearmClearance,true);
 result.chain=[];
 for(const phase of ['ready','coil','maximum-cocking','pelvis-drive','trunk-follow','release','follow-through','recovery']){
  const time=throwTime(phase);
  result.chain.push(await page.evaluate(time=>{
   const e=window.__LAB__,r=e.physics;e.setPlaying(false);e.seek(time);
   const [w,x,y,z]=Array.from(r.current.slice(3,7));
   const pelvisYawDeg=Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))*180/Math.PI;
   const fingerCurlDeg=['mcp2_flexion_r','pm2_flexion_r','md2_flexion_r','mcp3_flexion_r','pm3_flexion_r','md3_flexion','mcp4_flexion_r','pm4_flexion','md4_flexion_r','mcp5_flexion_r','pm5_flexion_r','md5_flexion_r'].reduce((sum,name)=>sum+r.jointAngle(name),0);
   e.rig.model.updateMatrixWorld(true);
   const quaternionAngleDeg=q=>2*Math.acos(Math.min(1,Math.abs(q.w)))*180/Math.PI;
   const fingerBones=['finger2-1_R','finger2-2_R','finger2-3_R','finger3-1_R','finger3-2_R','finger3-3_R','finger4-1_R','finger4-2_R','finger4-3_R','finger5-1_R','finger5-2_R','finger5-3_R'];
   const skinFingerCurlDeg=fingerBones.reduce((sum,name)=>sum+quaternionAngleDeg(e.rig.bone(name).quaternion),0);
   return {time,pelvisYawDeg,trunkAxialDeg:r.jointAngle('axial_rotation'),trunkFlexionDeg:r.jointAngle('flex_extension'),kneeDeg:r.jointAngle('knee_angle_r'),elbowDeg:r.jointAngle('elbow_flexion_r'),wristFlexionDeg:r.jointAngle('flexion_r'),physicsFingerCurlDeg:fingerCurlDeg,skinFingerCurlDeg,hand:r.point('lunate_r').toArray()};
  },time));
 }
 const coil=result.chain.find(row=>row.time===throwTime('coil'));
 const maximumCock=result.chain.find(row=>row.time===throwTime('maximum-cocking'));
 result.checks.pelvisLeadsTrunk=Math.abs(coil.pelvisYawDeg)>15&&Math.abs(coil.trunkAxialDeg)<5&&Math.abs(maximumCock.trunkAxialDeg)>Math.abs(coil.trunkAxialDeg)+5;
 result.checks.forwardTrunkFollowThrough=result.chain.find(row=>row.time===throwTime('follow-through')).trunkFlexionDeg< -5;
 const cock=result.chain.find(row=>row.time===throwTime('maximum-cocking')),release=result.chain.find(row=>row.time===throwTime('release'));
 result.checks.throwWristCocksAndReleases=cock.wristFlexionDeg< -5&&release.wristFlexionDeg>cock.wristFlexionDeg+18&&Math.abs(release.wristFlexionDeg)<=46;
 result.checks.throwSkinHandOpensAtRelease=cock.skinFingerCurlDeg>100&&release.skinFingerCurlDeg<cock.skinFingerCurlDeg-70;
 result.checks.throwPhysicalRecordDocumentsFingerRetarget=throwSpec.display.handPoseSource==='task-keyframe-retarget'&&release.physicsFingerCurlDeg>200;
 result.checks.throwKneeLoadsThenUnloads=cock.kneeDeg>release.kneeDeg+3&&release.kneeDeg>4;
 result.checks.throwArmExtendsAtRelease=release.elbowDeg<cock.elbowDeg-8;
 console.log('Throw phase checks:',JSON.stringify({coil,maximumCock,followThrough:result.chain.find(row=>row.time===throwTime('follow-through')),checks:result.checks},null,2));
 assert.equal(result.checks.pelvisLeadsTrunk,true);assert.equal(result.checks.forwardTrunkFollowThrough,true);
 assert.equal(result.checks.throwWristCocksAndReleases,true);assert.equal(result.checks.throwSkinHandOpensAtRelease,true);assert.equal(result.checks.throwPhysicalRecordDocumentsFingerRetarget,true);
 assert.equal(result.checks.throwKneeLoadsThenUnloads,true);assert.equal(result.checks.throwArmExtendsAtRelease,true);
 result.throwAudit=throwAudit;
 // Capture the actual WebGL canvas and a complete unloaded throw.
 const downloadPromise=page.waitForEvent('download');
 const videoBytes=await page.evaluate(async()=>{
  const e=window.__LAB__,canvas=e.renderer.domElement,stream=canvas.captureStream(30);
  const type=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm';
  const recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:4500000}),chunks=[];
  recorder.ondataavailable=event=>chunks.push(event.data);
  const stopped=new Promise(resolve=>recorder.onstop=()=>{const blob=new Blob(chunks,{type}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='baseball-throw.webm';document.body.append(link);link.click();link.remove();stream.getTracks().forEach(track=>track.stop());setTimeout(()=>URL.revokeObjectURL(url),2000);resolve(blob.size);});
  e.setView('threeQuarter');e.speed=1;e.loop=false;recorder.start();e.replay();
  const poll=setInterval(()=>{if(!e.playing){clearInterval(poll);setTimeout(()=>recorder.stop(),200);}},40);
  setTimeout(()=>{if(recorder.state==='recording'){clearInterval(poll);recorder.stop();}},12000);
  return stopped;
 });
 const download=await downloadPromise;await download.saveAs(outputFile('baseball-throw.webm'));result.video='baseball-throw.webm';result.videoBytes=fs.statSync(outputFile('baseball-throw.webm')).size;
 result.checks.fullActionVideo=videoBytes>100000&&result.videoBytes===videoBytes;assert.equal(result.checks.fullActionVideo,true);
 // Check the physical record and continuous skin both form a fist and use the wrist.
 const punchRow=page.locator('.motion-row').filter({hasText:'后手直拳'});await punchRow.click();
 await page.waitForFunction(()=>window.__LAB__?.physics?.ready&&!window.__LAB__.physicsLoading,{timeout:60000});
 await page.waitForTimeout(250);
 const fist=await page.evaluate(()=>{
  const e=window.__LAB__,r=e.physics;
  const quaternionAngleDeg=q=>2*Math.acos(Math.min(1,Math.abs(q.w)))*180/Math.PI;
  const distance=(point,a,b)=>{const axis=b.clone().sub(a),u=Math.max(0,Math.min(1,point.clone().sub(a).dot(axis)/axis.lengthSq()));return point.distanceTo(a.addScaledVector(axis,u));};
  const handBend=()=>e.rig.point('wrist_R').sub(e.rig.point('lowerarm01_R')).normalize().angleTo(e.rig.point('finger3-1_R').sub(e.rig.point('wrist_R')).normalize())*180/Math.PI;
  const saved=[...e.rig.bones].map(([name,bone])=>[name,bone.position.clone(),bone.quaternion.clone(),bone.scale.clone()]);
  e.rig.reset();const neutralHandBend=handBend();
  for(const [name,position,quaternion,scale] of saved){const bone=e.rig.bone(name);bone.position.copy(position);bone.quaternion.copy(quaternion);bone.scale.copy(scale);}
  e.rig.model.updateMatrixWorld(true);
  const frames=[.2,.48,.8,1.3,1.5,1.7,1.8,1.9,1.975,2.175,2.3,2.575].map(time=>{e.setPlaying(false);e.seek(time);e.rig.model.updateMatrixWorld(true);const wrist=e.rig.bone('wrist_R');
   const interior=(a,b,c)=>{const u=a.clone().sub(b).normalize(),v=c.clone().sub(b).normalize();return Math.acos(Math.max(-1,Math.min(1,u.dot(v))))*180/Math.PI;};
   const skinShoulder=e.rig.point('upperarm01_R'),skinElbow=e.rig.point('lowerarm01_R'),skinWrist=e.rig.point('wrist_R');
   const simShoulder=r.point('humerus_r'),simElbow=r.point('ulna_r'),simHand=r.point('lunate_r');
   const directionErrorDeg=skinWrist.clone().sub(skinShoulder).normalize().angleTo(simHand.clone().sub(simShoulder).normalize())*180/Math.PI;
   const tip=name=>{const entry=e.rig.info.bones.find(b=>b.name===name),bone=e.rig.bone(name);return wrist.worldToLocal(new (e.rig.point('wrist_R').constructor)().fromArray(entry.tail).sub(e.rig.rest.get(name)).applyMatrix4(bone.matrixWorld));};
   const thumbTip=tip('finger1-3_R'),indexProxBase=wrist.worldToLocal(e.rig.point('finger2-1_R'));let thumbIndexContactM=Infinity;
   for(let joint=1;joint<=3;joint++){const name=`finger2-${joint}_R`;thumbIndexContactM=Math.min(thumbIndexContactM,distance(thumbTip,wrist.worldToLocal(e.rig.point(name)),tip(name)));}
   return {time,hand:r.point('lunate_r').toArray(),
   pronationDeg:r.jointAngle('pro_sup_r'),wristFlexionDeg:r.jointAngle('flexion_r'),wristDeviationDeg:r.jointAngle('deviation_r'),
   skinElbowInteriorDeg:interior(skinShoulder,skinElbow,skinWrist),simElbowInteriorDeg:interior(simShoulder,simElbow,simHand),
   armDirectionErrorDeg:directionErrorDeg,
   skinUpperArmLengthM:skinShoulder.distanceTo(skinElbow),skinForearmLengthM:skinElbow.distanceTo(skinWrist),
   mcp3Deg:r.jointAngle('mcp3_flexion_r'),pip3Deg:r.jointAngle('pm3_flexion_r'),dip3Deg:r.jointAngle('md3_flexion'),
   skinMcp3Deg:quaternionAngleDeg(e.rig.bone('finger3-1_R').quaternion),
   skinPip3Deg:quaternionAngleDeg(e.rig.bone('finger3-2_R').quaternion),
   skinDip3Deg:quaternionAngleDeg(e.rig.bone('finger3-3_R').quaternion),
   skinWristBendFromRestDeg:Math.abs(handBend()-neutralHandBend),
   thumbOppositionDeg:r.jointAngle('cmc_abduction'),thumbMcpDeg:r.jointAngle('mp_flexion_r'),thumbIpDeg:r.jointAngle('ip_flexion_r'),thumbIndexContactM};});
  e.setView('threeQuarter');e.seek(1.7);e.rig.model.updateMatrixWorld(true);
  const leftWrist=e.rig.bone('wrist_L');
  const leftTip=name=>{const entry=e.rig.info.bones.find(b=>b.name===name),bone=e.rig.bone(name);return leftWrist.worldToLocal(new (e.rig.point('wrist_L').constructor)().fromArray(entry.tail).sub(e.rig.rest.get(name)).applyMatrix4(bone.matrixWorld));};
  const leftBase=name=>leftWrist.worldToLocal(e.rig.point(name));
  const leftPalmCenter=new (e.rig.point('wrist_L').constructor)();for(let digit=2;digit<=5;digit++)leftPalmCenter.add(leftBase(`finger${digit}-1_L`));leftPalmCenter.multiplyScalar(.25);
  const leftTipToPalmM=[];for(let digit=2;digit<=5;digit++)leftTipToPalmM.push(leftTip(`finger${digit}-3_L`).distanceTo(leftPalmCenter));
  const leftThumbTip=leftTip('finger1-3_L');let leftThumbIndexContactM=Infinity;
  for(let joint=1;joint<=3;joint++){const name=`finger2-${joint}_L`;leftThumbIndexContactM=Math.min(leftThumbIndexContactM,distance(leftThumbTip,leftWrist.worldToLocal(e.rig.point(name)),leftTip(name)));}
  return {frames,leftGuard:{tipToPalmM:leftTipToPalmM,maxTipToPalmCenterM:Math.max(...leftTipToPalmM),thumbIndexContactM:leftThumbIndexContactM},skin:{indexMcp:e.rig.bone('finger2-1_R').quaternion.angleTo(new (e.rig.bone('finger2-1_R').quaternion.constructor)())*180/Math.PI,
   middlePip:e.rig.bone('finger3-2_R').quaternion.angleTo(new (e.rig.bone('finger3-2_R').quaternion.constructor)())*180/Math.PI,
   middleDip:e.rig.bone('finger3-3_R').quaternion.angleTo(new (e.rig.bone('finger3-3_R').quaternion.constructor)())*180/Math.PI,
   upperArmLengthM:e.rig.rest.get('upperarm01_R').distanceTo(e.rig.rest.get('lowerarm01_R')),
   forearmLengthM:e.rig.rest.get('lowerarm01_R').distanceTo(e.rig.rest.get('wrist_R'))}};
 });
 result.punch=fist;
 await page.evaluate(()=>{const e=window.__LAB__;e.setPlaying(false);e.seek(1.7);e.setView('hand');});
 result.checks.handCameraTargetsPhysicsWrist=await page.evaluate(()=>window.__LAB__.controls.target.distanceTo(window.__LAB__.physics.point('lunate_r'))<.05);await page.waitForTimeout(250);
 await page.screenshot({path:outputFile('punch-fist-close.png')});result.punchHandClose='punch-fist-close.png';
 const peak=fist.frames.find(f=>f.time===1.7),hold=fist.frames.find(f=>f.time===1.975);result.checks.fistJointTargets=peak.skinMcp3Deg>45&&peak.skinPip3Deg>55&&peak.skinDip3Deg>25&&peak.thumbIndexContactM<.015;
 result.checks.wristMotion=Math.max(...fist.frames.map(f=>f.pronationDeg))-Math.min(...fist.frames.map(f=>f.pronationDeg))>10;
 result.checks.wristFlexesDuringPunch=Math.max(...fist.frames.map(f=>f.wristFlexionDeg))-Math.min(...fist.frames.map(f=>f.wristFlexionDeg))>3;
 const punchSpec=punchEnv.dynamics.action;
 const punchKey=phase=>punchSpec.reference.keyframes.find(frame=>frame.phase===phase).jointTargetsDeg;
 result.checks.wristAlignedAtExtension=punchSpec.display.handPoseSource==='task-keyframe-retarget'&&Math.abs(punchKey('full-extension').flexion_r)<=10&&peak.skinWristBendFromRestDeg<15&&hold.skinWristBendFromRestDeg<15;
 const throwRelease=result.chain.find(row=>row.time===throwTime('release'));
 result.checks.throwAndPunchHaveDifferentHandPaths=throwRelease.hand.reduce((sum,value,index)=>sum+(value-fist.frames.find(f=>f.time===1.7).hand[index])**2,0)**.5>.12;
 result.checks.thumbWrapsIndex=fist.frames.filter(f=>f.time>=1.7&&f.time<=2.3).every(f=>f.thumbIndexContactM<.015);
 result.checks.punchElbowMatchesMuscleState=fist.frames.filter(f=>f.time>=1.7&&f.time<=1.975).every(f=>Math.abs(f.skinElbowInteriorDeg-f.simElbowInteriorDeg)<2.5);
 result.checks.punchArmDirectionMatchesMuscleState=fist.frames.filter(f=>f.time>=1.7&&f.time<=1.975).every(f=>f.armDirectionErrorDeg<5);
 result.checks.skinArmLengthsStayFixed=fist.frames.every(f=>Math.abs(f.skinUpperArmLengthM-fist.skin.upperArmLengthM)<1e-5&&Math.abs(f.skinForearmLengthM-fist.skin.forearmLengthM)<1e-5);
 const recovery=fist.frames.find(f=>f.time===2.575);result.checks.handRemainsClosedDuringRecovery=recovery.skinMcp3Deg>=peak.skinMcp3Deg-10&&recovery.skinPip3Deg>=peak.skinPip3Deg-10&&recovery.skinDip3Deg>=peak.skinDip3Deg-10;
 result.checks.leftGuardFormsFist=fist.leftGuard.maxTipToPalmCenterM<.09&&fist.leftGuard.thumbIndexContactM<.02;
 const punchKeyFrames=fist.frames.filter(f=>[1.7,1.975,2.575].includes(f.time));
 console.log('Punch fist diagnostic:',JSON.stringify({checks:result.checks,keyFrames:punchKeyFrames},null,2));
 assert.equal(result.checks.fistJointTargets,true);assert.equal(result.checks.wristMotion,true);assert.equal(result.checks.wristFlexesDuringPunch,true);assert.equal(result.checks.wristAlignedAtExtension,true);assert.equal(result.checks.throwAndPunchHaveDifferentHandPaths,true);assert.equal(result.checks.thumbWrapsIndex,true);assert.equal(result.checks.punchElbowMatchesMuscleState,true);assert.equal(result.checks.punchArmDirectionMatchesMuscleState,true);assert.equal(result.checks.skinArmLengthsStayFixed,true);assert.equal(result.checks.handRemainsClosedDuringRecovery,true);assert.equal(result.checks.leftGuardFormsFist,true);
 await page.evaluate(()=>{const e=window.__LAB__;e.setView('threeQuarter');e.seek(1.7);});await page.waitForTimeout(200);
 await page.screenshot({path:outputFile('punch-extension.png')});result.punchExtension='punch-extension.png';
 await page.evaluate(()=>{const e=window.__LAB__;e.setView('hand');e.seek(1.975);});await page.waitForTimeout(200);
 await page.screenshot({path:outputFile('punch-fist-hold.png')});result.punchFistHold='punch-fist-hold.png';
 result.errors=errors;result.warnings=warnings;assert.deepEqual(errors,[]);
 atomicWriteFile(outputFile('dynamics-results.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({checks:result.checks,errors,warnings,poses:result.poses.length,videoBytes:result.videoBytes,punchKeyFrames},null,2));
}finally{await browser.close();}
