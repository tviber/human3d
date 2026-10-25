import {acquireValidationLock} from './process-lock.mjs';

export async function launchQaBrowser(chromium,options={}){
 const release=await acquireValidationLock();
 try{
  const browser=await chromium.launch({headless:true,args:['--renderer-process-limit=1'],...options});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
   const code=signal==='SIGINT'?130:143;
   const timeout=setTimeout(()=>{browser.process()?.kill('SIGKILL');process.exit(code);},3000);
   void browser.close().finally(()=>{clearTimeout(timeout);process.exit(code);});
  });
  return browser;
 }
 catch(error){release();throw error;}
}
