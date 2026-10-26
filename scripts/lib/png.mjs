import {deflateSync,inflateSync} from 'node:zlib';

/** Zero-dependency PNG codec for the agent review tooling (issue #32).
 * The repo deliberately carries no image dependency, and the review loop only
 * needs two things: emit synthetic calibration fixtures and cut/compare the
 * 640×720 renders the capture scripts already write. Scope limits, on
 * purpose: 8-bit depth, no interlace, color types 0/2/4/6 (grayscale, RGB,
 * gray+alpha, RGBA) on decode; palette (type 3), low bit depths and tRNS are
 * rejected with a clear message rather than mis-decoded. Encoding is always
 * RGBA/filter-0 — size does not matter for debug evidence. */

const SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
const crc32=(buf)=>{let c=0xffffffff;for(const b of buf)c=CRC_TABLE[(c^b)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type,'ascii'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([len,body,crc]);};

/** Encode 8-bit RGBA pixels (row-major, 4·width·height bytes) as a PNG. */
export function encodePng(width,height,rgba){
 if(!(rgba instanceof Uint8Array)||rgba.length!==width*height*4)throw new Error(`encodePng: expected ${width*height*4} RGBA bytes, got ${rgba?.length}`);
 const ihdr=Buffer.alloc(13);
 ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);
 ihdr[8]=8;   // bit depth
 ihdr[9]=6;   // color type RGBA
 // compression 0 · filter 0 · interlace 0
 const raw=Buffer.allocUnsafe(height*(1+width*4));
 for(let y=0;y<height;y++){
  raw[y*(1+width*4)]=0;   // filter type None
  Buffer.from(rgba.buffer,rgba.byteOffset+y*width*4,width*4).copy(raw,y*(1+width*4)+1);
 }
 return Buffer.concat([SIGNATURE,chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level:6})),chunk('IEND',Buffer.alloc(0))]);
}

const CHANNELS=new Map([[0,1],[2,3],[4,2],[6,4]]);
const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};

/** Decode a PNG into {width,height,rgba} (8-bit RGBA row-major). */
export function decodePng(buffer){
 if(!(buffer.length>=8)||!SIGNATURE.equals(buffer.subarray(0,8)))throw new Error('decodePng: not a PNG file');
 let pos=8,width=0,height=0,colorType=-1,bitDepth=0,interlace=0;
 const idat=[];
 while(pos+8<=buffer.length){
  const length=buffer.readUInt32BE(pos),type=buffer.toString('ascii',pos+4,pos+8);
  const data=buffer.subarray(pos+8,pos+8+length);
  if(type==='IHDR'){
   width=data.readUInt32BE(0);height=data.readUInt32BE(4);bitDepth=data[8];colorType=data[9];interlace=data[12];
  }else if(type==='IDAT')idat.push(data);
  else if(type==='IEND')break;
  pos+=12+length;
 }
 if(!width||!height)throw new Error('decodePng: missing IHDR');
 if(bitDepth!==8)throw new Error(`decodePng: unsupported bit depth ${bitDepth} (need 8)`);
 if(interlace)throw new Error('decodePng: interlaced PNG not supported');
 const bppSrc=CHANNELS.get(colorType);
 if(bppSrc===undefined)throw new Error(`decodePng: unsupported color type ${colorType} (palette/16-bit must be converted first)`);
 const stride=width*bppSrc;
 const raw=inflateSync(Buffer.concat(idat));
 if(raw.length<height*(1+stride))throw new Error(`decodePng: truncated pixel data (${raw.length} < ${height*(1+stride)})`);
 const lines=new Uint8Array(height*stride);
 for(let y=0;y<height;y++){
  const filter=raw[y*(1+stride)],src=raw.subarray(y*(1+stride)+1,(y+1)*(1+stride)),row=y*stride,prev=row-stride;
  for(let x=0;x<stride;x++){
   const a=x>=bppSrc?lines[row+x-bppSrc]:0,b=y>0?lines[prev+x]:0,c=x>=bppSrc&&y>0?lines[prev+x-bppSrc]:0;
   let v=src[x];
   if(filter===1)v+=a;else if(filter===2)v+=b;else if(filter===3)v+=(a+b)>>1;else if(filter===4)v+=paeth(a,b,c);
   else if(filter!==0)throw new Error(`decodePng: unknown filter ${filter}`);
   lines[row+x]=v&0xff;
  }
 }
 const rgba=new Uint8Array(width*height*4);
 for(let i=0;i<width*height;i++){
  const s=i*bppSrc,d=i*4;
  if(colorType===0){rgba[d]=rgba[d+1]=rgba[d+2]=lines[s];rgba[d+3]=255;}
  else if(colorType===2){rgba[d]=lines[s];rgba[d+1]=lines[s+1];rgba[d+2]=lines[s+2];rgba[d+3]=255;}
  else if(colorType===4){rgba[d]=rgba[d+1]=rgba[d+2]=lines[s];rgba[d+3]=lines[s+1];}
  else{rgba[d]=lines[s];rgba[d+1]=lines[s+1];rgba[d+2]=lines[s+2];rgba[d+3]=lines[s+3];}
 }
 return {width,height,rgba};
}

/** Crop a fractional or pixel region and nearest-neighbour upscale it. */
export function cropRegion({width,height,rgba},region,scale=1){
 const toPx=(v,size)=>Number.isFinite(v)&&v>0&&v<1?Math.round(v*size):Math.round(v);
 let x=toPx(region.x,width),y=toPx(region.y,height);
 let w=toPx(region.w,width),h=toPx(region.h,height);
 if(x<0||y<0||w<=0||h<=0||x+w>width||y+h>height)throw new Error(`region ${JSON.stringify(region)} outside ${width}×${height}`);
 const out=new Uint8Array(w*scale*4*h*scale);
 for(let py=0;py<h*scale;py++)for(let px=0;px<w*scale;px++){
  const s=((y+Math.floor(py/scale))*width+(x+Math.floor(px/scale)))*4,d=(py*w*scale+px)*4;
  out[d]=rgba[s];out[d+1]=rgba[s+1];out[d+2]=rgba[s+2];out[d+3]=rgba[s+3];
 }
 return {width:w*scale,height:h*scale,rgba:out};
}
