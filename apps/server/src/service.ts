import fs from 'node:fs';
import path from 'node:path';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from '@human3d/motion-core';
import {MOTION_FILES} from '@human3d/motion-core';
import {motionDefinitionPayload} from '@human3d/motion-core';
import {parseDoc,type WorkshopDoc} from '@human3d/motion-core';
import {WORKSHOP_LIMITS} from '@human3d/motion-core';
import {buildRigManifest,sha256} from './rig-manifest';
import {solveWorkshop,type PosePackage} from '@human3d/motion-core';
import {RIG_ID,SERVICE_VERSION,SOLVER_NAME,WORKSHOP_REVISION,artifactIdPayload,canonical,normalizedRequest,workshopMeta,type RigManifest} from '@human3d/motion-core';
import {createContract,describeErrors,type Contract} from './contract';
import {validatePosePackage} from '@human3d/motion-core';
import type {ErrorCode} from './errors';

/** Sorted-key canonical JSON hash of the fully resolved action definition. */
export const actionDefinitionHash=(payload:unknown)=>sha256(canonical(payload));
export const LIMITS_SVC={maxFps:60,defaultFps:40,
 /** Same caps the workshop UI and validator use (src/workshop/limits.ts). */
 maxWorkshopDuration:WORKSHOP_LIMITS.maxDuration,maxWorkshopKeys:WORKSHOP_LIMITS.maxKeys,
 maxBodyBytes:1<<20,
 idempotencyMaxKeys:256,idempotencyMaxBytes:32<<20,idempotencyTtlSeconds:900,idempotencyKeyMaxLength:128} as const;

interface IdempotentEntry{fingerprint:string;status:number;body:unknown;at:number;bytes:number}
export interface ServiceContext{rig:HumanRig;manifest:RigManifest;contract:Contract;idempotent:Map<string,IdempotentEntry>;idempotentBytes:number}

export async function createService(assetDir:string):Promise<ServiceContext>{
 const glb=fs.readFileSync(path.join(assetDir,'models/human.glb'));
 const rigJson=fs.readFileSync(path.join(assetDir,'models/rig.json'));
 const gltf=await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength),'');
 const parsed:Parameters<typeof buildRigManifest>[0]=JSON.parse(rigJson.toString('utf8'));
 return {rig:new HumanRig(gltf.scene,parsed),manifest:buildRigManifest(parsed,sha256(rigJson)),
  contract:createContract(),idempotent:new Map(),idempotentBytes:0};
}

interface ActionDescriptor{
 id:string;revision:string;title:string;english:string;kind:'workshop-doc';
 /** Hash of the resolved action definition; null for client-supplied documents (their hash is per request). */
 definitionSHA256:string|null;
 durationSeconds:number|null;parameters:Record<string,unknown>;outputs:{kind:string;format:string}[];
 phases?:{time:number;label:string}[];provenance:{source:string;license:string;upstreamLicense?:string};
 notes?:string[];
 /** Bundled actions carry their normalized document; ad-hoc 'workshop-doc'
  * requests supply it via action.parameters.document. */
 bundledDocument?:WorkshopDoc;
}

const BUNDLED_PARAMS={type:'object',additionalProperties:false,properties:{}};
const WORKSHOP_DOC_PARAMS={
 type:'object',additionalProperties:false,required:['document'],
 properties:{document:{type:'object',description:`WorkshopDoc v2 JSON: named keyframes with pose targets and constraints (plantL/plantR/grip/contact); each key may select its outgoing interpolation ('hermite' or 'linear', default 'hermite'), and its pose may set handSpread {L?,R?} in 0–1 (0 fist, 0.5 relaxed — the absent default, 1 open; a sampled pose channel that changes the solved finger joints) and optional headYaw/headPitch in degrees (relative to the neck; yaw −80–80°, pitch −45–45°; both default to 0). Optional freeArms=true allows arm and wrist rotation beyond anatomical bend limits; optional document flags such as clavicleLift, gripSide ('R'|'L', default 'R' — which hand holds the racket and gets the grip solve) and gripBevel (integer 1–8, default 1 — which of the handle's eight palm-relative bevels rests against the palm; orients the prop only, not a solve input). Solved by the kinematic FK/IK pipeline; at most ${WORKSHOP_LIMITS.maxDuration} s and ${WORKSHOP_LIMITS.maxKeys} keys. schemaVersion must be 2 — older documents are refused (400 validation_failed), never silently upgraded.`}},
};
const IDEMPOTENCY_KEY=new RegExp(`^[!-~]{1,${LIMITS_SVC.idempotencyKeyMaxLength}}$`);

let CATALOG:ActionDescriptor[]|undefined;
export function actionCatalog():ActionDescriptor[]{
 if(CATALOG)return CATALOG;
 // Bundled descriptors are built from the motion-file envelopes. The
 // definition hash covers only the output-bearing payload (document,
 // phases, notes, license) — display metadata and `order` can never move it.
 // Clip envelopes are not servable: their trajectory lives outside the
 // pose pipeline, so they never appear in the catalog.
 const bundled:ActionDescriptor[]=MOTION_FILES.filter(f=>f.kind==='workshop-motion').map(f=>{
  const definitionSHA256=actionDefinitionHash(motionDefinitionPayload(f));
  return {id:f.id,kind:'workshop-doc' as const,revision:`workshop-doc-${definitionSHA256.slice(0,12)}`,
   title:f.name,english:f.english,definitionSHA256,durationSeconds:f.duration,
   parameters:BUNDLED_PARAMS,outputs:[{kind:'motion',format:'pose-json'}],phases:f.phases,
   provenance:{source:'motion-file',license:f.license??'MIT (project-authored motion data)'},
   notes:f.notes??[],bundledDocument:f.document};
 });
 CATALOG=[...bundled,{id:'workshop-doc',revision:WORKSHOP_REVISION,title:'自定义动作文档',english:'CUSTOM WORKSHOP DOCUMENT',kind:'workshop-doc',
  definitionSHA256:null,durationSeconds:null,parameters:WORKSHOP_DOC_PARAMS,
  outputs:[{kind:'motion',format:'pose-json'}],
  provenance:{source:'client-supplied WorkshopDoc',license:'caller-owned; service asserts no rights'},
  notes:['kinematic solve only — no dynamics validation']}];
 return CATALOG;
}

type Reply={status:number;body:unknown};
function err(status:number,code:ErrorCode,message:string,extra:Record<string,unknown>={}):Reply{return {status,body:{error:{code,message,...extra}}};}
const json=(body:unknown,status=200):Reply=>({status,body});

/** Artifact id for a request fingerprint + resolved definition under this
 * service's rig manifest — the shared payload from core/protocol hashed with
 * node:crypto. */
export const artifactId=(request:string,definitionSHA256:string,ctx:ServiceContext,solver:string)=>
 'mot_'+sha256(canonical(artifactIdPayload(request,definitionSHA256,ctx.manifest.manifestSHA256,solver))).slice(0,16);

export function handleRequest(ctx:ServiceContext,method:string,route:string,body?:unknown,headers:Record<string,string>={}):Reply{
 if(method==='GET'&&route==='/v1/capabilities')return json({
  service:{name:'human3d-motion',version:SERVICE_VERSION,protocol:'v1'},
  rigs:[{id:RIG_ID,manifestSHA256:ctx.manifest.manifestSHA256,bones:ctx.manifest.bones.length,height:ctx.manifest.height,semantics:ctx.manifest.semantics}],
  // bundledDocument is server-side resolution data — never on the wire.
  actions:actionCatalog().map(({phases,bundledDocument:_bundled,...a})=>({...a,phaseCount:phases?.length??0})),
  limits:{...LIMITS_SVC,maxTracks:164,payload:'gzip accepted (Content-Encoding: gzip)'},
  endpoints:['GET /v1/capabilities','GET /v1/actions/{actionId}','GET /v1/rigs/{rigId}','POST /v1/motions'],
 });
 if(method==='GET'&&route.startsWith('/v1/actions/')){
  const id=decodeURIComponent(route.slice('/v1/actions/'.length));
  const a=actionCatalog().find(x=>x.id===id);
  if(!a)return err(404,'unknown_action',`no action '${id}'`,{available:actionCatalog().map(x=>x.id)});
  const {bundledDocument:_bundled,...pub}=a;
  return json(pub);
 }
 if(method==='GET'&&route.startsWith('/v1/rigs/')){
  const id=decodeURIComponent(route.slice('/v1/rigs/'.length));
  return id===RIG_ID?json(ctx.manifest):err(404,'unknown_rig',`no rig '${id}'`,{available:[RIG_ID]});
 }
 if(method==='POST'&&route==='/v1/motions')return solveMotion(ctx,body,headers);
 return err(404,'not_found',`${method} ${route}`);
}

interface RequestBody{action:{id:string;revision?:string;definitionSHA256?:string;parameters?:Record<string,unknown>};rig?:string;
 outputs?:{kind:string;format:string}[];sample?:{fps?:number}}

function forgetIdempotent(ctx:ServiceContext,key:string){
 const e=ctx.idempotent.get(key);
 if(e){ctx.idempotentBytes-=e.bytes;ctx.idempotent.delete(key);}
}
/** Prune expired entries, then evict oldest until under both the count and
 * byte caps. Map iteration order is insertion order, so the first keys are the oldest. */
function storeIdempotent(ctx:ServiceContext,key:string,entry:IdempotentEntry){
 const now=Date.now(),ttl=LIMITS_SVC.idempotencyTtlSeconds*1000;
 for(const [k,v]of ctx.idempotent)if(now-v.at>ttl)forgetIdempotent(ctx,k);
 forgetIdempotent(ctx,key);
 while(ctx.idempotent.size>=LIMITS_SVC.idempotencyMaxKeys||ctx.idempotentBytes+entry.bytes>LIMITS_SVC.idempotencyMaxBytes){
  const oldest=ctx.idempotent.keys().next().value;
  if(oldest===undefined)break;
  forgetIdempotent(ctx,oldest);
 }
 ctx.idempotent.set(key,entry);ctx.idempotentBytes+=entry.bytes;
}

function solveMotion(ctx:ServiceContext,body:unknown,headers:Record<string,string>):Reply{
 if(!body||typeof body!=='object'||Array.isArray(body))return err(400,'invalid_request','body must be a JSON object');
 if(!ctx.contract.request(body)){
  const details=describeErrors(ctx.contract.request.errors);
  return err(400,'invalid_request',`request does not match the contract: ${details[0]}`,{details});
 }
 const req=body as RequestBody;
 const actionId=req.action.id;
 const descriptor=actionCatalog().find(a=>a.id===actionId);
 if(!descriptor)return err(404,'unknown_action',`no action '${actionId}'`,{missing:['solver capability for this action'],available:actionCatalog().map(a=>a.id)});
 for(const o of req.outputs??[]){
  if(o.kind!=='motion')return err(400,'unsupported_output',`output kind '${o.kind}' not implemented`,{available:['motion']});
  if(o.format!=='pose-json')return err(400,'unsupported_output',`format '${o.format}' not implemented`,{available:['pose-json']});
 }
 const rigId=req.rig??RIG_ID;
 if(rigId!==RIG_ID)return err(409,'unsupported_rig',`rig '${rigId}' cannot be served`,{missing:['retarget adapter'],available:[RIG_ID]});
 const fps=req.sample?.fps??LIMITS_SVC.defaultFps;
 const params=req.action.parameters??{};
 const paramCheck=ctx.contract.compileParameters(descriptor.parameters);
 if(!paramCheck(params)){
  const details=describeErrors(paramCheck.errors);
  return err(400,'invalid_request',`action.parameters do not match '${actionId}': ${details[0]}`,{details});
 }

 // Every servable action resolves to a WorkshopDoc: bundled descriptors carry
 // their envelope document; ad-hoc requests parse and normalize theirs here.
 let requestDoc:WorkshopDoc|undefined;
 if(!descriptor.bundledDocument){
  try{requestDoc=parseDoc(JSON.stringify(params.document));}
  catch(e){return err(400,'validation_failed',`document rejected: ${e instanceof Error?e.message:String(e)}`);}
 }
 const doc=descriptor.bundledDocument??requestDoc;
 if(!doc)return err(400,'validation_failed','document rejected: no document supplied');
 if(doc.duration>LIMITS_SVC.maxWorkshopDuration)return err(400,'validation_failed',`document duration ${doc.duration}s exceeds ${LIMITS_SVC.maxWorkshopDuration}s`);
 if(doc.keys.length>LIMITS_SVC.maxWorkshopKeys)return err(400,'validation_failed',`document has ${doc.keys.length} keys > ${LIMITS_SVC.maxWorkshopKeys}`);
 const revision=descriptor.revision;
 const definitionSHA256=descriptor.definitionSHA256
  ??actionDefinitionHash({schema:WORKSHOP_REVISION,document:doc});
 // Preconditions: the client may pin the revision or definition it expects.
 if(req.action.revision!==undefined&&req.action.revision!==revision)
  return err(409,'precondition_failed',`action.revision '${req.action.revision}' does not match '${revision}'`,{expected:{revision}});
 if(req.action.definitionSHA256!==undefined&&req.action.definitionSHA256!==definitionSHA256)
  return err(409,'precondition_failed',`action.definitionSHA256 does not match the resolved definition`,{expected:{definitionSHA256}});

 // Resolve the request identity from the normalized form, so the key and the
 // artifact id ignore spelling differences (defaults written out or not).
 const fp=sha256(canonical(normalizedRequest(actionId,requestDoc,fps)));
 const key=headers['idempotency-key'];
 if(key!==undefined&&!IDEMPOTENCY_KEY.test(key))
  return err(400,'invalid_request',`Idempotency-Key must be 1..${LIMITS_SVC.idempotencyKeyMaxLength} visible ASCII characters`);
 if(key){
  const seen=ctx.idempotent.get(key);
  if(seen&&Date.now()-seen.at<=LIMITS_SVC.idempotencyTtlSeconds*1000)
   return seen.fingerprint===fp?{status:seen.status,body:seen.body}:err(409,'idempotency_conflict','Idempotency-Key reused with a different request body');
  if(seen)forgetIdempotent(ctx,key);
 }

 const motionId=artifactId(fp,definitionSHA256,ctx,SOLVER_NAME);
 const meta=(id:string)=>workshopMeta({motionId:id,manifestSHA256:ctx.manifest.manifestSHA256,bones:ctx.manifest.bones.length,
  actionId,revision,definitionSHA256,documentName:requestDoc?.name,
  prop:doc.keys.some(k=>k.constraints?.grip),loop:doc.loop,gripSide:doc.gripSide,bevel:doc.gripBevel,
  source:descriptor.provenance.source,license:descriptor.provenance.license,requestFingerprint:fp,
  fps,duration:doc.duration,keys:doc.keys.length,notes:descriptor.notes});
 const pkg=solveWorkshop(ctx.rig,doc,fps,meta(motionId),descriptor.phases);

 // Two gates before anything leaves the service: the package must satisfy the
 // published schema (a failure here is a service bug, hence 500), and the
 // semantic validator must accept the motion (a failure is a rejected input).
 if(!ctx.contract.posePackage(pkg))
  return err(500,'internal','solved package does not satisfy spec/pose-package.schema.json',{details:describeErrors(ctx.contract.posePackage.errors).slice(0,5)});
 const rejected=validatePosePackage(pkg,ctx.manifest);
 const res=rejected.length
  ?err(422,'motion_rejected','the solved motion fails the semantic checks; see details',{details:rejected})
  :json(pkg);
 if(key&&(res.status===200||res.status===422))
  storeIdempotent(ctx,key,{fingerprint:fp,status:res.status,body:res.body,at:Date.now(),bytes:JSON.stringify(res.body).length});
 return res;
}
