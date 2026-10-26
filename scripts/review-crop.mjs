import {processImage,compareSideBySide,sheetFromManifest} from './lib/review-crop.mjs';

// Issue #32 A3/B2: zoom/crop, grid & point overlays, reference-vs-render
// side-by-side and contact sheets — agent debug evidence over the PNGs the
// capture scripts already write. Pure Node, no browser, no image dependency.
//
//   node scripts/review-crop.mjs --img a.png [--region 0.3,0.1,0.2,0.3] [--scale 3]
//        [--grid [step]] [--point x,y …] --out zoom.png
//   node scripts/review-crop.mjs ref.png render.png --region x,y,w,h [--scale 2] --out cmp.png
//   node scripts/review-crop.mjs --sheet <capture-manifest.json> [--cols 4] --out sheet.png
//
// Regions accept fractions of the image (0–1) or absolute pixels. The
// side-by-side compares the SAME region of two same-framing images — it is a
// visual aid, not a reprojection check.
const args=process.argv.slice(2);
const positional=args.filter((a,i)=>!a.startsWith('--')&&!['--region','--scale','--out','--cols','--point','--img','--sheet','--manifest'].includes(args[i-1]));
let img='',sheet='',out='',region='',scale,schemaGrid=false,cols=4;
const points=[];
for(let i=0;i<args.length;i++){
 const a=args[i];
 const value=()=>{const v=args[++i];if(v===undefined||v.startsWith('--'))throw new Error(`${a} 需要一个值`);return v;};
 if(a==='--img')img=value();
 else if(a==='--sheet'||a==='--manifest')sheet=value();
 else if(a==='--out')out=value();
 else if(a==='--region')region=value();
 else if(a==='--scale')scale=Number(value());
 else if(a==='--cols')cols=Number(value());
 else if(a==='--grid'){schemaGrid=true;if(args[i+1]&&!args[i+1].startsWith('--')&&Number(args[i+1])>1)schemaGrid=Number(args[++i]);}
 else if(a==='--point')points.push(value());
 else if(a.startsWith('--')){console.error(`未知参数 ${a}`);process.exit(2);}
}
if(!out)throw new Error('需要 --out <file.png>');
try{
 if(sheet){
  const r=sheetFromManifest({manifest:sheet,output:out,cols});
  console.log(`拼图: ${r.count} 张 → ${out} (${r.width}×${r.height})`);
 }else if(positional.length===2){
  if(!region)throw new Error('并排对比需要 --region（在高风险部位放大才有意义）');
  const r=compareSideBySide({left:positional[0],right:positional[1],region,scale:scale??2,output:out});
  console.log(`并排对比: ${positional[0]} | ${positional[1]} → ${out} (${r.width}×${r.height})`);
 }else if(positional.length===0&&img){
  const r=processImage({input:img,region:region||undefined,scale:scale??1,grid:schemaGrid===false?undefined:schemaGrid,points,output:out});
  console.log(`裁剪/叠加: ${img} → ${out} (${r.width}×${r.height})`);
 }else if(positional.length===1&&!img){
  const r=processImage({input:positional[0],region:region||undefined,scale:scale??1,grid:schemaGrid===false?undefined:schemaGrid,points,output:out});
  console.log(`裁剪/叠加: ${positional[0]} → ${out} (${r.width}×${r.height})`);
 }else throw new Error('用法: --img <png> [裁剪/叠加] · <ref.png> <render.png> --region … [并排] · --sheet <manifest.json> [拼图]');
}catch(e){console.error(e instanceof Error?e.message:String(e));process.exit(1);}
