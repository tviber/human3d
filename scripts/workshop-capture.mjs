import {chromium} from 'playwright';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {resolveOutputDir,ensureOutputDir,assertTrackedWriteAllowed,atomicWriteFile} from './lib/qa-output.mjs';
import {verifyWebIdentity} from './lib/worktree-check.mjs';

// Render one motion document to still images through the workshop's REAL
// capture path (WorkshopEngine.captureStill: pause → snapshot → seek + solve →
// fixed camera → toBlob → restore). The document is loaded through the visible
// "导入" file input, never by injecting engine state, so every image is the
// same pixels the user's 渲染静帧 button produces.
//
//   node scripts/workshop-capture.mjs <doc.json> [--times 0,0.54,1.2]
//        [--views front,side,back,threeQuarter] [--labels a,b,c] [--tag name]
//        [--bundle]
//
// Times default to the document's key times; labels default to the key labels.
// --bundle (issue #32 B1) captures a REVIEW BUNDLE instead: key times ∪
// interval midpoints, default views front,side,threeQuarter (front/side for
// the pose, the oblique view to expose occlusion/depth), per-shot key/midpoint
// role and a document digest (same sha-256 form as the pose package's
// definition-hash document side) so every image traces back to the exact
// authored document. Feed the manifest to scripts/motion-review.mjs.
// Output: <dir>/<tag>-t<time>-<view>.png plus manifest.json with the document
// id/name, per-key constraint flags and the solved wrist/elbow/racket readings,
// so a reviewer can tie an image back to the numbers that produced it.
import {timesForBundle,shotRole,bundleBlock} from './lib/review-bundle.mjs';
const repoRoot=process.cwd();
const output=resolveOutputDir('visual-capture',process.argv.slice(2),repoRoot,process.env);
const args=output.args;
const flags={times:'',views:'',labels:'',tag:'',bundle:false};
const positional=[];
for(let i=0;i<args.length;i++){
 const arg=args[i];
 if(arg.startsWith('--')){
  const name=arg.slice(2);
  if(name==='bundle'){flags.bundle=true;continue;}
  if(!(name in flags))throw new Error(`unknown option --${name}`);
  if(i+1>=args.length||args[i+1].startsWith('--'))throw new Error(`--${name} requires a value`);
  flags[name]=args[++i];
 }else positional.push(arg);
}
if(positional.length!==1)throw new Error('usage: node scripts/workshop-capture.mjs <doc.json> [options]');
const docPath=path.resolve(repoRoot,positional[0]);
const raw=JSON.parse(fs.readFileSync(docPath,'utf8'));
// Accept a bare document, a workshop-motion envelope, or an exported library.
const doc=raw.kind==='workshop-motion'?raw.document
 :Array.isArray(raw.docs)?raw.docs.find(d=>d.id===raw.activeId)??raw.docs[0]
 :raw;
if(!doc||doc.schemaVersion!==2||!Array.isArray(doc.keys))throw new Error(`${positional[0]} does not contain a workshop document`);
const tag=flags.tag||doc.id||'doc';
const views=flags.views?flags.views.split(',').filter(Boolean)
 :flags.bundle?['front','side','threeQuarter']
 :['front','side','back','threeQuarter'];
const labels=flags.labels?flags.labels.split(','):[];
const times=flags.times
 ?flags.times.split(',').map(Number)
 :flags.bundle?timesForBundle(doc)
 :doc.keys.map(k=>k.time);
if(times.some(t=>!Number.isFinite(t)||t<0||t>doc.duration+1e-9))throw new Error(`--times must be numbers within [0, ${doc.duration}]`);

ensureOutputDir(output.dir,{root:repoRoot,updateEvidence:output.updateEvidence});
const outFile=name=>assertTrackedWriteAllowed(path.join(output.dir,name),{root:repoRoot,updateEvidence:output.updateEvidence});
const webBase=new URL(process.env.QA_WEB_URL??`http://127.0.0.1:${process.env.HUMAN3D_WEB_PORT??5173}/`);
const identity=await verifyWebIdentity(repoRoot,webBase);
if(!identity.ok)throw new Error(`dev server at ${webBase.origin} does not serve this checkout (${identity.detail})`);

const browser=await launchQaBrowser(chromium,{...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
try{
 const page=await browser.newPage({viewport:{width:1536,height:1024},deviceScaleFactor:1});
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(new URL('/workshop.html',webBase).href);
 await page.waitForFunction(()=>window.__WS__?.ready,{timeout:60000});
 await page.evaluate(()=>window.__WS__.setPlaying(false));
 // Import through the real hidden file input behind 导入动作. The card has a
 // second .json input (从备份恢复), so target the import one by position — the
 // same ordering the library QA suites rely on — instead of accepting both.
 const fileInputs=page.locator('input[type=file][accept=".json,application/json"]');
 if(await fileInputs.count()!==2)throw new Error(`workshop import card changed: expected 2 JSON inputs, found ${await fileInputs.count()}`);
 await fileInputs.first().setInputFiles({
  name:`${tag}.json`,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc)),
 });
 await page.waitForFunction(id=>window.__WS__.getDoc()?.id===id,doc.id,{timeout:30000});
 await page.evaluate(()=>window.__WS__.setPlaying(false));
 // The page normalized the document on import (parseDoc); digest THAT form so
 // the bundle identity matches what the pose-package pipeline would see.
 const normalizedDoc=flags.bundle?JSON.parse(await page.evaluate(()=>JSON.stringify(window.__WS__.getDoc()))):null;

 const shots=[];
 for(let i=0;i<times.length;i++){
  const time=Math.min(doc.duration,times[i]);
  for(const view of views){
   const payload=await page.evaluate(async({time,view})=>{
    const e=window.__WS__;
    // Seek + solve first so the geometry read below is the pose captureStill
    // will render; captureStill's own snapshot then restores to this same
    // time, so the read and the pixels describe one frame.
    e.seek(time);e.solveCurrent();
    const solvedFrame=e.latestFrame;
    // Read the solved frame the image was rendered from (same playhead time).
    const rig=e.rig;
    const vec=n=>rig.point(n).toArray().map(v=>Math.round(v*1e4)/1e4);
    const doc=e.getDoc();
    const key=doc.keys.reduce((best,k)=>Math.abs(k.time-time)<Math.abs(best.time-time)?k:best,doc.keys[0]);
    // Plausibility readings that a reviewer can check against the image:
    // elbow flexion, upper-arm elevation above horizontal and azimuth in the
    // torso frame, and the wrist-target residual (0 means the IK reached it).
    const read=(side)=>{
      const S=rig.point(`upperarm01_${side}`),E=rig.point(`lowerarm01_${side}`),W=rig.point(`wrist_${side}`);
      const V=rig.point(`upperarm01_${side}`).constructor;
      const upper=E.clone().sub(S),fore=W.clone().sub(E);
      const elbow=upper.angleTo(fore)*180/Math.PI;
      const off=rig.point(`upperarm01_${side==='R'?'L':'R'}`);
      const out=off.clone().sub(S);out.y=0;out.normalize();
      const front=side==='R'?new V().crossVectors(out,new V(0,1,0)):new V().crossVectors(new V(0,1,0),out);
      front.normalize();
      const u=upper.clone().normalize();
      const elev=Math.asin(Math.max(-1,Math.min(1,u.y)))*180/Math.PI;
      const az=Math.atan2(u.dot(out),u.dot(front))*180/Math.PI;
      const hand=side==='R'?key.pose.handR:key.pose.handL;
      const effectiveHand=side==='R'?solvedFrame.pose.handR:solvedFrame.pose.handL;
      const target=new V(effectiveHand.target.x,effectiveHand.target.y,effectiveHand.target.z);
      const keyTarget=new V(hand.target.x,hand.target.y,hand.target.z);
      const shoulderToWrist=S.distanceTo(W);
      return {elbow:+elbow.toFixed(1),upperElevation:+elev.toFixed(1),upperAzimuth:+az.toFixed(1),
       wristResidualMm:Math.round(W.distanceTo(target)*1000),wristTarget:target.toArray().map(v=>+v.toFixed(4)),
       nearestKeyTarget:keyTarget.toArray().map(v=>+v.toFixed(4)),shoulderToWrist:+shoulderToWrist.toFixed(3),
       wrist:vec(`wrist_${side}`),elbowPos:vec(`lowerarm01_${side}`)};
    };
    const tip=e.racket?e.racket.localToWorld(new e.racket.position.constructor(0,.61,0)):undefined;
    const solved={right:read('R'),left:read('L'),
     ...(tip?{tip:tip.toArray().map(v=>Math.round(v*1e4)/1e4)}:{})};
    const blob=await e.captureStill(time,{view});
    const bytes=new Uint8Array(await blob.arrayBuffer());
    let binary='';
    for(let k=0;k<bytes.length;k+=0x8000)binary+=String.fromCharCode(...bytes.subarray(k,k+0x8000));
    return {png:btoa(binary),time,view,restoredTime:e.time,solved,
     nearestKey:{id:key.id,label:key.label,time:key.time,delta:Math.round((time-key.time)*1e4)/1e4,constraints:key.constraints},
     gripSide:doc.gripSide??'R'};
   },{time,view});
   const label=labels[i]??payload.nearestKey.label??'';
   const slug=(label||'k').replace(/[^\p{L}\p{N}]+/gu,'-');
   const file=`${tag}-t${time.toFixed(3)}-${slug}-${view}.png`;
   fs.writeFileSync(outFile(file),Buffer.from(payload.png,'base64'));
   delete payload.png;
   shots.push({...payload,file,label,...(flags.bundle?{shotRole:shotRole(doc,time)}:{})});
  }
 }
 if(errors.length)throw new Error(`workshop page reported errors: ${errors.join(' | ')}`);
 const manifest={date:new Date().toISOString(),url:page.url(),webIdentity:identity,
  ...(flags.bundle?{kind:'workshop-review-bundle'}:{}),
  document:{id:doc.id,name:doc.name,duration:doc.duration,keys:doc.keys.length,gripSide:doc.gripSide??'R',handFrames:doc.handFrames},
  ...(flags.bundle?{bundle:bundleBlock({doc,normalizedDoc,docPath:path.relative(repoRoot,docPath)})}:{}),
  source:path.relative(repoRoot,docPath),views,shots};
 atomicWriteFile(outFile('manifest.json'),`${JSON.stringify(manifest,null,2)}\n`);
 console.log(JSON.stringify({output:output.dir,shots:shots.map(s=>({file:s.file,time:s.time,view:s.view,label:s.label,nearestKey:s.nearestKey.id,delta:s.nearestKey.delta}))},null,2));
}finally{await browser.close();}
