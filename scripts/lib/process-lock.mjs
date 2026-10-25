import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const bootTime=Math.round(Date.now()/1000-os.uptime());
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const releaseLock=lockDir=>fs.rmSync(lockDir,{recursive:true,force:true});
const limitScript=fileURLToPath(new URL('../check-process-limit.sh',import.meta.url));
export const PROCESS_LIMIT=4;

/** Node/ffmpeg processes this repository runs (all worktrees), as "pid args"
 * lines. Ownership rules live in scripts/check-process-limit.sh only. */
export function ownedProcesses(){
 return execFileSync('sh',[limitScript,'--list'],{encoding:'utf8'}).split('\n').filter(Boolean);
}

function assertResourceProcessLimit(){
 let owned;
 try{owned=ownedProcesses();}
 catch(error){throw new Error(`could not check the H3D process limit; refusing validation: ${error instanceof Error?error.message:String(error)}`);}
 if(owned.length>PROCESS_LIMIT)throw new Error(`refusing validation: found ${owned.length} H3D Node/ffmpeg processes; the limit is ${PROCESS_LIMIT}. Wait for existing jobs to finish before retrying.\n${owned.join('\n')}`);
}

function live(pid){
 try{process.kill(pid,0);return true;}
 catch(error){if(error.code==='EPERM')return true;if(error.code==='ESRCH')return false;throw error;}
}

export async function acquireValidationLock(label=path.basename(process.argv[1]??'validation')){
 assertResourceProcessLimit();
 const tmp=os.tmpdir();
 const ownName=`human3d-validation-${process.pid}-${randomUUID()}.lock`;
 // Unique lock paths let concurrent stale-lock cleanup avoid deleting a new owner's lock.
 const lockDir=path.join(tmp,ownName);
 fs.mkdirSync(lockDir);
 fs.writeFileSync(path.join(lockDir,'owner.json'),JSON.stringify({pid:process.pid,bootTime,label}));
 process.once('exit',()=>releaseLock(lockDir));
 try{
  for(const name of fs.readdirSync(tmp)){
   const match=/^human3d-validation-(\d+)-.+\.lock$/.exec(name);
   if(!match||name===ownName)continue;
   const other=path.join(tmp,name),pid=Number(match[1]);
   let owner;
   try{owner=JSON.parse(fs.readFileSync(path.join(other,'owner.json'),'utf8'));}
   catch{await delay(50);try{owner=JSON.parse(fs.readFileSync(path.join(other,'owner.json'),'utf8'));}catch{}}
   if(live(pid)&&(!owner||owner.bootTime===bootTime))
    throw new Error(`another validation task is active (pid ${pid}, ${owner?.label??'starting'}); wait for it to finish`);
   releaseLock(other);
  }
 }catch(error){releaseLock(lockDir);throw error;}
 return ()=>releaseLock(lockDir);
}

export default async function vitestProcessLock(){
 return acquireValidationLock('Vitest');
}
