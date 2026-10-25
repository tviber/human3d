import assert from 'node:assert/strict';
import path from 'node:path';
import {chromium} from 'playwright';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import {resolveOutputDir,ensureOutputDir,assertTrackedWriteAllowed} from './lib/qa-output.mjs';
import {verifyWebIdentity} from './lib/worktree-check.mjs';

// Browser plugin not available: real controls in Chrome, phone viewport emulation.
const root=process.cwd(),output=resolveOutputDir('lab-mobile',process.argv.slice(2),root,process.env);
assert.equal(output.args.length,0);ensureOutputDir(output.dir,{root,updateEvidence:output.updateEvidence});
const out=name=>assertTrackedWriteAllowed(path.join(output.dir,name),{root,updateEvidence:output.updateEvidence});
const base=new URL(process.env.QA_WEB_URL??'http://127.0.0.1:5173/');assert((await verifyWebIdentity(root,base)).ok);
const browser=await launchQaBrowser(chromium,{...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),errors=[];
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{
 await page.goto(base.href);await page.waitForFunction(()=>window.__LAB__?.ready,null,{timeout:60000});assert.match(await page.title(),/KINESIS/);assert.equal(await page.locator('vite-error-overlay').count(),0);
 await page.getByTestId('sheet-library').tap();await page.locator('.motion-row').filter({hasText:'正手挥拍'}).first().tap();await page.getByRole('button',{name:'暂停',exact:true}).tap();
 for(const width of [375,390,760,761,1280]){
  await page.setViewportSize({width,height:844});
  const compact=width<=760;
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const geometry=await page.locator('.phase-markers').evaluate(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,display:getComputedStyle(el).display,buttons:[...el.children].map(b=>{const q=b.getBoundingClientRect();return {x:q.x,y:q.y,right:q.right,bottom:q.bottom,height:q.height,position:getComputedStyle(b).position};})};});
  if(compact){
   assert.equal(geometry.display,'grid');
   for(const b of geometry.buttons){assert(b.height>=28);assert(b.y>=geometry.top);assert(b.bottom<=geometry.bottom);assert(b.bottom<=844);}
   for(let i=0;i<geometry.buttons.length;i++)for(let j=i+1;j<geometry.buttons.length;j++){const a=geometry.buttons[i],b=geometry.buttons[j];assert(a.right<=b.x||b.right<=a.x||a.bottom<=b.y||b.bottom<=a.y,'phase hit areas overlap');}
   for(const marker of await page.locator('.phase-markers button').all()){
    await marker.scrollIntoViewIfNeeded();await marker.tap();
    const label=await marker.innerText();await page.waitForFunction(label=>document.querySelector('.timeline-meta')?.textContent.includes(label),label);
   }
   await page.getByTestId('sheet-library').tap();await page.locator('.motion-panel .sheet-close').tap();await page.waitForFunction(()=>document.querySelector('[data-testid="sheet-library"]')?.getAttribute('aria-expanded')==='false');await page.locator('.motion-panel').waitFor({state:'hidden'});
  }else{assert(geometry.buttons.every(b=>b.position==='absolute'));assert.equal(await page.locator('.sheet-close').first().isVisible(),false);}
  await page.screenshot({path:out(`lab-${width}.png`)});
 }
 assert.deepEqual(errors,[]);console.log(`Lab mobile QA passed: 375/390/760/761/1280 widths; contained non-overlapping phase targets; scroll/touch seek; drawer close; desktop markers unchanged. Screenshots: ${output.dir}`);
}finally{await context.close();await browser.close();}
