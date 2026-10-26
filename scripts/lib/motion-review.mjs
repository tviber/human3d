import fs from 'node:fs';
import path from 'node:path';

/** Structured motion-review record + bounded-rework gate (issue #32 B3/B5).
 * `init` turns a workshop-capture `--bundle` manifest into a review.json
 * skeleton whose every shot MUST be looked at before `check` will pass; the
 * agent fills visual verdicts and findings, `check` enforces the contract:
 * complete viewing ledger, the five failure categories from the issue, a
 * suggestion AND an explicit uncertainty note per finding, and the rework
 * bound — round > 3 only with a human handoff block. No composite quality
 * score: numbers are carried as evidence, judgements are explicit.
 *
 * review.json is a sibling of the #23 session review-feedback
 * (kind 'h3d-review-feedback') — same vocabulary idea (time/keyId/view/part),
 * but this one is the machine-checkable loop record. */

export const REVIEW_KIND='h3d-motion-review';
export const REVIEW_VERSION=1;
export const MAX_ROUNDS=3;
/** Wrist-target residual above this is surfaced as a numeric finding
 * automatically (solve could not reach the authored target). */
export const WRIST_RESIDUAL_FLAG_MM=5;
export const FAILURE_CATEGORIES=['side-view-wrong','deviates-from-reference','ik-clamp','penetration-contact-drift','reference-unjudgeable'];
export const CATEGORY_NOTES={
 'side-view-wrong':'左右侧别或视角错了',
 'deviates-from-reference':'末端可达但明显偏离参考',
 'ik-clamp':'IK clamp / 限位',
 'penetration-contact-drift':'肢体穿透或脚接触漂移',
 'reference-unjudgeable':'参考未标定/遮挡，无法判定',
};

/** Build the skeleton review record from a capture-bundle manifest. */
export function initReview(manifest,{round=1,reference}={}){
 if(manifest.kind!=='workshop-review-bundle')throw new Error('需要 workshop-capture --bundle 生成的 manifest（含文档摘要与 key/midpoint 角色）');
 const shots=manifest.shots.map(s=>({file:s.file,time:s.time,view:s.view,keyId:s.nearestKey?.id??null,
  shotRole:s.shotRole??'key',visual:null,note:''}));
 const residuals=[];
 for(const s of manifest.shots){
  for(const side of ['right','left']){
   const mm=s.solved?.[side]?.wristResidualMm;
   if(Number.isFinite(mm)&&mm>WRIST_RESIDUAL_FLAG_MM)
    residuals.push({file:s.file,time:s.time,view:s.view,side:side==='right'?'R':'L',mm});
  }
 }
 const findings=residuals.map((r,i)=>({id:`F${i+1}`,time:r.time,keyId:null,view:r.view,
  part:`腕（${r.side}）`,category:'ik-clamp',auto:true,
  numericSource:{...r},
  evidence:`wristResidualMm ${r.mm}（>${WRIST_RESIDUAL_FLAG_MM}，来自 capture manifest ${r.file}）`,
  solveStatus:'numeric-invalid',referenceStatus:'unverified',
  suggestion:'先查目标是否超出臂长/限位（语义调整或收近目标），再复跑生产求解',uncertainty:''}));
 return {kind:REVIEW_KIND,version:REVIEW_VERSION,round,
  docDigest:manifest.bundle?.docDigest??null,revision:manifest.bundle?.revision??null,
  doc:manifest.document,capture:{manifestSource:null,shots:shots.length,views:manifest.views},
  reference:reference??{available:false,aligned:false,note:'无参考帧或相机未标定：一切「接近参考」的结论都只能是 unverified'},
  shots,findings,
  numerical:{worstWristResidualMm:residuals.length?Math.max(...residuals.map(r=>r.mm)):0,flagged:residuals},
  handoff:null};
}

/** Validate a filled review record. Returns every contract violation. */
export function checkReview(review){
 const problems=[];
 const fail=(m)=>problems.push(m);
 if(review?.kind!==REVIEW_KIND||review?.version!==REVIEW_VERSION)fail(`必须是 ${REVIEW_KIND} v${REVIEW_VERSION}`);
 if(!Array.isArray(review.shots)||review.shots.length===0)fail('没有 shots——先用 init 从 capture manifest 生成');
 if(review.findings!==undefined&&!Array.isArray(review.findings))fail('findings 必须是数组');
 const shots=Array.isArray(review.shots)?review.shots:[];
 const findings=Array.isArray(review.findings)?review.findings:[];
 let unseen=0,unnoted=0;
 for(const s of shots){
  if(!s||typeof s!=='object'){fail('shot 必须是对象');continue;}
  if(s.visual===null){unseen++;continue;}
  if(!['ok','suspect'].includes(s.visual))fail(`${s.file}: visual 必须是 ok 或 suspect`);
  if(s.visual==='suspect'&&!String(s.note||'').trim())unnoted++;
 }
 if(unseen)fail(`${unseen} 张图未查看（visual 为空）——必须逐张实际查看，不允许只凭数值全绿宣布正确`);
 if(unnoted)fail(`${unnoted} 张 suspect 的图缺少说明（note）`);
 const findingIds=new Set();
 for(const f of findings){
  if(!f||typeof f!=='object'){fail('finding 必须是对象');continue;}
  const at=`findings[${f.id??'?'}]`;
  findingIds.add(f.id);
  if(!FAILURE_CATEGORIES.includes(f.category))fail(`${at}: category 必须是 ${FAILURE_CATEGORIES.join(' | ')} 之一`);
  if(!['numeric-valid','numeric-invalid'].includes(f.solveStatus))fail(`${at}: solveStatus 必须是 numeric-valid 或 numeric-invalid`);
  if(!['unverified','consistent','inconsistent'].includes(f.referenceStatus))fail(`${at}: referenceStatus 必须是 unverified | consistent | inconsistent`);
  if(!String(f.evidence||'').trim())fail(`${at}: 缺少 evidence（测量值或截图文件名）`);
  if(!String(f.suggestion||'').trim())fail(`${at}: 缺少 suggestion（建议下一步）`);
  if(!String(f.uncertainty||'').trim())fail(`${at}: 缺少 uncertainty（写「无」也要显式写）`);
  if(f.category==='deviates-from-reference'&&f.referenceStatus==='unverified')
   fail(`${at}: 声称偏离参考但参考是 unverified——改为 reference-unjudgeable 或先说明可判定的依据`);
 }
 const round=review.round;
 if(!Number.isInteger(round)||round<1)fail('round 必须是 ≥1 的整数');
 const flagged=review?.numerical?.flagged;
 if(!Array.isArray(flagged))fail('numerical.flagged 必须是数组；请从最新 capture manifest 重新 init');
 const flaggedResiduals=Array.isArray(flagged)?flagged:[];
 for(const residual of flaggedResiduals){
  if(!residual||typeof residual!=='object'){
   fail('numerical.flagged 每项必须是腕残差对象；请重新 capture/init');
   continue;
  }
  const linked=findings.some(f=>f&&typeof f==='object'&&f.auto===true
   &&f.category==='ik-clamp'&&f.numericSource
   &&f.numericSource.file===residual.file&&f.numericSource.time===residual.time
   &&f.numericSource.view===residual.view&&f.numericSource.side===residual.side
   &&f.numericSource.mm===residual.mm);
  if(!linked)fail(`numerical.flagged ${residual?.file??'?'}（${residual?.side??'?'}腕 ${residual?.mm??'?'} mm）缺少对应的自动 ik-clamp finding；请重新 capture/init，不能只删除 finding`);
 }
 const automaticFindings=findings.filter(f=>f&&typeof f==='object'&&f.auto===true&&f.numericSource);
 for(const finding of automaticFindings){
  const linked=flaggedResiduals.some(r=>r&&r.file===finding.numericSource.file&&r.time===finding.numericSource.time
   &&r.view===finding.numericSource.view&&r.side===finding.numericSource.side&&r.mm===finding.numericSource.mm);
  if(!linked)fail(`findings[${finding.id??'?'}] 的自动数值来源不在 numerical.flagged 中；请重新 capture/init`);
 }
 for(const residual of flaggedResiduals){
  if(!Number.isFinite(residual?.mm)||residual.mm<=WRIST_RESIDUAL_FLAG_MM)
   fail('numerical.flagged 只能包含超过阈值的有限腕残差；请重新 capture/init');
 }
 const realFindings=findings.filter(f=>f&&typeof f==='object'&&f.category!=='reference-unjudgeable');
 const handoff=review.handoff;
 const validHandoff=!!handoff&&Array.isArray(handoff.reasons)&&handoff.reasons.length>0
  &&Array.isArray(handoff.humanItems)&&handoff.humanItems.length>0;
 if(round>MAX_ROUNDS&&!validHandoff)
  fail(`round ${round} 已超过 ${MAX_ROUNDS} 轮上限：必须填写 handoff{reasons,humanItems} 移交人工，不允许继续调角度`);
 const verdict=round<=MAX_ROUNDS&&!flaggedResiduals.length&&!problems.length&&!realFindings.length
  &&shots.every(s=>s&&s.visual==='ok')?'pass':'fail-with-handoff';
 if(verdict==='fail-with-handoff'){
  if(round<=MAX_ROUNDS&&!handoff&&realFindings.length&&round===MAX_ROUNDS)
   fail(`第 ${MAX_ROUNDS} 轮仍有 ${realFindings.length} 个未解决问题且没有 handoff——修复并开下一轮，或写 handoff 移交`);
 }
 const valid=problems.length===0;
 return {valid,ok:valid&&verdict==='pass',verdict,problems};
}

/** init CLI: read manifest, write skeleton beside it. */
export function initFromManifestFile(manifestPath,{round,referenceFrames=[],out}={}){
 const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 const reference=referenceFrames.length
  ?{available:true,aligned:false,frames:referenceFrames,note:'相机未标定：视觉并排相似不等于重投影一致'}
  :undefined;
 const review=initReview(manifest,{round,reference});
 review.capture.manifestSource=path.basename(manifestPath);
 const target=out??path.join(path.dirname(path.resolve(manifestPath)),'review.json');
 fs.writeFileSync(target,JSON.stringify(review,null,2)+'\n');
 return {review,target};
}

/** check CLI: load, validate, report; exit code comes from ok. */
export function checkReviewFile(reviewPath){
 const review=JSON.parse(fs.readFileSync(reviewPath,'utf8'));
 return {review,result:checkReview(review)};
}
