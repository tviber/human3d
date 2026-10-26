import type {HumanRig} from './rig';
import {artifactIdPayload,canonical,normalizedRequest,rigManifestBody,SOLVER_NAME,WORKSHOP_REVISION,workshopMeta,
 type RigJsonFile,type RigManifest} from './protocol';
import {solveWorkshop,type PosePackage} from './pose-package';
import {validatePosePackage} from './validate';
import {parseDoc,type WorkshopDoc} from './document';
import {WORKSHOP_LIMITS} from './limits';

/** In-browser pose-package builder: the same pipeline the service runs for
 * POST /v1/motions {action:{id:'workshop-doc'}}, minus transport, request
 * contract and idempotency layers. Everything hashes and validates through
 * the shared src/core/protocol.ts + src/core/pose-package.ts primitives, so a
 * package built here is byte-identical to the service response — including
 * id, requestFingerprint, tracks, events and quality — whenever the input
 * reaches the same gate the service's does (an object-shaped document with
 * fps inside the request schema's bound). Outside that envelope the Ajv
 * contract layer has no local twin: the builder mirrors the service's gate
 * ORDER (the fps bound is refused before the document is read, just as the
 * contract check precedes parseDoc) and its error codes, but phrases those
 * rejections in its own words. Node-free: the digest is WebCrypto by
 * default, injectable for tests. */

/** SHA-256 hex of a UTF-8 string. */
export type Digest=(s:string)=>Promise<string>;
/** Default digest — globalThis.crypto.subtle. Browsers expose it only on
 * secure origins (https or localhost); when absent the export must fail with
 * a readable error, never a fabricated hash. */
export const subtleDigest:Digest=async s=>{
 const subtle=globalThis.crypto?.subtle;
 if(!subtle)throw new Error('姿态包导出需要 https 或 localhost 环境（crypto.subtle 不可用）');
 const buf=await subtle.digest('SHA-256',new TextEncoder().encode(s));
 return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
};

export interface PackageEnv{
 /** Skin rig the package is solved against — must be the rig `manifest` describes. */
 rig:HumanRig;
 /** Session-cached manifest: build once per session and reuse across exports. */
 manifest:RigManifest;
 /** Defaults to globalThis.crypto.subtle via subtleDigest. */
 digest?:Digest;
}

export interface PackageError{code:string;message:string;details?:string[]}
export type PackageExportResult=
 |{status:200;body:PosePackage}
 |{status:400|422;body:{error:PackageError}};

/** The request schema's fps bound (spec/motion-request.schema.json). The
 * service enforces it at the contract layer; the local builder checks it
 * before solving so an out-of-range rate fails the same way. */
const LIMITS_FPS={min:1,max:60} as const;

/** Browser-side twin of the server's buildRigManifest: identical body, the
 * manifestSHA256 computed through `digest`. sourceSHA256 is outside the
 * package validation chain — pass the source asset's hash when known. */
export async function buildManifestLocal(rigJson:RigJsonFile,sourceHash='',digest:Digest=subtleDigest):Promise<RigManifest>{
 const body=rigManifestBody(rigJson);
 return {...body,manifestSHA256:await digest(canonical(body)),sourceSHA256:sourceHash};
}

/** Build a pose package for a workshop document locally. Mirrors
 * solveMotion's ad-hoc branch step for step:
 *  - the input is snapshotted (`JSON.stringify`) then normalized through
 *    `parseDoc`, so the request fingerprint and definition hash land on the
 *    same normalized document the service sees — and a caller mutating the
 *    live document mid-export cannot leak into the bytes;
 *  - documents past the shared duration/keys caps get the service's 400 body;
 *  - the semantic validator's problems become the 422 error.details verbatim. */
export async function buildPosePackageLocal(doc:unknown,fps:number,env:PackageEnv):Promise<PackageExportResult>{
 const digest=env.digest??subtleDigest;
 // Gate order mirrors the service: its request contract (which carries the
 // fps bound) runs before parseDoc, so a doubly-bad input — malformed
 // document plus out-of-range fps — must answer invalid_request here too,
 // not validation_failed.
 if(!Number.isFinite(fps)||fps<1||fps>LIMITS_FPS.max)
  return {status:400,body:{error:{code:'invalid_request',message:`sample.fps ${String(fps)} out of range (${LIMITS_FPS.min}–${LIMITS_FPS.max})`}}};
 let requestDoc:WorkshopDoc;
 try{requestDoc=parseDoc(JSON.stringify(doc));}
 catch(e){return {status:400,body:{error:{code:'validation_failed',message:`document rejected: ${e instanceof Error?e.message:String(e)}`}}};}
 // Symmetric dead guards: parseDoc already refuses both caps through
 // validateDocShape, so neither check can fire on this path. They stay to
 // mirror service.ts verbatim — there they are live (bundled descriptors
 // skip parseDoc), and keeping the same belt here makes the twin readable.
 if(requestDoc.duration>WORKSHOP_LIMITS.maxDuration)
  return {status:400,body:{error:{code:'validation_failed',message:`document duration ${requestDoc.duration}s exceeds ${WORKSHOP_LIMITS.maxDuration}s`}}};
 if(requestDoc.keys.length>WORKSHOP_LIMITS.maxKeys)
  return {status:400,body:{error:{code:'validation_failed',message:`document has ${requestDoc.keys.length} keys > ${WORKSHOP_LIMITS.maxKeys}`}}};
 const definitionSHA256=await digest(canonical({schema:WORKSHOP_REVISION,document:requestDoc}));
 const fp=await digest(canonical(normalizedRequest('workshop-doc',requestDoc,fps)));
 const motionId='mot_'+(await digest(canonical(artifactIdPayload(fp,definitionSHA256,env.manifest.manifestSHA256,SOLVER_NAME)))).slice(0,16);
 const meta=workshopMeta({motionId,manifestSHA256:env.manifest.manifestSHA256,bones:env.manifest.bones.length,
  actionId:'workshop-doc',revision:WORKSHOP_REVISION,definitionSHA256,
  documentName:requestDoc.name,prop:requestDoc.keys.some(k=>k.constraints?.grip),loop:requestDoc.loop,gripSide:requestDoc.gripSide,bevel:requestDoc.gripBevel,
  source:'client-supplied WorkshopDoc',license:'caller-owned; service asserts no rights',
  requestFingerprint:fp,fps,duration:requestDoc.duration,keys:requestDoc.keys.length,
  notes:['kinematic solve only — no dynamics validation']});
 const pkg=solveWorkshop(env.rig,requestDoc,fps,meta);
 const rejected=validatePosePackage(pkg,env.manifest);
 return rejected.length
  ?{status:422,body:{error:{code:'motion_rejected',message:'the solved motion fails the semantic checks; see details',details:rejected}}}
  :{status:200,body:pkg};
}
