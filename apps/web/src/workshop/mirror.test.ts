import {describe,it,expect,beforeAll} from 'vitest';
import {RACKET_TIP_LOCAL} from '@human3d/motion-core';
import fs from 'node:fs';
import {Quaternion,Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from '@human3d/motion-core';
import {attachRacket} from '@human3d/motion-core';
import {blankDocument,contactStartKey,defaultDocument,frameAt,isReleaseKey,mirrorDoc,parseDoc,serializeDoc,sortedKeys,validateDocShape,type V3,type WorkshopDoc} from '@human3d/motion-core';
import {solveEffectiveFrame} from '@human3d/motion-core';
import {unwrapMotionFile} from '@human3d/motion-core';
import {mulberry32,randomDoc} from '@human3d/motion-core';
import {HistoryBook} from './history';
import {MotionLibrary} from './library';

/** WP-D 文档镜像 — mirrorDoc is tested against the REAL solve path
 * (frameAt → solveEffectiveFrame), never a re-implementation: a passing
 * assertion here means the mirrored document produces the geometrically
 * mirrored skeleton. Mirror plane x=0; this rig's rest skeleton is bilateral
 * (left = +X, right = −X, mirrored rest positions, identity orientations) —
 * the same M·q·M convention grip-side.test.ts pins.
 *
 * mirrorDoc is an involution on the canonical byte form: every shipped asset,
 * seed and parseDoc output serialises in interface field order, and
 * mirror(mirror(doc)) reproduces those bytes exactly. A hand-assembled doc
 * with scrambled property order still round-trips value-for-value. */

let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);

const origin=()=>rig.rest.get('root')!;
const mirrorName=(n:string)=>n.endsWith('_L')?`${n.slice(0,-2)}_R`:n.endsWith('_R')?`${n.slice(0,-2)}_L`:n;
const mirrorQuat=(q:Quaternion)=>new Quaternion(q.x,-q.y,-q.z,q.w);
const shipDoc=(name:string)=>parseDoc(JSON.stringify(unwrapMotionFile(JSON.parse(fs.readFileSync(`assets/motions/${name}.json`,'utf8')))));

/** Solve one frame and capture every bone's world position + orientation. */
const solved=(doc:WorkshopDoc,t:number)=>{
 solveEffectiveFrame(rig,frameAt(doc,t,origin()));
 const pos=new Map<string,Vector3>(),quat=new Map<string,Quaternion>();
 for(const [n]of rig.bones){
  pos.set(n,rig.point(n));
  quat.set(n,rig.bone(n).getWorldQuaternion(new Quaternion()));
 }
 return {pos,quat};
};

/** The whole-rig mirror assertion: mirrored-doc bone `n` must equal the
 * x-reflection of the source doc's `mirrorName(n)` — positions AND world
 * orientations (so finger winding, palm frames and wrist cones are pinned,
 * not just joint locations). Returns the measured maxima so the report can
 * record real residuals next to the gate. */
const expectMirror=(M:ReturnType<typeof solved>,O:ReturnType<typeof solved>,posTol=1e-9,angTol=1e-6)=>{
 let posMax=0,angMax=0;
 for(const [n,p]of M.pos){
  const op=O.pos.get(mirrorName(n))!;
  const d=p.distanceTo(new Vector3(-op.x,op.y,op.z));
  expect(d,`position ${n}`).toBeLessThan(posTol);posMax=Math.max(posMax,d);
  const a=M.quat.get(n)!.angleTo(mirrorQuat(O.quat.get(mirrorName(n))!));
  expect(a,`orientation ${n}`).toBeLessThan(angTol);angMax=Math.max(angMax,a);
 }
 return {posMax,angMax};
};

/** Uniform sample times across the doc, hitting keys and open intervals. */
const timesOf=(doc:WorkshopDoc)=>{
 const out=new Set<number>([0,doc.duration/3,doc.duration/2,doc.duration*.77,doc.duration]);
 for(const k of doc.keys){out.add(k.time);out.add(Math.min(doc.duration,k.time+.013));}
 return [...out].sort((a,b)=>a-b);
};

describe('mirrorDoc — round-trip involution',()=>{
 const cases:Record<string,()=>WorkshopDoc>={
  default:()=>defaultDocument(rig.rest),
  blank:()=>blankDocument(rig.rest,'t','t'),
  'forehand asset':()=>shipDoc('forehand'),
  'reach asset (clavicleLift)':()=>shipDoc('reach'),
  'idle asset':()=>shipDoc('idle'),
 };
 for(const [name,make]of Object.entries(cases)){
  it(`mirror∘mirror is byte-exact on ${name}`,()=>{
   const doc=make();
   expect(serializeDoc(mirrorDoc(mirrorDoc(doc)))).toBe(serializeDoc(doc));
   // The mirrored document is itself a legal document.
   expect(()=>parseDoc(serializeDoc(mirrorDoc(doc)))).not.toThrow();
   expect(validateDocShape(mirrorDoc(doc))).toEqual([]);
  });
 }
 it('byte-exact on a canonical left-grip document and random docs',()=>{
  const base=JSON.parse(serializeDoc(defaultDocument(rig.rest))) as Record<string,unknown>;
  const {keys,...head}=base;                       // keys is the last field — rebuild in canonical order
  const lDoc=parseDoc(JSON.stringify({...head,gripSide:'L',keys}));
  expect(lDoc.gripSide).toBe('L');
  expect(serializeDoc(mirrorDoc(mirrorDoc(lDoc)))).toBe(serializeDoc(lDoc));
  lDoc.keys[1].interpolation='linear';
  expect(mirrorDoc(lDoc).keys[1].interpolation).toBe('linear');
  expect(serializeDoc(mirrorDoc(mirrorDoc(lDoc)))).toBe(serializeDoc(lDoc));
  for(const seed of [7,42,1234]){
   const d=randomDoc(mulberry32(seed),rig.rest);    // seeded sweep: loops, mixed handFrames, some 'L'
   expect(serializeDoc(mirrorDoc(mirrorDoc(d)))).toBe(serializeDoc(d));
  }
 });
 it('round-trips value-exact even when the input order is scrambled',()=>{
  const doc=defaultDocument(rig.rest);
  const scrambled=parseDoc(JSON.stringify({keys:doc.keys,...(({keys:_k,...rest})=>rest)(doc)}));
  expect(validateDocShape(scrambled)).toEqual([]);
  expect(mirrorDoc(mirrorDoc(scrambled))).toEqual(scrambled);
 });
 it('flips the markers so the copy never shares the source identity',()=>{
  const doc=defaultDocument(rig.rest),m=mirrorDoc(doc);
  expect(m.id).toBe(`${doc.id}.mirrored`);expect(m.name).toContain('镜像');expect(m.english).toContain('MIRRORED');
  expect(m.id).not.toBe(doc.id);expect(m.name).not.toBe(doc.name);
  expect(mirrorDoc(m).id).toBe(doc.id);           // the markers toggle back
  expect(m.gripSide).toBe('L');expect(mirrorDoc(m).gripSide).toBeUndefined();
  for(const [i,k]of m.keys.entries()){
   const o=doc.keys[i];
   expect(k.id).toBe(o.id);expect(k.time).toBe(o.time);expect(k.label).toBe(o.label);expect(k.videoTime).toBe(o.videoTime);
  }
  expect(m.duration).toBe(doc.duration);expect(m.loop).toBe(doc.loop);expect(m.inbetweens).toBe(doc.inbetweens);
 });
 it('keeps each hand in the frame it was authored in (handFrames swaps sides)',()=>{
  const doc=blankDocument(rig.rest,'t','t');
  doc.handFrames={L:'world',R:'pelvis'};
  const m=mirrorDoc(doc);
  expect(m.handFrames).toEqual({L:'pelvis',R:'world'});
  expect(serializeDoc(mirrorDoc(m))).toBe(serializeDoc(doc));
 });
 it('mirrors every geometric field key-by-key',()=>{
  const doc=shipDoc('forehand'),m=mirrorDoc(doc);
  const mv=(v:V3)=>({x:-v.x,y:v.y,z:v.z});
  for(const [i,k]of m.keys.entries()){
   const o=doc.keys[i];
   expect(k.pose.root).toEqual(mv(o.pose.root));
   expect(k.pose.yaw).toBe(-o.pose.yaw);expect(k.pose.lean).toBe(o.pose.lean);
   expect(k.pose.chest).toBe(-o.pose.chest);expect(k.pose.side).toBe(-o.pose.side);
   for(const [ms,os]of [['handL','handR'],['handR','handL']]as const)
    for(const f of ['target','pole','forward','normal']as const)expect(k.pose[ms][f]).toEqual(mv(o.pose[os][f]));
   for(const [ms,os]of [['footL','footR'],['footR','footL']]as const){
    expect(k.pose[ms].target).toEqual(mv(o.pose[os].target));expect(k.pose[ms].pole).toEqual(mv(o.pose[os].pole));
    expect(k.pose[ms].yaw).toBe(-o.pose[os].yaw);expect(k.pose[ms].pitch).toBe(o.pose[os].pitch);
   }
   expect(k.constraints.plantL).toBe(o.constraints.plantR);expect(k.constraints.plantR).toBe(o.constraints.plantL);
   expect(k.constraints.grip).toBe(o.constraints.grip);expect(k.constraints.contact).toBe(o.constraints.contact);
  }
 });
 it('preserves racket grip bevel/tilt and swaps handSpread sides',()=>{
  const base=shipDoc('forehand');base.gripBevel=6;base.gripTilt=23;
  // Asymmetric, with an explicit relaxed R — the mirror carries it as data
  // (only normalizeDoc folds). The byte-exact involution is pinned on
  // mirrorDoc's own output: a mutated doc has gripBevel after `keys`, while
  // mirrorDoc emits it before, so mirror∘mirror reproduces mirrorDoc's
  // canonical placement, not the mutation order.
  base.keys[0].pose.handSpread={L:.2,R:.5};
  base.keys[1].pose.handSpread={R:.8};
  const m=mirrorDoc(base);
  expect(m.gripBevel).toBe(6);                       // same number = same grip
  expect(m.gripTilt).toBe(23);                       // same local X angle on mirrored grip
  expect(m.keys[0].pose.handSpread).toEqual({L:.5,R:.2});
  expect(m.keys[1].pose.handSpread).toEqual({L:.8});
  expect(serializeDoc(mirrorDoc(mirrorDoc(m)))).toBe(serializeDoc(m));
  expect(validateDocShape(parseDoc(JSON.stringify(m)))).toEqual([]);
 });
});

describe('mirrorDoc — mirrored solve',()=>{
 /** Solve the mirrored and source docs through the real pipeline at every
  * sample time and require a whole-rig x-mirror. */
 const solveBoth=(doc:WorkshopDoc)=>{
  const m=mirrorDoc(doc),worst={posMax:0,angMax:0};
  for(const inbetweens of [true,false]){
   const d:WorkshopDoc={...doc,inbetweens},dm:WorkshopDoc={...m,inbetweens};
   for(const t of timesOf(d)){
    const O=solved(d,t),M=solved(dm,t);
    const r=expectMirror(M,O);worst.posMax=Math.max(worst.posMax,r.posMax);worst.angMax=Math.max(worst.angMax,r.angMax);
   }
  }
  return worst;
 };
 it('mirrors the shipped forehand (dense, asymmetric, contact key)',()=>{
  const w=solveBoth(shipDoc('forehand'));
  console.log(`forehand mirror residuals: pos ${w.posMax.toExponential(2)} m, ang ${w.angMax.toExponential(2)} rad`);
 });
 it('mirrors the seeded five-key document',()=>{
  const w=solveBoth(defaultDocument(rig.rest));
  console.log(`defaultDoc mirror residuals: pos ${w.posMax.toExponential(2)} m, ang ${w.angMax.toExponential(2)} rad`);
 });
 it('mirrors a left-grip document back onto the right side',()=>{
  const doc=defaultDocument(rig.rest);
  const raw=JSON.parse(serializeDoc(doc)) as Record<string,unknown>;
  const {keys,...head}=raw;
  const lDoc=parseDoc(JSON.stringify({...head,gripSide:'L',keys}));
  const w=solveBoth(lDoc);
  console.log(`left-grip mirror residuals: pos ${w.posMax.toExponential(2)} m, ang ${w.angMax.toExponential(2)} rad`);
 });
 it('mirrors asymmetric handFrames docs (frame follows the hand)',()=>{
  const doc=defaultDocument(rig.rest);
  doc.handFrames={L:'world',R:'pelvis'};
  const w=solveBoth(doc);
  console.log(`mixed-frame mirror residuals: pos ${w.posMax.toExponential(2)} m, ang ${w.angMax.toExponential(2)} rad`);
 });
 it('mirrors random documents end-to-end',()=>{
  for(const seed of [11,222]){
   const w=solveBoth(randomDoc(mulberry32(seed),rig.rest));
   console.log(`randomDoc(${seed}) mirror residuals: pos ${w.posMax.toExponential(2)} m, ang ${w.angMax.toExponential(2)} rad`);
  }
 });
});

describe('mirrorDoc — contact intervals',()=>{
 /** A doc with a real release: left foot lifts mid-run while the right stays
  * planted, so the mirrored doc must hold the RIGHT contact over the same
  * times and swing the mirrored left foot. */
 const releaseDoc=()=>{
  const doc=blankDocument(rig.rest,'释放','rel');
  const k:WorkshopDoc['keys'][number]=JSON.parse(JSON.stringify(doc.keys[0]));
  k.id='k-mid';k.time=.5;k.constraints={...k.constraints,plantL:false};
  k.pose.footL.target={x:.25,y:.35,z:.3};k.pose.footL.yaw=20;
  doc.keys.splice(1,0,k);
  return doc;
 };
 it('keeps interval timing and mirrors the held contact point',()=>{
  const doc=releaseDoc(),m=mirrorDoc(doc);
  const ks=sortedKeys(doc),mk=sortedKeys(m);
  expect(mk.map(k=>k.time)).toEqual(ks.map(k=>k.time));
  expect(mk.map(k=>[k.constraints.plantL,k.constraints.plantR])).toEqual(ks.map(k=>[k.constraints.plantR,k.constraints.plantL]));
  // Source: LEFT foot is released at .5 → its contact owner is key 0.
  const cs=contactStartKey(doc,'L',.25)!,cm=contactStartKey(m,'R',.25)!;
  expect(cm.time).toBe(cs.time);
  expect(cm.pose.footR.target).toEqual({x:-cs.pose.footL.target.x,y:cs.pose.footL.target.y,z:cs.pose.footL.target.z});
  expect(cm.pose.footR.yaw).toBe(-cs.pose.footL.yaw);expect(cm.pose.footR.pitch).toBe(cs.pose.footL.pitch);
  // Release flags swap sides at the same indices.
  expect(isReleaseKey(doc,1,'L')).toBe(true);expect(isReleaseKey(m,1,'R')).toBe(true);
  expect(isReleaseKey(doc,1,'R')).toBe(false);expect(isReleaseKey(m,1,'L')).toBe(false);
 });
 it('the solved mid-swing foot and held contact are x-mirrors',()=>{
  const doc=releaseDoc(),m=mirrorDoc(doc);
  for(const t of [.1,.3,.5,.75,1]){
   const O=solved(doc,t),M=solved(m,t);
   expectMirror(M,O,1e-8,1e-5);
   // Held contact: mirrored doc's right foot sits at the mirror of the
   // source's left contact throughout the interval.
   expect(M.pos.get('foot_R')!.distanceTo(new Vector3(-O.pos.get('foot_L')!.x,O.pos.get('foot_L')!.y,O.pos.get('foot_L')!.z))).toBeLessThan(1e-8);
  }
 });
});

describe('mirrorDoc — grip side and parse boundary',()=>{
 it('moves the racket to the other wrist with the mirrored mount',()=>{
  const doc=shipDoc('forehand'),m=mirrorDoc(doc);
  expect(m.gripSide).toBe('L');
  const rR=attachRacket(rig,'R'),rL=attachRacket(rig,'L');
  const world=(racket:typeof rR)=>({o:racket.getWorldPosition(new Vector3()),tip:racket.localToWorld(RACKET_TIP_LOCAL.clone()),q:racket.getWorldQuaternion(new Quaternion())});
  solved(doc,.5);const R=world(rR);
  solved(m,.5);const L=world(rL);
  expect(rL.parent?.name).toBe('wrist_L');
  for(const k of ['o','tip']as const)expect(L[k].distanceTo(new Vector3(-R[k].x,R[k].y,R[k].z))).toBeLessThan(1e-8);
  expect(L.q.angleTo(mirrorQuat(R.q))).toBeLessThan(1e-6);
  rR.removeFromParent();rL.removeFromParent();
 });
 it('mirrored output stays parseable; malformed input stays rejected',()=>{
  // Every real document's mirror must pass the same boundary validator.
  for(const doc of [defaultDocument(rig.rest),shipDoc('forehand'),shipDoc('reach'),randomDoc(mulberry32(9),rig.rest)]){
   expect(validateDocShape(mirrorDoc(doc))).toEqual([]);
   expect(()=>parseDoc(serializeDoc(mirrorDoc(doc)))).not.toThrow();
  }
  // A degenerate direction frame stays degenerate after mirroring (x→−x
  // preserves zero and near-parallel exactly), so the validator still
  // catches it instead of the transform producing a silently new defect.
  const bad=blankDocument(rig.rest,'bad','bad');
  bad.keys[0].pose.handR.forward={x:0,y:0,z:0};
  const errs0=validateDocShape(bad);
  expect(errs0.some(e=>e.includes('forward'))).toBe(true);
  const errsM=validateDocShape(mirrorDoc(bad));
  expect(errsM.some(e=>e.includes('forward'))).toBe(true);
  expect(()=>parseDoc(serializeDoc(mirrorDoc(bad)))).toThrow();
  // A stretched-but-legal document stays legal: extreme yaw/pitch values
  // mirror without pushing the shape validator over any edge.
  const edge=blankDocument(rig.rest,'edge','edge');
  for(const k of edge.keys){k.pose.yaw=179;k.pose.lean=-45;k.pose.chest=88;k.pose.side=-29;k.pose.footL.pitch=38;k.pose.footR.yaw=-89;}
  expect(validateDocShape(mirrorDoc(edge))).toEqual([]);
 });
 it('one undo step on the mirrored doc restores the source (cross-document book)',()=>{
  // The exact call sequence WorkshopApp performs: the mirrored doc's book is
  // seeded with the source snapshot, undo pops it and the app deposits the
  // forward step on the restored doc's book (redo stays symmetric).
  const src=defaultDocument(rig.rest),m=mirrorDoc(src),books=new HistoryBook();
  books.of(m.id).record(src);
  const back=books.of(m.id).undo(m)!;
  /* undo re-parses through normalizeDoc, which re-canonicalizes hand frames —
   * the restored doc equals the source's normalized form (the same thing any
   * same-document undo would land on), not the live object's raw bytes. */
  expect(back.id).toBe(src.id);expect(serializeDoc(back)).toBe(serializeDoc(parseDoc(serializeDoc(src))));
  books.of(back.id).pushFuture(m);              // app: undo's cross-id deposit
  const fwd=books.of(back.id).redo(back)!;
  expect(fwd.id).toBe(m.id);expect(serializeDoc(fwd)).toBe(serializeDoc(parseDoc(serializeDoc(m))));
  books.of(fwd.id).pushPast(back);              // app: redo's cross-id deposit
  const back2=books.of(fwd.id).undo(fwd)!;
  expect(back2.id).toBe(src.id);
 });
});

describe('mirrorDoc — cross-document undo is pointer semantics',()=>{
 /* Replays WorkshopApp's undo()/redo() call order verbatim against a REAL
  * MotionLibrary + HistoryBook (same paradigm as the book-level test above,
  * extended to the app branch decisions — keep this replay in lockstep with
  * WorkshopApp.tsx undo()/redo()). The pinned contract: a history
  * step restoring a DIFFERENT id only moves the selection — the snapshot's
  * content is never written back under a foreign id. The pre-fix applyDoc
  * overwrote the library doc wholesale, so a post-mirror edit on the source
  * was silently erased by undoing the mirror. */
 const appUndo=(l:MotionLibrary,books:HistoryBook)=>{
  const cur=l.active(),prev=books.of(cur.id).undo(cur);
  if(!prev)return 'empty';
  if(prev.id!==cur.id){
   if(!l.docs.some(x=>x.id===prev.id))return 'hint';
   books.of(prev.id).pushFuture(cur);l.select(prev.id);return 'switch';
  }
  const i=l.docs.findIndex(x=>x.id===prev.id);if(i<0)return 'hint';
  l.docs[i]=prev;l.save();return 'apply';
 };
 const appRedo=(l:MotionLibrary,books:HistoryBook)=>{
  const cur=l.active(),next=books.of(cur.id).redo(cur);
  if(!next)return 'empty';
  if(next.id!==cur.id){
   if(!l.docs.some(x=>x.id===next.id))return 'hint';
   books.of(next.id).pushPast(cur);l.select(next.id);return 'switch';
  }
  const i=l.docs.findIndex(x=>x.id===next.id);if(i<0)return 'hint';
  l.docs[i]=next;l.save();return 'apply';
 };
 it('undo/redo across ids switch selection only — newer edits survive',()=>{
  const l=new MotionLibrary(rig.rest).load(),books=new HistoryBook();
  l.onRemoved=id=>books.drop(id);               // the app's wiring
  const A=l.active();
  const B=l.add(mirrorDoc(A));                  // app: mirrorActiveDoc — B enters selected
  books.of(B.id).record(A);                     // app seeds the source snapshot on B's book
  // The user then goes BACK to A and edits — after B's snapshot was taken.
  l.select(A.id);
  books.of(A.id).record(A);                     // recordBefore (different doc → always records)
  A.keys[0].pose.lean=31;A.name='改过的A';
  const aAfter=serializeDoc(A);
  // Select B, press undo: pops the stale A snapshot. The pre-fix applyDoc
  // would have overwritten the library's A (erasing the lean/name edit);
  // the contract is selection-only, so the library keeps A's new content.
  l.select(B.id);
  expect(appUndo(l,books)).toBe('switch');
  expect(l.active().id).toBe(A.id);
  expect(serializeDoc(l.docs.find(d=>d.id===A.id)!)).toBe(aAfter);
  // Symmetric redo: A's book future now holds the B snapshot deposited by
  // the undo. Editing B in between makes that snapshot stale — redo must
  // still only select B, not write the stale bytes over it.
  l.select(B.id);books.of(B.id).record(B);B.keys[0].pose.lean=7;B.name='改过的B';
  const bAfter=serializeDoc(B);
  l.select(A.id);
  expect(appRedo(l,books)).toBe('switch');
  expect(l.active().id).toBe(B.id);
  expect(serializeDoc(l.docs.find(d=>d.id===B.id)!)).toBe(bAfter);
 });
 it('a cross-document step to a deleted doc takes the hint path — no resurrection',()=>{
  const l=new MotionLibrary(rig.rest).load(),books=new HistoryBook();
  l.onRemoved=id=>books.drop(id);
  const A=l.active(),B=l.add(mirrorDoc(A));
  books.of(B.id).record(A);                     // seeded source snapshot survives on B's book
  l.remove(A.id);                               // delete drops A's OWN book, not B's snapshot
  expect(l.docs.some(d=>d.id===A.id)).toBe(false);
  // Undo on B pops the stale A snapshot; the id no longer names a library
  // document, so the app branch is the hint — no write, no crash, B stays.
  expect(appUndo(l,books)).toBe('hint');
  expect(l.active().id).toBe(B.id);
  expect(l.docs.some(d=>d.id===A.id)).toBe(false);
  expect(books.of(B.id).canUndo()).toBe(false); // the step was consumed once
 });
});
