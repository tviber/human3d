import {describe,it,expect,beforeAll} from 'vitest';
import fs from 'node:fs';
import {Vector3,Quaternion,AnimationClip,AnimationMixer,SkinnedMesh,Mesh} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {handFrame} from './hand-frame';
import {HumanRig,mapMyoSimThumbToSkin} from './rig';
import {solveTwoBone,angleAt,frameRotation,clampJoint,hingedArmRotations,forearmTwist,DEG} from './kinematics';
import {MOTION_FILES,motionFileById} from './motion-files';
import {frameAt} from './document';
import {solveEffectiveFrame} from './solver';
import {attachRacket,RACKET_HANDLE} from './props/racket';
import {gripFrame,blendGrip} from './grip';
import type {MotionId} from './types';
let rig:HumanRig,walkClip:AnimationClip,racket:ReturnType<typeof attachRacket>;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));racket=attachRacket(rig);walkClip=AnimationClip.parse(JSON.parse(fs.readFileSync('public/models/walk.json','utf8')));
},30000);
const durationOf=(id:string)=>id==='walk'?walkClip.duration:motionFileById(id)!.duration;
function setPose(id:MotionId,t:number){
 rig.reset();
 if(id==='walk'){
  const mixer=new AnimationMixer(rig.model);const action=mixer.clipAction(walkClip).play();action.time=t;mixer.update(0);rig.model.updateMatrixWorld(true);
  return ()=>{mixer.stopAllAction();mixer.uncacheRoot(rig.model)};
 }
 // Document motions replay through the production path: envelope document →
 // frameAt → solveEffectiveFrame — the same pipeline the service serves.
 solveEffectiveFrame(rig,frameAt(motionFileById(id)!.document!,t,rig.rest.get('root')!));
 rig.model.updateMatrixWorld(true);
 return ()=>{};
}
describe('constant-length IK',()=>{
 it('reaches a valid target with exact segment lengths',()=>{const r=new Vector3(0,1,0),t=new Vector3(.15,.2,.2),s=solveTwoBone(r,t,new Vector3(0,.5,1),.45,.44,135);expect(r.distanceTo(s.mid)).toBeCloseTo(.45,10);expect(s.mid.distanceTo(s.end)).toBeCloseTo(.44,10);expect(s.residual).toBeLessThan(1e-8);expect(s.mid.z).toBeGreaterThan(t.z);});
 it('retargets world landmarks without changing the skin arm lengths or direction',()=>{
  rig.reset();rig.model.updateMatrixWorld(true);const root=rig.point('upperarm01_R'),target=root.clone().add(new Vector3(.05,.02,.50)),pole=root.clone().add(new Vector3(.1,-.2,.2));
  const solved=rig.limbToWorldTargets('R','arm',target,pole),elbow=rig.point('lowerarm01_R'),wrist=rig.point('wrist_R');
  expect(root.distanceTo(elbow)).toBeCloseTo(rig.rest.get('upperarm01_R')!.distanceTo(rig.rest.get('lowerarm01_R')!),6);
  expect(elbow.distanceTo(wrist)).toBeCloseTo(rig.rest.get('lowerarm01_R')!.distanceTo(rig.rest.get('wrist_R')!),6);
  expect(wrist.distanceTo(solved.end)).toBeLessThan(1e-6);expect(angleAt(root,elbow,wrist)).toBeCloseTo(solved.flexion,4);
 });
 it('clamps unreachable, overflexed and singular targets without stretching or NaN',()=>{for(const target of [new Vector3(0,-10,0),new Vector3(0,1,0),new Vector3(.001,1,0)]){const r=new Vector3(0,1,0),s=solveTwoBone(r,target,r,.45,.44,135);expect(s.flexion).toBeLessThanOrEqual(135+1e-8);expect(r.distanceTo(s.mid)).toBeCloseTo(.45,8);expect(s.mid.distanceTo(s.end)).toBeCloseTo(.44,8);expect(s.mid.toArray().every(Number.isFinite)).toBe(true);}});
 it('clamps finger input and maps reference frames with unit quaternions',()=>{expect(clampJoint('fingerDIP',120)).toBe(75);const q=frameRotation(new Vector3(0,1,0),new Vector3(0,0,1),new Vector3(1,0,0),new Vector3(0,0,1));expect(q.length()).toBeCloseTo(1,10);expect(new Vector3(0,1,0).applyQuaternion(q).distanceTo(new Vector3(1,0,0))).toBeLessThan(1e-8);});
 it('carries the forearm with the shoulder while retaining a single elbow hinge',()=>{
  const a=new Vector3(.1,-.3,0),b=new Vector3(.1,-.25,.12),axis=new Vector3(-1,0,0);
  const poses=[-.3,0,.3].map(swing=>hingedArmRotations(a,b,new Vector3(0,-1,0).applyAxisAngle(axis,swing),axis,30));
  const local=poses.map(p=>p.shoulder.clone().invert().multiply(p.elbow));
  for(const p of poses){const upper=a.clone().applyQuaternion(p.shoulder),lower=b.clone().applyQuaternion(p.elbow);expect(upper.angleTo(lower)/DEG).toBeCloseTo(30,8);expect(new Vector3().crossVectors(upper,lower).normalize().dot(axis)).toBeGreaterThan(.999999);}
  expect(local[0].angleTo(local[1])).toBeLessThan(1e-7);expect(local[1].angleTo(local[2])).toBeLessThan(1e-7);
 });
});
describe('real authored asset and animation data',()=>{
 it('has a skinned continuous human surface, 163 bones and complete fingers',()=>{let mesh:SkinnedMesh|undefined;rig.model.traverse(o=>{if(o instanceof SkinnedMesh)mesh=o;});expect(mesh).toBeDefined();expect(mesh!.geometry.getAttribute('position').count).toBe(55784);expect(mesh!.geometry.getAttribute('uv').count).toBe(55784);expect(rig.bones.size).toBe(163);for(const side of ['L','R'])for(let f=1;f<=5;f++)for(let j=1;j<=3;j++)expect(rig.bones.has(`finger${f}-${j}_${side}`)).toBe(true);const w=mesh!.geometry.getAttribute('skinWeight');for(let i=0;i<w.count;i++)expect(w.getX(i)+w.getY(i)+w.getZ(i)+w.getW(i)).toBeCloseTo(1,5);});
 it('resolves all bundled motion files and drives every rig bone',()=>{
  // The envelopes are the lab's motion list; walk references a clip asset,
  // and the two dynamics-motion envelopes replay MyoSim records rather than
  // writing the skin rig through the document path.
  expect(MOTION_FILES.map(f=>f.id).sort()).toEqual([
   'baseball-throw','basic-arms-up','basic-forward-fold','basic-full-squat','basic-half-squat','basic-lunge','basic-push-turn','basic-weight-shift','basic-wide-squat',
   'forehand','idle','punch','reach','ready','squat','walk',
  ]);
  for(const f of MOTION_FILES.filter(f=>f.kind!=='dynamics-motion')){
   expect(f.duration).toBeGreaterThan(1);
   const cleanup=setPose(f.id,f.duration/2);
   for(const [n,b]of rig.bones){
    expect(b.quaternion.length(),`${f.id}:${n}`).toBeCloseTo(1,6);
    expect(b.position.toArray().every(Number.isFinite),`${f.id}:${n}`).toBe(true);
   }
   expect(rig.point('root').toArray().every(Number.isFinite)).toBe(true);
   cleanup();
  }
 });
 it('preserves every local bone length and unit rotation at 31 times per motion',()=>{
  for(const f of MOTION_FILES.filter(f=>f.kind!=='dynamics-motion'))for(let i=0;i<=30;i++){const cleanup=setPose(f.id,i/31*durationOf(f.id));for(const [n,b]of rig.bones){if(n!=='root')expect(b.position.distanceTo(rig.restLocal.get(n)!)).toBeLessThan(1e-7);expect(b.scale.toArray()).toEqual([1,1,1]);expect(b.quaternion.length()).toBeCloseTo(1,4);}for(const side of ['L','R']){const knee=angleAt(rig.point(`upperleg01_${side}`),rig.point(`lowerleg01_${side}`),rig.point(`foot_${side}`));const elbow=angleAt(rig.point(`upperarm01_${side}`),rig.point(`lowerarm01_${side}`),rig.point(`wrist_${side}`));expect(knee).toBeLessThanOrEqual(135.1);expect(elbow).toBeLessThanOrEqual(145.1);}cleanup();}
 },60000);
 it('keeps hip, shoulder, ankle and wrist within engineering ranges at 80 times per motion',()=>{
  for(const f of MOTION_FILES.filter(f=>f.kind!=='dynamics-motion'))for(let i=0;i<80;i++){const cleanup=setPose(f.id,i/80*durationOf(f.id));
   for(const side of ['L','R']){
    const hip=rig.point(`lowerleg01_${side}`).sub(rig.point(`upperleg01_${side}`)).applyQuaternion(rig.bone('root').getWorldQuaternion(new Quaternion()).invert());
    const h=Math.atan2(hip.z,-hip.y)*180/Math.PI;expect(h,`${f.id}@${(i/80*durationOf(f.id)).toFixed(3)}:${side}`).toBeGreaterThanOrEqual(-20.1);expect(h,`${f.id}@${(i/80*durationOf(f.id)).toFixed(3)}:${side}`).toBeLessThanOrEqual(120.1);
    const shank=rig.point(`foot_${side}`).sub(rig.point(`lowerleg01_${side}`)).applyQuaternion(rig.bone(`foot_${side}`).getWorldQuaternion(new Quaternion()).invert());
    const ankle=Math.atan2(-shank.z,-shank.y)*180/Math.PI;expect(ankle,`${f.id}@${(i/80*durationOf(f.id)).toFixed(3)}:${side}`).toBeGreaterThanOrEqual(-40.1);expect(ankle,`${f.id}@${(i/80*durationOf(f.id)).toFixed(3)}:${side}`).toBeLessThanOrEqual(20.1);
    const shoulder=rig.point(`lowerarm01_${side}`).sub(rig.point(`upperarm01_${side}`)).applyQuaternion(rig.bone(`clavicle_${side}`).getWorldQuaternion(new Quaternion()).invert());
    expect(shoulder.angleTo(new Vector3(0,-1,0))*180/Math.PI,`${f.id}@${(i/80*durationOf(f.id)).toFixed(3)}:${side}`).toBeLessThanOrEqual(165.1);
    const hand=rig.rest.get(`finger3-1_${side}`)!.clone().sub(rig.rest.get(`wrist_${side}`)!).applyQuaternion(rig.bone(`wrist_${side}`).getWorldQuaternion(new Quaternion()));
    expect(hand.angleTo(rig.point(`wrist_${side}`).sub(rig.point(`lowerarm01_${side}`)))*180/Math.PI).toBeLessThanOrEqual(60.1);
   }cleanup();
  }
 },60000);
 it('uses mirrored physical palm normals and flexion axes',()=>{
  const left=handFrame(rig.rest,'L'),right=handFrame(rig.rest,'R');
  const mirror=(v:Vector3)=>new Vector3(-v.x,v.y,v.z);
  expect(left.normal.distanceTo(mirror(right.normal))).toBeLessThan(.001);
  expect(left.forward.distanceTo(mirror(right.forward))).toBeLessThan(.001);
  // Rotation axes are axial vectors; their mirror has the opposite parity.
  expect(left.flexionAxis.distanceTo(mirror(right.flexionAxis).negate())).toBeLessThan(.001);
 });
 it('points both standing palms inward, with mirrored relaxed finger tips',()=>{
  const cleanup=setPose('idle',0);
  for(const side of ['L','R'] as const){const palmar=handFrame(rig.rest,side).normal.applyQuaternion(rig.bone(`wrist_${side}`).getWorldQuaternion(new Quaternion()));expect(palmar.dot(new Vector3(side==='L'?-1:1,0,0))).toBeGreaterThan(.99);}
  for(let finger=2;finger<=5;finger++){
   const tip=(side:'L'|'R')=>{const name=`finger${finger}-3_${side}`,b=rig.info.bones.find(b=>b.name===name)!;return new Vector3().fromArray(b.tail).sub(rig.rest.get(name)!).applyMatrix4(rig.bone(name).matrixWorld);};
   const r=tip('R');r.x=-r.x;expect(tip('L').distanceTo(r)).toBeLessThan(.002);
  }cleanup();
 });
 it('closes the punch fist with articulated MCP/PIP/DIP joints and a thumb across the index',()=>{
  rig.reset();
  const radians=(degrees:number)=>degrees*DEG;
  // Angles are physical MyoSim coordinates from the integrated punch record;
  // the thumb's two opposite local skin axes are converted at the rig boundary.
  const thumb=mapMyoSimThumbToSkin({cmcFlexion:radians(-44),cmcOpposition:radians(40),mcp:radians(40),ip:radians(25)});
  rig.articulateHand('R',{
   thumb,
   fingers:{
    2:{mcp:radians(68),pip:radians(88),dip:radians(55)},
    3:{mcp:radians(72),pip:radians(90),dip:radians(58)},
    4:{mcp:radians(74),pip:radians(88),dip:radians(58)},
    5:{mcp:radians(75),pip:radians(85),dip:radians(55)},
   },
  });
  const wrist=rig.bone('wrist_R');
  const tip=(name:string)=>wrist.worldToLocal(new Vector3().fromArray(rig.info.bones.find(b=>b.name===name)!.tail).sub(rig.rest.get(name)!).applyMatrix4(rig.bone(name).matrixWorld));
  const base=(name:string)=>wrist.worldToLocal(rig.bone(name).getWorldPosition(new Vector3()));
  for(const digit of [2,3,4,5])for(const joint of [1,2,3]){
   expect(rig.bone(`finger${digit}-${joint}_R`).quaternion.angleTo(new Quaternion())).toBeGreaterThan(20*DEG);
  }
  const thumbTip=tip('finger1-3_R'),indexBase=base('finger2-1_R'),indexTip=tip('finger2-1_R'),indexAxis=indexTip.clone().sub(indexBase);
  const u=Math.max(0,Math.min(1,thumbTip.clone().sub(indexBase).dot(indexAxis)/indexAxis.lengthSq()));
  expect(thumbTip.distanceTo(indexBase.addScaledVector(indexAxis,u))).toBeLessThan(.015);
  const palmCenter=new Vector3();for(const digit of [2,3,4,5])palmCenter.add(base(`finger${digit}-1_R`));palmCenter.multiplyScalar(.25);
  for(const digit of [2,3,4,5])expect(tip(`finger${digit}-3_R`).distanceTo(palmCenter)).toBeLessThan(.09);
 });
 it('closes the lead guard hand into a fist around its own palm',()=>{
  const punch=JSON.parse(fs.readFileSync('assets/motions/punch.json','utf8')).dynamics.action;
  const pose=punch.display.leftGuardHandPoseDeg,radians=(degrees:number)=>degrees*DEG;
  rig.reset();
  rig.articulateHand('L',{
   // The left skin palm normal is mirrored; the authored skin-local opposition angle therefore has the opposite sign from the right-hand MyoSim target.
   thumb:{cmcFlexion:radians(pose.thumb.cmcFlexion),cmcOpposition:radians(pose.thumb.cmcOpposition),mcp:radians(pose.thumb.mcp),ip:radians(pose.thumb.ip)},
   fingers:{
    2:{mcp:radians(pose.fingers['2'].mcp),pip:radians(pose.fingers['2'].pip),dip:radians(pose.fingers['2'].dip)},
    3:{mcp:radians(pose.fingers['3'].mcp),pip:radians(pose.fingers['3'].pip),dip:radians(pose.fingers['3'].dip)},
    4:{mcp:radians(pose.fingers['4'].mcp),pip:radians(pose.fingers['4'].pip),dip:radians(pose.fingers['4'].dip)},
    5:{mcp:radians(pose.fingers['5'].mcp),pip:radians(pose.fingers['5'].pip),dip:radians(pose.fingers['5'].dip)},
   },
  });
  const wrist=rig.bone('wrist_L');
  const tip=(name:string)=>wrist.worldToLocal(new Vector3().fromArray(rig.info.bones.find(b=>b.name===name)!.tail).sub(rig.rest.get(name)!).applyMatrix4(rig.bone(name).matrixWorld));
  const base=(name:string)=>wrist.worldToLocal(rig.bone(name).getWorldPosition(new Vector3()));
  const palmCenter=new Vector3();for(const digit of [2,3,4,5])palmCenter.add(base(`finger${digit}-1_L`));palmCenter.multiplyScalar(.25);
  for(const digit of [2,3,4,5])expect(tip(`finger${digit}-3_L`).distanceTo(palmCenter)).toBeLessThan(.09);
  const thumbTip=tip('finger1-3_L'),indexBase=base('finger2-1_L'),indexTip=tip('finger2-1_L'),indexAxis=indexTip.clone().sub(indexBase);
  const u=Math.max(0,Math.min(1,thumbTip.clone().sub(indexBase).dot(indexAxis)/indexAxis.lengthSq()));
  expect(thumbTip.distanceTo(indexBase.addScaledVector(indexAxis,u))).toBeLessThan(.02);
 });
 it('animates the punch wrist and keeps a clenched fist through recovery',()=>{
  const punch=JSON.parse(fs.readFileSync('assets/motions/punch.json','utf8')).dynamics.action;
  const frames=punch.reference.keyframes;
  const guard=frames.find((frame:any)=>frame.phase==='guard-and-clench').jointTargetsDeg;
  const peak=frames.find((frame:any)=>frame.phase==='full-extension').jointTargetsDeg;
  const follow=frames.find((frame:any)=>frame.phase==='brief-follow-through').jointTargetsDeg;
  expect(guard.pro_sup_r).not.toBe(peak.pro_sup_r);
  expect(guard.flexion_r).toBe(0);
  expect(peak.flexion_r).toBeLessThan(0);
  expect(follow.flexion_r).toBe(0);
  expect(peak.deviation_r).toBe(0);
  expect(guard.cmc_flexion).toBeLessThan(0);
  expect(peak.cmc_abduction).toBeGreaterThan(25);
  expect(peak.ip_flexion_r).toBeGreaterThan(10);
  expect(punch.display.handPoseSource).toBe('task-keyframe-retarget');
  expect(Math.abs(frames.at(-1).jointTargetsDeg.flexion_r)).toBeLessThanOrEqual(10);
  expect(frames.at(-1).jointTargetsDeg.mcp3_flexion_r).toBeGreaterThanOrEqual(peak.mcp3_flexion_r-2);
  expect(punch.reference.armControl).toBe('joint-keyframes');
  const chamber=frames.find((frame:any)=>frame.phase==='neutral'),extension=frames.find((frame:any)=>frame.phase==='full-extension');
  expect(chamber.rightElbowFlexionRad).toBeGreaterThan(extension.rightElbowFlexionRad+1);
  expect(Math.abs(extension.rightShoulderRotvecRad[1])).toBeLessThan(1);
  expect(punch.display.leftGuardHandPoseDeg.fingers['3'].mcp).toBeGreaterThan(75);
  expect(punch.display.leftGuardHandPoseDeg.thumb.cmcOpposition).toBeLessThan(0);
  for(const digit of [2,3,4,5]){
   expect(peak[`mcp${digit}_flexion_r`]).toBeGreaterThan(45);
   expect(peak[`pm${digit}_flexion${digit===4?'':'_r'}`]).toBeGreaterThan(55);
   expect(peak[`md${digit}_flexion${digit===3?'':'_r'}`]).toBeGreaterThan(25);
  }
 });
 it('keeps ordinary walking feet in separate tracks and closes the pose seam',()=>{
  let minWidth=Infinity,maxWidth=-Infinity,minSway=Infinity,maxSway=-Infinity;
  for(let i=0;i<100;i++){const cleanup=setPose('walk',i/100*walkClip.duration);const width=rig.point('foot_L').x-rig.point('foot_R').x;minWidth=Math.min(minWidth,width);maxWidth=Math.max(maxWidth,width);const x=rig.point('root').x;minSway=Math.min(minSway,x);maxSway=Math.max(maxSway,x);cleanup();}
  expect(minWidth).toBeGreaterThan(.06);expect(maxWidth).toBeLessThan(.18);expect(maxSway-minSway).toBeLessThan(.065);
  const first=setPose('walk',0),pose=new Map([...rig.bones].map(([n,b])=>[n,b.quaternion.clone()]));first();
  const last=setPose('walk',walkClip.duration-1e-6);for(const [n,b]of rig.bones)expect(b.quaternion.angleTo(pose.get(n)!)).toBeLessThan(.01);last();
 });
 it('keeps both walking elbow creases facing the anatomical flexion plane',()=>{
  for(let i=0;i<100;i++){const cleanup=setPose('walk',i/100*walkClip.duration);
   for(const side of ['L','R']){
    const a=rig.rest.get(`lowerarm01_${side}`)!.clone().sub(rig.rest.get(`upperarm01_${side}`)!),b=rig.rest.get(`wrist_${side}`)!.clone().sub(rig.rest.get(`lowerarm01_${side}`)!);
    const upper=rig.point(`lowerarm01_${side}`).sub(rig.point(`upperarm01_${side}`)),lower=rig.point(`wrist_${side}`).sub(rig.point(`lowerarm01_${side}`));
    const flex=upper.angleTo(lower),hinge=new Vector3().crossVectors(a,b).normalize();
    const expected=new Quaternion().setFromAxisAngle(hinge,flex-a.angleTo(b));
    expect(rig.bone(`lowerarm01_${side}`).quaternion.angleTo(expected)).toBeLessThan(.001);
    const skinHinge=hinge.applyQuaternion(rig.bone(`upperarm01_${side}`).getWorldQuaternion(new Quaternion()));
    const anatomicalAxis=new Vector3(-1,0,0).applyQuaternion(rig.bone('spine01').getWorldQuaternion(new Quaternion()));
    expect(skinHinge.dot(anatomicalAxis)).toBeGreaterThan(.95);
   }cleanup();
  }
 });
 it('keeps both squat ankles planted within 0.1mm at 81 samples',()=>{
  for(let i=0;i<=80;i++){const cleanup=setPose('squat',i/81*durationOf('squat'));for(const side of ['L','R']){const expected=new Vector3(side==='L'?.135:-.135,rig.rest.get(`foot_${side}`)!.y,.018);expect(rig.point(`foot_${side}`).distanceTo(expected)).toBeLessThan(.0001);}cleanup();}
 });
 it('locks measured walking support intervals in world space within 0.2mm',()=>{
  const meta=JSON.parse(fs.readFileSync('public/models/walk-meta.json','utf8'));
  for(const {side,start,end}of meta.supportWindows){let anchor:Vector3|undefined;
   for(let t=start;t<=end;t+=.01){const cleanup=setPose('walk',t),p=rig.point(`foot_${side}`);if(!anchor)anchor=p.clone();expect(Math.hypot(p.x-anchor.x,p.z-anchor.z)).toBeLessThan(.0002);cleanup();}
  }
 });
 it('keeps palm-to-handle transform fixed throughout the forehand',()=>{
  for(let i=0;i<=100;i++){const cleanup=setPose('forehand',i/101*durationOf('forehand'));const expected=rig.bone('wrist_R').localToWorld(gripFrame(rig,'R',RACKET_HANDLE).center.clone());expect(racket.getWorldPosition(new Vector3()).distanceTo(expected)).toBeLessThan(1e-10);cleanup();}
 });
 it('wraps every finger around the grip cylinder with contact and bounded distal flexion',()=>{
  const cleanup=setPose('ready',0);const {center,axis,forward,normal}=gripFrame(rig,'R',RACKET_HANDLE);const wrist=rig.bone('wrist_R');
  for(let f=1;f<=5;f++){
   let min=Infinity;
   for(let j=1;j<=3;j++){
    const n=`finger${f}-${j}_R`,bi=rig.info.bones.find(b=>b.name===n)!;
    const a=wrist.worldToLocal(rig.point(n)).sub(center);
    const b=wrist.worldToLocal(new Vector3().fromArray(bi.tail).sub(rig.rest.get(n)!).applyMatrix4(rig.bone(n).matrixWorld)).sub(center);
    // Closest point on the phalanx centerline to the grip axis.
    const ar=a.clone().addScaledVector(axis,-a.dot(axis)),br=b.clone().addScaledVector(axis,-b.dot(axis)),d=br.clone().sub(ar);
    const u=Math.max(0,Math.min(1,-ar.dot(d)/d.lengthSq()));const radial=ar.addScaledVector(d,u).length();min=Math.min(min,radial);
    expect(radial).toBeGreaterThan(.016); // No bone centerline runs through the handle.
   }
   expect(min).toBeLessThan(.025); // Within finger pad contact allowance.
   const n=`finger${f}-3_R`,bi=rig.info.bones.find(b=>b.name===n)!,tail=new Vector3().fromArray(bi.tail).sub(rig.rest.get(n)!).applyMatrix4(rig.bone(n).matrixWorld);
   const dip=angleAt(rig.point(`finger${f}-2_R`),rig.point(n),tail);expect(dip).toBeLessThanOrEqual(75.1);
  }
  cleanup();
 });
});

describe('forearm twist and grip blend are continuous',()=>{
 it('maps palm roll to an odd, bounded, continuous twist across the atan2 wrap at ±π',()=>{
  const cap=.65*80*DEG;
  let prev=forearmTwist(-Math.PI),worst=0,peak=0;
  for(let a=-Math.PI+1e-3;a<=Math.PI+1e-9;a+=1e-3){const g=forearmTwist(a);worst=Math.max(worst,Math.abs(g-prev));peak=Math.max(peak,Math.abs(g));prev=g;}
  // The slope never exceeds ~0.82 rad/rad, so a 1 mrad roll step moves the twist by under 1 mrad.
  expect(worst).toBeLessThan(1e-3);
  expect(peak).toBeLessThanOrEqual(cap+1e-12);
  for(const a of [.3,1,1.4,2.2,3])expect(forearmTwist(-a)).toBeCloseTo(-forearmTwist(a),12);
  expect(Math.abs(forearmTwist(Math.PI-1e-6)-forearmTwist(-Math.PI+1e-6))).toBeLessThan(1e-5);
 });
 it('moves every right-hand finger joint by a bounded angle per 1% of grip amount',()=>{
  const names:string[]=[];
  for(let f=1;f<=5;f++)for(let j=1;j<=3;j++)names.push(`finger${f}-${j}_R`);
  let prev:Quaternion[]|undefined,worst=0;
  for(let a=0;a<=1+1e-9;a+=.01){
   // The solver resets the rig before every frame's blend; mirror that here so the
   // wrap is solved from the rest finger pose at each amount.
   rig.reset();blendGrip(rig,'R',a,RACKET_HANDLE);
   const now=names.map(n=>rig.bone(n).quaternion.clone());
   if(prev)now.forEach((q,i)=>{worst=Math.max(worst,q.angleTo(prev![i]));});
   prev=now;
  }
  expect(worst).toBeLessThan(.05);
 });
});

/* worldPointInto (issue #10 PR-C) — the flush-preconditioned world read:
 * setFromMatrixPosition on the ALREADY-flushed tree, with no ancestor
 * re-walk (point()/pointInto pay that walk per call). It lives in this file
 * — the rig-semantics suite — because what is pinned is rig behaviour (the
 * batch deferral window, the stale-read contract, the dev guard), not a
 * solver output. The guard exists in the landed rig.ts, so the throw is
 * asserted, not skipped. */
describe('worldPointInto — post-flush world read (issue #10 PR-C)',()=>{
 it('returns the caller-owned vector equal to point() after a solve',()=>{
  const cleanup=setPose('idle',.5); // solveEffectiveFrame → batch-end flush
  for(const n of ['head','root','wrist_R','foot_L','finger3-3_L']){
   const out=new Vector3();
   expect(rig.worldPointInto(n,out),`${n} returns out`).toBe(out); // out-param, not a fresh vector
   expect(out.distanceTo(rig.point(n)),n).toBeLessThan(1e-12);     // same matrixWorld point() would recompute
  }
  cleanup();
 });
 it('reads the flushed matrixWorld — an unflushed write stays invisible until syncWorld',()=>{
  rig.reset();
  const before=rig.point('head');
  rig.bone('head').position.x+=.05; // raw write below the rig API — no syncWorld, stale tree
  const stale=rig.worldPointInto('head',new Vector3());
  expect(stale.distanceTo(before)).toBeLessThan(1e-12);        // still the OLD matrixWorld
  expect(stale.distanceTo(rig.point('head'))).toBeGreaterThan(.04); // point() self-updates → sees +.05
  rig.syncWorld();
  expect(rig.worldPointInto('head',new Vector3()).distanceTo(rig.point('head'))).toBeLessThan(1e-12);
 });
 it('sees batch-deferred writes after the outermost batch exits',()=>{
  rig.reset();
  expect(rig.batch(()=>42)).toBe(42); // generic passthrough
  rig.batch(()=>{rig.batch(()=>{rig.bone('head').position.x+=.05;});}); // nested: only the outer exit flushes
  const out=rig.worldPointInto('head',new Vector3());
  // Rest pose has identity rotations, so the +.05 local x is a world +.05.
  expect(out.x).toBeCloseTo(rig.rest.get('head')!.x+.05,10);
  expect(out.distanceTo(rig.point('head'))).toBeLessThan(1e-12);
 });
 it('throws inside an open batch where matrixWorld is deliberately stale',()=>{
  expect(()=>rig.batch(()=>rig.worldPointInto('head',new Vector3()))).toThrow(/batch/);
  // Still open inside a NESTED batch — the inner exit only decrements.
  expect(()=>rig.batch(()=>rig.batch(()=>rig.worldPointInto('head',new Vector3())))).toThrow(/batch/);
  // The guard's batch depth unwound through the throws — outside a batch
  // the read works again.
  expect(()=>rig.worldPointInto('head',new Vector3())).not.toThrow();
 });
});
