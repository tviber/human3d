import {webPlatform} from '../platform/platform';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {attachProp,generateMotion,HumanRig} from '@human3d/motion-core';
import type {RigInfo} from '@human3d/motion-core';
import type {GenerateWorkerReply,GenerateWorkerRequest,MotionGenSummary} from './generation-protocol';

const worker=self as unknown as {
 onmessage:((event:MessageEvent<GenerateWorkerRequest>)=>void)|null;
 postMessage:(message:GenerateWorkerReply)=>void;
};

worker.onmessage=async(event:MessageEvent<GenerateWorkerRequest>)=>{
 const request=event.data;
 if(request?.type!=='generate')return;
 try{
  const [gltf,response]=await Promise.all([
   new GLTFLoader().loadAsync(webPlatform.assetUrl('/models/human.glb')).catch(error=>{
    throw new Error(`GLTFLoader Worker 无法加载人体模型：${error instanceof Error?error.message:String(error)}`);
   }),
   webPlatform.fetchAsset('/models/rig.json').catch(error=>{
    throw new Error(`人体骨架请求失败：${error instanceof Error?error.message:String(error)}`);
   }),
  ]);
  if(!response.ok)throw new Error(`人体骨架请求失败：${response.status}`);
  const info=await response.json() as RigInfo;
  const rig=new HumanRig(gltf.scene,info);
  const grip=request.doc.gripSide==='L'?'L':'R';
  const racket=attachProp(rig,'racket',grip,request.doc.gripBevel,request.doc.gripTilt);
  const result=generateMotion(rig,{
   doc:request.doc,
   lockedKeyIds:request.lockedKeyIds,
   adjust:request.adjust,
   tip:request.doc.keys.some(k=>k.constraints.contact)?racket:undefined,
   onProgress:(progress)=>worker.postMessage({type:'progress',progress}),
  });
  // Probe frames are useful for offline diagnostics but the UI does not show
  // them. Strip them before structured cloning the review result to the page.
  const summary:MotionGenSummary={
   candidates:result.candidates.map(({doc,objective,verdict,metrics,constraints})=>({doc,objective,verdict,metrics,constraints})),
   rejected:result.rejected,
   diagnostics:result.diagnostics,
  };
  worker.postMessage({type:'done',result:summary});
 }catch(error){
  worker.postMessage({type:'error',message:error instanceof Error?error.message:String(error)});
 }
};
