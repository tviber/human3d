import fs from 'node:fs';
import path from 'node:path';
import {verifyReviewBundleCapture,MIDPOINT_TARGET_DELTA_M} from './lib/review-bundle-qa.mjs';

// Issue #32 review acceptance: verify that a REAL browser capture produced a
// complete, numerically honest review bundle and that the review gate then
// blocks it. Run after scripts/workshop-capture.mjs --bundle on a machine that
// may run Chromium (CI); the checks themselves are pure Node.
//
//   node scripts/review-bundle-browser-qa.mjs <capture-output-dir>
const outputDir=process.argv[2];
if(!outputDir||process.argv.length!==3){
 console.error('usage: node scripts/review-bundle-browser-qa.mjs <capture-output-dir>');
 process.exit(2);
}
try{
 const result=verifyReviewBundleCapture(outputDir);
 const target=path.join(path.resolve(outputDir),'review-bundle-browser-qa.result.json');
 fs.writeFileSync(target,`${JSON.stringify(result,null,2)}\n`);
 console.log(`✓ ${result.shots} 张截图（${result.midpoints} 个中点）· 中点腕残差 ≤5 mm · 插值目标差 ${result.interpolatedTargetCheck.nearestKeyTargetDeltaM} m（≥${MIDPOINT_TARGET_DELTA_M} m）`);
 console.log(`✓ motion-review init(${result.review.initExit}) → 未查看 ${result.review.unviewedShots} 张 → check(${result.review.checkExit}) 已拦截`);
 console.log(`✓ 正向契约样例：完整填写 ${result.review.completeLedgerShots}/${result.shots} 张截图 → check(PASS/${result.review.completeLedgerExit})`);
 console.log(`→ ${target}`);
}catch(error){
 console.error(error instanceof Error?error.message:String(error));
 process.exit(1);
}
