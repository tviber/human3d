import {VRM_SEMANTIC_MAP} from './semantic-map';
import {RACKET_BEVEL_DEFAULT} from './props/racket';
import type {WorkshopDoc} from './document';

/** Wire-level protocol primitives shared by the Node service (src/server) and
 * the in-browser package builder (src/core/package-export.ts). Deliberately
 * pure — no node imports — so both sides derive identical canonical strings,
 * fingerprints, artifact ids and manifest bodies; hashing stays with the
 * caller (node:crypto on the server, crypto.subtle in the browser). */

/** Solver build identity — carried into provenance.solverRevision and
 * artifactIdPayload's solver.revision, i.e. into every pose-package id.
 * Bump it on ANY change to solve semantics: the document sampler
 * (frameAt/interpolation/contact rewrite), solvePose/solveEffectiveFrame, IK
 * (solveTwoBone/limb/hand clamps), the pelvis correction, analyzePose checks.
 * Without a bump the same request+document hashes to the same artifact id
 * while delivering a different trajectory — the cache-confusion regression
 * learning[2] warns about ("same id, different motion"). Pure refactors that
 * cannot alter a single solved frame (comments, renaming, extraction) do not
 * require a bump — but when in doubt, bump: a stale id is worse than a
 * gratuitous one. */
export const SERVICE_VERSION='0.11.0';
export const RIG_ID='makehuman-body';
/** Format revision of the ad-hoc workshop document contract. Bumped with the
 * schema, not per document; bundled actions get a content-derived revision. */
export const WORKSHOP_REVISION='workshop-doc/v6';
/** Solver identity: carried into provenance.solver and the artifact hash.
 * A rewrite under a new algorithm deserves a new name; same-name semantic
 * changes bump SERVICE_VERSION (see its comment). */
export const SOLVER_NAME='workshop-hermite-fk-ik';

// Sorted-key JSON stringify; sufficient for fingerprints on our own data
// (ASCII keys, plain numbers). Not full RFC 8785 but deterministic.
export const canonical=(v:unknown):string=>JSON.stringify(v,(_k,val)=>
 val&&typeof val==='object'&&!Array.isArray(val)
  ?Object.fromEntries(Object.entries(val as Record<string,unknown>).sort(([a],[b])=>a<b?-1:a>b?1:0))
  :val);

/** The request as the service understands it: defaults filled, the document
 * normalized (schemaVersion 2), and preconditions dropped because they do not
 * change the output. Two requests that mean the same motion share this form,
 * so their fingerprints and artifact ids agree. The document embeds whole —
 * including `gripSide`: it selects which wrist/fingers the grip stage solves
 * and which wrist carries the racket, i.e. it changes the solved trajectory,
 * so two documents differing only in grip side must never share a fingerprint
 * or artifact id. (An explicit 'R' normalizes to the absent default first, so
 * spellings that mean the same solve still collide as intended.) */
export function normalizedRequest(actionId:string,doc:WorkshopDoc|undefined,fps:number){
 return {action:{id:actionId,parameters:doc?{document:doc}:{}},rig:RIG_ID,outputs:[{kind:'motion',format:'pose-json'}],sample:{fps}};
}

/** What the artifact IS — binds the request to the exact action definition,
 * rig manifest and solver that produced it. A solver or rig upgrade yields a
 * new id for the same request, so caches never conflate two trajectories. */
export const artifactIdPayload=(requestFingerprint:string,definitionSHA256:string,manifestSHA256:string,solver:string)=>
 ({protocol:'v1',requestFingerprint,definitionSHA256,
  rig:{id:RIG_ID,manifestSHA256},solver:{name:solver,revision:SERVICE_VERSION}});
/** The `mot_` artifact id from the digest of canonical(artifactIdPayload(...)).
 * `digest` is the caller's synchronous sha256 hex — node:crypto on the server;
 * async environments (WebCrypto) hash the payload themselves and apply the
 * same 'mot_'+hex.slice(0,16) rule. */
export const artifactId=(requestFingerprint:string,definitionSHA256:string,manifestSHA256:string,solver:string,digest:(s:string)=>string)=>
 'mot_'+digest(canonical(artifactIdPayload(requestFingerprint,definitionSHA256,manifestSHA256,solver))).slice(0,16);

export interface RigJsonBone{name:string;sourceName:string;parent:string|null;head:number[];tail:number[]}
export interface RigJsonFile{height:number;bones:RigJsonBone[];vertices:number;triangles:number;license:string}
/** The rig-manifest body every protocol hash agrees on: hierarchy, rest-local
 * TRS and the VRM semantic vocabulary. Hashing stays outside so node and
 * WebCrypto callers share one body — the server's buildRigManifest adds the
 * manifestSHA256/sourceSHA256 pair. */
export function rigManifestBody(rig:RigJsonFile){
 const bySemantic=new Map(Object.entries(VRM_SEMANTIC_MAP).map(([sem,bone])=>[bone,sem]));
 const headOf=new Map(rig.bones.map(b=>[b.name,b.head]));
 const bones=rig.bones.map(b=>{
  const parent=b.parent??null,ph=parent?headOf.get(parent)!:null;
  // GLB nodes carry translation only: rest local rotation is the identity
  // quaternion [0,0,0,1] and rest scale is [1,1,1] by construction.
  const restLocal={
   translation:ph?[b.head[0]-ph[0],b.head[1]-ph[1],b.head[2]-ph[2]]:b.head,
   rotation:[0,0,0,1],scale:[1,1,1]};
  return {name:b.name,parent,restLocal,head:b.head,tail:b.tail,
   semantic:bySemantic.get(b.name)??'extra'};
 });
 return {
  schemaVersion:1,kind:'rig-manifest',id:RIG_ID,
  units:{length:'meter',angle:'radian'},
  frame:{handedness:'right',up:'+Y',forward:'+Z'},
  height:rig.height,bones,
  semantics:{vocabulary:'vrm-humanoid-1.0',mapped:bySemantic.size,extra:bones.length-bySemantic.size},
  license:{rig:'CC0',source:'MakeHuman community assets',note:'Pose data derived from this rig inherits the rig license only; motion-source licenses are per-action.'},
 };
}
/** The served manifest: the shared body plus its own hash and the source
 * asset's hash (the latter is informational — nothing in the package
 * validation chain reads it). */
export type RigManifest=ReturnType<typeof rigManifestBody>&{manifestSHA256:string;sourceSHA256:string};

/** Capture-meta assembly shared by the service's solve path and the local
 * builder: every hash arrives precomputed so the factory stays synchronous
 * and environment-free. `documentName` marks the ad-hoc workshop-doc path —
 * bundled descriptors leave it undefined and ship `parameters: {}`. */
export interface WorkshopMetaArgs{
 motionId:string;manifestSHA256:string;bones:number;
 actionId:string;revision:string;definitionSHA256:string;
 /** Ad-hoc workshop-doc packages name the client document; bundled
  * descriptors leave it undefined and ship `parameters: {}`. */
 documentName?:string;
 /** Ad-hoc presentation hints: prop flags the racket (any key carries a grip
  * constraint), loop mirrors doc.loop, gripSide mirrors doc.gripSide ('L'
  * only — 'R' is the absent default), bevel mirrors doc.gripBevel (1 only —
  * the canonical facet is the absent default). `parameters` is an open object
  * in the schema and never enters the artifact hash — the copy a consumer
  * needs to display the held prop travels with the presentation hints, while
  * the solve-affecting document stays inside parameters.document. */
 prop?:boolean;loop?:boolean;gripSide?:'L'|'R';bevel?:number;
 source:string;license:string;requestFingerprint:string;
 fps:number;duration:number;keys:number;notes?:string[];
}
export function workshopMeta(a:WorkshopMetaArgs){
 const parameters=a.documentName===undefined?{}:
  {documentName:a.documentName,presentation:{...(a.prop?{prop:'racket' as const}:{}),
   ...(a.prop&&a.gripSide==='L'?{gripSide:'L' as const}:{}),
   ...(a.prop&&a.bevel!==undefined&&a.bevel!==RACKET_BEVEL_DEFAULT?{bevel:a.bevel}:{}),
   loop:a.loop===true}};
 return {motionId:a.motionId,manifestSHA256:a.manifestSHA256,bones:a.bones,
  action:{id:a.actionId,revision:a.revision,parameters,definitionSHA256:a.definitionSHA256},
  provenance:{solver:SOLVER_NAME,solverRevision:SERVICE_VERSION,source:a.source,requestFingerprint:a.requestFingerprint,
   license:{motion:a.license,rig:'CC0'},
   parametersResolved:{fps:a.fps,duration:a.duration,keys:a.keys}},
  // Descriptor notes become package warnings; the kinematic-only caveat applies
  // to every served motion (documented defects like forehand's stay first).
  warnings:[...(a.notes??[]),'engineering-approximation: 运动学求解器输出，未做动力学验证']};
}
