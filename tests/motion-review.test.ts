import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {initReview,checkReview,initFromManifestFile,MAX_ROUNDS} from '../scripts/lib/motion-review.mjs';
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

const viewAll=(review:ReviewRecord,visual:'ok'|'suspect'='ok')=>{for(const s of review.shots)s.visual=visual;};

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
  const r=checkReview(initReview(manifest()));
  expect(r.valid).toBe(false);
  expect(r.ok).toBe(false);
  expect(r.verdict).toBe('fail-with-handoff');
  expect(r.problems.join('')).toContain('3 张图未查看');
 });
 it('does not pass when an automatic numeric finding is deleted but its residual remains flagged',()=>{
  const review=initReview(manifest());
  viewAll(review);
  review.findings=[];
  const r=checkReview(review);
  expect(r.valid).toBe(false);expect(r.ok).toBe(false);expect(r.verdict).toBe('fail-with-handoff');
  expect(r.problems.join('')).toContain('numerical.flagged');
 });
 it('passes after a fresh capture reports no numeric residual flags',()=>{
  const recaptured=manifest();
  recaptured.shots[1].solved.right.wristResidualMm=1;
  const review=initReview(recaptured);
  viewAll(review);
  expect(review.numerical.flagged).toEqual([]);
  expect(review.findings).toEqual([]);
  const r=checkReview(review);
  expect(r.valid).toBe(true);expect(r.ok).toBe(true);expect(r.verdict).toBe('pass');
 });
 it('treats reference-unjudgeable as not blocking, but real findings force a handoff path',()=>{
  const review=initReview(healthyManifest());
  viewAll(review);
  review.findings=[{id:'F1',time:.5,keyId:'k2',view:'front',part:'右腕',category:'reference-unjudgeable',evidence:'e',solveStatus:'numeric-valid',referenceStatus:'unverified',suggestion:'s',uncertainty:'u'}];
  expect(checkReview(review).verdict).toBe('pass');
  review.findings.push({id:'F2',time:.5,keyId:'k2',view:'side',part:'右肘',category:'ik-clamp',evidence:'e',solveStatus:'numeric-invalid',referenceStatus:'unverified',suggestion:'s',uncertainty:'u'});
  const unresolved=checkReview(review);
  expect(unresolved.valid).toBe(true);
  expect(unresolved.verdict).toBe('fail-with-handoff');
  expect(unresolved.ok).toBe(false);
 });
 it('rejects "deviates from reference" claims made while the reference is unverified',()=>{
  const review=initReview(healthyManifest());
  viewAll(review);
  review.findings=[{id:'F1',time:.5,keyId:'k2',view:'front',part:'右腕',category:'deviates-from-reference',evidence:'e',solveStatus:'numeric-valid',referenceStatus:'unverified',suggestion:'s',uncertainty:'u'}];
  const r=checkReview(review);
  expect(r.ok).toBe(false);
  expect(r.problems.join('')).toContain('reference-unjudgeable');
 });
 it('rejects malformed shot and finding collections as an invalid record',()=>{
  const review=initReview(manifest());
  review.shots=[null as never];
  review.findings=[null as never];
  const r=checkReview(review);
  expect(r.valid).toBe(false);
  expect(r.ok).toBe(false);
  expect(r.problems.join(' ')).toContain('shot 必须是对象');
  expect(r.problems.join(' ')).toContain('finding 必须是对象');
 });
 it('requires a note on every suspect shot',()=>{
  const review=initReview(manifest());
  viewAll(review,'suspect');
  review.findings=[];
  const r=checkReview(review);
  expect(r.problems.join('')).toContain('缺少说明');
 });
 it('validates the five categories and the mandatory finding fields',()=>{
  const review=initReview(manifest());
  viewAll(review);
  const base:ReviewFinding={id:'F1',time:.5,keyId:'k2',view:'front',part:'p',evidence:'e',solveStatus:'numeric-valid',referenceStatus:'unverified',category:'ik-clamp',suggestion:'s',uncertainty:'u'};
  review.findings=[{...base,category:'made-up'}];
  expect(checkReview(review).problems.join('')).toContain('category');
  review.findings=[{...base,uncertainty:''}];
  expect(checkReview(review).problems.join('')).toContain('uncertainty');
 });
 it('enforces the rework bound: round > 3 needs a handoff, not more angle tweaks',()=>{
  const review=initReview(healthyManifest(),{round:MAX_ROUNDS+1});
  viewAll(review);
  review.findings=[{id:'F1',time:.5,keyId:'k2',view:'front',part:'右肘',category:'ik-clamp',evidence:'e',solveStatus:'numeric-invalid',referenceStatus:'unverified',suggestion:'s',uncertainty:'u'}];
  const bare=checkReview(review);
  expect(bare.ok).toBe(false);
  expect(bare.problems.join('')).toContain(`超过 ${MAX_ROUNDS} 轮`);
  review.handoff={reasons:['三轮后肘部仍穿身'],humanItems:['人工确认引拍肘高度']};
   const handedOff=checkReview(review);
   expect(handedOff.problems.join('')).not.toContain('超过');
   expect(handedOff.valid).toBe(true);
   expect(handedOff.verdict).toBe('fail-with-handoff');
   expect(handedOff.ok).toBe(false);

 });
 it('cannot PASS after round 3 even when all findings were removed',()=>{
  const review=initReview(manifest(),{round:MAX_ROUNDS+1});
  viewAll(review);
  review.findings=[];
  review.numerical.flagged=[];
  review.numerical.worstWristResidualMm=0;
  const withoutHandoff=checkReview(review);
  expect(withoutHandoff.ok).toBe(false);
  expect(withoutHandoff.verdict).toBe('fail-with-handoff');
  expect(withoutHandoff.problems.join('')).toContain(`超过 ${MAX_ROUNDS} 轮`);
  review.handoff={reasons:['自动返工轮数已耗尽'],humanItems:['人工复核最终动作']};
  const handedOff=checkReview(review);
  expect(handedOff.valid).toBe(true);
  expect(handedOff.ok).toBe(false);
  expect(handedOff.verdict).toBe('fail-with-handoff');
 });
});

describe('file round-trip',()=>{
 it('exits non-zero for a valid fail-with-handoff review record',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'human3d-motion-review-cli-'));
  const review=initReview(healthyManifest());
  viewAll(review);
  review.findings=[{id:'F1',time:.5,keyId:'k2',view:'front',part:'右腕',category:'ik-clamp',evidence:'残差 9 mm',solveStatus:'numeric-invalid',referenceStatus:'unverified',suggestion:'检查手腕目标',uncertainty:'当前数值只说明存在残差'}];
  const file=path.join(dir,'review.json');
  fs.writeFileSync(file,JSON.stringify(review));
  const result=spawnSync(process.execPath,['scripts/motion-review.mjs','check',file],{cwd:process.cwd(),encoding:'utf8'});
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('HANDOFF');
  expect(result.stdout).not.toContain('PASS');
 });
 it('init writes the skeleton beside the manifest and check reads it back',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'human3d-motion-review-'));
  const manifestPath=path.join(dir,'manifest.json');
  fs.writeFileSync(manifestPath,JSON.stringify(manifest()));
  const{target}=initFromManifestFile(manifestPath,{round:2});
  expect(target).toBe(path.join(dir,'review.json'));
  const{review,result}=(()=>{const r=JSON.parse(fs.readFileSync(target,'utf8'));return {review:r,result:checkReview(r)};})();
  expect(review.round).toBe(2);
  expect(result.problems.join('')).toContain('未查看');
 });
});
