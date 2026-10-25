import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {createService,handleRequest,LIMITS_SVC} from './service';
import type {ErrorCode} from './errors';
// Loopback-only reference service for the v1 motion protocol. No user-supplied
// paths/scripts; request body capped; pose-json output only.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const assetDir=process.env.HUMAN3D_ASSETS??path.join(root,'public');
const port=Number(process.env.HUMAN3D_PORT??8788);

/** Host must name the loopback interface. Binding to 127.0.0.1 alone does not
 * stop DNS rebinding: a page on another name can resolve to 127.0.0.1, and the
 * browser then sends that other name in Host. */
const HOST_OK=/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/;
/** Browsers always send Origin on cross-origin POSTs. When present it must be
 * the service's own origin; absent Origin (curl, server-side clients) is allowed. */
function originAllowed(origin:string|undefined,host:string){
 if(origin===undefined)return true;
 try{return new URL(origin).host===host;}catch{return false;}
}

export async function startMotionService(listenPort=port,assets=assetDir){
const ctx=await createService(assets);
const server=http.createServer((req,res)=>{
 const send=(status:number,body:unknown)=>{
  const data=JSON.stringify(body);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(data)});
  res.end(data);
 };
 const sendError=(status:number,code:ErrorCode,message:string)=>send(status,{error:{code,message}});
 const host=req.headers.host??'';
 if(!HOST_OK.test(host)){sendError(403,'forbidden',`Host '${host}' is not the loopback service`);req.resume();return;}
 if(!originAllowed(req.headers.origin,host)){sendError(403,'forbidden','Origin does not match the service');req.resume();return;}
 if(req.method==='POST'){
  const type=(req.headers['content-type']??'').split(';')[0].trim().toLowerCase();
  if(type!=='application/json'){sendError(415,'unsupported_media_type','POST bodies must be application/json');req.resume();return;}
 }
 const url=new URL(req.url??'/','http://localhost');
 // Honour the advertised contract: bodies may arrive Content-Encoding: gzip.
 // The byte cap applies to the DECOMPRESSED payload — compressed size says
 // nothing about how large the request actually is.
 const enc=(req.headers['content-encoding']??'identity').toLowerCase();
 if(enc!=='identity'&&enc!=='gzip'){sendError(400,'invalid_request',`unsupported Content-Encoding '${enc}'`);req.resume();return;}
 const stream=enc==='gzip'?req.pipe(zlib.createGunzip()):req;
 const chunks:Buffer[]=[];let size=0,done=false;
 // fail() also destroys the gunzip stream: a rejected request must stop
 // spending CPU on decompressing the rest of an over-limit body.
 const fail=(status:number,code:ErrorCode,message:string)=>{if(!done){done=true;sendError(status,code,message);if(stream!==req)stream.destroy();req.socket.end();}};
 stream.on('data',(c:Buffer)=>{size+=c.length;if(size>LIMITS_SVC.maxBodyBytes){fail(413,'request_too_large',`body exceeds ${LIMITS_SVC.maxBodyBytes} bytes`);return;}chunks.push(c);});
 stream.on('error',()=>fail(400,'invalid_request','request body could not be decompressed'));
 req.on('error',()=>fail(400,'invalid_request','request stream failed'));
 stream.on('end',()=>{
  if(done)return;done=true;
  let body:unknown;
  if(chunks.length){
   try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
   catch{sendError(400,'invalid_json','request body is not valid JSON');return;}
  }
  try{
   const headers:Record<string,string>={};
   const idem=req.headers['idempotency-key'];if(typeof idem==='string')headers['idempotency-key']=idem;
   const out=handleRequest(ctx,req.method??'GET',url.pathname,body,headers);
   send(out.status,out.body);
  }catch(e){sendError(500,'internal',e instanceof Error?e.message:String(e));}
 });
});
await new Promise<void>((resolve,reject)=>{
 server.once('error',reject);
 server.listen(listenPort,'127.0.0.1',()=>{server.off('error',reject);resolve();});
});
return server;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 await startMotionService();
 console.log(`human3d-motion v1 listening on http://127.0.0.1:${port}`);
 console.log(`GET /v1/capabilities · POST /v1/motions · assets: ${assetDir}`);
}
