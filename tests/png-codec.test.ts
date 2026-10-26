import {describe,it,expect} from 'vitest';
import {deflateSync} from 'node:zlib';
import {encodePng,decodePng,cropRegion} from '../scripts/lib/png.mjs';

const SIG=Buffer.from([137,80,78,71,13,10,26,10]);
const crc=(buf:Buffer)=>{let c=0xffffffff;for(const b of buf)c=((c>>>8)^((()=>{let x=(c^b)&0xff;for(let k=0;k<8;k++)x=x&1?0xedb88320^(x>>>1):x>>>1;return x;})()))>>>0;return (c^0xffffffff)>>>0;};
const chunk=(type:string,data:Buffer)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type,'ascii'),data]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(body));return Buffer.concat([len,body,c]);};
/** Hand-assemble a small RGB PNG whose scanlines use the given per-row filter
 * types — the repo's own encoder always writes filter 0, so the unfilter paths
 * (Sub/Up/Average/Paeth) can only be covered by fixtures built here. */
const buildFilteredPng=(width:number,height:number,filters:number[])=>{
 const bpp=3,stride=width*bpp;
 const px=new Uint8Array(height*stride);
 for(let y=0;y<height;y++)for(let x=0;x<stride;x++)px[y*stride+x]=(y*stride+x)*7&0xff;
 const raw=Buffer.alloc(height*(1+stride));
 const predict=(filter:number,left:number,up:number)=>filter===1?left:filter===2?up:filter===3?(left+up)>>1:0;
 for(let y=0;y<height;y++){
  raw[y*(1+stride)]=filters[y];
  const row=y*stride;
  for(let x=0;x<stride;x++){
   const left=x>=bpp?px[row+x-bpp]:0,up=y>0?px[row-stride+x]:0;
   raw[y*(1+stride)+1+x]=(px[row+x]-predict(filters[y],left,up))&0xff;
  }
 }
 // Paeth row needs the true predictor, not 0.
 for(let y=0;y<height;y++)if(filters[y]===4){
  const row=y*stride;
  for(let x=0;x<stride;x++){
   const left=x>=bpp?px[row+x-bpp]:0,up=y>0?px[row-stride+x]:0,ul=x>=bpp&&y>0?px[row-stride+x-bpp]:0;
   const p=left+up-ul,pa=Math.abs(p-left),pb=Math.abs(p-up),pc=Math.abs(p-ul);
   const pred=pa<=pb&&pa<=pc?left:pb<=pc?up:ul;
   raw[y*(1+stride)+1+x]=(px[row+x]-pred)&0xff;
  }
 }
 const ihdr=Buffer.alloc(13);
 ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
 return Buffer.concat([SIG,chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
};

describe('png codec',()=>{
 it('round-trips RGBA through encode → decode byte-exact',()=>{
  const w=13,h=7;
  const rgba=new Uint8Array(w*h*4);
  for(let i=0;i<w*h;i++){rgba[i*4]=i*3&0xff;rgba[i*4+1]=i*5&0xff;rgba[i*4+2]=255-(i*7&0xff);rgba[i*4+3]=i===17?0:255;}
  const decoded=decodePng(encodePng(w,h,rgba));
  expect(decoded.width).toBe(w);expect(decoded.height).toBe(h);
  expect([...decoded.rgba]).toEqual([...rgba]);
 });
 it('decodes all five scanline filters (RGB color type 2)',()=>{
  const w=9,h=5;
  const img=decodePng(buildFilteredPng(w,h,[0,1,2,3,4]));
  expect(img.width).toBe(w);expect(img.height).toBe(h);
  for(let i=0;i<w*h;i++){
   for(let c=0;c<3;c++)expect(img.rgba[i*4+c]).toBe((i*3+c)*7&0xff);
   expect(img.rgba[i*4+3]).toBe(255);
  }
 });
 it('rejects non-PNG input, palette color type and interlace with clear errors',()=>{
  expect(()=>decodePng(Buffer.from('not a png at all'))).toThrow(/not a PNG/);
  const ihdr=(colorType:number,interlace:number)=>{const b=Buffer.alloc(13);b.writeUInt32BE(2,0);b.writeUInt32BE(2,4);b[8]=8;b[9]=colorType;b[12]=interlace;return b;};
  const wrap=(ihdrBuf:Buffer)=>Buffer.concat([SIG,chunk('IHDR',ihdrBuf),chunk('IDAT',deflateSync(Buffer.alloc(2*(1+2*1)))),chunk('IEND',Buffer.alloc(0))]);
  expect(()=>decodePng(wrap(ihdr(3,0)))).toThrow(/color type 3/);
  expect(()=>decodePng(wrap(ihdr(2,1)))).toThrow(/interlaced/);
 });
});

describe('cropRegion',()=>{
 const image={width:100,height:80,rgba:new Uint8Array(100*80*4).fill(9)};
 it('crops pixel and fractional regions and upscales',()=>{
  const px=cropRegion(image,{x:10,y:20,w:5,h:4});
  expect(px.width).toBe(5);expect(px.height).toBe(4);
  const scaled=cropRegion(image,{x:.1,y:.25,w:.05,h:.05},3);
  expect(scaled.width).toBe(15);expect(scaled.height).toBe(12);
 });
 it('refuses regions outside the image',()=>{
  expect(()=>cropRegion(image,{x:98,y:0,w:5,h:5})).toThrow(/outside/);
  expect(()=>cropRegion(image,{x:-1,y:0,w:5,h:5})).toThrow(/outside/);
 });
});
