import {describe,it,expect,beforeAll} from 'vitest';
import fs from 'node:fs';
import {Quaternion,Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from './rig';
import {blankDocument,frameAt,type WorkshopDoc,type WorkshopKey} from './document';
import {boundLegTurnForClearance,rotateLegAbout,solveEffectiveFrame} from './solver';
import {measureSemantic} from './semantic-edit';
import {angleAt,DEG} from './kinematics';
import {FOOT_CLEARANCE_M,footGeometry,footLift} from './foot';

/** Rigid leg-FK encoding (issue #37): the knee handle's free-leg drag and the
 * semantic panel's hip/knee edits share rotateLegAbout. These tests run the
 * real path — solve, encode, re-solve through frameAt — and report the three
 * residuals separately: knee flexion (exact by construction), ankle flexion
 * and foot orientation (bounded by the yaw·pitch roll-drop). */
let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);

const origin=()=>rig.rest.get('root')!;
const kneeAngle=()=>angleAt(rig.point('upperleg01_L'),rig.point('lowerleg01_L'),rig.point('foot_L'));
/** Solve the document at t=0 so the live rig matches the edited key. */
const solve=(doc:WorkshopDoc)=>{solveEffectiveFrame(rig,frameAt(doc,0,origin()));};
const setup=()=>{
 const doc=blankDocument(rig.rest,'t','leg-rotate');
 const k=doc.keys[0];
 k.constraints.plantL=false;k.constraints.plantR=false;
 solve(doc);
 return {doc,k};
};

describe('rotateLegAbout',()=>{
 it('moves ankle target and pole rigidly about the pivot',()=>{
  const {k}=setup(),p=k.pose;
  const hip=rig.point('upperleg01_L'),ankle=rig.point('foot_L'),pole=new Vector3(p.footL.pole.x,p.footL.pole.y,p.footL.pole.z);
  const turn=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.3);
  rotateLegAbout(rig,p,'L',hip,turn);
  const wantAnkle=ankle.clone().sub(hip).applyQuaternion(turn).add(hip);
  const wantPole=pole.clone().sub(hip).applyQuaternion(turn).add(hip);
  expect(p.footL.target).toEqual({x:expect.closeTo(wantAnkle.x,9),y:expect.closeTo(wantAnkle.y,9),z:expect.closeTo(wantAnkle.z,9)});
  expect(p.footL.pole).toEqual({x:expect.closeTo(wantPole.x,9),y:expect.closeTo(wantPole.y,9),z:expect.closeTo(wantPole.z,9)});
 });
 it('keeps knee flexion exact and bounds ankle/foot-orientation drift',()=>{
  const {doc,k}=setup(),p=k.pose;
  const hip=rig.point('upperleg01_L');
  const knee0=kneeAngle(),dorsi0=measureSemantic(rig,'ankle','flexion','L');
  const footQ0=rig.bone('foot_L').getWorldQuaternion(new Quaternion());
  /* A general off-axis turn — the direction a knee drag actually produces.
   * The yaw·pitch re-encode drops the turn's roll component, so "joint
   * angles unchanged" is approximate below the pivot; measure each channel
   * separately instead of asserting the invariant wholesale. */
  const turn=new Quaternion().setFromUnitVectors(new Vector3(0,-1,0),new Vector3(.45,-1,.35).normalize());
  rotateLegAbout(rig,p,'L',hip,turn);
  solve(doc);
  const knee1=kneeAngle(),dorsi1=measureSemantic(rig,'ankle','flexion','L');
  const residualDeg=footQ0.premultiply(turn).angleTo(rig.bone('foot_L').getWorldQuaternion(new Quaternion()))/DEG;
  expect(Math.abs(knee1-knee0)).toBeLessThan(.01); // rigid FK: exact
  expect(Math.abs(dorsi1-dorsi0)).toBeLessThan(6); // roll-drop drift, measured bound
  /* ~22° measured on this ~28° off-axis turn: the yaw·pitch storage cannot
   * hold the turn's roll, so the foot-frame residual is real, not zero —
   * the same trade-off the semantic editor's legFK always made. Pin the
   * bound so a regression that makes it worse is caught. */
  expect(residualDeg).toBeLessThan(25);
 });
});

describe('boundLegTurnForClearance',()=>{
 const raisedFoot=(doc:WorkshopDoc,k:WorkshopKey)=>{
  // A raised, nearly extended leg: rotating the offset toward straight-down
  // pitches the toes under the sole plane — the burial the bound exists for.
  k.pose.footL.target={x:.1,y:.45,z:.7};solve(doc);
  const hip=rig.point('upperleg01_L'),dir=rig.point(`foot_L`).sub(hip).normalize();
  return {hip,turn:new Quaternion().setFromUnitVectors(dir,new Vector3(0,-1,0))};
 };
 it('returns the requested turn when the sole stays clear',()=>{
  const {doc,k}=setup();
  const {hip}=raisedFoot(doc,k),geo=footGeometry(rig.rest,'L');
  // Swinging the raised leg further up keeps the sole clear by construction.
  const dir=rig.point(`foot_L`).sub(hip).normalize();
  const up=new Quaternion().setFromUnitVectors(dir,new Vector3(.4,1,.2).normalize());
  const out=boundLegTurnForClearance(rig,k.pose,'L',hip,up,geo);
  expect(out.angleTo(up)).toBeLessThan(1e-9);
 });
 it('clamps a foot-burying turn at the contact band',()=>{
  const {doc,k}=setup(),p=k.pose,geo=footGeometry(rig.rest,'L');
  const {hip,turn}=raisedFoot(doc,k);
  const probe={...p,footL:{...p.footL}};rotateLegAbout(rig,probe,'L',hip,turn);
  const unbounded=footLift(geo,probe.footL.target.y,probe.footL.yaw,probe.footL.pitch);
  expect(unbounded).toBeLessThan(-FOOT_CLEARANCE_M); // premise: this turn buries past the band
  const bounded=boundLegTurnForClearance(rig,p,'L',hip,turn,geo);
  rotateLegAbout(rig,p,'L',hip,bounded);
  /* The clamp stops at the analyzer's contact band (−FOOT_CLEARANCE_M), not
   * at an exact-0 floor: a grounded foot may tilt into the band like a real
   * foot rolling on its edge, while anything deeper is still refused. */
  expect(footLift(geo,p.footL.target.y,p.footL.yaw,p.footL.pitch)).toBeGreaterThanOrEqual(-FOOT_CLEARANCE_M-1e-6);
  // The bound is a real clamp: strictly between identity and the request.
  expect(bounded.angleTo(new Quaternion())).toBeGreaterThan(1e-6);
  expect(bounded.angleTo(turn)).toBeGreaterThan(1e-6);
 });
});
