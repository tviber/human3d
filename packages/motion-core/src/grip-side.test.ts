import {describe,it,expect,beforeAll} from 'vitest';
import {RACKET_TIP_LOCAL} from './props/racket';
import fs from 'node:fs';
import {CylinderGeometry,Mesh,Quaternion,Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from './rig';
import {attachRacket,bevelDirection,bevelRoll,RACKET_BEVELS,RACKET_GRIP_TILT_LIMIT_DEG} from './props/racket';
import {gripFrame} from './grip';
import {RACKET_HANDLE} from './props/racket';
import {blankDocument,frameAt,parseDoc,serializeDoc,validateDocShape,type FootTarget,type HandTarget,type V3,type WorkshopDoc} from './document';
import {solveEffectiveFrame} from './solver';
import {canonical,normalizedRequest} from './protocol';
import {validateMotionFileShape} from './motion-file';
import {analyzeProbeFrames,probeFrames} from './quality-probe';

/** WP-D gripSide 侧别参数化 — the whole suite runs the real
 * frameAt → solveEffectiveFrame path (never a hand-rolled mirror of the
 * solver), so a passing mirror assertion means the solve itself
 * conjugates across the rig's x=0 rest plane.
 *
 * Mirror contract: the rig's rest skeleton is bilateral — every `_L`/`_R`
 * bone pair sits at mirrored rest positions with identity orientations —
 * so mirroring every doc input (hand targets/poles/frames, foot
 * targets/poles/yaw, root.x, torso yaw/chest/side) must produce a solve
 * whose positions and world orientations are the exact x-reflection of
 * the right-side solve. gripSide switches which hand wraps and mounts the
 * racket; everything else (support, feet, spine) is side-agnostic and
 * therefore identical under the swap. */

let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);

const mirrorV=(v:V3):V3=>({x:-v.x,y:v.y,z:v.z});
const mirrorHand=(h:HandTarget):HandTarget=>({target:mirrorV(h.target),pole:mirrorV(h.pole),forward:mirrorV(h.forward),normal:mirrorV(h.normal)});
const mirrorFoot=(f:FootTarget):FootTarget=>({target:mirrorV(f.target),pole:mirrorV(f.pole),yaw:-f.yaw,pitch:f.pitch});
const mirrorName=(n:string)=>n.endsWith('_L')?`${n.slice(0,-2)}_R`:n.endsWith('_R')?`${n.slice(0,-2)}_L`:n;
/** Quat of the mirrored rotation M·q·M for the x-reflection M. */
const mirrorQuat=(q:Quaternion)=>new Quaternion(q.x,-q.y,-q.z,q.w);

/** A doc whose left half is the exact x-mirror of its right half — the
 * blank template is nearly symmetric already (shared root at x=0, no
 * torso twist); only the hand poles and the yaw sign need re-mirroring. */
const symmetricDoc=()=>{
 const doc=blankDocument(rig.rest,'对称握拍','sym-grip');
 for(const k of doc.keys){
  k.pose.handL=mirrorHand(k.pose.handR);
  k.pose.footL=mirrorFoot(k.pose.footR);
  k.constraints.grip=true;
 }
 return doc;
};

/** Solve one frame and capture every bone's world position + orientation. */
const solved=(doc:WorkshopDoc,t:number)=>{
 solveEffectiveFrame(rig,frameAt(doc,t,rig.rest.get('root')!));
 const pos=new Map<string,Vector3>(),quat=new Map<string,Quaternion>();
 for(const [n]of rig.bones){
  pos.set(n,rig.point(n));
  quat.set(n,rig.bone(n).getWorldQuaternion(new Quaternion()));
 }
 return {pos,quat};
};

/** Assert L equals the x-mirror of R — positions AND world orientations,
 * so finger winding, palm orientation and wrist cones are all pinned.
 * Measured residuals: ≤5e-16 m / ≤5e-8 rad — the tolerances stay
 * machine-epsilon-adjacent so the test can never certify an approximate
 * mirror as the real one (WP-D's 方案A acceptance bar). */
const expectMirror=(L:ReturnType<typeof solved>,R:ReturnType<typeof solved>,posTol=1e-9,angTol=1e-6)=>{
 for(const [n,p]of L.pos){
  const rp=R.pos.get(mirrorName(n))!;
  expect(p.distanceTo(new Vector3(-rp.x,rp.y,rp.z)),`position ${n}`).toBeLessThan(posTol);
  const q=L.quat.get(n)!;
  expect(q.angleTo(mirrorQuat(R.quat.get(mirrorName(n))!)),`orientation ${n}`).toBeLessThan(angTol);
 }
};

/** Closest distance from a wrist-local point to the finite tapered octagonal
 * handle prism. CylinderGeometry uses thetaStart=π/8, eight sides, a 145 mm
 * length and radii 18 mm (cap) / 16 mm (head). */
const HANDLE_FINGER_RADIUS=.004;
const racketHandleGeometry=(racket:ReturnType<typeof attachRacket>)=>{
 const handle=racket.children.find(child=>child instanceof Mesh&&child.geometry instanceof CylinderGeometry&&Math.abs(child.geometry.parameters.height-.145)<1e-9);
 expect(handle,'racket must contain its finite cylindrical handle').toBeDefined();
 return (handle as Mesh).geometry as CylinderGeometry;
};
const handlePolygon=(y:number,geometry:CylinderGeometry)=>{
 const {height,radialSegments,thetaStart,radiusTop,radiusBottom}=geometry.parameters,half=height/2,clamped=Math.max(-half,Math.min(half,y));
 const radius=radiusTop+(half-clamped)/height*(radiusBottom-radiusTop),vertices:Vector3[]=[];
 for(let i=0;i<radialSegments;i++){
  const theta=thetaStart+i*Math.PI*2/radialSegments;
  vertices.push(new Vector3(Math.sin(theta)*radius,0,Math.cos(theta)*radius));
 }
 return vertices;
};
const distanceToSegment2=(p:Vector3,a:Vector3,b:Vector3)=>{
 const d=b.clone().sub(a),u=Math.max(0,Math.min(1,((p.x-a.x)*d.x+(p.z-a.z)*d.z)/(d.x*d.x+d.z*d.z||1)));
 return Math.hypot(p.x-a.x-u*d.x,p.z-a.z-u*d.z);
};
const pointInsidePolygon=(p:Vector3,vertices:Vector3[])=>{
 let sign=0;
 for(let i=0;i<vertices.length;i++){
  const a=vertices[i],b=vertices[(i+1)%vertices.length],cross=(b.x-a.x)*(p.z-a.z)-(b.z-a.z)*(p.x-a.x);
  if(Math.abs(cross)<1e-12)continue;
  const current=Math.sign(cross);if(sign&&current!==sign)return false;sign=current;
 }
 return true;
};
const pointToHandleDistance=(p:Vector3,geometry:CylinderGeometry)=>{
 const half=geometry.parameters.height/2,y=Math.max(-half,Math.min(half,p.y)),poly=handlePolygon(y,geometry),radial=pointInsidePolygon(p,poly)?0:Math.min(...poly.map((v,i)=>distanceToSegment2(p,v,poly[(i+1)%poly.length]))),axial=Math.abs(p.y-y);
 return Math.hypot(radial,axial);
};
/** Finger-segment capsule clearance against the actual finite racket prism.
 * The 4 mm radius is a conservative skeletal proxy for the visible finger pad. */
const expectGripFingerClearance=(side:'L'|'R',racket:ReturnType<typeof attachRacket>)=>{
 racket.updateMatrixWorld(true);const geometry=racketHandleGeometry(racket);
 for(let finger=1;finger<=5;finger++)for(let joint=1;joint<=3;joint++){
  const name=`finger${finger}-${joint}_${side}`,bone=rig.bone(name),info=rig.info.bones.find(b=>b.name===name)!;
  const worldA=rig.point(name),worldB=new Vector3().fromArray(info.tail).sub(rig.rest.get(name)!).applyMatrix4(bone.matrixWorld);
  const a=racket.worldToLocal(worldA.clone()),b=racket.worldToLocal(worldB.clone());
  for(let sample=0;sample<=40;sample++){
   const p=a.clone().lerp(b,sample/40),clearance=pointToHandleDistance(p,geometry);
   expect(clearance,`${name} capsule clearance at segment sample ${sample}`).toBeGreaterThanOrEqual(HANDLE_FINGER_RADIUS-1e-4);
  }
 }
};
/** A skeletal web proxy: midpoint between the thumb and index base origins.
 * Its radial direction from the closest point on the tilted shaft is compared
 * with the selected bevel's contact point, not treated as literal skin. */
const expectWebAtSelectedBevel=(side:'L'|'R',bevel:number,racket:ReturnType<typeof attachRacket>)=>{
 racket.updateMatrixWorld(true);
 const wrist=rig.bone(`wrist_${side}`),thumb=wrist.worldToLocal(rig.point(`finger1-1_${side}`)),index=wrist.worldToLocal(rig.point(`finger2-1_${side}`)),web=thumb.add(index).multiplyScalar(.5),webWorld=wrist.localToWorld(web.clone()),inRacket=racket.worldToLocal(webWorld);
 const closestAxisY=Math.max(-racketHandleGeometry(racket).parameters.height/2,Math.min(racketHandleGeometry(racket).parameters.height/2,inRacket.y));
 const webRadial=new Vector3(inRacket.x,0,inRacket.z),magnitude=webRadial.length();
 expect(magnitude,'thumb-index web proxy must sit off the handle axis').toBeGreaterThan(1e-4);
 webRadial.divideScalar(magnitude);
 const selected=bevelDirection(side,bevel).setY(0).normalize();
 const angle=webRadial.angleTo(selected),contactDistance=2*RACKET_HANDLE.radius*Math.sin(angle/2);
 // A 35° radial tolerance is 13.3 mm between skeletal proxy and selected
 // contact point at the 22 mm finger-wrap radius.
 expect(contactDistance,`bevel ${bevel} web-to-facet proxy at shaft y=${closestAxisY.toFixed(3)}`).toBeLessThanOrEqual(2*RACKET_HANDLE.radius*Math.sin(35*Math.PI/360)+1e-9);
};

describe('gripSide — parse and normalize',()=>{
 it('omitted side stays the canonical absent form and solves as R',()=>{
  const doc=blankDocument(rig.rest,'t','t');
  const back=parseDoc(serializeDoc(doc));
  expect(back.gripSide).toBeUndefined();
  expect(frameAt(back,.3,rig.rest.get('root')).gripSide).toBe('R');
 });
 it('preserves an explicit L through serialize→parse',()=>{
  const doc=blankDocument(rig.rest,'t','t');doc.gripSide='L';
  const back=parseDoc(serializeDoc(doc));
  expect(back.gripSide).toBe('L');
  expect(frameAt(back,.3,rig.rest.get('root')).gripSide).toBe('L');
  // Stepped docs carry the side through the same branch.
  const stepped={...doc,inbetweens:false};
  expect(frameAt(stepped,.3,rig.rest.get('root')).gripSide).toBe('L');
 });
 it('normalizes an explicit R to the absent canonical form',()=>{
  const doc=blankDocument(rig.rest,'t','t'),raw=JSON.parse(serializeDoc(doc)) as {gripSide?:string};
  raw.gripSide='R';
  expect(parseDoc(JSON.stringify(raw)).gripSide).toBeUndefined();
 });
 it('rejects non-R/L values instead of silently keeping them',()=>{
  const doc=blankDocument(rig.rest,'t','t'),raw=JSON.parse(serializeDoc(doc)) as {gripSide?:string};
  raw.gripSide='B';
  expect(validateDocShape(raw).some(e=>e.includes('gripSide'))).toBe(true);
  expect(()=>parseDoc(JSON.stringify(raw))).toThrow();
 });
 it('validates shaft tilt on motion-file prop capabilities',()=>{
  const envelope=(gripTilt:number)=>({schemaVersion:1,kind:'workshop-motion',id:'tilt',order:0,
   name:'倾角',english:'TILT',duration:1,description:'',method:'',focus:[],phases:[],
   capabilities:{prop:{kind:'racket',trail:true,handView:true,gripTilt}},document:{duration:1}});
  expect(validateMotionFileShape(envelope(-45))).toEqual([]);
  expect(validateMotionFileShape(envelope(45))).toEqual([]);
  expect(validateMotionFileShape(envelope(45.01)).some(e=>e.includes('capabilities.prop.gripTilt'))).toBe(true);
 });
 it('round-trips the document-level racket tilt and folds its zero default',()=>{
  const doc=blankDocument(rig.rest,'拍柄倾斜','grip-tilt');
  doc.gripTilt=22.5;
  const back=parseDoc(serializeDoc(doc));
  expect(back.gripTilt).toBe(22.5);
  expect(frameAt(back,.3,rig.rest.get('root')).gripTilt).toBe(22.5);
  const zero=JSON.parse(serializeDoc({...doc,gripTilt:0}));
  expect(parseDoc(JSON.stringify(zero)).gripTilt).toBeUndefined();
  for(const invalid of [NaN,45.01,-45.01]){
   const raw=JSON.parse(serializeDoc(doc)) as {gripTilt?:number};raw.gripTilt=invalid;
   expect(validateDocShape(raw).some(e=>e.includes('gripTilt'))).toBe(true);
   expect(()=>parseDoc(JSON.stringify(raw))).toThrow();
  }
 });
 it('folds the side into the request fingerprint, collapsing R spellings',()=>{
  const base=blankDocument(rig.rest,'t','t');
  const wire=(side?:string)=>{const raw=JSON.parse(serializeDoc(base)) as {gripSide?:string};if(side!==undefined)raw.gripSide=side;return raw;};
  const canon=(raw:object)=>canonical(normalizedRequest('workshop-doc',parseDoc(JSON.stringify(raw)),40));
  const a=canon(wire()),b=canon(wire('L')),c=canon(wire('R'));
  expect(b).not.toBe(a);   // L 与 R 解出不同轨迹 → 必须不同指纹
  expect(c).toBe(a);       // 显式 'R' 与缺省语义相同 → 归一后同指纹
 });
});

describe('gripSide — mirrored solve',()=>{
 const solveBoth=(edit:(d:WorkshopDoc)=>void,times:number[])=>{
  const doc=symmetricDoc();edit(doc);
  for(const inbetweens of [true,false]){
   const d:WorkshopDoc={...doc,inbetweens};
   for(const t of times){
    const R=solved(d,t);
    const L=solved({...d,gripSide:'L'},t);
    expectMirror(L,R);
   }
  }
 };
 it('solves a left grip as the exact x-mirror of the same right grip',()=>{
  solveBoth(()=>{},[0,.25,.5,.75,1]);
 });
 it('mirrors the wrist cone clamp when the bend exceeds the limit',()=>{
  solveBoth(d=>{
   for(const k of d.keys){
    // Low hand + straight-up desired forward ≈90° bend → the 59.8°
    // cone engages on both sides; symmetry must survive the clamp.
    k.pose.handR.target={x:-.25,y:.7,z:.35};k.pose.handR.forward={x:0,y:1,z:0};k.pose.handR.normal={x:-1,y:0,z:0};
    k.pose.handL=mirrorHand(k.pose.handR);
   }
  },[0,.5,1]);
 });
 it('mirrors clavicle assist onto the gripping side',()=>{
  solveBoth(d=>{
   d.clavicleLift=true;
   for(const k of d.keys){
    k.pose.handR.target={x:-.25,y:1.75,z:.1};
    k.pose.handL=mirrorHand(k.pose.handR);
   }
  },[0,.5,1]);
 });
 it('actually wraps the left fingers instead of leaving them relaxed',()=>{
  const doc=symmetricDoc();
  solved({...doc,gripSide:'L'},.5);
  const wrappedL=rig.point('finger1-3_L');
  solved(doc,.5);
  const relaxedL=rig.point('finger1-3_L');
  expect(wrappedL.distanceTo(relaxedL)).toBeGreaterThan(.01);
 });
 it('full grip fully owns finger rotations regardless of authored hand spread',()=>{
  const doc=symmetricDoc();
  const fingerNames=Array.from({length:5},(_,f)=>Array.from({length:3},(_,j)=>`finger${f+1}-${j+1}_R`)).flat();
  const solveSpread=(spread:number)=>{
   for(const key of doc.keys)key.pose.handSpread={...(key.pose.handSpread??{}),R:spread};
   const frame=frameAt(doc,.5,rig.rest.get('root')!);
   expect(frame.gripAmount).toBe(1);
   solveEffectiveFrame(rig,frame);
   return fingerNames.map(name=>rig.bone(name).quaternion.clone());
  };
  const fist=solveSpread(0),open=solveSpread(1);
  const maxAngle=Math.max(...fist.map((q,i)=>q.angleTo(open[i])));
  expect(maxAngle).toBeLessThan(1e-7);
 });
});

describe('gripSide — racket mount',()=>{
 it('derives the left grip frame as the mirror of the right',()=>{
  const R=gripFrame(rig,'R',RACKET_HANDLE),L=gripFrame(rig,'L',RACKET_HANDLE);
  // Polar vectors mirror x→−x; the handle axis is a cross product
  // (axial) so its mirror is (−x→x, y→−y, z→−z) — same line, opposite sense.
  for(const [a,b]of [[L.forward,R.forward],[L.normal,R.normal],[L.center,R.center]]as const){
   expect(a.x).toBeCloseTo(-b.x,9);expect(a.y).toBeCloseTo(b.y,9);expect(a.z).toBeCloseTo(b.z,9);
  }
  expect(L.axis.x).toBeCloseTo(R.axis.x,9);expect(L.axis.y).toBeCloseTo(-R.axis.y,9);expect(L.axis.z).toBeCloseTo(-R.axis.z,9);
 });
 it('bevel rolls mirror and every palm-relative direction advances by one 45° facet',()=>{
  expect(RACKET_BEVELS).toBe(8);
  for(let bevel=1;bevel<=RACKET_BEVELS;bevel++){
   const r=bevelDirection('R',bevel),l=bevelDirection('L',bevel);
   expect(l.x).toBeCloseTo(-r.x,12);expect(l.y).toBeCloseTo(r.y,12);expect(l.z).toBeCloseTo(r.z,12);
   expect(bevelRoll('L',bevel)).toBe(-bevelRoll('R',bevel));
   if(bevel<RACKET_BEVELS){
    // Azimuth maps θ→(sinθ,cosθ), so the plain (x,z) cross comes out NEGATED;
    // swap the order to measure the +45° advance from one facet to the next.
    const next=bevelDirection('R',bevel+1);
    expect(Math.atan2(next.x*r.z-next.z*r.x,r.x*next.x+r.z*next.z)).toBeCloseTo(Math.PI/4,12);
   }
  }
 });
 it('mounts nondefault bevels as the exact left/right mirror',()=>{
  const doc=symmetricDoc();
  for(const bevel of [2,4,8]){
   const rR=attachRacket(rig,'R',bevel,23),rL=attachRacket(rig,'L',bevel,23);
   solved(doc,.5);const R={tip:rR.localToWorld(RACKET_TIP_LOCAL.clone()),q:rR.getWorldQuaternion(new Quaternion()),edge:rR.localToWorld(new Vector3(.03,.45,0))};
   // The left mount is the conjugated transform, so a local probe with x≠0
   // corresponds to the x-mirrored local point on the left racket.
   solved({...doc,gripSide:'L'},.5);const L={tip:rL.localToWorld(RACKET_TIP_LOCAL.clone()),q:rL.getWorldQuaternion(new Quaternion()),edge:rL.localToWorld(new Vector3(-.03,.45,0))};
   for(const k of ['tip','edge']as const)expect(L[k].distanceTo(new Vector3(-R[k].x,R[k].y,R[k].z)),`bevel ${bevel} ${k}`).toBeLessThan(1e-9);
   expect(L.q.angleTo(mirrorQuat(R.q)),`bevel ${bevel} rotation`).toBeLessThan(1e-6);
   rR.removeFromParent();rL.removeFromParent();
  }
 });
 it('tilts the racket around the palm-held grip and carries the finger wrap with the shaft',()=>{
  const doc=symmetricDoc(),base=attachRacket(rig,'R'),tilted=attachRacket(rig,'R',undefined,24);
  const before=solved(doc,.5);
  const baseTip=base.localToWorld(RACKET_TIP_LOCAL.clone()),baseQ=base.getWorldQuaternion(new Quaternion());
  const baseCenter=base.getWorldPosition(new Vector3());
  const tiltedDoc={...doc,gripTilt:24};
  const after=solved(tiltedDoc,.5);
  const tiltedTip=tilted.localToWorld(RACKET_TIP_LOCAL.clone());
  expect(tilted.getWorldPosition(new Vector3()).distanceTo(baseCenter)).toBeLessThan(1e-9);
  expect(tiltedTip.distanceTo(baseTip)).toBeGreaterThan(.05);
  const baseAxis=new Vector3(0,1,0).applyQuaternion(baseQ),tiltedAxis=new Vector3(0,1,0).applyQuaternion(tilted.getWorldQuaternion(new Quaternion()));
  expect(tiltedAxis.angleTo(baseAxis)).toBeCloseTo(24*Math.PI/180,6);
  const fingerBones=Array.from(before.quat.keys()).filter(name=>/^finger[1-5]-/.test(name));
  expect(Math.max(...fingerBones.map(name=>before.quat.get(name)!.angleTo(after.quat.get(name)!)))).toBeGreaterThan(.02);
  for(const [name,p]of before.pos)if(!/^finger[1-5]-/.test(name))expect(after.pos.get(name)!.distanceTo(p),`non-finger bone ${name}`).toBeLessThan(1e-9);
  for(const [name,q]of before.quat)if(!/^finger[1-5]-/.test(name))expect(after.quat.get(name)!.angleTo(q),`non-finger bone ${name} orientation`).toBeLessThan(1e-7);
  const gripCenter=rig.bone('wrist_R').localToWorld(gripFrame(rig,'R',RACKET_HANDLE).center.clone());
  expect(tilted.getWorldPosition(new Vector3()).distanceTo(gripCenter)).toBeLessThan(1e-9);
  base.removeFromParent();tilted.removeFromParent();
 });
 it('keeps tilted octagonal handles outside finger capsules and seats the selected facet at the web',()=>{
  for(const tilt of [-RACKET_GRIP_TILT_LIMIT_DEG,0,RACKET_GRIP_TILT_LIMIT_DEG])for(const bevel of [1,3,8]){
   const doc=symmetricDoc();doc.gripTilt=tilt;doc.gripBevel=bevel;
   const rR=attachRacket(rig,'R',bevel,tilt),rL=attachRacket(rig,'L',bevel,tilt);
   const R=solved(doc,.5);
   expectGripFingerClearance('R',rR);expectWebAtSelectedBevel('R',bevel,rR);
   const world=(racket:typeof rR,localX:number)=>({
    tip:racket.localToWorld(RACKET_TIP_LOCAL.clone()),
    facet:racket.localToWorld(new Vector3(localX,.084,0)),
    q:racket.getWorldQuaternion(new Quaternion()),
   });
   const racketR=world(rR,.03);
   const L=solved({...doc,gripSide:'L'},.5);
   expectMirror(L,R);
   expectGripFingerClearance('L',rL);expectWebAtSelectedBevel('L',bevel,rL);
   const racketL=world(rL,-.03);
   for(const k of ['tip','facet']as const)expect(racketL[k].distanceTo(new Vector3(-racketR[k].x,racketR[k].y,racketR[k].z)),`tilt ${tilt} bevel ${bevel} racket ${k}`).toBeLessThan(1e-9);
   expect(racketL.q.angleTo(mirrorQuat(racketR.q)),`tilt ${tilt} bevel ${bevel} racket rotation`).toBeLessThan(1e-6);
   rR.removeFromParent();rL.removeFromParent();
  }
 });
 it('mounts on wrist_L with the mirrored transform',()=>{
  const doc=symmetricDoc();
  const rR=attachRacket(rig,'R'),rL=attachRacket(rig,'L');
  const world=(racket:typeof rR)=>({
   o:racket.getWorldPosition(new Vector3()),
   tip:racket.localToWorld(RACKET_TIP_LOCAL.clone()),
   face:racket.localToWorld(new Vector3(0,.45,.03)),
   q:racket.getWorldQuaternion(new Quaternion()),
  });
  solved(doc,.5);
  const R=world(rR);
  solved({...doc,gripSide:'L'},.5);
  expect(rL.parent?.name).toBe('wrist_L');
  const L=world(rL);
  for(const k of ['o','tip','face']as const){
   expect(L[k].distanceTo(new Vector3(-R[k].x,R[k].y,R[k].z)),`racket ${k}`).toBeLessThan(1e-9);
  }
  expect(L.q.angleTo(mirrorQuat(R.q))).toBeLessThan(1e-6);
  rR.removeFromParent();rL.removeFromParent();
 });
});

describe('gripSide — analysis',()=>{
 it('quality probe instruments the gripping arm, not the right arm',()=>{
  const doc=symmetricDoc();doc.gripSide='L';
  // Desymmetrize: a far-away left target makes arm.d discriminate which
  // side the probe instrumented (mirrored targets could not).
  for(const k of doc.keys)k.pose.handL.target={x:.55,y:.6,z:.5};
  const frames=probeFrames(rig,doc,60);
  const report=analyzeProbeFrames({doc,fps:60,frames,rest:rig.rest});
  expect(report.gripSide).toBe('L');
  expect(report.ik.armResidual.side).toBe('L');
  expect(report.chain.map(c=>c.bone)).toContain('wrist_L');
  expect(report.chain.map(c=>c.bone)).not.toContain('wrist_R');
  // arm.d is |handL.target − solved left shoulder root| — recomputed the
  // same way, at the same frame, against the same rig the probe used.
  const f=frameAt(doc,.5,rig.rest.get('root'));
  solveEffectiveFrame(rig,f);
  const arm=frames[Math.round(.5*60)].arm;
  const to=(v:Vector3,from:Vector3)=>v.distanceTo(from);
  const dL=to(rig.point('upperarm01_L'),new Vector3(f.pose.handL.target.x,f.pose.handL.target.y,f.pose.handL.target.z));
  const dR=to(rig.point('upperarm01_R'),new Vector3(f.pose.handR.target.x,f.pose.handR.target.y,f.pose.handR.target.z));
  expect(arm.d).toBeCloseTo(dL,6);
  expect(Math.abs(arm.d-dR)).toBeGreaterThan(.1);
 });
});
