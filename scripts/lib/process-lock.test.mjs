import {describe,expect,it} from 'vitest';
import {countNodeAndFfmpegProcesses} from './process-lock.mjs';

describe('countNodeAndFfmpegProcesses',()=>{
 it('counts Node runtimes, npm launchers, and ffmpeg while ignoring unrelated apps',()=>{
  const processList=[
   'node',
   'npm exec @playwright/mcp@latest',
   'zcode-node-repl-mcp',
   'ffmpeg',
   'tsserver',
   'Chromium',
   'WindowServer',
   'mds_stores',
   '/Applications/Codex.app/Contents/Resources/vendor/node_modules/codex',
   'content manager.node',
  ].join('\n');
  expect(countNodeAndFfmpegProcesses(processList)).toBe(5);
 });
});
