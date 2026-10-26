import fs from 'node:fs';
import path from 'node:path';
import {encodePng,decodePng,cropRegion} from './png.mjs';

/** Crop / grid / point-overlay / side-by-side / contact-sheet helpers for the
 * agent review loop (issue #32 A3 + B2). These are debug evidence tools for
 * inspecting reference frames and capture renders at high-risk areas — they
 * make no claim about camera alignment: a visual side-by-side is NOT a
 * reprojection check, and the guide says so. Everything works on decoded RGBA
 * images so tests can drive the library directly. */

export const GRID_COLOR=[200,200,200];
export const POINT_COLOR=[220,40,40];

const put=(img,x,y,[r,g,b])=>{
 if(x<0||y<0||x>=img.width||y>=img.height)return;
 const d=(y*img.width+x)*4;
 img.rgba[d]=r;img.rgba[d+1]=g;img.rgba[d+2]=b;img.rgba[d+3]=255;
};

/** Draw a light reference grid (mutates a copy of the image). */
export function overlayGrid(image,step=50){
 const out={width:image.width,height:image.height,rgba:new Uint8Array(image.rgba)};
 for(let x=step;x<image.width;x+=step)for(let y=0;y<image.height;y++){put(out,x,y,GRID_COLOR);put(out,x+1,y,GRID_COLOR);}
 for(let y=step;y<image.height;y+=step)for(let x=0;x<image.width;x++){put(out,x,y,GRID_COLOR);put(out,x+1,y,GRID_COLOR);}
 return out;
}

/** Draw a labelled crosshair at pixel (x,y) (mutates a copy). */
export function overlayPoint(image,{x,y},color=POINT_COLOR){
 const out={width:image.width,height:image.height,rgba:new Uint8Array(image.rgba)};
 for(let d=-8;d<=8;d++){put(out,x+d,y,color);put(out,x,y+d,color);}
 put(out,x,y,[0,0,0]);
 return out;
}

/** Horizontally join images with a divider gap; shorter images are padded. */
export function sideBySide(images,gap=6){
 const height=Math.max(...images.map(i=>i.height));
 const width=images.reduce((w,i)=>w+i.width,0)+gap*(images.length-1);
 const out={width,height,rgba:new Uint8Array(width*height*4).fill(255)};
 let x0=0;
 for(const img of images){
  for(let y=0;y<img.height;y++)for(let x=0;x<img.width;x++){
   const s=(y*img.width+x)*4,d=(y*width+x0+x)*4;
   out.rgba[d]=img.rgba[s];out.rgba[d+1]=img.rgba[s+1];out.rgba[d+2]=img.rgba[s+2];out.rgba[d+3]=img.rgba[s+3];
  }
  x0+=img.width+gap;
 }
 return out;
}

/** Compose a contact sheet in list order (manifest order = time-major). */
export function composeSheet(images,cols=4,gap=4){
 const rows=Math.ceil(images.length/cols);
 const cellW=Math.max(...images.map(i=>i.width)),cellH=Math.max(...images.map(i=>i.height));
 const width=cols*cellW+(cols-1)*gap,height=rows*cellH+(rows-1)*gap;
 const out={width,height,rgba:new Uint8Array(width*height*4).fill(255)};
 images.forEach((img,i)=>{
  const cx=(i%cols)*(cellW+gap),cy=Math.floor(i/cols)*(cellH+gap);
  for(let y=0;y<img.height;y++)for(let x=0;x<img.width;x++){
   const s=(y*img.width+x)*4,d=((cy+y)*width+cx+x)*4;
   out.rgba[d]=img.rgba[s];out.rgba[d+1]=img.rgba[s+1];out.rgba[d+2]=img.rgba[s+2];out.rgba[d+3]=img.rgba[s+3];
  }
 });
 return out;
}

const parseRegion=(spec)=>{
 const [x,y,w,h]=spec.split(',').map(Number);
 if(![x,y,w,h].every(Number.isFinite))throw new Error(`--region 需要 x,y,w,h 数字（0–1 之间按比例），收到 ${spec}`);
 return {x,y,w,h};
};
const toPx=(v,size)=>v>0&&v<1?Math.round(v*size):Math.round(v);

/** Load, optionally crop+scale, optionally draw grid/points, write one PNG. */
export function processImage({input,region,scale=1,grid,points=[],output}){
 let image=decodePng(fs.readFileSync(input));
 if(region)image=cropRegion(image,parseRegion(region),scale);
 if(grid)image=overlayGrid(image,grid===true?50:Number(grid));
 for(const p of points){
  const [x,y]=p.split(',').map(Number);
  if(!Number.isFinite(x)||!Number.isFinite(y))throw new Error(`--point 需要 x,y 像素坐标，收到 ${p}`);
  image=overlayPoint(image,{x:toPx(x,image.width),y:toPx(y,image.height)});
 }
 fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
 fs.writeFileSync(output,encodePng(image.width,image.height,image.rgba));
 return {width:image.width,height:image.height};
}

/** Crop the same region from two same-framing images and join them for
 * visual comparison (reference | render). NOT a reprojection check. */
export function compareSideBySide({left,right,region,scale=2,gap=6,output}){
 if(!region)throw new Error('side-by-side 需要 --region（在高风险部位放大才有意义）');
 const reg=parseRegion(region);
 const a=cropRegion(decodePng(fs.readFileSync(left)),reg,scale);
 const b=cropRegion(decodePng(fs.readFileSync(right)),reg,scale);
 const joined=sideBySide([a,b],gap);
 fs.writeFileSync(output,encodePng(joined.width,joined.height,joined.rgba));
 return {width:joined.width,height:joined.height};
}

/** Contact-sheet every shot listed in a workshop-capture manifest. */
export function sheetFromManifest({manifest,output,cols=4}){
 const dir=path.dirname(path.resolve(manifest));
 const m=JSON.parse(fs.readFileSync(manifest,'utf8'));
 if(!Array.isArray(m.shots)||!m.shots.length)throw new Error('manifest 没有 shots（先跑 workshop-capture）');
 const images=m.shots.map(s=>decodePng(fs.readFileSync(path.join(dir,s.file))));
 const sheet=composeSheet(images,cols);
 fs.writeFileSync(output,encodePng(sheet.width,sheet.height,sheet.rgba));
 return {count:images.length,width:sheet.width,height:sheet.height};
}
