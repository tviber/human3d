import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {WRIST_RESIDUAL_FLAG_MM} from './motion-review.mjs';

/** Verify a workshop-capture `--bundle` output as a real review loop, not just
 * as a set of files (issue #32 review): the manifest must carry bundle
 * identity, every referenced screenshot must exist, both wrists at every
 * midpoint are computed against THAT frame's interpolated targets and stay
 * under the flag threshold, at least one midpoint proves the interpolated
 * target is genuinely different from its nearest key target (the regression
 * that made healthy midpoints report `ik-clamp`), and `motion-review init` →
 * unviewed → `check` must block. Pure Node: the browser part is the caller's
 * `workshop-capture` run, so this verifies the artifacts it left behind. */

/** Minimum distance (m) between a midpoint's interpolated wrist target and its
 * nearest key's stored target. The issue-32 fixture moves ~0.3 m between keys,
 * so 5 cm is loose enough for the real document and far tighter than the
 * multi-centimetre error the nearest-key confusion produced. */
export const MIDPOINT_TARGET_DELTA_M=.05;

const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const WRIST_SIDES=['right','left'];

/** Structural + numeric checks. Returns a report or throws with every problem. */
export function verifyReviewBundleCapture(outputDir,{run=spawnSync,repoRoot=process.cwd()}={}){
 const problems=[];
 const fail=message=>problems.push(message);
 const dir=path.resolve(outputDir);
 const manifestPath=path.join(dir,'manifest.json');
 if(!fs.existsSync(manifestPath))throw new Error(`no manifest.json in ${dir}`);
 const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 if(manifest.kind!=='workshop-review-bundle')fail('manifest.kind 必须是 workshop-review-bundle（capture --bundle）');
 if(!manifest.bundle?.docDigest)fail('缺少 bundle.docDigest');
 if(!manifest.bundle?.revision)fail('缺少 bundle.revision');
 const shots=Array.isArray(manifest.shots)?manifest.shots:[];
 if(!shots.length)fail('manifest 没有 shots');
 for(const shot of shots){
  if(!fs.existsSync(path.join(dir,shot.file??'')))fail(`截图缺失：${shot.file}`);
 }
 const midpoints=shots.filter(shot=>shot.shotRole==='midpoint');
 if(!midpoints.length)fail('manifest 没有 midpoint 截图——审阅包必须覆盖关键帧区间中点');
 const wristSamples=[];
 for(const shot of midpoints){
  for(const side of WRIST_SIDES){
   const solved=shot.solved?.[side];
   const mm=solved?.wristResidualMm;
   if(!Number.isFinite(mm)){fail(`${shot.file}: 缺少 ${side}.wristResidualMm`);continue;}
   wristSamples.push({file:shot.file,time:shot.time,side,mm});
   if(mm>WRIST_RESIDUAL_FLAG_MM)fail(`${shot.file}: ${side} 中点腕残差 ${mm} mm > ${WRIST_RESIDUAL_FLAG_MM} mm`);
   if(!Array.isArray(solved.wristTarget)||!Array.isArray(solved.nearestKeyTarget))
    fail(`${shot.file}: 缺少 ${side}.wristTarget/${side}.nearestKeyTarget，无法证明残差用的是插值帧目标`);
  }
 }
 const distinct=midpoints.flatMap(shot=>WRIST_SIDES.map(side=>({shot,side,solved:shot.solved?.[side]})))
  .find(({solved})=>Array.isArray(solved?.wristTarget)&&Array.isArray(solved?.nearestKeyTarget)
   &&distance(solved.wristTarget,solved.nearestKeyTarget)>=MIDPOINT_TARGET_DELTA_M);
 if(!distinct)fail(`没有任何中点左右腕的插值目标与最近关键帧目标相差 ≥${MIDPOINT_TARGET_DELTA_M*100} cm——残差可能仍按最近关键帧目标计算`);

 let initExit=null,checkExit=null,unviewed=null;
 if(!problems.length){
  const json=args=>run(process.execPath,args,{cwd:repoRoot,encoding:'utf8'});
  const init=json(['scripts/motion-review.mjs','init',manifestPath]);
  initExit=init.status;
  const reviewPath=path.join(dir,'review.json');
  if(init.status!==0)fail(`motion-review init 失败：${init.stderr||init.stdout}`);
  else if(!fs.existsSync(reviewPath))fail('motion-review init 没有生成 review.json');
  else{
   const review=JSON.parse(fs.readFileSync(reviewPath,'utf8'));
   unviewed=review.shots.filter(shot=>shot.visual===null).length;
   if(review.shots.length!==shots.length)fail(`review.json 的 shot 数 ${review.shots.length} ≠ manifest ${shots.length}`);
   if(unviewed!==review.shots.length)fail('init 骨架不应带已查看状态');
   const check=json(['scripts/motion-review.mjs','check',reviewPath]);
   checkExit=check.status;
   const out=`${check.stdout??''}${check.stderr??''}`;
   if(check.status!==1)fail(`未查看的 review 必须以退出码 1 拦截，实际 ${check.status}`);
   if(out.includes('判定: PASS'))fail('未查看的 review 被判定为 PASS');
   if(!/未查看|INVALID/.test(out))fail('check 没有报告未查看的 shot');
  }
 }
 if(problems.length)throw new Error(`review bundle 验收失败：\n  - ${problems.join('\n  - ')}`);
 const sample=distinct.solved;
 return {kind:'h3d-review-bundle-browser-qa',version:1,
  docDigest:manifest.bundle.docDigest,shots:shots.length,midpoints:midpoints.length,
  files:shots.map(shot=>shot.file),
  midpointWristResiduals:wristSamples,
  interpolatedTargetCheck:{file:distinct.shot.file,time:distinct.shot.time,side:distinct.side,
   nearestKeyTargetDeltaM:+distance(sample.wristTarget,sample.nearestKeyTarget).toFixed(4),
   wristResidualMm:sample.wristResidualMm},
  review:{initExit,checkExit,unviewedShots:unviewed,blockedAsRequired:checkExit===1}};
}
