import {configDefaults,defineConfig} from 'vitest/config';

export default defineConfig({
 test:{
  pool:'threads',
  maxWorkers:1,
  fileParallelism:false,
  globalSetup:'./scripts/lib/process-lock.mjs',
  exclude:[
   ...configDefaults.exclude,
   '**/.out/**',
   '**/.worktrees/**',
   '**/worktrees/**',
   '**/build/**',
   '**/dist/**',
   '**/.git/**',
   '**/node_modules/**',
  ],
 },
});
