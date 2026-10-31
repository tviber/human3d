// Experimental deterministic constraint-trajectory optimizer CLI — a thin shell over
// packages/motion-core/src/generate.ts (the metric implementation is shared
// with vitest via measureDoc/evalDetail — no second copy, learning[4]).
// Results describe measured constraint/trajectory changes; they do not claim
// that a motion is natural.
//
// Usage: npx tsx scripts/generate-motion.mts [forehand|squat|forehand-detuned|squat-detuned|all]
//   forehand          spec/examples/forehand-study.request.json 的文档，
//                     ready/contact 键锁定，tip=attachRacket(gripSide,gripBevel,gripTilt)
//   squat             motionFileById('squat') 在 [0,1.6,2.8,4.8,5.6] 的子采样
//                     （双脚全程支撑，无 contact → 不带 tip）
//   *-detuned         先经 applyGenMove 施加恰好一个晶格步的损伤
//                     （forehand: k-back retime +B；squat: sub2 trunk phase +P），
//                     再对受损文档跑同一优化器
//
// 每个 case 默认写入 .out/<worktree>/<run>/generate-motion/，可用 --out-dir 覆盖；
// 写入跟踪文件需要显式传 --update-evidence。stdout 打印 A/B 摘要。
import fs from 'node:fs';
import path from 'node:path';
import {createService} from '@human3d/server';
import {attachRacket,motionFileById,generateMotion,subsampleDoc,
 buildGenContext,applyGenMove,retimeStep,
 type ChannelGroup,type MotionGenResult,type WorkshopDoc} from '@human3d/motion-core';
import {resolveOutputDir,assertTrackedWriteAllowed,atomicWriteFile,ensureOutputDir} from './lib/qa-output.mjs';

const root=process.cwd();
const output=resolveOutputDir('generate-motion',process.argv.slice(2),root,process.env);
const outputFile=name=>assertTrackedWriteAllowed(path.join(output.dir,name),{root,updateEvidence:output.updateEvidence});
const which=output.args[0]??'all';
const ctx=await createService(path.resolve('public'));
ensureOutputDir(output.dir,{root,updateEvidence:output.updateEvidence});

const forehandSrc=()=>(JSON.parse(fs.readFileSync('spec/examples/forehand-study.request.json','utf8'))
 .action.parameters.document)as WorkshopDoc;
const squatSrc=()=>subsampleDoc(motionFileById('squat')!.document!,[0,1.6,2.8,4.8,5.6],ctx.rig.rest);
const FOREHAND_LOCKS=['k-ready','k-contact'];

/* Detune: exactly ONE lattice step of damage, applied through the same move
 * machinery the optimizer uses (exported for this purpose + tests). */
const detuneRetime=(doc:WorkshopDoc,keyId:string,locked:string[])=>{
 const g=buildGenContext(ctx.rig,doc,{lockedKeyIds:locked});
 const B=retimeStep(g,doc,keyId);
 const out=applyGenMove(g,doc,{kind:'retime',keyId,delta:B});
 if(!out)throw new Error(`detune retime ${keyId} +${B}s 非法`);
 return{doc:out,damage:`retime ${keyId} +${B.toFixed(3)}s`};
};
const detunePhase=(doc:WorkshopDoc,keyId:string,group:ChannelGroup)=>{
 const g=buildGenContext(ctx.rig,doc);
 const out=applyGenMove(g,doc,{kind:'phase',keyId,group,offset:g.maxPhaseShift});
 if(!out)throw new Error(`detune phase ${keyId}:${group} +${g.maxPhaseShift}s 非法`);
 return{doc:out,damage:`phase ${keyId}:${group} +${g.maxPhaseShift}s`};
};

interface Case{build:()=>{doc:WorkshopDoc;damage?:string};lockedKeyIds?:string[];tip:boolean}
const CASES:Record<string,Case>={
 forehand:{build:()=>({doc:forehandSrc()}),lockedKeyIds:FOREHAND_LOCKS,tip:true},
 squat:{build:()=>({doc:squatSrc()}),tip:false},
 'forehand-detuned':{build:()=>detuneRetime(forehandSrc(),'k-back',FOREHAND_LOCKS),
  lockedKeyIds:FOREHAND_LOCKS,tip:true},
 'squat-detuned':{build:()=>detunePhase(squatSrc(),'sub2','trunk'),tip:false},
};
const ids=which==='all'?Object.keys(CASES):[which];

let racket:ReturnType<typeof attachRacket>|undefined;
for(const id of ids){
 const c=CASES[id];
 if(!c){console.log(`${id}: 未知 case（可选 ${Object.keys(CASES).join('|')}|all）`);process.exitCode=1;continue;}
 const dmg=c.build();
 const doc=dmg.doc;
 /* attachRacket 于 gripSide 腕部 —— 同一把球拍对象在多次探测间复用，
  * tip.parent===wrist_<gs> 的软校验在 emit 门禁里记录。 */
 if(c.tip&&!racket)racket=attachRacket(ctx.rig,doc.gripSide==='L'?'L':'R',doc.gripBevel,doc.gripTilt);
 const res:MotionGenResult=generateMotion(ctx.rig,{doc,lockedKeyIds:c.lockedKeyIds,tip:c.tip?racket:undefined});

 const d=res.diagnostics;
 console.log(`\n=== generate:${id} (experimental constrained trajectory search) ===  ${doc.name} (${doc.keys.length} keys, ${doc.duration}s)`);
 if(dmg.damage)console.log(`  damage: ${dmg.damage}`);
 console.log(`  stop=${d.stopReason}  evals=${d.evals} (baseline/search/report, inclusive)  sweeps=${d.sweeps}  applied=${d.appliedMoves.length}`);
 for(const m of d.appliedMoves)
  console.log(`    move ${m.kind} ${m.keyId}${m.group?`:${m.group}`:''} Δ=${(m.delta*1000).toFixed(0)}ms`);
 for(const r of res.rejected)console.log(`  rejected ${r.code}: ${r.reason}${r.objective!==undefined?` (obj=${r.objective.toFixed(4)})`:''}`);
 for(const cand of res.candidates){
  console.log(`  candidate verdict=${cand.verdict} objective=${cand.objective.toFixed(4)}`);
  /* Keep the terminal summary limited to directionally interpretable quality
   * rows. Path timing and movement magnitude stay in the JSON evidence. */
  const rows=Object.entries(cand.metrics)
   .map(([k,r])=>({k,r,delta:r.after-r.before,
    noiseFloor:Math.max(1e-9,Math.max(Math.abs(r.before),Math.abs(r.after))*1e-4),
    rel:(r.after-r.before)/Math.max(Math.abs(r.before),1e-9)}))
   .filter(x=>x.r.better!=='na'&&Math.abs(x.delta)>x.noiseFloor&&Math.abs(x.rel)>=0.01)
   .sort((a,b)=>Math.abs(b.rel)-Math.abs(a.rel));
  for(const{k,r,rel}of rows.slice(0,14))
   console.log(`    ${k.padEnd(24)} ${r.before.toPrecision(4)} → ${r.after.toPrecision(4)} ${r.unit.padEnd(8)} ${(rel*100).toFixed(1)}%`);
  const failed=cand.constraints.filter(g=>!g.ok);
  console.log(`  constraints: ${cand.constraints.map(g=>`${g.ok?'✓':'✗'}${g.code}`).join('  ')}${failed.length?` — ${failed.map(g=>g.detail).join('；')}`:''}`);
 }
 atomicWriteFile(outputFile(`generate-${id}.json`),JSON.stringify({
  case:id,damage:dmg.damage??null,
  request:{lockedKeyIds:c.lockedKeyIds??[],tip:!!c.tip},
  diagnostics:res.diagnostics,baseline:res.baseline,rejected:res.rejected,
  candidates:res.candidates.map(({probe,...rest})=>({...rest,probe:{...probe,frames:undefined}})),
 },null,1));
 console.log(`  → ${path.join(output.dir,`generate-${id}.json`)}`);
}
