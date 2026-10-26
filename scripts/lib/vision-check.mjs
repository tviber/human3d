import {randomBytes,randomUUID} from 'node:crypto';
import {encodePng} from './png.mjs';

/** Vision-coordinate sanity check for the agent motion-review loop (issue #32
 * work package A). Before reading any 2D keypoints off a user reference
 * image, the agent must locate markers on a synthetic image whose ground
 * truth is known exactly — separating "the model reads image coordinates
 * inaccurately" from "the solver computed something wrong".
 *
 * The fixture is generated from a random seed created at emit time. `--check`
 * receives that seed from the user's answers file and recomputes the truth
 * instead of reading the ground truth from disk: no public fixed answer key
 * can be reused across runs. Scope is deliberately narrow: this calibrates
 * image-plane
 * localization ONLY. Passing says nothing about inferring 3D depth, pose or
 * camera geometry — those stay explicitly unverified.
 *
 * Image conventions (stated here because confusing them is the failure mode
 * this tool exists to catch): pixel coordinates, origin at the TOP-left, x
 * right, y down, integers. Markers are black discs; the digit label beside
 * each disc is the marker's id. The red rectangle's truth is its top-left
 * corner plus size in pixels. */

export const VISION_CHECK_WIDTH=800;
export const VISION_CHECK_HEIGHT=600;
export const VISION_CHECK_MARKER_COUNT=10;
/** Verdict thresholds in pixels (max marker error). */
export const VISION_PASS_PX=4;
export const VISION_WARN_PX=10;

const DEFAULT_SEED=0x33a32;
const normalizeSeed=seed=>Number.isInteger(seed)&&seed>=0&&seed<=0xffffffff?seed:undefined;
const nextRandomSeed=()=>randomBytes(4).readUInt32LE(0);
const rand=(state)=>{let s=state;s=(s*1664525+1013904223)>>>0;return [s>>>0,s];};

/* 3×5 bitmap digits, rows top→bottom, for the marker id labels. */
const DIGITS={
 '0':[7,5,5,5,7],'1':[2,6,2,2,7],'2':[7,1,7,4,7],'3':[7,1,3,1,7],'4':[5,5,7,1,1],
 '5':[7,4,7,1,7],'6':[7,4,7,5,7],'7':[7,1,1,2,2],'8':[7,5,7,5,7],'9':[7,5,7,1,7]};

/** Generate one seeded fixture image and its exact ground truth. */
export function generateFixture({seed=DEFAULT_SEED}={}){
 seed=normalizeSeed(seed);
 if(seed===undefined)throw new Error('generateFixture: seed must be an unsigned 32-bit integer');
 const markers=[];
 let state=seed;
 for(let id=1;id<=VISION_CHECK_MARKER_COUNT;id++){
  // Rejection sampling keeps markers off the grid lines (multiples of 50) and
  // apart from each other, so passing needs real localization, not counting
  // squares — and two markers can never be confused by overlap.
  for(;;){
   const [sx,s1]=rand(state);const [sy,s2]=rand(s1);state=s2;
   const x=30+sx%(VISION_CHECK_WIDTH-60),y=30+sy%(VISION_CHECK_HEIGHT-60);
   if(x%50<7||x%50>43||y%50<7||y%50>43)continue;
   if(markers.every(m=>Math.hypot(m.x-x,m.y-y)>70))markers.push({id,x,y});
   if(markers.length===id)break;
  }
 }
 let rx=0,ry=0,rw=0,rh=0;
 for(;;){
  const [sx,s1]=rand(state);const [sy,s2]=rand(s1);const [sw,s3]=rand(s2);const [sh,s4]=rand(s3);state=s4;
  rx=60+sx%(VISION_CHECK_WIDTH-260);ry=60+sy%(VISION_CHECK_HEIGHT-200);
  rw=100+sw%120;rh=80+sh%90;
  if(markers.every(m=>m.x<rx-12||m.x>rx+rw+12||m.y<ry-12||m.y>ry+rh+12))break;
 }
 const rgba=new Uint8Array(VISION_CHECK_WIDTH*VISION_CHECK_HEIGHT*4).fill(255);
 const put=(x,y,[r,g,b])=>{
  if(x<0||y<0||x>=VISION_CHECK_WIDTH||y>=VISION_CHECK_HEIGHT)return;
  const d=(y*VISION_CHECK_WIDTH+x)*4;
  rgba[d]=r;rgba[d+1]=g;rgba[d+2]=b;rgba[d+3]=255;
 };
 // Light spatial-reference grid every 50 px — it aids orientation without
 // giving away marker centres (those are kept off the lines).
 for(let gx=50;gx<VISION_CHECK_WIDTH;gx+=50)for(let gy=0;gy<VISION_CHECK_HEIGHT;gy++){put(gx,gy,[225,225,225]);put(gx,gy+1,[225,225,225]);}
 for(let gy=50;gy<VISION_CHECK_HEIGHT;gy+=50)for(let gx=0;gx<VISION_CHECK_WIDTH;gx++){put(gx,gy,[225,225,225]);put(gx+1,gy,[225,225,225]);}
 // Red rectangle (truth = top-left corner + size).
 for(let x=rx;x<rx+rw;x++)for(const y of [ry,ry+rh-1])put(x,y,[200,30,30]);
 for(let y=ry;y<ry+rh;y++)for(const x of [rx,rx+rw-1])put(x,y,[200,30,30]);
 // Markers: black disc r=7, id label to the lower-right.
 for(const m of markers){
  for(let dy=-7;dy<=7;dy++)for(let dx=-7;dx<=7;dx++)if(dx*dx+dy*dy<=49)put(m.x+dx,m.y+dy,[20,20,20]);
  const label=String(m.id);
  for(let c=0;c<label.length;c++){
   const glyph=DIGITS[label[c]];
   for(let row=0;row<5;row++)for(let col=0;col<3;col++)if(glyph[row]&(4>>col))
    for(let sy=0;sy<2;sy++)for(let sx=0;sx<2;sx++)put(m.x+11+c*8+col*2+sx,m.y+4+row*2+sy,[20,20,20]);
  }
 }
 return {seed,width:VISION_CHECK_WIDTH,height:VISION_CHECK_HEIGHT,rgba,truth:{markers,rect:{x:rx,y:ry,w:rw,h:rh}}};
}

export function createBlindFixture(){
 const seed=nextRandomSeed();
 const fixture=generateFixture({seed});
 return {...fixture,challengeId:randomUUID()};
}

export function fixturePng(seed=DEFAULT_SEED){const f=generateFixture({seed});return encodePng(f.width,f.height,f.rgba);}

const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

/** Grade the agent's answers against the recomputed truth.
 * answers: {markers:[{id,x,y}], rect:{x,y,w,h}} in pixels, top-left origin. */
export function gradeVision(answers,truth){
 const feedback=[];
 if(!answers||!Array.isArray(answers.markers))return {verdict:'fail',feedback:['answers.json 缺少 markers 数组——按模板重新输出'],markers:[],rect:null,maxErrorPx:Infinity};
 const byId=new Map(answers.markers.map(m=>[m.id,m]));
 const graded=truth.markers.map(t=>{
  const a=byId.get(t.id);
  if(!a||!Number.isFinite(a.x)||!Number.isFinite(a.y))return {id:t.id,errorPx:Infinity};
  return {id:t.id,errorPx:+dist(a,t).toFixed(2)};
 });
 // A swapped pair reports huge per-id errors while a permutation would fit
 // far better — name it, because "located both markers but mislabelled them"
 // has a different remedy (label discipline) than mislocating.
 const swapped=[];
 for(let i=0;i<truth.markers.length;i++)for(let j=i+1;j<truth.markers.length;j++){
  const ti=truth.markers[i],tj=truth.markers[j],ai=byId.get(ti.id),aj=byId.get(tj.id);
  if(!ai||!aj)continue;
  if(dist(ai,ti)+dist(aj,tj)>dist(ai,tj)+dist(aj,ti)+20)swapped.push([ti.id,tj.id]);
 }
 let maxErrorPx=0;
 for(const g of graded){
  if(!Number.isFinite(g.errorPx)){feedback.push(`标记 ${g.id}：答案缺失或坐标非法（必须是数字像素坐标）`);maxErrorPx=Infinity;}
  else maxErrorPx=Math.max(maxErrorPx,g.errorPx);
 }
 let rect=null,rectMissing=true;
 if(answers.rect&&[answers.rect.x,answers.rect.y,answers.rect.w,answers.rect.h].every(Number.isFinite)){
  rectMissing=false;
  rect={errorPx:+Math.max(dist({x:answers.rect.x,y:answers.rect.y},truth.rect),
   dist({x:answers.rect.x+answers.rect.w,y:answers.rect.y}, {x:truth.rect.x+truth.rect.w,y:truth.rect.y}),
   dist({x:answers.rect.x,y:answers.rect.y+answers.rect.h},{x:truth.rect.x,y:truth.rect.y+truth.rect.h}),
   dist({x:answers.rect.x+answers.rect.w,y:answers.rect.y+answers.rect.h},{x:truth.rect.x+truth.rect.w,y:truth.rect.y+truth.rect.h})).toFixed(2)};
  maxErrorPx=Math.max(maxErrorPx,rect.errorPx);
 }else feedback.push('矩形 rect：答案缺失或坐标非法（左上角 + 宽高，像素）——校验题必须全部作答');
 for(const [a,b] of swapped)feedback.push(`标记 ${a} 与 ${b} 的定位疑似对调（互换后误差显著更小）——检查标签是否与圆点对应`);
 let verdict='fail';
 if(!rectMissing&&maxErrorPx<=VISION_PASS_PX)verdict='pass';
 else if(!rectMissing&&maxErrorPx<=VISION_WARN_PX)verdict='warn';
 else feedback.push('校准未通过：不要继续从参考图读坐标，转人工标点或先校准相机；把误差与原图一并回报，不要随机改动作数值。');
 if(verdict==='warn')feedback.push('校准处于警告带：仅允许在图上做大粒度判断（左右/上下/明显穿模），像素级结论一律视为不可确定。');
 return {verdict,markers:graded,rect,swapped,maxErrorPx:+maxErrorPx.toFixed(2),feedback};
}

export const SCOPE_NOTE='本检查只校准图像平面定位能力，不证明能正确推断 3D 深度、人体姿态或相机几何；通过≠可以跳过坐标/相机条件核对。';
