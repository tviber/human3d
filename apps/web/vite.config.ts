import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
/** The web app lives in apps/web but keeps consuming the repo-level `public/`
 * assets (models, dynamics records) and emitting `dist/` at the repo root —
 * the dev server and the preview keep the same URLs and output layout the QA
 * scripts and docs expect. `server.fs.allow` covers the workspace sources
 * (packages/motion-core) so the linked package can be served through /@fs/.
 * HUMAN3D_BUILD_OUT_DIR can isolate build output per worktree. */
const repoRoot=fileURLToPath(new URL('../..',import.meta.url));
const configuredPort=(name:string,fallback:number):number=>{
 const raw=process.env[name]??String(fallback);
 const port=Number(raw);
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error(`${name} must be an integer from 1 to 65535; received ${raw}`);
 return port;
};
const fsErrorCode=(error:unknown):string|undefined=>{
 if(error&&typeof error==='object'&&'code'in error&&typeof error.code==='string')return error.code;
 return undefined;
};
const realPathForOutput=(target:string):string=>{
 const missing:string[]=[];
 let cursor=target;
 while(true){
  try{return path.resolve(fs.realpathSync(cursor),...missing);}
  catch(error){
   const code=fsErrorCode(error);
   if(code!=='ENOENT'&&code!=='ENOTDIR')throw error;
   let stat:fs.Stats|undefined;
   try{stat=fs.lstatSync(cursor);}
   catch(statError){if(fsErrorCode(statError)!=='ENOENT')throw statError;}
   if(stat?.isSymbolicLink())throw new Error(`HUMAN3D_BUILD_OUT_DIR contains a dangling symlink at ${cursor}`);
   const parent=path.dirname(cursor);
   if(parent===cursor)throw error;
   missing.unshift(path.basename(cursor));
   cursor=parent;
  }
 }
};
const isStrictlyWithin=(directory:string,target:string):boolean=>{
 const relative=path.relative(directory,target);
 return relative!==''&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);
};
export function resolveBuildOutDir(repoRoot:string,requested?:string):string{
 const lexicalRoot=path.resolve(repoRoot);
 const canonicalRoot=fs.realpathSync(lexicalRoot);
 const requestedPath=requested?.trim()||'dist';
 const lexicalOutput=path.resolve(lexicalRoot,requestedPath);
 const lexicalRelative=path.relative(lexicalRoot,lexicalOutput);
 const isDistOutput=lexicalRelative==='dist';
 const isOutNestedOutput=lexicalRelative.startsWith(`.out${path.sep}`);
 if(!isDistOutput&&!isOutNestedOutput)
  throw new Error(`HUMAN3D_BUILD_OUT_DIR must be dist or a nested path under .out; received ${requestedPath}`);
 const canonicalOutRoot=realPathForOutput(path.join(lexicalRoot,'.out'));
 const canonicalDistRoot=realPathForOutput(path.join(lexicalRoot,'dist'));
 const canonicalOutRootRelative=path.relative(canonicalRoot,canonicalOutRoot);
 const outRootIsSafe=canonicalOutRootRelative==='.out'||canonicalOutRootRelative==='dist'||canonicalOutRootRelative.startsWith(`dist${path.sep}`);
 if(!outRootIsSafe)
  throw new Error(`the .out root resolves outside generated output areas: ${canonicalOutRoot}`);
 const canonicalDistRootRelative=path.relative(canonicalRoot,canonicalDistRoot);
 const distRootIsSafe=canonicalDistRootRelative==='dist'||isStrictlyWithin(canonicalOutRoot,canonicalDistRoot);
 if(!distRootIsSafe)
  throw new Error(`the dist root resolves outside generated output areas: ${canonicalDistRoot}`);
 const canonicalOutput=realPathForOutput(lexicalOutput);
 if(isDistOutput&&canonicalOutput!==canonicalDistRoot)
  throw new Error(`HUMAN3D_BUILD_OUT_DIR no longer resolves to the canonical dist root: ${canonicalOutput}`);
 if(isOutNestedOutput&&!isStrictlyWithin(canonicalOutRoot,canonicalOutput))
  throw new Error(`HUMAN3D_BUILD_OUT_DIR must remain nested under the canonical .out root: ${canonicalOutput}`);
 return canonicalOutput;
}
const buildOutDir=resolveBuildOutDir(repoRoot,process.env.HUMAN3D_BUILD_OUT_DIR);
export default defineConfig({
 plugins:[react()],
 publicDir:path.resolve(repoRoot,'public'),
 build:{
  outDir:buildOutDir,
  emptyOutDir:true,
  rollupOptions:{input:{main:'index.html',workshop:'workshop.html'},output:{manualChunks:{three:['three']}}},
 },
 server:{port:configuredPort('HUMAN3D_WEB_PORT',5173),strictPort:true,fs:{allow:[repoRoot]}},
 preview:{port:configuredPort('HUMAN3D_PREVIEW_PORT',4173),strictPort:true},
});
