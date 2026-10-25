import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const bootTime=Math.round(Date.now()/1000-os.uptime());
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const releaseLock=lockDir=>fs.rmSync(lockDir,{recursive:true,force:true});

export function countNodeAndFfmpegProcesses(processList){
 const runtime=/^(?:node_repl|zcode-node-repl-mcp|node(?:js)?|npm|npx|pnpm|yarn|bun|tsx|vite|vitest|tsserver|ffmpeg)(?=$|[\s._-])/;
 return processList.split(/\r?\n/).filter(line=>runtime.test(line.trim().toLowerCase().replace(/^.*[\\/]/,''))).length;
}

function assertResourceProcessLimit(){
 let processList;
 try{processList=execFileSync('ps',['-A','-o','comm='],{encoding:'utf8'});}
 catch(error){throw new Error(`could not check the Node/ffmpeg process limit; refusing validation: ${error instanceof Error?error.message:String(error)}`);}
 const count=countNodeAndFfmpegProcesses(processList);
 if(count>4)throw new Error(`refusing validation: found ${count} Node/ffmpeg processes; the machine limit is 4. Wait for existing jobs to finish before retrying.`);
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
