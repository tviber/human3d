import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot=fileURLToPath(new URL('../..',import.meta.url));
const port=(name:string,fallback:number)=>{
 const value=Number(process.env[name]??fallback);
 if(!Number.isInteger(value)||value<1||value>65535)throw new Error(`${name} must be a valid port`);
 return value;
};

export default defineConfig({
 root:path.join(repoRoot,'apps/web'),
 plugins:[react()],
 publicDir:path.join(repoRoot,'public'),
 build:{outDir:path.join(repoRoot,'dist'),emptyOutDir:true,rollupOptions:{output:{manualChunks:{three:['three']}}}},
 server:{host:'127.0.0.1',port:port('HUMAN3D_WEB_PORT',5173),strictPort:true},
 preview:{host:'127.0.0.1',port:port('HUMAN3D_PREVIEW_PORT',4173),strictPort:true},
});
