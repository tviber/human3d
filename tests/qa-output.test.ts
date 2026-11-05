import {afterEach,describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertTrackedWriteAllowed,atomicWriteFile,ensureOutputDir,resolveOutputDir} from '../scripts/lib/qa-output.mjs';
import {resolveBuildOutDir} from '../apps/web/vite.config';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tempDirs:string[]=[];
const tempDir=()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'human3d-qa-output-'));
 tempDirs.push(dir);
 return dir;
};
const readRepoFile=(relativePath:string)=>fs.readFileSync(path.join(ROOT,relativePath),'utf8');
const sourceCallPositions=(source:string,callName:string)=>
 [...source.matchAll(new RegExp(`\\b${callName}\\s*\\(`,'g'))].map(match=>match.index??-1);
const sourceMatchPositions=(source:string,marker:RegExp)=>
 [...source.matchAll(new RegExp(marker.source,`${marker.flags}g`))].map(match=>match.index??-1);
const lastPositionBefore=(positions:number[],boundary:number)=>
 positions.filter(position=>position<boundary).slice(-1)[0]??-1;
const ifConditions=(source:string)=>
 [...source.matchAll(/if\s*\(([^{}]*?)\)\s*\{/gs)].map(match=>({
  condition:match[1]??'',position:match.index??-1,body:source.slice(match.index??0,(match.index??0)+500),
 }));
const ensureCallWithRootOption=(rootOption:string)=>new RegExp(
 `\\bensureOutputDir\\s*\\([^;]*,\\s*\\{\\s*${rootOption}\\s*,\\s*updateEvidence\\s*:\\s*output\\.updateEvidence\\s*\\}\\s*\\)\\s*;`,
);
const ensureWithRoot=ensureCallWithRootOption('root');
const expectFreshWriteOrder=(source:string,writeMarker:RegExp)=>{
 const write=source.search(writeMarker);
 const preparation=lastPositionBefore(sourceMatchPositions(source,ensureWithRoot),write);
 const guards=sourceCallPositions(source,'assertTrackedWriteAllowed').filter(position=>position<write);
 const freshGuard=guards[guards.length-1]??-1;
 expect([preparation,freshGuard,write].every(position=>position>=0)).toBe(true);
 expect(preparation).toBeLessThan(freshGuard);
 expect(freshGuard).toBeLessThan(write);
};
afterEach(()=>{
 for(const dir of tempDirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});
});
const defaultOutputDir=(root:string,worktreeId='fixture-worktree',runId='fixture-run',scriptKey='qa-output')=>
 resolveOutputDir(scriptKey,[],root,{HUMAN3D_WORKTREE_ID:worktreeId,HUMAN3D_RUN_ID:runId}).dir;
const attemptGuardedWrite=(target:string,root:string,contents:Buffer)=>{
 let writeReached=false;
 let error:unknown;
 try{
  const allowedTarget=assertTrackedWriteAllowed(target,{root,updateEvidence:false});
  writeReached=true;
  fs.mkdirSync(path.dirname(allowedTarget),{recursive:true});
  fs.writeFileSync(allowedTarget,contents);
 }catch(caught){
  error=caught;
 }
 return {error,writeReached};
};
const replaceScratchRootWithOutsideSymlink=(root:string,rootAlias:string,outside:string)=>{
 const scratchRoot=path.join(root,'.out');
 fs.mkdirSync(scratchRoot,{recursive:true});
 const output=resolveOutputDir('qa-output',[],rootAlias,{
  HUMAN3D_WORKTREE_ID:'fixture-worktree',HUMAN3D_RUN_ID:'fixture-run',
 });
 fs.rmSync(scratchRoot,{recursive:true,force:true});
 fs.symlinkSync(outside,scratchRoot,'dir');
 return output.dir;
};

describe('QA and generator output resolution',()=>{
 it('defaults to a stable per-worktree, per-run script scratch directory',()=>{
  const env={HUMAN3D_RUN_ID:'unit-run-42'};
  const first=resolveOutputDir('quality-probe',['--fps','240'],ROOT,env);
  const second=resolveOutputDir('quality-probe',['--fps','240'],ROOT,env);
  const relative=path.relative(ROOT,first.dir).split(path.sep);
  expect(relative).toHaveLength(4);
  expect(relative[0]).toBe('.out');
  expect(relative[1]).not.toBe(''); // Worktree identity is implementation-defined.
  expect(relative[2]).toBe('unit-run-42');
  expect(relative[3]).toBe('quality-probe');
  expect(second.dir).toBe(first.dir);
  expect(first.args).toEqual(['--fps','240']);
  expect(first.updateEvidence).toBe(false);
 });

 it('consumes output and evidence flags while preserving unrelated CLI arguments',()=>{
  const outDir=path.join(tempDir(),'explicit-output');
  const result=resolveOutputDir('package-export',[
   '--fps','60','--out-dir',outDir,'--update-evidence','--motion','idle',
  ],ROOT,{HUMAN3D_RUN_ID:'unit-run-7'});
  expect(result.dir).toBe(outDir);
  expect(result.args).toEqual(['--fps','60','--motion','idle']);
  expect(result.updateEvidence).toBe(true);
 });

 it('accepts the equals form of the output option and leaves evidence opt-in false',()=>{
  const outDir=path.join(tempDir(),'explicit-equals');
  const result=resolveOutputDir('package-export',[
   `--out-dir=${outDir}`,'--dry-run',
  ],ROOT,{HUMAN3D_RUN_ID:'unit-run-8'});
  expect(result.dir).toBe(outDir);
  expect(result.args).toEqual(['--dry-run']);
  expect(result.updateEvidence).toBe(false);
 });
});

describe('Vite build output resolution',()=>{
 it('rejects output that could erase tracked spec files',()=>{
  const root=tempDir();
  expect(()=>resolveBuildOutDir(root,'spec')).toThrow();
 });

 it('rejects the shared .out root',()=>{
  const root=tempDir();
  fs.mkdirSync(path.join(root,'.out'),{recursive:true});
  expect(()=>resolveBuildOutDir(root,'.out')).toThrow();
 });

 it('rejects a .out root symlink that resolves into the repository spec tree',()=>{
  const root=tempDir();
  const source=path.join(root,'spec');
  fs.mkdirSync(source);
  fs.symlinkSync(source,path.join(root,'.out'),'dir');
  expect(()=>resolveBuildOutDir(root,path.join('.out','build'))).toThrow();
 });

 it('rejects a dist root symlink that resolves into the repository spec tree',()=>{
  const root=tempDir();
  const source=path.join(root,'spec');
  fs.mkdirSync(source);
  fs.symlinkSync(source,path.join(root,'dist'),'dir');
  expect(()=>resolveBuildOutDir(root,undefined)).toThrow();
 });

 it('rejects an output path that escapes through a symlink',()=>{
  const root=tempDir();
  const outside=tempDir();
  const linkedOutput=path.join(root,'.out','redirected');
  fs.mkdirSync(path.dirname(linkedOutput),{recursive:true});
  fs.symlinkSync(outside,linkedOutput,'dir');
  expect(()=>resolveBuildOutDir(root,path.join('.out','redirected','build'))).toThrow();
 });

 it('uses dist by default and accepts explicit dist output',()=>{
  const root=tempDir();
  expect(resolveBuildOutDir(root,undefined)).toBe(path.join(fs.realpathSync(root),'dist'));
  expect(resolveBuildOutDir(root,'dist')).toBe(path.join(fs.realpathSync(root),'dist'));
 });

 it('allows nested .out build output',()=>{
  const root=tempDir();
  const nestedOutput=path.join(fs.realpathSync(root),'.out','worktree-a','build');
  expect(resolveBuildOutDir(root,path.join('.out','worktree-a','build'))).toBe(nestedOutput);
 });
});

describe('default scratch output symlink containment',()=>{
 it('rejects a default output when the .out root symlinks outside the temp repository',()=>{
  const root=tempDir();
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  const outside=tempDir();
  const sentinel=path.join(outside,'sentinel.txt');
  const sentinelBytes=Buffer.from('keep outside sentinel');
  const outsideOutput=path.join(outside,'fixture-worktree','fixture-run','qa-output','generated.json');
  fs.writeFileSync(sentinel,sentinelBytes);
  fs.symlinkSync(outside,path.join(root,'.out'),'dir');

  let resolutionError:unknown;
  try{
   defaultOutputDir(root);
  }catch(error){
   resolutionError=error;
  }
  expect(resolutionError).toBeInstanceOf(Error);
  expect(fs.existsSync(outsideOutput)).toBe(false);
  expect(fs.readFileSync(sentinel)).toEqual(sentinelBytes);
 });

 it('rejects a default output when a nested .out component symlinks outside the temp repository',()=>{
  const root=tempDir();
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  const outside=tempDir();
  const worktreeId='fixture-worktree';
  const runId='fixture-run';
  const sentinel=path.join(outside,'sentinel.txt');
  const sentinelBytes=Buffer.from('keep nested outside sentinel');
  const outsideOutput=path.join(outside,runId,'qa-output','generated.json');
  fs.writeFileSync(sentinel,sentinelBytes);
  fs.mkdirSync(path.join(root,'.out'),{recursive:true});
  fs.symlinkSync(outside,path.join(root,'.out',worktreeId),'dir');

  let resolutionError:unknown;
  try{
   defaultOutputDir(root,worktreeId,runId);
  }catch(error){
   resolutionError=error;
  }
  expect(resolutionError).toBeInstanceOf(Error);
  expect(fs.existsSync(outsideOutput)).toBe(false);
  expect(fs.readFileSync(sentinel)).toEqual(sentinelBytes);
 });

 it('rejects a default scratch leaf symlink before a caller can overwrite its outside target',()=>{
  const root=tempDir();
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  const outside=tempDir();
  const sentinel=path.join(outside,'sentinel.txt');
  const sentinelBytes=Buffer.from('keep leaf sentinel');
  const outputDir=defaultOutputDir(root);
  const outputTarget=path.join(outputDir,'generated.json');
  fs.writeFileSync(sentinel,sentinelBytes);
  fs.mkdirSync(outputDir,{recursive:true});
  fs.symlinkSync(sentinel,outputTarget);

  const attempt=attemptGuardedWrite(outputTarget,root,Buffer.from('overwrite attempt'));
  expect(attempt.error).toBeInstanceOf(Error);
  expect(attempt.writeReached).toBe(false);
  expect(fs.readFileSync(sentinel)).toEqual(sentinelBytes);
 });

 it('rechecks the default path if .out becomes an outside symlink after resolution',()=>{
  const root=tempDir();
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  const outside=tempDir();
  const worktreeId='fixture-worktree';
  const runId='fixture-run';
  const sentinel=path.join(outside,'sentinel.txt');
  const sentinelBytes=Buffer.from('keep raced sentinel');
  const outsideOutput=path.join(outside,worktreeId,runId,'qa-output','generated.json');
  fs.writeFileSync(sentinel,sentinelBytes);
  fs.mkdirSync(path.join(root,'.out'),{recursive:true});
  const outputDir=defaultOutputDir(root,worktreeId,runId);
  const outputTarget=path.join(outputDir,'generated.json');
  fs.rmSync(path.join(root,'.out'),{recursive:true,force:true});
  fs.symlinkSync(outside,path.join(root,'.out'),'dir');

  const attempt=attemptGuardedWrite(outputTarget,root,Buffer.from('outside write attempt'));
  expect(attempt.error).toBeInstanceOf(Error);
  expect(attempt.writeReached).toBe(false);
  expect(fs.existsSync(outsideOutput)).toBe(false);
  expect(fs.readFileSync(sentinel)).toEqual(sentinelBytes);
 });
});

describe('ensureOutputDir scratch containment',()=>{
 it('rejects a pre-existing .out root symlink before creating an outside directory',()=>{
  const root=tempDir();
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  const outside=tempDir();
  const outputDir=path.join(root,'.out','fixture-worktree','fixture-run','qa-output');
  const outsideOutputDir=path.join(outside,'fixture-worktree','fixture-run','qa-output');
  fs.symlinkSync(outside,path.join(root,'.out'),'dir');

  expect(()=>ensureOutputDir(outputDir,{root})).toThrow();
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.existsSync(outsideOutputDir)).toBe(false);
 });

 it('rejects a nested .out symlink before creating an outside directory',()=>{
  const root=tempDir();
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  const outside=tempDir();
  const outputDir=path.join(root,'.out','fixture-worktree','fixture-run','qa-output');
  const outsideOutputDir=path.join(outside,'fixture-run','qa-output');
  fs.mkdirSync(path.join(root,'.out'),{recursive:true});
  fs.symlinkSync(outside,path.join(root,'.out','fixture-worktree'),'dir');

  expect(()=>ensureOutputDir(outputDir,{root})).toThrow();
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.existsSync(outsideOutputDir)).toBe(false);
 });

 it('rechecks a resolved default path before creating directories after a root alias race',()=>{
  const root=tempDir();
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  const outside=tempDir();
  const aliasParent=tempDir();
  const rootAlias=path.join(aliasParent,'repo-alias');
  fs.symlinkSync(root,rootAlias,'dir');
  const outputDir=replaceScratchRootWithOutsideSymlink(root,rootAlias,outside);
  const outsideOutputDir=path.join(outside,'fixture-worktree','fixture-run','qa-output');

  expect(()=>ensureOutputDir(outputDir,{root:rootAlias})).toThrow();
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.existsSync(outsideOutputDir)).toBe(false);
 });

 it('rechecks a resolved default target after a root alias race before allowing a write',()=>{
  const root=tempDir();
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  const outside=tempDir();
  const aliasParent=tempDir();
  const rootAlias=path.join(aliasParent,'repo-alias');
  fs.symlinkSync(root,rootAlias,'dir');
  const outputDir=replaceScratchRootWithOutsideSymlink(root,rootAlias,outside);
  const outputTarget=path.join(outputDir,'generated.json');
  const outsideOutputDir=path.join(outside,'fixture-worktree','fixture-run','qa-output');

  expect(()=>assertTrackedWriteAllowed(outputTarget,{root:rootAlias,updateEvidence:false})).toThrow();
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.existsSync(outsideOutputDir)).toBe(false);
  expect(fs.existsSync(path.join(outsideOutputDir,'generated.json'))).toBe(false);
 });

 it('creates an explicit .out root and allows repeated creation of the same valid scratch directory',()=>{
  const root=tempDir();
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  const explicitScratch=resolveOutputDir('qa-output',['--out-dir','.out'],root,{
   HUMAN3D_WORKTREE_ID:'fixture-worktree',HUMAN3D_RUN_ID:'fixture-run',
  }).dir;
  expect(explicitScratch).toBe(path.join(root,'.out'));
  expect(ensureOutputDir(explicitScratch,{root})).toBe(explicitScratch);

  const defaultDir=defaultOutputDir(root);
  const first=ensureOutputDir(defaultDir,{root});
  const second=ensureOutputDir(defaultDir,{root});
  expect(first).toBe(defaultDir);
  expect(second).toBe(first);
  expect(fs.statSync(second).isDirectory()).toBe(true);
 });

 it('creates an explicit external output directory',()=>{
  const root=tempDir();
  const outside=tempDir();
  const explicitDir=path.join(outside,'explicit-output');
  const resolved=resolveOutputDir('qa-output',['--out-dir',explicitDir],root,{});

  expect(ensureOutputDir(resolved.dir,{root})).toBe(explicitDir);
  expect(fs.statSync(explicitDir).isDirectory()).toBe(true);
 });

 it('creates a non-scratch spec/solver-baseline helper path',()=>{
  const root=tempDir();
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  const baselineDir=path.join(root,'spec','solver-baseline');

  expect(ensureOutputDir(baselineDir,{root})).toBe(baselineDir);
  expect(fs.statSync(baselineDir).isDirectory()).toBe(true);
 });

   it('fails closed before creating an in-repo output path when Git lookup is unavailable',()=>{
   const root=tempDir();
   const outputDir=path.join(root,'spec','ensure-output');

   expect(()=>ensureOutputDir(outputDir,{root})).toThrow(/could not verify whether .* is tracked: .*git ls-files/i);
   expect(fs.existsSync(path.join(root,'spec'))).toBe(false);
   expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('routes solver baseline destination directory creation through the output helper',()=>{
  const source=fs.readFileSync(path.join(ROOT,'scripts','recapture-solver-baseline.mts'),'utf8');
  expect(source).toMatch(/ensureOutputDir\s*\(\s*destinationDir\s*,\s*\{\s*root\s*,\s*updateEvidence\s*:\s*output\.updateEvidence\s*\}\s*\)/);
 });
});

describe('scratch output alias containment',()=>{
 it('rejects an explicit absolute --out-dir through a repository-root alias when .out escapes',()=>{
  const root=tempDir();
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  const outside=tempDir();
  const aliasParent=tempDir();
  const rootAlias=path.join(aliasParent,'repo-alias');
  fs.symlinkSync(root,rootAlias,'dir');
  fs.symlinkSync(outside,path.join(root,'.out'),'dir');
  const explicitDir=path.join(rootAlias,'.out','explicit-output');
  const resolved=resolveOutputDir('qa-output',['--out-dir',explicitDir],root,{});
  const target=path.join(resolved.dir,'generated.json');

  expect(resolved.dir).toBe(explicitDir);
  expect(()=>ensureOutputDir(resolved.dir,{root})).toThrow();
  expect(()=>assertTrackedWriteAllowed(target,{root,updateEvidence:false})).toThrow();
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.existsSync(path.join(outside,'explicit-output'))).toBe(false);
  expect(fs.existsSync(path.join(outside,'explicit-output','generated.json'))).toBe(false);
 });

 it('rejects a case-folded .OUT alias to an outside scratch root',({skip})=>{
   const root=tempDir();
   const outside=tempDir();
   execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
   const scratchRoot=path.join(root,'.out');
   const caseFoldedScratchRoot=path.join(root,'.OUT');
   fs.symlinkSync(outside,scratchRoot,'dir');
   const scratchStat=fs.lstatSync(scratchRoot);
   let caseFoldedStat:fs.Stats|undefined;
   try{
    caseFoldedStat=fs.lstatSync(caseFoldedScratchRoot);
   }catch(error){
    const code=error&&typeof error==='object'&&'code'in error?error.code:undefined;
    if(code!=='ENOENT')throw error;
   }
   if(!caseFoldedStat||caseFoldedStat.dev!==scratchStat.dev||caseFoldedStat.ino!==scratchStat.ino)skip();

   const outputDir=path.join(caseFoldedScratchRoot,'fixture-worktree','fixture-run','qa-output');
   const outputTarget=path.join(outputDir,'generated.json');
   expect(()=>ensureOutputDir(outputDir,{root})).toThrow();
   expect(()=>assertTrackedWriteAllowed(outputTarget,{root,updateEvidence:false})).toThrow();
   expect(fs.readdirSync(outside)).toEqual([]);
   expect(fs.existsSync(path.join(outside,'fixture-worktree'))).toBe(false);
 });

 it('rejects a nested outside symlink through a case-folded .OUT alias',({skip})=>{
   const root=tempDir();
   const outside=tempDir();
   execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
   const scratchRoot=path.join(root,'.out');
   const caseFoldedScratchRoot=path.join(root,'.OUT');
   fs.mkdirSync(scratchRoot);
   const scratchStat=fs.lstatSync(scratchRoot);
   let caseFoldedStat:fs.Stats|undefined;
   try{
    caseFoldedStat=fs.lstatSync(caseFoldedScratchRoot);
   }catch(error){
    const code=error&&typeof error==='object'&&'code'in error?error.code:undefined;
    if(code!=='ENOENT')throw error;
   }
   if(!caseFoldedStat||caseFoldedStat.dev!==scratchStat.dev||caseFoldedStat.ino!==scratchStat.ino)skip();

   const sentinelPath=path.join(outside,'sentinel.json');
   const sentinelBytes=Buffer.from('outside sentinel bytes\n');
   fs.writeFileSync(sentinelPath,sentinelBytes);
   const outputParent=path.join(scratchRoot,'fixture-worktree','fixture-run');
   fs.mkdirSync(outputParent,{recursive:true});
   fs.symlinkSync(outside,path.join(outputParent,'qa-output'),'dir');

   const outputDir=path.join(caseFoldedScratchRoot,'fixture-worktree','fixture-run','qa-output');
   const outputTarget=path.join(outputDir,'generated.json');
   expect(()=>ensureOutputDir(outputDir,{root})).toThrow();
   expect(()=>assertTrackedWriteAllowed(outputTarget,{root,updateEvidence:false})).toThrow();
   const attempt=attemptGuardedWrite(outputTarget,root,Buffer.from('replacement evidence bytes\n'));
   expect(attempt.error).toBeDefined();
   expect(attempt.writeReached).toBe(false);
   expect(fs.readFileSync(sentinelPath)).toEqual(sentinelBytes);
   expect(fs.readdirSync(outside).sort()).toEqual(['sentinel.json']);
  });

  it('keeps case-distinct paths separate on case-sensitive filesystems',({skip})=>{
    const root=tempDir();
    const trackedDir=path.join(root,'assets');
    const trackedPath=path.join(trackedDir,'evidence.json');
    fs.mkdirSync(trackedDir,{recursive:true});
    fs.writeFileSync(trackedPath,'tracked evidence\n');
    execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
    execFileSync('git',['add','--','assets/evidence.json'],{cwd:root,stdio:'ignore'});

    const aliasDir=path.join(root,'ASSETS');
    let aliasStat:fs.Stats|undefined;
    try{
     aliasStat=fs.lstatSync(aliasDir);
    }catch(error){
     const code=error&&typeof error==='object'&&'code'in error?error.code:undefined;
     if(code!=='ENOENT')throw error;
    }
    const trackedDirStat=fs.lstatSync(trackedDir);
    if(aliasStat&&aliasStat.dev===trackedDirStat.dev&&aliasStat.ino===trackedDirStat.ino)skip();

    expect(()=>assertTrackedWriteAllowed(path.join(aliasDir,'evidence.json'),{root,updateEvidence:false})).not.toThrow();
   });

   it('checks tracked symlink ancestors beneath case-aliased repository components',({skip})=>{
   const root=tempDir();
   const outside=tempDir();
   const scratchRoot=path.join(root,'.out');
   const caseFoldedScratchRoot=path.join(root,'.OUT');
   fs.mkdirSync(scratchRoot);
   const scratchStat=fs.lstatSync(scratchRoot);
   let caseFoldedStat:fs.Stats|undefined;
   try{
    caseFoldedStat=fs.lstatSync(caseFoldedScratchRoot);
   }catch(error){
    const code=error&&typeof error==='object'&&'code'in error?error.code:undefined;
    if(code!=='ENOENT')throw error;
   }
   if(!caseFoldedStat||caseFoldedStat.dev!==scratchStat.dev||caseFoldedStat.ino!==scratchStat.ino)skip();

   const trackedRelative='assets/external-link';
   const trackedPath=path.join(root,trackedRelative);
   fs.mkdirSync(path.dirname(trackedPath),{recursive:true});
   fs.symlinkSync(outside,trackedPath,'dir');
   execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
   execFileSync('git',['add','--',trackedRelative],{cwd:root,stdio:'ignore'});

   const aliasTarget=path.join(root,'ASSETS','external-link','generated.json');
   expect(()=>assertTrackedWriteAllowed(aliasTarget,{root,updateEvidence:false})).toThrow(/refusing to overwrite tracked file assets\/external-link/i);
   expect(fs.existsSync(path.join(outside,'generated.json'))).toBe(false);
  });

  it('rejects an in-repo alias symlink to .out when .out resolves outside',()=>{
  const root=tempDir();
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  const outside=tempDir();
  const aliasPath=path.join(root,'scratch-alias');
  fs.symlinkSync(outside,path.join(root,'.out'),'dir');
  fs.symlinkSync('.out',aliasPath,'dir');
  const outputDir=path.join(aliasPath,'fixture-worktree','fixture-run','qa-output');
  const target=path.join(outputDir,'generated.json');

  expect(()=>ensureOutputDir(outputDir,{root})).toThrow();
  expect(()=>assertTrackedWriteAllowed(target,{root,updateEvidence:false})).toThrow();
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.existsSync(path.join(outside,'fixture-worktree'))).toBe(false);
 });
});

describe('output preparation source order',()=>{
 it('asserts every production output-directory helper call and its root option',()=>{
  const callSites=[
   {file:'scripts/bench-workshop.mts',count:5,rootOption:'root'},
   {file:'scripts/extract-dynamics-reference.mjs',count:1,rootOption:'root'},
   {file:'scripts/export-pose-package.mts',count:1,rootOption:'root'},
   {file:'scripts/measure-quality-probe.mts',count:1,rootOption:'root'},
   {file:'scripts/browser-qa.mjs',count:1,rootOption:'root\\s*:\\s*repoRoot'},
   {file:'scripts/package-to-glb.mts',count:1,rootOption:'root'},
   {file:'scripts/generate-motion.mts',count:1,rootOption:'root'},
   {file:'scripts/recapture-solver-baseline.mts',count:1,rootOption:'root'},
  ];
  expect(callSites.reduce((total,{count})=>total+count,0)).toBe(12);
  for(const {file,count,rootOption} of callSites){
   const source=readRepoFile(file);
   expect(sourceCallPositions(source,'ensureOutputDir')).toHaveLength(count);
   expect(sourceMatchPositions(source,ensureCallWithRootOption(rootOption))).toHaveLength(count);
  }

  const declarations=readRepoFile('scripts/lib/qa-output.d.mts');
  const ensureDeclaration=declarations.match(/export declare function ensureOutputDir\([\s\S]*?\): string;/)?.[0]??'';
  expect(ensureDeclaration).toMatch(/options:\s*\{\s*root:\s*string\s*[;,]\s*updateEvidence\?:\s*boolean/);
 });

 it('prepares the dynamics reference output before a fresh write guard and write',()=>{
  const source=readRepoFile('scripts/extract-dynamics-reference.mjs');
  expectFreshWriteOrder(source,/atomicWriteFile\s*\(\s*outputFile\s*,/);
 });

 it('prepares package-to-GLB output before a fresh write guard and write',()=>{
  const source=readRepoFile('scripts/package-to-glb.mts');
  expectFreshWriteOrder(source,/atomicWriteFile\s*\(\s*out\s*,/);
 });

 it('prepares pose-package output before a fresh write guard and write',()=>{
  const source=readRepoFile('scripts/export-pose-package.mts');
  expectFreshWriteOrder(source,/atomicWriteFile\s*\(\s*out\s*,/);
 });

 it('validates both bench output modes and preflights regular destinations',()=>{
  const source=readRepoFile('scripts/bench-workshop.mts');
  const profileStart=source.search(/if\s*\(\s*profile\s*\)\s*\{/);
  const profileExit=source.indexOf('process.exit(0);',profileStart);
  const profileEnd=source.indexOf('}',profileExit);
  expect(profileStart).toBeGreaterThanOrEqual(0);
  expect(profileExit).toBeGreaterThan(profileStart);
  expect(profileEnd).toBeGreaterThan(profileExit);

  const beforeProfile=source.slice(0,profileStart);
  expect(beforeProfile).toMatch(/assertTrackedWriteAllowed\s*\(\s*outTarget/);
  const earlyReportPreparations=sourceMatchPositions(beforeProfile,/ensureOutputDir\s*\(\s*path\.dirname\s*\(\s*reportTarget/);
  const earlyReportGuards=sourceMatchPositions(beforeProfile,/assertTrackedWriteAllowed\s*\(\s*reportTarget/);
  if(earlyReportPreparations.length+earlyReportGuards.length>0){
   expect(ifConditions(source).some(({condition,position,body})=>
    /!\s*profile/.test(condition)&&position<profileStart&&/ensureOutputDir\s*\([^;]*reportTarget|assertTrackedWriteAllowed\s*\(\s*reportTarget/.test(body))).toBe(true);
  }

  const profileMode=source.slice(profileStart,profileEnd);
  const profileWrite=/atomicWriteFile\s*\(\s*profileOut\s*,/;
  expect(profileMode).not.toMatch(/ensureOutputDir\s*\(\s*path\.dirname\s*\(\s*reportTarget|assertTrackedWriteAllowed\s*\(\s*reportTarget/);
  expectFreshWriteOrder(profileMode,profileWrite);

  const regularMode=source.slice(profileEnd+1);
  const baselineWrite=/atomicWriteFile\s*\(\s*baselineOut\s*,/;
  const reportWrite=/atomicWriteFile\s*\(\s*finalReportPath\s*,/;
  const firstRegularWrite=regularMode.search(baselineWrite);
  const finalReportWrite=regularMode.search(reportWrite);
  const firstRegularMeasurement=regularMode.search(/\brunStageLoop\s*\(/);
  expect(firstRegularWrite).toBeGreaterThanOrEqual(0);
  expect(finalReportWrite).toBeGreaterThan(firstRegularWrite);
  expect(firstRegularMeasurement).toBeGreaterThanOrEqual(0);

  const outputPreparations=sourceMatchPositions(regularMode,/ensureOutputDir\s*\(\s*path\.dirname\s*\(\s*outTarget\s*\)/);
  const reportPreparations=sourceMatchPositions(regularMode,/ensureOutputDir\s*\(\s*path\.dirname\s*\(\s*reportTarget\s*\)/);
  const outputGuards=sourceMatchPositions(regularMode,/assertTrackedWriteAllowed\s*\(\s*outTarget\s*,/);
  const reportGuards=sourceMatchPositions(regularMode,/assertTrackedWriteAllowed\s*\(\s*reportTarget\s*,/);
  const outputPreparation=lastPositionBefore(outputPreparations,firstRegularWrite);
  const outputGuard=lastPositionBefore(outputGuards,firstRegularWrite);
  const reportPreparation=lastPositionBefore(reportPreparations,firstRegularWrite);
  const reportGuard=lastPositionBefore(reportGuards,firstRegularWrite);
  expect(outputPreparation).toBeGreaterThanOrEqual(0);
  expect(outputGuard).toBeGreaterThan(outputPreparation);
  expect(reportPreparation).toBeGreaterThanOrEqual(0);
  expect(reportGuard).toBeGreaterThan(reportPreparation);
  expect(outputGuard).toBeLessThan(firstRegularWrite);
  expect(reportGuard).toBeLessThan(firstRegularWrite);

  const finalReportPreparation=lastPositionBefore(reportPreparations,finalReportWrite);
  const finalReportGuard=lastPositionBefore(reportGuards,finalReportWrite);
  expect(finalReportPreparation).toBeGreaterThanOrEqual(0);
  expect(finalReportGuard).toBeGreaterThan(finalReportPreparation);
  expect(finalReportGuard).toBeLessThan(finalReportWrite);

  const firstRegularMeasurementAbsolute=profileEnd+1+firstRegularMeasurement;
  const firstRegularWriteAbsolute=profileEnd+1+firstRegularWrite;
  const firstRegularPreparationAbsolute=profileEnd+1+Math.min(outputPreparation,reportPreparation);
  const conditionalGuards=ifConditions(source);
  const collisionGuard=conditionalGuards.find(({condition,body})=>
   /out/i.test(condition)&&/report/i.test(condition)&&/(?:process\.exit\s*\(|throw\s+)/.test(body));
  const collisionPosition=collisionGuard?.position??-1;
  expect(collisionPosition).toBeGreaterThanOrEqual(0);
  expect(conditionalGuards.some(({condition,position})=>
   /!\s*profile/.test(condition)&&position<collisionPosition&&collisionPosition<position+500)).toBe(true);
  expect(collisionPosition).toBeLessThan(firstRegularMeasurementAbsolute);
  expect(collisionPosition).toBeLessThan(firstRegularPreparationAbsolute);
  expect(collisionPosition).toBeLessThan(firstRegularWriteAbsolute);

  const compareSelfGuard=conditionalGuards.find(({condition,body})=>
   /comparePath/i.test(condition)&&/out/i.test(condition)&&/(?:process\.exit\s*\(|throw\s+)/.test(body));
  const compareGuardPosition=compareSelfGuard?.position??-1;
  expect(compareGuardPosition).toBeGreaterThanOrEqual(0);
  expect(compareGuardPosition).toBeLessThan(firstRegularMeasurementAbsolute);
  expect(compareGuardPosition).toBeLessThan(firstRegularWriteAbsolute);
 });
});

describe('atomic output writes',()=>{
 it('publishes content via rename and leaves no sibling temp files',()=>{
  const dir=tempDir();
  const target=path.join(dir,'result.json');
  atomicWriteFile(target,'{"a":1}');
  expect(fs.readFileSync(target,'utf8')).toBe('{"a":1}');
  expect(fs.readdirSync(dir)).toEqual(['result.json']);
 });

 it('replaces an existing file fully rather than appending or truncating in place',()=>{
  const dir=tempDir();
  const target=path.join(dir,'result.json');
  atomicWriteFile(target,'long-original-contents');
  atomicWriteFile(target,Buffer.from('short'));
  expect(fs.readFileSync(target,'utf8')).toBe('short');
  expect(fs.readdirSync(dir)).toEqual(['result.json']);
 });
});

describe('tracked evidence write protection',()=>{
 const trackedTarget=path.join(ROOT,'spec/examples/idle.pose.json');

 it('rejects a tracked write unless --update-evidence was provided',()=>{
  expect(()=>assertTrackedWriteAllowed(trackedTarget,{root:ROOT,updateEvidence:false})).toThrow();
 });

 it('allows a tracked write with explicit evidence update opt-in',()=>{
  expect(()=>assertTrackedWriteAllowed(trackedTarget,{root:ROOT,updateEvidence:true})).not.toThrow();
 });

 it('allows an untracked path that traverses the same symlink more than once',()=>{
  const root=tempDir();
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  const repeated=path.join(root,'repeat');
  fs.symlinkSync('.',repeated,'dir');
  const target=path.join(repeated,'repeat','generated.json');

  expect(()=>assertTrackedWriteAllowed(target,{root,updateEvidence:false})).not.toThrow();
 });

 it('rejects a dangling symlink to an indexed file missing from the worktree',()=>{
  const root=tempDir();
  const trackedPath=path.join(root,'evidence','missing.json');
  const outputPath=path.join(root,'scratch','redirected.json');
  fs.mkdirSync(path.dirname(trackedPath),{recursive:true});
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});
  fs.writeFileSync(trackedPath,'{}');
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  execFileSync('git',['add','--','evidence/missing.json'],{cwd:root,stdio:'ignore'});
  fs.unlinkSync(trackedPath);
  fs.symlinkSync(trackedPath,outputPath);

  expect(()=>{
   const allowedTarget=assertTrackedWriteAllowed(outputPath,{root,updateEvidence:false});
   fs.writeFileSync(allowedTarget,'replacement');
  }).toThrow();
  expect(fs.existsSync(trackedPath)).toBe(false);
 });

 it('rejects a scratch hard link to staged evidence before writing through it',()=>{
  const root=tempDir();
  const trackedRelative='spec/evidence.json';
  const trackedPath=path.join(root,'spec','evidence.json');
  const aliasPath=path.join(root,'scratch','evidence-link.json');
  const originalBytes=Buffer.from('original evidence bytes\n');
  const replacementBytes=Buffer.from('replacement evidence bytes\n');
  fs.mkdirSync(path.dirname(trackedPath),{recursive:true});
  fs.mkdirSync(path.dirname(aliasPath),{recursive:true});
  fs.writeFileSync(trackedPath,originalBytes);
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  execFileSync('git',['add','--',trackedRelative],{cwd:root,stdio:'ignore'});
  fs.linkSync(trackedPath,aliasPath);

  let writeReached=false;
  let writeError:unknown;
  try{
   const allowedTarget=assertTrackedWriteAllowed(aliasPath,{root,updateEvidence:false});
   writeReached=true;
   fs.writeFileSync(allowedTarget,replacementBytes);
  }catch(error){
   writeError=error;
  }
  expect(writeError).toBeInstanceOf(Error);
  expect(writeReached).toBe(false);
  expect(fs.readFileSync(trackedPath)).toEqual(originalBytes);
 });

 it('rejects a .out symlink to staged tracked evidence before a caller can overwrite it',()=>{
  const root=tempDir();
  const trackedRelative='spec/evidence.json';
  const trackedPath=path.join(root,'spec','evidence.json');
  const outputDir=defaultOutputDir(root);
  const aliasPath=path.join(outputDir,'alias.json');
  const originalBytes=Buffer.from('staged evidence bytes\n');
  fs.mkdirSync(path.dirname(trackedPath),{recursive:true});
  fs.mkdirSync(outputDir,{recursive:true});
  fs.writeFileSync(trackedPath,originalBytes);
  execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
  execFileSync('git',['add','--',trackedRelative],{cwd:root,stdio:'ignore'});
  fs.symlinkSync(trackedPath,aliasPath);

  const attempt=attemptGuardedWrite(aliasPath,root,Buffer.from('overwrite attempt'));
  expect(attempt.error).toBeInstanceOf(Error);
  expect(attempt.writeReached).toBe(false);
  expect(fs.readFileSync(trackedPath)).toEqual(originalBytes);
 });

  it('rejects a staged tracked symlink file to an external sentinel before writing',()=>{
   const root=tempDir();
   const outside=tempDir();
   const trackedRelative='spec/external-evidence.json';
   const trackedPath=path.join(root,trackedRelative);
   const sentinelPath=path.join(outside,'evidence.json');
   const originalBytes=Buffer.from('external evidence sentinel\n');
   fs.mkdirSync(path.dirname(trackedPath),{recursive:true});
   fs.writeFileSync(sentinelPath,originalBytes);
   fs.symlinkSync(sentinelPath,trackedPath);
   execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
   execFileSync('git',['add','--',trackedRelative],{cwd:root,stdio:'ignore'});

   const attempt=attemptGuardedWrite(trackedPath,root,Buffer.from('overwrite attempt'));
   expect(attempt.error).toBeInstanceOf(Error);
   expect(attempt.writeReached).toBe(false);
   expect(fs.readFileSync(sentinelPath)).toEqual(originalBytes);
  });

  it('rejects a staged tracked directory symlink target to an external sentinel before writing',()=>{
   const root=tempDir();
   const outside=tempDir();
   const trackedRelative='spec/external-assets';
   const trackedPath=path.join(root,trackedRelative);
   const nestedTarget=path.join(trackedPath,'evidence.json');
   const sentinelPath=path.join(outside,'evidence.json');
   const originalBytes=Buffer.from('external directory sentinel\n');
   fs.mkdirSync(path.dirname(trackedPath),{recursive:true});
   fs.writeFileSync(sentinelPath,originalBytes);
   fs.symlinkSync(outside,trackedPath,'dir');
   execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
   execFileSync('git',['add','--',trackedRelative],{cwd:root,stdio:'ignore'});

   const attempt=attemptGuardedWrite(nestedTarget,root,Buffer.from('overwrite attempt'));
   expect(attempt.error).toBeInstanceOf(Error);
   expect(attempt.writeReached).toBe(false);
   expect(fs.readFileSync(sentinelPath)).toEqual(originalBytes);
  });

  it('preflights a tracked directory symlink with evidence update opt-in',()=>{
   const root=tempDir();
   const outside=tempDir();
   const trackedRelative='assets/external-link';
   const trackedPath=path.join(root,trackedRelative);
   const sentinelPath=path.join(outside,'sentinel.json');
   const originalBytes=Buffer.from('external asset sentinel\n');
   fs.mkdirSync(path.dirname(trackedPath),{recursive:true});
   fs.writeFileSync(sentinelPath,originalBytes);
   const sentinelBytes=fs.readFileSync(sentinelPath);
   fs.symlinkSync(outside,trackedPath,'dir');
   execFileSync('git',['init','--quiet'],{cwd:root,stdio:'ignore'});
   execFileSync('git',['add','--',trackedRelative],{cwd:root,stdio:'ignore'});

   const outsideEntries=fs.readdirSync(outside).sort();
   const outputArgs=['--out-dir',path.join(trackedPath,'new')];
   const defaultResolved=resolveOutputDir('qa-output',outputArgs,root,{});
   expect(defaultResolved.updateEvidence).toBe(false);
   expect(()=>ensureOutputDir(defaultResolved.dir,{root,updateEvidence:defaultResolved.updateEvidence})).toThrow(/refusing to overwrite tracked file assets\/external-link/);
   expect(fs.existsSync(path.join(outside,'new'))).toBe(false);
   expect(fs.readdirSync(outside).sort()).toEqual(outsideEntries);
   expect(fs.readFileSync(sentinelPath)).toEqual(sentinelBytes);

   const updateResolved=resolveOutputDir('qa-output',[...outputArgs,'--update-evidence'],root,{});
   expect(updateResolved.updateEvidence).toBe(true);
   expect(ensureOutputDir(updateResolved.dir,{root,updateEvidence:updateResolved.updateEvidence})).toBe(updateResolved.dir);
   expect(fs.statSync(path.join(outside,'new')).isDirectory()).toBe(true);
   expect(fs.readdirSync(outside).sort()).toEqual([...outsideEntries,'new'].sort());
   expect(fs.readFileSync(sentinelPath)).toEqual(sentinelBytes);

   const target=path.join(updateResolved.dir,'generated.json');
   expect(()=>assertTrackedWriteAllowed(target,{root,updateEvidence:false})).toThrow();
   expect(()=>assertTrackedWriteAllowed(target,{root,updateEvidence:updateResolved.updateEvidence})).not.toThrow();
  });
 });
