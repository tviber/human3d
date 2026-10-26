import {describe,it,expect} from 'vitest';
import {REVIEW_BUNDLE_REVISION,canonicalJson,docDigest,timesForBundle,shotRole,bundleBlock} from '../scripts/lib/review-bundle.mjs';
import {WORKSHOP_REVISION} from '@human3d/motion-core';
import {createHash} from 'node:crypto';

const doc=(times:number[],duration:number)=>({schemaVersion:2,id:'d',name:'n',duration,inbetweens:true,loop:false,
 handFrames:{L:'pelvis',R:'pelvis'},keys:times.map((time:number,i:number)=>({id:`k${i}`,time,label:`k${i}`,
  pose:{},constraints:{}}))});

describe('timesForBundle',()=>{
 it('captures every key time and each adjacent interval midpoint, deduped and sorted',()=>{
  expect(timesForBundle(doc([0,.5,1],1.2)).map(t=>Math.round(t*1000)))
   .toEqual([0,250,500,750,1000]);
 });
 it('keeps a single interval midpoint when two keys share the seam',()=>{
  const times=timesForBundle(doc([0,.4,.8],.8));
  expect(times).toHaveLength(5);
  expect(times.map(t=>Math.round(t*1000))).toEqual([0,200,400,600,800]);
 });
 it('clamps into [0,duration]',()=>{
  const times=timesForBundle(doc([0,.2],.3));
  expect(Math.min(...times)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...times)).toBeLessThanOrEqual(.3);
 });
 it('classifies shots as key or midpoint',()=>{
  const d=doc([0,.5,1],1);
  expect(shotRole(d,0)).toBe('key');
  expect(shotRole(d,.25)).toBe('midpoint');
  expect(shotRole(d,.5)).toBe('key');
 });
});

describe('document digest',()=>{
 it('pins the revision literal to the protocol WORKSHOP_REVISION',()=>{
  expect(REVIEW_BUNDLE_REVISION).toBe(WORKSHOP_REVISION);
 });
 it('sorts keys recursively so property order cannot move the digest',()=>{
  const a={z:1,a:{y:[2,1],b:3},m:[{q:1,p:2}]};
  const b={a:{b:3,y:[2,1]},m:[{p:2,q:1}],z:1};
  expect(canonicalJson(a)).toBe(canonicalJson(b));
  expect(docDigest(a)).toBe(docDigest(b));
 });
 it('changes when the document changes and stays stable otherwise',()=>{
  const d=doc([0,.5],1);
  expect(docDigest(d)).toBe(docDigest(JSON.parse(JSON.stringify(d))));
  const changed=JSON.parse(JSON.stringify(d));changed.keys[0].label='x';
  expect(docDigest(changed)).not.toBe(docDigest(d));
 });
 it('matches the pose-package definition-hash document side (same form, same sha-256)',()=>{
  const d=doc([0,.5],1);
  const expected=createHash('sha256')
   .update(canonicalJson({schema:WORKSHOP_REVISION,document:d})).digest('hex');
  expect(docDigest(d)).toBe(expected);
 });
});

describe('bundleBlock',()=>{
 it('carries digest, source path and sorted key times for traceability',()=>{
  const d=doc([.5,0],1);
  const block=bundleBlock({doc:d,normalizedDoc:d,docPath:'evidence/issue-32/x.json'});
  expect(block.docDigest).toBe(docDigest(d));
  expect(block.keyTimes).toEqual([0,.5]);
  expect(block.docSource).toBe('evidence/issue-32/x.json');
  expect(block.revision).toBe(WORKSHOP_REVISION);
 });
});
