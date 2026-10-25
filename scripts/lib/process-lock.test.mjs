import {spawn} from 'node:child_process';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
import {ownedProcesses} from './process-lock.mjs';

const repoRoot=fileURLToPath(new URL('../..',import.meta.url));

// One real probe process at a time keeps this test inside the limit it checks.
async function probeOwned(cwd,scriptArg){
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)',scriptArg],{cwd,stdio:'ignore'});
 try{
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  return ownedProcesses().some(line=>line.startsWith(`${child.pid} `));
 }finally{child.kill();}
}

describe('ownedProcesses',()=>{
 it('counts repository Node processes by absolute path or by working directory',async()=>{
  expect(await probeOwned(os.tmpdir(),`${repoRoot}scripts/probe-absolute.mjs`)).toBe(true);
  expect(await probeOwned(repoRoot,'scripts/probe-relative.mjs')).toBe(true);
 });
 it('ignores Node processes that belong to other projects',async()=>{
  expect(await probeOwned(os.tmpdir(),'scripts/probe-elsewhere.mjs')).toBe(false);
 });
});
