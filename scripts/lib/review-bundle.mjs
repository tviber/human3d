import {createHash} from 'node:crypto';

/** Deterministic review-bundle helpers (issue #32 work package B1), shared by
 * scripts/workshop-capture.mjs (`--bundle`) and its tests. Pure Node — no
 * browser, no TS imports — so the capture script (plain .mjs, run with node
 * on CI) can use them directly.
 *
 * `docDigest` mirrors the definition-hash INPUT the pose-package pipeline
 * uses (canonical({schema:WORKSHOP_REVISION, document}) from
 * packages/motion-core/src/protocol.ts + package-export.ts) — same
 * sorted-key canonicalization, same sha-256. It is deliberately ONLY the doc
 * side (the full artifact id additionally binds fps, rig manifest and solver
 * revision): a review bundle needs to prove WHICH authored document produced
 * these pixels, and comparing that across a round of fixes. The revision
 * literal below is pinned to WORKSHOP_REVISION by tests/review-bundle.test.ts
 * — bump both together. */

/** Must equal WORKSHOP_REVISION in packages/motion-core/src/protocol.ts. */
export const REVIEW_BUNDLE_REVISION='workshop-doc/v8';

/** Sorted-key stable stringify — mirrors canonical() in protocol.ts. */
export function canonicalJson(value){
 return JSON.stringify(value,(_k,val)=>
  val&&typeof val==='object'&&!Array.isArray(val)
   ?Object.fromEntries(Object.entries(val).sort(([a],[b])=>a<b?-1:a>b?1:0))
   :val);
}

/** sha256 hex of the canonical {schema, document} form. */
export function docDigest(normalizedDoc,revision=REVIEW_BUNDLE_REVISION){
 return createHash('sha256').update(canonicalJson({schema:revision,document:normalizedDoc})).digest('hex');
}

/** Capture times for a review bundle: every key time plus the midpoint of
 * each adjacent key interval — keys show the authored poses, midpoints show
 * what the sampler does between them (interpolation problems live there).
 * Times are deduped (ε 1e-6) and clamped into [0, duration]. */
export function timesForBundle(doc){
 const keys=[...doc.keys].sort((a,b)=>a.time-b.time);
 const times=[];
 const push=t=>{t=Math.max(0,Math.min(doc.duration,t));if(!times.some(u=>Math.abs(u-t)<1e-6))times.push(t);};
 for(let i=0;i<keys.length;i++){
  push(keys[i].time);
  if(i+1<keys.length)push((keys[i].time+keys[i+1].time)/2);
 }
 return times;
}

/** Classify a capture time against the document's key times. */
export function shotRole(doc,time){
 return doc.keys.some(k=>Math.abs(k.time-time)<1e-6)?'key':'midpoint';
}

/** The bundle block embedded in a workshop-capture manifest. */
export function bundleBlock({doc,normalizedDoc,docPath}){
 return {revision:REVIEW_BUNDLE_REVISION,docDigest:docDigest(normalizedDoc),
  docSource:docPath,keyTimes:doc.keys.map(k=>k.time).slice().sort((a,b)=>a-b),
  note:'docDigest = sha256(canonical({schema,document}))，与姿态包 definition hash 的文档侧一致；改文档→新摘要'};
}
