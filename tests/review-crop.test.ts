import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {encodePng,decodePng} from '../scripts/lib/png.mjs';
import {overlayGrid,overlayPoint,sideBySide,composeSheet,processImage,compareSideBySide,sheetFromManifest} from '../scripts/lib/review-crop.mjs';

const solid=(w:number,h:number,v:number)=>({width:w,height:h,rgba:new Uint8Array(w*h*4).fill(v)});
const px=(img:{width:number;height:number;rgba:Uint8Array},x:number,y:number)=>[...img.rgba.slice((y*img.width+x)*4,(y*img.width+x)*4+3)];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'human3d-review-crop-'));
const writePng=(name:string,img:{width:number;height:number;rgba:Uint8Array})=>{const p=path.join(tmp,name);fs.writeFileSync(p,encodePng(img.width,img.height,img.rgba));return p;};

describe('overlays and composites',()=>{
 it('overlayGrid marks grid lines without touching other pixels',()=>{
  const img=overlayGrid(solid(120,80,255),50);
  expect(px(img,50,10)).toEqual([200,200,200]);
  expect(px(img,51,10)).toEqual([200,200,200]);
  expect(px(img,60,10)).toEqual([255,255,255]);
 });
 it('overlayPoint draws a crosshair with a black centre',()=>{
  const img=overlayPoint(solid(60,60,255),{x:30,y:30});
  expect(px(img,30,30)).toEqual([0,0,0]);
  expect(px(img,38,30)).toEqual([220,40,40]);
  expect(px(img,30,38)).toEqual([220,40,40]);
 });
 it('sideBySide joins with a divider and pads to the tallest',()=>{
  const joined=sideBySide([solid(10,10,10),solid(10,20,20)],4);
  expect(joined.width).toBe(24);expect(joined.height).toBe(20);
  expect(px(joined,12,0)).toEqual([255,255,255]);   // divider
  expect(px(joined,0,0)).toEqual([10,10,10]);
 });
 it('composeSheet lays images out row-major',()=>{
  const sheet=composeSheet([solid(10,10,1),solid(10,10,2),solid(10,10,3),solid(10,10,4),solid(10,10,5)],4,2);
  expect(sheet.width).toBe(4*10+3*2);expect(sheet.height).toBe(2*10+2);
  expect(px(sheet,0,0)).toEqual([1,1,1]);
  expect(px(sheet,12,0)).toEqual([2,2,2]);
  expect(px(sheet,0,12)).toEqual([5,5,5]);          // row 2 starts
 });
});

describe('file-backed tools',()=>{
 it('processImage crops, scales and draws overlays end to end',()=>{
  const src=writePng('src.png',solid(100,100,240));
  const out=path.join(tmp,'zoom.png');
  // Grid is drawn AFTER the crop in the cropped image's own coordinates.
  const r=processImage({input:src,region:'25,25,20,20',scale:2,grid:10,points:['40,40'],output:out});
  expect([r.width,r.height]).toEqual([40,40]);
  const img=decodePng(fs.readFileSync(out));
  expect(px(img,10,10)).toEqual([200,200,200]);
  expect(px(img,15,15)).toEqual([240,240,240]);
 });
 it('processImage accepts fractional regions',()=>{
  const src=writePng('src2.png',solid(200,100,99));
  const out=path.join(tmp,'frac.png');
  const r=processImage({input:src,region:'0.5,0.25,0.25,0.5',output:out});
  expect([r.width,r.height]).toEqual([50,50]);
 });
 it('compareSideBySide crops the same region from both inputs',()=>{
  const a=writePng('a.png',solid(100,100,10)),b=writePng('b.png',solid(100,100,200));
  const out=path.join(tmp,'cmp.png');
  const r=compareSideBySide({left:a,right:b,region:'10,10,30,30',scale:2,gap:4,output:out});
  expect([r.width,r.height]).toEqual([124,60]);
  const img=decodePng(fs.readFileSync(out));
  expect(px(img,0,0)).toEqual([10,10,10]);
  expect(px(img,62,0)).toEqual([255,255,255]);      // divider
  expect(px(img,64,0)).toEqual([200,200,200]);
 });
 it('sheetFromManifest composes every shot from a capture manifest',()=>{
  const shots=['a.png','b.png','a.png'].map(f=>({file:f}));
  fs.writeFileSync(path.join(tmp,'manifest.json'),JSON.stringify({shots}));
  const out=path.join(tmp,'sheet.png');
  const r=sheetFromManifest({manifest:path.join(tmp,'manifest.json'),output:out,cols:2});
  expect(r.count).toBe(3);
  const img=decodePng(fs.readFileSync(out));
  expect([img.width,img.height]).toEqual([2*100+4,2*100+4]);
 });
 it('refuses a side-by-side without a region',()=>{
  const a=writePng('c.png',solid(10,10,1)),b=writePng('d.png',solid(10,10,1));
  expect(()=>compareSideBySide({left:a,right:b,output:path.join(tmp,'x.png')})).toThrow(/region/);
 });
});
