import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createBlindFixture,generateFixture,gradeVision,fixturePng,VISION_PASS_PX,VISION_WARN_PX,SCOPE_NOTE} from '../scripts/lib/vision-check.mjs';
import {decodePng} from '../scripts/lib/png.mjs';

const shiftX=(truth:{markers:{id:number;x:number;y:number}[];rect:{x:number;y:number;w:number;h:number}},d:number)=>({
 markers:truth.markers.map(m=>({id:m.id,x:m.x+d,y:m.y})),
 rect:{x:truth.rect.x+d,y:truth.rect.y,w:truth.rect.w,h:truth.rect.h},
});

describe('vision-check CLI',()=>{
 it('uses a fresh private seed sidecar and binds answers to the challenge id',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'human3d-vision-check-'));
  const cli=path.resolve('scripts/agent-vision-check.mjs');
  const emit=(outDir:string)=>spawnSync(process.execPath,[cli,'--emit','--out-dir',outDir],{encoding:'utf8'});
  const firstDir=path.join(dir,'first'),secondDir=path.join(dir,'second');
  const first=emit(firstDir),second=emit(secondDir);
  expect(first.status).toBe(0);expect(second.status).toBe(0);
  const template=JSON.parse(fs.readFileSync(path.join(firstDir,'answers.template.json'),'utf8'));
  const sidecar=path.join(firstDir,`.vision-check-${template.challengeId}.json`);
  expect(fs.existsSync(sidecar)).toBe(true);
  expect(template).not.toHaveProperty('seed');
  const secret=JSON.parse(fs.readFileSync(sidecar,'utf8'));
  const truth=generateFixture({seed:secret.seed}).truth;
  const answers={...template,markers:truth.markers,rect:truth.rect};
  const answersPath=path.join(firstDir,'answers.json');
  fs.writeFileSync(answersPath,JSON.stringify(answers));
  const checked=spawnSync(process.execPath,[cli,'--check',answersPath],{encoding:'utf8'});
  expect(checked.status).toBe(0);
  const result=JSON.parse(fs.readFileSync(path.join(firstDir,'vision-check.result.json'),'utf8'));
  expect(result.challengeId).toBe(template.challengeId);
  const wrongChallenge=path.join(secondDir,'answers.json');
  fs.writeFileSync(wrongChallenge,JSON.stringify(answers));
  const rejected=spawnSync(process.execPath,[cli,'--check',wrongChallenge],{encoding:'utf8'});
  expect(rejected.status).toBe(2);
  expect(rejected.stderr).toContain('找不到本次视觉校准挑战');
 });
});

describe('vision-check fixture',()=>{
 it('is deterministic for an explicit seed',()=>{
  const a=generateFixture({seed:0x33a32}),b=generateFixture({seed:0x33a32});
  expect(a.seed).toBe(b.seed);
  expect([...a.rgba]).toEqual([...b.rgba]);
  expect(a.truth).toEqual(b.truth);
 });
 it('creates a fresh blind challenge whose truth can only be regenerated from its seed',()=>{
  const a=createBlindFixture(),b=createBlindFixture();
  expect(a.challengeId).not.toBe(b.challengeId);
  expect(a.seed).not.toBe(b.seed);
  expect(a.truth).toEqual(generateFixture({seed:a.seed}).truth);
  expect(b.truth).toEqual(generateFixture({seed:b.seed}).truth);
 });
 it('keeps marker centres off the reference grid and mutually separated',()=>{
  const {truth}=generateFixture();
  expect(truth.markers).toHaveLength(10);
  for(const m of truth.markers){
   expect(m.x%50).toBeGreaterThanOrEqual(7);expect(m.x%50).toBeLessThanOrEqual(43);
   expect(m.y%50).toBeGreaterThanOrEqual(7);expect(m.y%50).toBeLessThanOrEqual(43);
  }
  for(let i=0;i<truth.markers.length;i++)for(let j=i+1;j<truth.markers.length;j++)
   expect(Math.hypot(truth.markers[i].x-truth.markers[j].x,truth.markers[i].y-truth.markers[j].y)).toBeGreaterThan(70);
 });
 it('round-trips through PNG and paints a dark pixel at every marker centre',()=>{
  const f=generateFixture();
  const img=decodePng(fixturePng());
  expect([img.width,img.height]).toEqual([f.width,f.height]);
  for(const m of f.truth.markers){
   const d=(m.y*img.width+m.x)*4;
   expect(img.rgba[d]).toBeLessThan(60);expect(img.rgba[d+1]).toBeLessThan(60);expect(img.rgba[d+2]).toBeLessThan(60);
  }
 });
});

describe('gradeVision',()=>{
 const truth=generateFixture().truth;
 it('grades an exact reading as pass',()=>{
  const g=gradeVision(truth,truth);
  expect(g.verdict).toBe('pass');expect(g.maxErrorPx).toBe(0);expect(g.feedback).toHaveLength(0);
 });
 it('keeps a small constant offset inside the pass band',()=>{
  const g=gradeVision(shiftX(truth,VISION_PASS_PX-1),truth);
  expect(g.verdict).toBe('pass');
 });
 it('warns inside the warn band and forbids pixel-level conclusions there',()=>{
  const g=gradeVision(shiftX(truth,VISION_WARN_PX-2),truth);
  expect(g.verdict).toBe('warn');
  expect(g.feedback.join('')).toContain('像素级结论');
 });
 it('fails a misread with actionable human-handoff feedback, not just a score',()=>{
  const g=gradeVision(shiftX(truth,30),truth);
  expect(g.verdict).toBe('fail');
  expect(g.feedback.join('')).toContain('人工');
  expect(g.feedback.join('')).toContain('不要继续从参考图读坐标');
 });
 it('detects swapped id labels when the permutation fits far better',()=>{
  const swapped={markers:truth.markers.map(m=>m.id===truth.markers[0].id?{...truth.markers[1],id:m.id}:m.id===truth.markers[1].id?{...truth.markers[0],id:m.id}:m),rect:truth.rect};
  const g=gradeVision(swapped,truth);
  expect(g.swapped).toContainEqual([truth.markers[0].id,truth.markers[1].id]);
  expect(g.feedback.join('')).toContain('对调');
 });
 it('fails on a missing marker and a missing rectangle with per-item feedback',()=>{
  const noMarker={markers:truth.markers.slice(0,9),rect:truth.rect};
  const g1=gradeVision(noMarker,truth);
  expect(g1.verdict).toBe('fail');expect(g1.feedback.join('')).toContain('标记 10');
  const g2=gradeVision({markers:truth.markers},truth);
  expect(g2.verdict).toBe('fail');expect(g2.feedback.join('')).toContain('rect');
 });
 it('states the scope limit on every verdict',()=>{
  expect(SCOPE_NOTE).toContain('只校准图像平面定位');
  expect(SCOPE_NOTE).toContain('不证明');
 });
});
