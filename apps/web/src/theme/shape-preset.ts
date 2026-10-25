import {SkinnedMesh,type BufferGeometry,type Object3D} from 'three';

/**
 * shape-preset.ts — 「健硕」英雄体型（画板 ui-restyle s1 → b + 下巴微收尖）。
 *
 * 全部塑形以**绑定空间顶点形变**实现（加载时一次性改 HumanSurface 几何），
 * 刻意不碰骨骼 scale：播放路径每帧 solvePose→rig.reset() 会把骨骼归一
 * （solver.ts 的每帧求解），而给 reset 加体型基准会把体型泄进求解几何与
 * 姿态包采样（AGENTS.md 红线）。顶点形变随蒙皮走、与动画正交、两页引擎
 * 共用；腿长保持原长（与骨架运动学纠缠），只做围度与轮廓。
 *
 * ① 躯干轮廓：关键点插值的宽度曲线（收腰 0.94 → 胸 1.05 → 肩 1.10），
 *    |x|<0.35 排除绑定的平伸手臂；
 * ② 手臂围度：绑定臂沿 ±X 平伸，截面 (y,z) 外扩、向腕衰减；
 * ③ 腿围度：y<0.98 只加围不改长度；
 * ④ 下巴：下巴球收窄 13%、尖端前推 7mm（双向高斯，避开下颌角——
 *    「尖一点，不蛇精」）。
 */

/** 站姿皮肤网格判据：局部 bbox 顶 ≈1.78m（排除解剖内层等非同空间几何）。 */
const SKIN_TOP=1.7;

/** 躯干宽度曲线关键点 [y, xMul, zMul]，按 y 线性插值，区间外为 1。 */
const TORSO_KEYS:[number,number,number][]=[
  [0.95,1,1],
  [1.06,0.94,0.94],  // 收腰
  [1.18,1,1],
  [1.30,1.05,1.04],  // 胸廓
  [1.40,1.02,1.02],
  [1.47,1.10,1.03],  // 肩（止于下巴下缘之下，不波及头部）
  [1.53,1,1],
];

/** 手臂围度：绑定空间手臂沿 ±X 平伸，截面在 (y,z)——近肩厚、向腕收。 */
const ARM={yFrom:1.16,yTo:1.46,xFrom:0.30,xTo:0.60,zMul:1.16,fade:0.35};

/** 腿围度：只加大腿/小腿围（止于 0.98，与躯干带不重叠），不改长度。 */
const LEG={yFrom:0.45,yTo:0.98,xMul:1.06,zMul:1.06,fade:0.12};

/** 下巴：下巴球收窄 13%、尖端前推 7mm（双向高斯，避开下颌角）。 */
const CHIN={yMin:1.475,yMax:1.565,zFront:0.03,center:1.52,sigma:0.03,narrow:0.13,tipCenter:1.525,tipSigma:0.014,tipPush:0.007,tipWidth:0.06};

const smooth=(t:number)=>{const c=Math.min(1,Math.max(0,t));return c*c*(3-2*c);};

function torsoMul(y:number):[number,number]{
  if(y<TORSO_KEYS[0][0]||y>=TORSO_KEYS[TORSO_KEYS.length-1][0])return [1,1];
  for(let i=0;i<TORSO_KEYS.length-1;i++){
    const [ya,ax,az]=TORSO_KEYS[i],[yb,bx,bz]=TORSO_KEYS[i+1];
    if(y>=ya&&y<yb){
      const t=(y-ya)/(yb-ya);
      return [ax+(bx-ax)*t,az+(bz-az)*t];
    }
  }
  return [1,1];
}

function shapeSurface(geometry:BufferGeometry):void{
  geometry.computeBoundingBox();
  const bb=geometry.boundingBox;
  if(!bb||bb.max.y<SKIN_TOP)return;
  const pos=geometry.attributes.position;
  const n=pos.count;
  for(let i=0;i<n;i++){
    const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);
    let nx=x,nz=z;
    // ① 躯干/肩 V 型轮廓（|x|<0.35 把绑定的平伸手臂排除在外）
    if(y>=0.95&&y<=1.53&&Math.abs(x)<0.35){
      const [mx,mz]=torsoMul(y);
      nx*=mx;nz*=mz;
    }
    // ② 手臂围度（绑定臂 |x|≥0.30）：截面外扩、向腕衰减
    if(y>=ARM.yFrom&&y<=ARM.yTo&&Math.abs(x)>=ARM.xFrom){
      const along=Math.min((Math.abs(x)-ARM.xFrom)/(ARM.xTo-ARM.xFrom),1);
      const w=1-ARM.fade*smooth(along/0.5);
      nz*=1+(ARM.zMul-1)*w;
    }
    // ③ 腿围度（y<0.98，与躯干带不重叠）
    if(y>=LEG.yFrom&&y<=LEG.yTo&&Math.abs(nx)<0.25){
      const w=1-LEG.fade*smooth(Math.min((LEG.yTo-y)/(LEG.yTo-LEG.yFrom)*2,1));
      nx*=1+(LEG.xMul-1)*w;
      nz*=1+(LEG.zMul-1)*w;
    }
    // ④ 下巴微收尖
    if(y>=CHIN.yMin&&y<=CHIN.yMax&&z>=CHIN.zFront){
      const wy=Math.exp(-Math.pow((y-CHIN.center)/CHIN.sigma,2));
      nx*=1-CHIN.narrow*wy;
      const wt=Math.exp(-Math.pow((y-CHIN.tipCenter)/CHIN.tipSigma,2))*(1-Math.min(Math.abs(x)/CHIN.tipWidth,1));
      nz+=CHIN.tipPush*wt;
    }
    if(nx!==x)pos.setX(i,nx);
    if(nz!==z)pos.setZ(i,nz);
  }
  pos.needsUpdate=true;
}

export function applyHeroicShape(root:Object3D):void{
  root.traverse(o=>{
    if(!(o instanceof SkinnedMesh))return;
    shapeSurface(o.geometry as BufferGeometry);
  });
}
