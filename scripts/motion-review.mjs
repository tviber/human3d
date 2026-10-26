import fs from 'node:fs';
import {initFromManifestFile,checkReviewFile,MAX_ROUNDS,FAILURE_CATEGORIES,CATEGORY_NOTES} from './lib/motion-review.mjs';

// Issue #32 B3/B5: structured review record + bounded rework gate.
//
//   node scripts/motion-review.mjs init <manifest.json> [--round 1]
//        [--reference ref.png …] [--out review.json]
//     → skeleton from a workshop-capture --bundle manifest. Then ACTUALLY LOOK
//       at every shot image; fill shots[].visual (ok|suspect, note when
//       suspect) and findings[] (category/evidence/suggestion/uncertainty).
//
//   node scripts/motion-review.mjs check <review.json>
//     → enforces: every shot viewed, findings complete, reference claims
//       honest, round ≤ 3 (beyond only with a handoff block). Exit 1 on any
//       violation — green tests alone never make this pass.
const args=process.argv.slice(2);
const cmd=args.shift();
try{
 if(cmd==='init'){
  const manifest=args.shift();
  if(!manifest||!fs.existsSync(manifest))throw new Error('用法: motion-review.mjs init <manifest.json> [--round N] [--reference ref.png …] [--out file]');
  const round=args.includes('--round')?Number(args[args.indexOf('--round')+1]):1;
  const referenceFrames=args.flatMap((a,i)=>args[i-1]==='--reference'?[a]:[]);
  const out=args.includes('--out')?args[args.indexOf('--out')+1]:undefined;
  const{review,target}=initFromManifestFile(manifest,{round,referenceFrames,out});
  console.log(`review 骨架 → ${target}（${review.shots.length} 张待查看 · ${review.findings.length} 条自动数值发现 · round ${review.round}）`);
  console.log('下一步：逐张查看 shots[].file 对应图片，填写 visual/note/findings，然后 check。');
 }else if(cmd==='check'){
  const file=args.shift();
  if(!file)throw new Error('用法: motion-review.mjs check <review.json>');
  const{review,result}=checkReviewFile(file);
  if(result.problems.length)for(const p of result.problems)console.error(`  ✗ ${p}`);
  console.log(`round ${review.round}/${MAX_ROUNDS} · 判定: ${result.ok?'PASS':'FAIL（'+result.verdict+'）'}`);
  process.exit(result.ok?0:1);
 }else{
  console.error(`未知命令 ${cmd??''}。类别对照：${FAILURE_CATEGORIES.map(c=>`${c}=${CATEGORY_NOTES[c]}`).join(' · ')}`);
  console.error('用法: motion-review.mjs init <manifest.json> [opts] | check <review.json>');
  process.exit(2);
 }
}catch(e){console.error(e instanceof Error?e.message:String(e));process.exit(2);}
