import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {load as loadYaml} from 'js-yaml';
import {requiredResult} from '../scripts/ci-gate.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workflow=loadYaml(fs.readFileSync(path.join(ROOT,'.github/workflows/test.yml'),'utf8')) as Record<string,any>;
const triggers=(workflow.on??workflow['on']) as Record<string,any>;
const jobs=workflow.jobs as Record<string,any>;
const asList=(value:unknown):string[]=>value===undefined?[]:Array.isArray(value)?value.map(String):[String(value)];
const compact=(value:unknown)=>String(value??'').replace(/\s+/g,'').toLowerCase();

function ready(
 full:{checks:string|null|undefined;dynamics:string|null|undefined}={checks:'success',dynamics:'success'},
 event='pull_request',
 fast:string|null|undefined='skipped',
){
 return requiredResult({event,draft:false,fast,full});
}

describe('CI workflow lifecycle and stable required gate',()=>{
 it('parses the checked-in workflow and names every lifecycle event explicitly',()=>{
  expect(triggers).toBeDefined();
  expect(workflow.name).toBe('test');
  expect(triggers.push?.branches).toEqual(['main']);
  expect(triggers.pull_request?.types).toEqual([
   'opened','synchronize','reopened','ready_for_review','converted_to_draft',
  ]);
 });

 it('defines the four stable job IDs and gates ready-only checks on draft state',()=>{
  expect(Object.keys(jobs).sort()).toEqual(['dynamics','fast','full','required']);
  for(const id of ['full','dynamics']){
   const condition=compact(jobs[id].if);
   expect(asList(jobs[id].needs)).toContain('fast');
   expect(condition,`${id} must run after fast completes even if it failed`).toContain('always()');
   expect(condition,`${id} must have an explicit draft guard`).not.toBe('');
   expect(condition,`${id} must identify pull-request draft state`).toContain('draft');
   expect(condition,`${id} must distinguish pull requests from pushes`).toContain('pull_request');
   expect(condition,`${id} must run for non-draft PRs`).toMatch(/!.*pull_request\.draft|pull_request\.draft==false|pull_request\.draft!=true/);
  }
 });

 it('cancels superseded runs for the same ref',()=>{
  const concurrency=workflow.concurrency as Record<string,unknown>;
  expect(concurrency).toBeDefined();
  expect(concurrency['cancel-in-progress']).toBe(true);
  expect(String(concurrency.group)).toContain('github.ref');
 });

 it('bounds every job with a finite timeout',()=>{
  for(const [id,job] of Object.entries(jobs)){
   expect(Number.isInteger(job['timeout-minutes']),`${id} timeout`).toBe(true);
   expect(job['timeout-minutes'],`${id} timeout`).toBeGreaterThan(0);
   expect(job['timeout-minutes'],`${id} timeout should be bounded`).toBeLessThanOrEqual(180);
  }
 });

 it('keeps workflow caches within npm and Python package caches',()=>{
  const steps=Object.values(jobs).flatMap((job:any)=>job.steps??[]);
  const caches=steps.flatMap((step:any)=>{
   const uses=String(step.uses??'');
   if(/actions\/cache(?:@|$)/i.test(uses))return [{kind:'standalone',cache:step.with?.path??''}];
   if(/actions\/setup-node@/i.test(uses)&&step.with?.cache)return [{kind:'npm',cache:step.with.cache}];
   if(/actions\/setup-python@/i.test(uses)&&step.with?.cache)return [{kind:'python',cache:step.with.cache}];
   return step.with?.cache?[{kind:'other',cache:step.with.cache}]:[];
  });
  expect(caches.length).toBeGreaterThan(0);
  expect(caches.every((entry:any)=>entry.kind==='npm'&&entry.cache==='npm'||entry.kind==='python'&&entry.cache==='pip')).toBe(true);
  expect(caches.some((entry:any)=>entry.kind==='npm')).toBe(true);
  expect(caches.some((entry:any)=>entry.kind==='python')).toBe(true);
 });

 it('makes required wait for every status and invoke the gate helper with job results',()=>{
  const required=jobs.required;
  expect(compact(required.if)).toContain('always()');
  expect(asList(required.needs)).toEqual(expect.arrayContaining(['fast','full','dynamics']));
  const wiring=JSON.stringify(required.steps??[]);
  expect(wiring).toMatch(/ci-gate\.mjs|requiredResult/);
  expect(wiring).toContain('needs.fast.result');
  expect(wiring).toContain('needs.full.result');
  expect(wiring).toContain('needs.dynamics.result');
 });
});

describe('requiredResult status truth table',()=>{
 it.each([
  ['success','success','draft_deferred'],
  ['failure','failure','fast_failed'],
  ['cancelled','cancelled','fast_cancelled'],
  ['skipped','skipped','fast_skipped'],
  ['unrun',undefined,'fast_unrun'],
  ['null unrun',null,'fast_unrun'],
  ['stale','stale','fast_stale'],
 ] as const)('keeps a draft run non-green and reports the reason for %s fast status',(_label,fast,reason)=>{
  const result=requiredResult({event:'pull_request',draft:true,fast,full:{checks:'skipped',dynamics:'skipped'}});
  expect(result.ok).toBe(false);
  expect(result.reason).toBe(reason);
 });

 it.each([
  ['ready pull request','pull_request'],
  ['main push','push'],
 ])('accepts %s after both required suites succeed when fast is skipped',(_label,event)=>{
  const result=ready({checks:'success',dynamics:'success'},event,'skipped');
  expect(result.ok).toBe(true);
 });

 it('accepts a ready run when fast completed successfully',()=>{
  const result=ready({checks:'success',dynamics:'success'},'pull_request','success');
  expect(result.ok).toBe(true);
 });

 it.each(['failure','cancelled',undefined,null,'stale'] as const)(
  'fails a ready run when fast work is %s',status=>{
   const result=requiredResult({event:'pull_request',draft:false,fast:status,full:{checks:'success',dynamics:'success'}});
   expect(result.ok).toBe(false);
  },
 );

 it.each(['failure','cancelled','skipped',undefined,null,'stale'] as const)(
  'fails a ready run when full checks are %s',status=>{
   const result=ready({checks:status,dynamics:'success'});
   expect(result.ok).toBe(false);
  },
 );

 it.each(['failure','cancelled','skipped',undefined,null,'stale'] as const)(
  'fails a ready run when dynamics work is %s',status=>{
   const result=ready({checks:'success',dynamics:status});
   expect(result.ok).toBe(false);
  },
 );
});

describe('browser QA workflow',()=>{
 // Kept in its own workflow: adding a job to `test` would change the four-job
 // required gate contract this file pins.
 const browserWorkflow=loadYaml(fs.readFileSync(path.join(ROOT,'.github/workflows/browser-qa.yml'),'utf8')) as Record<string,any>;
 const browserJobs=browserWorkflow.jobs as Record<string,any>;
 const browserTriggers=(browserWorkflow.on??browserWorkflow['on']) as Record<string,any>;

 it('runs the two library browser suites on every PR update',()=>{
  expect(Object.keys(browserJobs)).toEqual(['library']);
  for(const type of ['opened','synchronize','reopened','ready_for_review']){
   expect(browserTriggers.pull_request?.types).toContain(type);
  }
  const steps=JSON.stringify(browserJobs.library.steps);
  expect(steps).toContain('library-backup-qa.mjs');
  expect(steps).toContain('library-concurrency-browser-qa.mjs');
  expect(steps).toContain('playwright install');
  expect(Number.isInteger(browserJobs.library['timeout-minutes'])).toBe(true);
 });

 it('runs the same suites locally through qa:library',()=>{
  const scripts=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).scripts as Record<string,string>;
  expect(scripts['qa:library']).toContain('library-backup-qa.mjs');
  expect(scripts['qa:library']).toContain('library-concurrency-browser-qa.mjs');
 });
});
