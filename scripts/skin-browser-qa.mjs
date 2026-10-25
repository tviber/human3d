import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {chromium} from 'playwright';
import {resolveOutputDir,ensureOutputDir,assertTrackedWriteAllowed} from './lib/qa-output.mjs';
import {verifyWebIdentity} from './lib/worktree-check.mjs';

// Real switches write the production material path. Engine reads and playback control are diagnostics only.
const root=process.cwd(),output=resolveOutputDir('skin',process.argv.slice(2),root,process.env);
assert.equal(output.args.length,0);ensureOutputDir(output.dir,{root,updateEvidence:output.updateEvidence});
const out=name=>assertTrackedWriteAllowed(path.join(output.dir,name),{root,updateEvidence:output.updateEvidence});
const base=new URL(process.env.QA_WEB_URL??`http://127.0.0.1:${process.env.HUMAN3D_WEB_PORT??5173}/`);
const identity=await verifyWebIdentity(root,base);assert(identity.ok,identity.detail);
const browser=await chromium.launch({headless:true,...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
const errors=[];let fault=false;
const skinSwitch=page=>page.getByRole('switch',{name:'超赛皮肤',exact:true});
const check=async(page,key,ssj)=>{
 const state=await page.evaluate(({key,ssj})=>{
  const e=window[key],before=window.__skinSnapshot;let unchanged=true;
  for(const {mesh,geometry,attributes,material} of before){
   unchanged&&=mesh.geometry===geometry&&mesh.skeleton===attributes.skeleton;
   for(const [name,values] of attributes.data){
    unchanged&&=geometry.getAttribute(name).array.every((v,i)=>v===values[i]);
    unchanged&&=mesh.geometry.getAttribute(name).array.every((v,i)=>v===values[i]);
   }
   unchanged&&=!mesh.geometry.hasAttribute('color');
   unchanged&&=ssj?mesh.material.isMeshStandardMaterial&&mesh.material.map?.image.width===2048&&mesh.material.map?.colorSpace==='srgb'&&mesh.material.map.flipY===false:mesh.material===material;
  }
  const hair=e.model.getObjectByName('ssj-hair');
  const g=hair?.children[0].geometry,rest=e.skinSwap.hairPhysics?.rest;let rootsFixed=true,maxBend=0;
  if(g&&rest){const p=g.getAttribute('position'),flex=g.getAttribute('hairFlex');for(let i=0;i<p.count;i++){const d=Math.hypot(p.getX(i)-rest[i*3],p.getY(i)-rest[i*3+1],p.getZ(i)-rest[i*3+2]);maxBend=Math.max(maxBend,d);if(flex.getY(i)===0&&d!==0)rootsFixed=false;}}
  return {unchanged,rootsFixed,maxBend,skin:e.skin,hairCount:e.model.getObjectsByProperty('name','ssj-hair').length,hairVisible:hair?.visible??false,solidHair:!!hair&&hair.parent===e.rig.bone('head')&&hair.children[0].isMesh&&hair.children[0].geometry.index.count>1000,doc:e.getDoc?JSON.stringify(e.getDoc()):null,storage:localStorage.getItem('kinesis-workshop-library')};
 },{key,ssj});
 assert(state.unchanged,'skin swap changed original surface geometry/normals/weights or failed to restore the material');assert(state.rootsFixed&&state.maxBend<=.02401,'hair roots moved or spring motion exceeded its bound');assert.equal(state.skin,ssj?'ssj':'default');assert.equal(state.hairVisible,ssj);assert.equal(state.hairCount,1);assert(state.solidHair,'hair must be a real indexed 3D mesh on the head bone');return state;
};
try{
 for(const [route,key] of [['/','__LAB__'],['/workshop.html','__WS__']]){
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!fault)errors.push(m.text());});
  const requests=[];page.on('request',r=>{if(r.url().includes('/models/skins/'))requests.push(r.url());});
  await page.goto(new URL(route,base).href);await page.waitForFunction(key=>window[key]?.ready,key,{timeout:60000});
  assert.equal(new URL(page.url()).pathname,route);assert.match(await page.title(),/KINESIS/);assert((await page.locator('body').innerText()).includes('超赛皮肤'));assert.equal(await page.locator('vite-error-overlay').count(),0);
  assert.equal(requests.length,0,'default viewer eagerly loaded unused skin textures');
  assert.equal(await page.evaluate(key=>window[key].model.getObjectsByProperty('name','ssj-hair').length,key),0,'default skin must start bald');
  await page.evaluate(key=>{
   const e=window[key];e.setPlaying(false);e.seek(0);
   window.__skinBones=JSON.stringify([...e.rig.bones.values()].map(b=>[b.position.toArray(),b.quaternion.toArray(),b.scale.toArray()]));window.__skinSnapshot=[];e.model.traverse(mesh=>{if(mesh.isSkinnedMesh)window.__skinSnapshot.push({mesh,geometry:mesh.geometry,material:mesh.material,attributes:{skeleton:mesh.skeleton,data:['position','normal','uv','skinIndex','skinWeight'].map(name=>[name,mesh.geometry.getAttribute(name).array.slice()])}});});
  },key);
  const documentBefore=await page.evaluate(key=>({doc:window[key].getDoc?JSON.stringify(window[key].getDoc()):null,storage:localStorage.getItem('kinesis-workshop-library')}),key);
  // Fault injection drops a real texture request; success still uses the real server and image decoder.
  fault=true;await page.route('**/models/skins/ssj-body.png',r=>r.abort());
  await skinSwitch(page).click();await page.getByRole('alert').filter({hasText:'超赛贴图加载失败'}).waitFor();
  assert.equal(await skinSwitch(page).getAttribute('aria-checked'),'false');assert.equal(await page.evaluate(key=>window[key].skin,key),'default');
  await page.unroute('**/models/skins/ssj-body.png');fault=false;
  await skinSwitch(page).click();await page.waitForFunction(key=>window[key].skin==='ssj',key);await page.waitForFunction(()=>document.querySelector('[aria-label="超赛皮肤"]').getAttribute('aria-checked')==='true');
  await page.waitForFunction(key=>window[key].skinSwap.hairPhysics.particles.some(p=>p.offset.length()>.001),key);
  const dressed=await check(page,key,true);assert(await page.evaluate(key=>JSON.stringify([...window[key].rig.bones.values()].map(b=>[b.position.toArray(),b.quaternion.toArray(),b.scale.toArray()]))===window.__skinBones,key),'skin appearance wrote to bone transforms');assert.deepEqual({doc:dressed.doc,storage:dressed.storage},documentBefore);
  const first=await page.evaluate(key=>({hair:window[key].model.getObjectByName('ssj-hair').uuid,map:window.__skinSnapshot[0].mesh.material.map.uuid,material:window.__skinSnapshot[0].mesh.material.uuid,geometry:window.__skinSnapshot[0].mesh.geometry.uuid}),key);
  await page.screenshot({path:out(`${key}-desktop.png`)});
  const camera=await page.evaluate(key=>({position:window[key].camera.position.toArray(),target:window[key].controls.target.toArray()}),key);
  for(const [view,position] of [['face',[0,1.72,.85]],['profile',[.85,1.72,0]],['rear',[0,1.72,-.85]],['three-quarter',[.60,1.72,.60]]]){
   await page.evaluate(({key,position})=>{const e=window[key];e.camera.position.fromArray(position);e.controls.target.set(0,1.72,0);e.controls.update();e.renderer.render(e.scene,e.camera);},{key,position});
   if(view==='rear'){
    const coverage=await page.evaluate(key=>{
     const e=window[key],mesh=window.__skinSnapshot[0].mesh,pos=mesh.geometry.getAttribute('position'),source=e.renderer.domElement,canvas=document.createElement('canvas');
     canvas.width=source.width;canvas.height=source.height;const ctx=canvas.getContext('2d');ctx.drawImage(source,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let covered=0,total=0;
     for(let i=0;i<pos.count;i++)if(Math.abs(pos.getX(i))<.018&&pos.getY(i)>1.71&&pos.getY(i)<1.75&&pos.getZ(i)<0){
      const p=mesh.getVertexPosition(i,e.camera.position.clone()).applyMatrix4(mesh.matrixWorld).project(e.camera),x=Math.round((p.x+1)*canvas.width/2),y=Math.round((1-p.y)*canvas.height/2),o=(y*canvas.width+x)*4;
      total++;if(pixels[o]>120&&pixels[o]>pixels[o+2]*1.4&&pixels[o+1]>pixels[o+2]*1.3)covered++;
     }
     return {covered,total};
    },key);
    assert(coverage.total>20&&coverage.covered/coverage.total>.9,`rear scalp shows through the hair: ${JSON.stringify(coverage)}`);
   }
   await page.screenshot({path:out(`${key}-${view}-ssj.png`)});
   await skinSwitch(page).click();await page.waitForFunction(key=>window[key].skin==='default',key);await check(page,key,false);
   // setSkin reframes the camera, so restore the exact same diagnostic view for comparison.
   await page.evaluate(({key,position})=>{const e=window[key];e.camera.position.fromArray(position);e.controls.target.set(0,1.72,0);e.controls.update();e.renderer.render(e.scene,e.camera);},{key,position});
   await page.screenshot({path:out(`${key}-${view}-default.png`)});
   await skinSwitch(page).click();await page.waitForFunction(key=>window[key].skin==='ssj',key);await check(page,key,true);
  }
  await page.evaluate(({key,camera})=>{const e=window[key];e.camera.position.fromArray(camera.position);e.controls.target.fromArray(camera.target);e.controls.update();e.renderer.render(e.scene,e.camera);},{key,camera});
  if(key==='__LAB__'){
   await page.getByRole('switch',{name:'人体表面',exact:true}).click();
   assert.equal(await page.evaluate(()=>window.__LAB__.model.getObjectByName('ssj-hair').visible),false);
   await page.getByRole('switch',{name:'人体表面',exact:true}).click();
   // Find an authored chest triangle, then hover through the real pointer path.
   const points=await page.evaluate(()=>{
    const e=window.__LAB__,mesh=window.__skinSnapshot[0].mesh,g=mesh.geometry,uv=g.getAttribute('uv'),idx=g.index,rect=e.renderer.domElement.getBoundingClientRect(),points=[];
    for(let i=0;i<idx.count;i+=3){const a=idx.getX(i),b=idx.getX(i+1),c=idx.getX(i+2);if(e.anatomy.atlas.regionAt({x:(uv.getX(a)+uv.getX(b)+uv.getX(c))/3,y:(uv.getY(a)+uv.getY(b)+uv.getY(c))/3})?.key!=='pectoralis_L')continue;
     const p=mesh.getVertexPosition(a,e.camera.position.clone()).applyMatrix4(mesh.matrixWorld).project(e.camera);points.push({x:rect.x+(p.x+1)*rect.width/2,y:rect.y+(1-p.y)*rect.height/2});}
    return points.filter((_,i)=>i%20===0).slice(0,15);
   });
   let selected=false;for(const p of points){await page.mouse.move(p.x,p.y);await page.waitForTimeout(180);if(await page.evaluate(()=>window.__LAB__.anatomy.state.active==='pectoralis_L')){selected=true;break;}}
   assert(selected,'muscle selection stopped working on the textured body');await page.mouse.move(10,10);
   await page.getByRole('button',{name:/正手挥拍/}).click();await page.evaluate(()=>window.__LAB__.seek(.5));
  }else{
   const download=page.waitForEvent('download');await page.getByRole('button',{name:'渲染静帧',exact:true}).click();await(await download).saveAs(out('workshop-still.png'));
   const margin=await page.evaluate(async data=>{
    const image=new Image();image.src=`data:image/png;base64,${data}`;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    const pixels=ctx.getImageData(0,0,image.width,image.height).data;let count=0,first=image.height;
    for(let i=0;i<pixels.length;i+=4)if(pixels[i]>200&&pixels[i+1]>pixels[i+2]*1.6&&pixels[i]>pixels[i+1]*1.03){count++;first=Math.min(first,Math.floor(i/4/image.width));}
    return {count,first,width:image.width,height:image.height};
   },fs.readFileSync(out('workshop-still.png')).toString('base64'));
   assert.equal(margin.width,640);assert.equal(margin.height,720);assert(margin.count>300&&margin.first>=8,'export cropped the golden hair');
   const repeat=page.waitForEvent('download');await page.getByRole('button',{name:'渲染静帧',exact:true}).click();await(await repeat).saveAs(out('workshop-still-repeat.png'));
   assert(fs.readFileSync(out('workshop-still.png')).equals(fs.readFileSync(out('workshop-still-repeat.png'))),'settled hair export depends on live spring history');
   const state=await check(page,key,true);assert.deepEqual({doc:state.doc,storage:state.storage},documentBefore);
  }
  await skinSwitch(page).click();await page.waitForFunction(key=>window[key].skin==='default',key);await check(page,key,false);await page.screenshot({path:out(`${key}-default-bald.png`),animations:'disabled'});
  await skinSwitch(page).click();await page.waitForFunction(key=>window[key].skin==='ssj',key);await check(page,key,true);
  assert.deepEqual(await page.evaluate(key=>({hair:window[key].model.getObjectByName('ssj-hair').uuid,map:window.__skinSnapshot[0].mesh.material.map.uuid,material:window.__skinSnapshot[0].mesh.material.uuid,geometry:window.__skinSnapshot[0].mesh.geometry.uuid}),key),first,'repeat switches allocated new materials or hair');
  await page.setViewportSize({width:390,height:844});await page.getByTestId(key==='__LAB__'?'sheet-inspector':'sheet-right').click();await skinSwitch(page).scrollIntoViewIfNeeded();
  assert(await skinSwitch(page).isVisible());assert(await skinSwitch(page).isEnabled());await page.screenshot({path:out(`${key}-mobile.png`)});
  await skinSwitch(page).click();await page.waitForFunction(key=>window[key].skin==='default',key);await check(page,key,false);
  const released=await page.evaluate(key=>{
   const e=window[key],swap=e.skinSwap,resources=new Set(swap.textures);
   for(const entry of swap.entries)resources.add(entry.replacement);
   swap.hair.traverse(o=>{if(o.isMesh){resources.add(o.geometry);resources.add(o.material);}});
   for(const eye of swap.eyes){resources.add(eye.geometry);resources.add(eye.material);}
   const counts=new Map();for(const resource of resources){counts.set(resource,0);resource.addEventListener('dispose',()=>counts.set(resource,counts.get(resource)+1));}
   e.dispose();return [...counts.values()].every(n=>n===1)&&!e.model.getObjectByName('ssj-hair');
  },key);
  assert(released,'viewer disposal leaked or double-disposed skin resources');await page.close();
 }
 const phone=await browser.newPage({viewport:{width:390,height:844}});phone.on('pageerror',e=>errors.push(e.message));phone.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await phone.goto(new URL('/workshop.html',base).href);await phone.waitForFunction(()=>window.__WS__?.ready);
 assert.equal(await phone.getByTestId('mode-review').getAttribute('aria-pressed'),'true');
 await phone.getByTestId('sheet-right').click();await skinSwitch(phone).scrollIntoViewIfNeeded();await skinSwitch(phone).click();await phone.waitForFunction(()=>window.__WS__.skin==='ssj');
 await phone.screenshot({path:out('workshop-phone-review.png')});await phone.close();
 assert.deepEqual(errors,[]);console.log('Skin QA passed: both viewers, lazy load, failure/retry, unchanged original surface geometry/normals/weights, material restore, surface visibility, muscle picking, moving pose, capture, repeated switches and mobile controls.');
 console.log(`Screenshots: ${output.dir}`);
}finally{await browser.close();}
