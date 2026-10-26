import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {initReview,checkReview,checkReviewFile,initFromManifestFile,MAX_ROUNDS} from '../scripts/lib/motion-review.mjs';
import type {ReviewRecord,ReviewFinding} from '../scripts/lib/motion-review.mjs';

const manifest=()=>({kind:'workshop-review-bundle',date:'2026-10-26T00:00:00Z',
 bundle:{revision:'workshop-doc/v5',docDigest:'a'.repeat(64),docSource:'x.json',keyTimes:[0,.5],note:''},
 document:{id:'d',name:'n',duration:1,keys:2,gripSide:'R',handFrames:{L:'pelvis',R:'pelvis'}},
 views:['front','side','threeQuarter'],
 shots:[
  {file:'a-t0-front.png',time:0,view:'front',shotRole:'key',nearestKey:{id:'k1'},solved:{right:{wristResidualMm:1},left:{wristResidualMm:2}}},
  {file:'a-t0.5-front.png',time:.5,view:'front',shotRole:'key',nearestKey:{id:'k2'},solved:{right:{wristResidualMm:9},left:{wristResidualMm:1}}},
  {file:'a-t0.5-side.png',time:.5,view:'side',shotRole:'key',nearestKey:{id:'k2'},solved:{right:{wristResidualMm:1},left:{wristResidualMm:1}}},
 ]});
const healthyManifest=()=>{
 const value=manifest();
 value.shots[1].solved.right.wristResidualMm=1;
 return value;
};
const checkWithManifest=(review:unknown,sourceManifest:unknown)=>checkReview(review,{manifest:sourceManifest});
const manifestWith27Shots=()=>({
 ...healthyManifest(),
 shots:Array.from({length:27},(_,i)=>({file:`shot-${i+1}.png`,time:i/26,
  view:['front','side','threeQuarter'][i%3],shotRole:i%3===0?'key':'midpoint',
  nearestKey:{id:`k${Math.floor(i/3)}`},solved:{right:{wristResidualMm:0},left:{wristResidualMm:0}}})),
});

const viewAll=(review:ReviewRecord,visual:'ok'|'suspect'='ok')=>{for(const s of review.shots)s.visual=visual;};
const writeCapture=(dir:string,source:ReturnType<typeof manifest>,opts:{round?:number}={})=>{
 fs.mkdirSync(dir,{recursive:true});
 const manifestPath=path.join(dir,'manifest.json');
 fs.writeFileSync(manifestPath,JSON.stringify(source));
 for(const shot of source.shots)fs.writeFileSync(path.join(dir,shot.file),'png fixture');
 return {...initFromManifestFile(manifestPath,opts),manifestPath};
};

describe('initReview',()=>{
 it('builds a viewing ledger from the bundle manifest and flags large residuals automatically',()=>{
  const r=initReview(manifest());
  expect(r.shots).toHaveLength(3);
  expect(r.shots.map(s=>[s.file,s.shotRole,s.keyId])).toContainEqual(['a-t0.5-front.png','key','k2']);
  expect(r.shots.every(s=>s.visual===null)).toBe(true);
  expect(r.numerical.worstWristResidualMm).toBe(9);
  expect(r.findings).toHaveLength(1);
  expect(r.findings[0].category).toBe('ik-clamp');
  expect(r.findings[0].evidence).toContain(`wristResidualMm 9`);
  expect(r.docDigest).toBe('a'.repeat(64));
 });
 it('requires a bundle manifest, pointing at the right command',()=>{
  const plain={...manifest(),kind:undefined};
  expect(()=>initReview(plain)).toThrow(/--bundle/);
 });
 it('marks an absent reference as unverified by construction',()=>{
  expect(initReview(manifest()).reference.available).toBe(false);
  expect(initReview(manifest()).reference.note).toContain('unverified');
  const withRef=initReview(manifest(),{reference:{available:true,aligned:false,note:'x',frames:['r.png']}});
  expect(withRef.reference.aligned).toBe(false);   // 相机未标定不是可配置的“已对齐”
 });
});

describe('checkReview — the gate',()=>{
 it('refuses a record with unviewed shots: green numbers alone never pass',()=>{
  const source=manifest();
  const r=checkWithManifest(initReview(source),source);
  expect(r.valid).toBe(false);
  expect(r.ok).toBe(false);
  expect(r.verdict).toBe('fail-with-handoff');
  expect(r.problems.join('')).toContain('3 张图未查看');
 });
 it('does not pass when an automatic numeric finding is deleted but its residual remains flagged',()=>{
  const source=manifest();
  const review=initReview(source);
  viewAll(review);
  review.findings=[];
  const r=checkWithManifest(review,source);
  expect(r.valid).toBe(false);expect(r.ok).toBe(false);expect(r.verdict).toBe('fail-with-handoff');
  expect(r.problems.join('')).toContain('numerical.flagged');
 });
 it('rejects clearing both finding and numerical records while the source manifest still flags a wrist',()=>{
  const source=manifest();
  const review=initReview(source);
  viewAll(review);
  review.findings=[];
  review.numerical.flagged=[];
  review.numerical.worstWristResidualMm=0;
  const r=checkWithManifest(review,source);
  expect(r.valid).toBe(false);expect(r.ok).toBe(false);
  expect(r.problems.join('')).toContain('numerical.flagged 与原始 manifest');
 });
 it('rejects keeping one of 27 screenshot records when the source manifest has all 27',()=>{
  const source=manifestWith27Shots();
  const review=initReview(source);
  viewAll(review);
  review.shots=[review.shots[0]];
  const r=checkWithManifest(review,source);
  expect(r.valid).toBe(false);expect(r.ok).toBe(false);
  expect(r.problems.join('')).toContain('review.shots 与原始 manifest 不一致（1/27）');
 });
 it('passes after a fresh capture reports no numeric residual flags',()=>{
  const recaptured=manifest();
  recaptured.shots[1].solved.right.wristResidualMm=1;
  const review=initReview(recaptured);
  viewAll(review);
  expect(review.numerical.flagged).toEqual([]);
  expect(review.findings).toEqual([]);
  const r=checkWithManifest(review,recaptured);
  expect(r.valid).toBe(true);expect(r.ok).toBe(true);expect(r.verdict).toBe('pass');
 });
 it('treats reference-unjudgeable as not blocking, but real findings force a handoff path',()=>{
  const source=healthyManifest();
  const review=initReview(source);
  viewAll(review);
  review.findings=[{id:'F1',time:.5,keyId:'k2',view:'front',part:'右腕',category:'reference-unjudgeable',evidence:'e',solveStatus:'numeric-valid',referenceStatus:'unverified',suggestion:'s',uncertainty:'u'}];
  expect(checkWithManifest(review,source).verdict).toBe('pass');
  review.findings.push({id:'F2',time:.5,keyId:'k2',view:'side',part:'右肘',category:'ik-clamp',evidence:'e',solveStatus:'numeric-invalid',referenceStatus:'unverified',suggestion:'s',uncertainty:'u'});
  const unresolved=checkWithManifest(review,source);
  expect(unresolved.valid).toBe(true);
  expect(unresolved.verdict).toBe('fail-with-handoff');
  expect(unresolved.ok).toBe(false);
 });
 it('rejects "deviates from reference" claims made while the reference is unverified',()=>{
  const source=healthyManifest();
  const review=initReview(source);
  viewAll(review);
  review.findings=[{id:'F1',time:.5,keyId:'k2',view:'front',part:'右腕',category:'deviates-from-reference',evidence:'e',solveStatus:'numeric-valid',referenceStatus:'unverified',suggestion:'s',uncertainty:'u'}];
  const r=checkWithManifest(review,source);
  expect(r.ok).toBe(false);
  expect(r.problems.join('')).toContain('reference-unjudgeable');
 });
 it('rejects malformed shot and finding collections as an invalid record',()=>{
  const source=manifest();
  const review=initReview(source);
  review.shots=[null as never];
  review.findings=[null as never];
  const r=checkWithManifest(review,source);
  expect(r.valid).toBe(false);
  expect(r.ok).toBe(false);
  expect(r.problems.join(' ')).toContain('shot 必须是对象');
  expect(r.problems.join(' ')).toContain('finding 必须是对象');
 });
 it('requires a note on every suspect shot',()=>{
  const source=manifest();
  const review=initReview(source);
  viewAll(review,'suspect');
  review.findings=[];
  const r=checkWithManifest(review,source);
  expect(r.problems.join('')).toContain('缺少说明');
 });
 it('validates the five categories and the mandatory finding fields',()=>{
  const source=manifest();
  const review=initReview(source);
  viewAll(review);
  const base:ReviewFinding={id:'F1',time:.5,keyId:'k2',view:'front',part:'p',evidence:'e',solveStatus:'numeric-valid',referenceStatus:'unverified',category:'ik-clamp',suggestion:'s',uncertainty:'u'};
  review.findings=[{...base,category:'made-up'}];
  expect(checkWithManifest(review,source).problems.join('')).toContain('category');
  review.findings=[{...base,uncertainty:''}];
  expect(checkWithManifest(review,source).problems.join('')).toContain('uncertainty');
 });
 it('enforces the rework bound: round > 3 needs a handoff, not more angle tweaks',()=>{
  const source=healthyManifest();
  const review=initReview(source,{round:MAX_ROUNDS+1});
  viewAll(review);
  review.findings=[{id:'F1',time:.5,keyId:'k2',view:'front',part:'右肘',category:'ik-clamp',evidence:'e',solveStatus:'numeric-invalid',referenceStatus:'unverified',suggestion:'s',uncertainty:'u'}];
  const bare=checkWithManifest(review,source);
  expect(bare.ok).toBe(false);
  expect(bare.problems.join('')).toContain(`超过 ${MAX_ROUNDS} 轮`);
  review.handoff={reasons:['三轮后肘部仍穿身'],humanItems:['人工确认引拍肘高度']};
   const handedOff=checkWithManifest(review,source);
   expect(handedOff.problems.join('')).not.toContain('超过');
   expect(handedOff.valid).toBe(true);
   expect(handedOff.verdict).toBe('fail-with-handoff');
   expect(handedOff.ok).toBe(false);

 });
 it('cannot PASS after round 3 even when all findings were removed',()=>{
  const source=healthyManifest();
  const review=initReview(source,{round:MAX_ROUNDS+1});
  viewAll(review);
  review.findings=[];
  review.numerical.flagged=[];
  review.numerical.worstWristResidualMm=0;
  const withoutHandoff=checkWithManifest(review,source);
  expect(withoutHandoff.ok).toBe(false);
  expect(withoutHandoff.verdict).toBe('fail-with-handoff');
  expect(withoutHandoff.problems.join('')).toContain(`超过 ${MAX_ROUNDS} 轮`);
  review.handoff={reasons:['自动返工轮数已耗尽'],humanItems:['人工复核最终动作']};
  const handedOff=checkWithManifest(review,source);
  expect(handedOff.valid).toBe(true);
  expect(handedOff.ok).toBe(false);
  expect(handedOff.verdict).toBe('fail-with-handoff');
 });
});

describe('file round-trip',()=>{
 it('exits non-zero for a valid fail-with-handoff review record',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'human3d-motion-review-cli-'));
  const source=healthyManifest();
  const {review,target}=writeCapture(dir,source);
  viewAll(review);
  review.findings=[{id:'F1',time:.5,keyId:'k2',view:'front',part:'右腕',category:'ik-clamp',evidence:'残差 9 mm',solveStatus:'numeric-invalid',referenceStatus:'unverified',suggestion:'检查手腕目标',uncertainty:'当前数值只说明存在残差'}];
  fs.writeFileSync(target,JSON.stringify(review));
  const result=spawnSync(process.execPath,['scripts/motion-review.mjs','check',target],{cwd:process.cwd(),encoding:'utf8'});
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('HANDOFF');
  expect(result.stdout).not.toContain('PASS');
 });
 it('reads the original manifest before accepting a complete PASS record',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'human3d-motion-review-pass-'));
  const {review,target}=writeCapture(dir,healthyManifest());
  viewAll(review);
  fs.writeFileSync(target,JSON.stringify(review));
  const {result}=checkReviewFile(target);
  expect(result.valid).toBe(true);expect(result.ok).toBe(true);expect(result.verdict).toBe('pass');
  expect(review.capture.manifestSource).toBe('manifest.json');
  expect(review.capture.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
 });
 it('rejects a source manifest changed after init',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'human3d-motion-review-stale-manifest-'));
  const source=healthyManifest();
  const {review,target,manifestPath}=writeCapture(dir,source);
  viewAll(review);
  fs.writeFileSync(target,JSON.stringify(review));
  fs.writeFileSync(manifestPath,JSON.stringify({...source,document:{...source.document,name:'changed after init'}}));
  const {result}=checkReviewFile(target);
  expect(result.valid).toBe(false);expect(result.ok).toBe(false);
  expect(result.problems.join('')).toContain('原始 manifest 文件内容已变化');
 });
 it('rejects a missing screenshot referenced by the source manifest',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'human3d-motion-review-missing-shot-'));
  const {review,target}=writeCapture(dir,healthyManifest());
  viewAll(review);
  fs.unlinkSync(path.join(dir,review.shots[0].file));
  fs.writeFileSync(target,JSON.stringify(review));
  const {result}=checkReviewFile(target);
  expect(result.valid).toBe(false);expect(result.ok).toBe(false);
  expect(result.problems.join('')).toContain('原始 manifest 引用的截图缺失');
 });
 it('CLI rejects clearing both numeric lists when the original manifest still flags a wrist',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'human3d-motion-review-numeric-source-'));
  const {review,target}=writeCapture(dir,manifest());
  viewAll(review);
  review.findings=[];
  review.numerical.flagged=[];
  review.numerical.worstWristResidualMm=0;
  fs.writeFileSync(target,JSON.stringify(review));
  const {result}=checkReviewFile(target);
  expect(result.valid).toBe(false);expect(result.ok).toBe(false);
  expect(result.problems.join('')).toContain('numerical.flagged 与原始 manifest');
 });
 it('CLI rejects a one-shot review against the original 27-shot manifest',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'human3d-motion-review-shot-source-'));
  const {review,target}=writeCapture(dir,manifestWith27Shots());
  viewAll(review);
  review.shots=[review.shots[0]];
  fs.writeFileSync(target,JSON.stringify(review));
  const {result}=checkReviewFile(target);
  expect(result.valid).toBe(false);expect(result.ok).toBe(false);
  expect(result.problems.join('')).toContain('review.shots 与原始 manifest 不一致（1/27）');
 });
 it('init writes the skeleton beside the manifest and check reads it back',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'human3d-motion-review-'));
  const source=manifest();
  const {target,manifestPath}=writeCapture(dir,source,{round:2});
  expect(target).toBe(path.join(dir,'review.json'));
  const {review,result}=checkReviewFile(target);
  expect(review.round).toBe(2);
  expect(result.problems.join('')).toContain('未查看');
  expect(review.capture.manifestSource).toBe(path.basename(manifestPath));
 });
});
