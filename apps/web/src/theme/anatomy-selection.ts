import {Box3,Matrix4,Raycaster,Sphere,Vector2,Vector3,type Camera,type SkinnedMesh} from 'three';
import {applyAnatomySkin,type AnatomyAtlas,type AnatomySkin,type MuscleRegion} from './anatomy-skin';
import type {SemanticPart,Side} from '@human3d/motion-core';
import './anatomy-selection.css';

type Gesture={x:number;y:number;moved:boolean};
const FOREARM_GROUPS=['Superficial part of anterior compartment of forearm.g','Deep part of anterior compartment of forearm.g','Superficial part of posterior compartment of forearm.g','Deep part of posterior compartment of forearm.g'];
const THIGH_GROUPS=['Anterior compartment of thigh.g','Medial compartment of thigh.g','Posterior compartment of thigh.g','Adductor magnus.l','Adductor magnus.r'];
const LOWER_LEG_GROUPS=['Anterior compartment of leg.g','Lateral compartment of leg.g','Superficial part of posterior compartment of leg.g','Deep part of posterior compartment of leg.g'];
const FOOT_GROUPS=['Muscles of foot.g','Flexor hallucis brevis.g','Adductor hallucis.g'];
const HIP_GROUPS=['Iliopsoas muscle.g','Superficial gluteal muscles.g','Deep gluteal muscles.g',...THIGH_GROUPS];
const PART_GROUPS:Record<SemanticPart,readonly string[]>={
 shoulder:['Deltoid muscle.g','Rotator cuff muscles.g','Scapulohumeral muscles.g','Biceps brachii muscle.g','Anterior compartment of arm.g','Triceps brachii muscle.g','Pectoralis major muscle.g','Trapezius muscle.g'],
 elbow:[],forearm:FOREARM_GROUPS,wrist:FOREARM_GROUPS,hip:HIP_GROUPS,
 legs:[...HIP_GROUPS,...LOWER_LEG_GROUPS,...FOOT_GROUPS],
 knee:[...THIGH_GROUPS,...LOWER_LEG_GROUPS],ankle:[...LOWER_LEG_GROUPS,...FOOT_GROUPS],
 trunk:['Iliocostalis muscles.g','Longissimus muscles.g','Spinalis muscles.g','Splenius muscles.g','Multifidus muscles.g','Semispinalis muscles.g','Rotatores.g','Interspinales muscles.g','Trapezius muscle.g','Hypaxial muscles of back.g','Pectoralis major muscle.g','Levatores costarum.g','Muscles of thorax.g','Thoracic part of muscular system.g','Muscles of abdomen.g','Pelvic diaphragm.g','Levator ani.g','Perineal muscles.g'],
};
const PART_KEYS:Partial<Record<SemanticPart,readonly string[]>>={
 shoulder:['latissimus','serratus_anterior','rhomboid_major','rhomboid_minor','levator_scapulae'],
 elbow:['biceps','brachialis','triceps','anconeus','brachioradialis'],
};
const SIDELESS_PARTS:readonly SemanticPart[]=['legs','trunk'];
const SEMANTIC_HIGHLIGHT_AMOUNT=.58;
/** One shared event path for the lab and workshop. All state is ephemeral:
 * neither pose edits, undo history nor motion documents know about selection. */
export class AnatomySelection{
 private readonly skins:AnatomySkin[]=[];
 private readonly raycaster=new Raycaster();private readonly ndc=new Vector2();
 private readonly inverse=new Matrix4();private readonly box=new Box3();private readonly p=new Vector3();
 private readonly offsets=new Map<SkinnedMesh,number>();
 private readonly pointers=new Map<number,Gesture>();private cursor?:{x:number;y:number};private nextPick=0;
 private hovered?:MuscleRegion;private selected?:MuscleRegion;private active?:MuscleRegion;
 private readonly semanticAmount={value:0};private semanticTarget=0;private semanticMapActive=false;
 private readonly label=document.createElement('div');private readonly text=document.createElement('span');private readonly clear=document.createElement('button');
 private suspended=false;private disposed=false;
 constructor(private readonly host:HTMLElement,private readonly canvas:HTMLCanvasElement,private readonly camera:Camera,private readonly atlas:AnatomyAtlas,private readonly blocked:(event:PointerEvent)=>boolean=()=>false){
  this.label.className='anatomy-selection';this.label.hidden=true;this.label.setAttribute('role','status');this.label.setAttribute('aria-live','polite');
  this.clear.type='button';this.clear.textContent='×';this.clear.setAttribute('aria-label','清除肌肉选择');this.clear.addEventListener('click',this.clearSelection);
  const credit=document.createElement('a');credit.className='anatomy-source';credit.textContent=atlas.metadata.source.name;credit.href=atlas.metadata.source.licenseURL;credit.target='_blank';credit.rel='noopener noreferrer';credit.title=atlas.metadata.source.attribution;
  this.label.append(this.text,credit,this.clear);host.append(this.label);
  canvas.addEventListener('pointerdown',this.down,{capture:true});canvas.addEventListener('pointermove',this.move);
  canvas.addEventListener('pointerleave',this.leave);window.addEventListener('pointerup',this.up);window.addEventListener('pointercancel',this.cancel);
  window.addEventListener('blur',this.blur);
 }
 add(mesh:SkinnedMesh){
  this.skins.push(applyAnatomySkin(mesh,this.atlas,this.semanticAmount));
  // Bound every influenced rest vertex relative to its bone. A conservative
  // posed bound then costs O(bones), rather than skinning all vertices on hover.
  const position=mesh.geometry.getAttribute('position'),si=mesh.geometry.getAttribute('skinIndex'),sw=mesh.geometry.getAttribute('skinWeight');
  let offset=0;const rest=new Vector3();mesh.updateWorldMatrix(true,false);
  for(let i=0;i<position.count;i++)for(let k=0;k<4;k++)if(sw.getComponent(i,k)>0){
   const bone=si.getComponent(i,k);this.p.fromBufferAttribute(position,i).applyMatrix4(mesh.bindMatrix).applyMatrix4(mesh.skeleton.boneInverses[bone]);
   offset=Math.max(offset,this.p.distanceTo(rest));
  }
  this.offsets.set(mesh,offset);
 }
 /** Read-only diagnostics are also used by real-pointer browser acceptance. */
 get state(){return {hovered:this.hovered?.key??null,selected:this.selected?.key??null,active:this.active?.key??null};}
 /** Highlights every visible muscle region belonging to a semantic edit part. */
 setSemanticHighlight(part:SemanticPart,side?:Side){
  const groups=new Set(PART_GROUPS[part]),keys=new Set(PART_KEYS[part]??[]),sideSuffix=SIDELESS_PARTS.includes(part)?undefined:`_${side??'R'}`;
  const ids=this.atlas.metadata.regions.filter(region=>{
   if(sideSuffix&&!region.key.endsWith(sideSuffix))return false;
   const baseKey=region.key.replace(/_[LRC]$/,'');
   return keys.has(baseKey)||region.sourceObjects.some(source=>groups.has(source.group));
  }).map(region=>region.id);
  this.atlas.setHighlightedRegions(ids);this.semanticMapActive=ids.length>0;this.semanticTarget=this.semanticMapActive?SEMANTIC_HIGHLIGHT_AMOUNT:0;
 }
 clearSemanticHighlight(){this.semanticTarget=0;}
 private pick(x:number,y:number){
  const rect=this.canvas.getBoundingClientRect();
  if(!rect.width||!rect.height||x<rect.left||x>rect.right||y<rect.top||y>rect.bottom)return undefined;
  this.ndc.set((x-rect.left)/rect.width*2-1,1-(y-rect.top)/rect.height*2);this.camera.updateWorldMatrix(true,false);this.raycaster.setFromCamera(this.ndc,this.camera);
  const meshes=this.skins.map(s=>s.mesh).filter(mesh=>{
   for(let object=mesh as import('three').Object3D|null;object;object=object.parent)if(!object.visible)return false;
   return true;
  });
  for(const mesh of meshes){
   mesh.updateWorldMatrix(true,false);this.inverse.copy(mesh.matrixWorld).invert();this.box.makeEmpty();let scale=0;
   for(const bone of mesh.skeleton.bones){bone.updateWorldMatrix(true,false);this.p.setFromMatrixPosition(bone.matrixWorld).applyMatrix4(this.inverse);this.box.expandByPoint(this.p);scale=Math.max(scale,new Matrix4().multiplyMatrices(this.inverse,bone.matrixWorld).getMaxScaleOnAxis());}
   this.box.expandByScalar(this.offsets.get(mesh)!*scale);mesh.boundingSphere??=new Sphere();this.box.getBoundingSphere(mesh.boundingSphere);mesh.boundingBox??=new Box3();mesh.boundingBox.copy(this.box);
  }
  const hit=this.raycaster.intersectObjects(meshes,false)[0];return hit?.uv?this.atlas.regionAt(hit.uv):undefined;
 }
 private down=(event:PointerEvent)=>{
  const invalid=event.button!==0||this.suspended||this.blocked(event);
  this.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY,moved:invalid});
  if(this.pointers.size>1)for(const pointer of this.pointers.values())pointer.moved=true;
  this.hovered=undefined;this.updateActive();
 };
 private move=(event:PointerEvent)=>{
  const gesture=this.pointers.get(event.pointerId);
  if(gesture&&Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>6)gesture.moved=true;
  if(event.pointerType==='touch'||this.pointers.size||this.suspended||this.blocked(event)){this.cursor=undefined;this.hovered=undefined;this.updateActive();return;}
  this.cursor={x:event.clientX,y:event.clientY};
 };
 private up=(event:PointerEvent)=>{
  const gesture=this.pointers.get(event.pointerId);this.pointers.delete(event.pointerId);
  if(!gesture||gesture.moved||this.pointers.size||this.suspended||this.blocked(event)||Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>6)return;
  this.selected=this.pick(event.clientX,event.clientY);this.hovered=undefined;this.cursor=undefined;this.updateActive();
 };
 private cancel=(event:PointerEvent)=>{this.pointers.delete(event.pointerId);for(const p of this.pointers.values())p.moved=true;this.leave();};
 private leave=()=>{this.cursor=undefined;this.hovered=undefined;this.updateActive();};
 private blur=()=>{this.pointers.clear();this.leave();};
 private clearSelection=()=>{this.selected=undefined;this.leave();};
 private updateActive(){
  this.active=this.hovered??this.selected;this.label.hidden=this.suspended||!this.active;
  this.text.textContent=this.active?.name??'';this.text.title=this.active?.sourceObjects.map(s=>s.name).join('\n')??'';this.clear.hidden=!this.selected;
  this.label.dataset.muscle=this.active?.key??'';
 }
 /** Capture suppresses both visible colour and incoming gestures, preserving
  * the pinned selection for restoration after the complete capture session. */
 setSuspended(value:boolean){this.suspended=value;this.pointers.clear();this.cursor=undefined;this.hovered=undefined;this.updateActive();if(value){for(const s of this.skins)s.amount.value=0;this.semanticAmount.value=0;}}
 update(dt:number,now=performance.now()){
  if(this.disposed||this.suspended)return;
  if(this.cursor&&!this.pointers.size&&now>=this.nextPick){this.hovered=this.pick(this.cursor.x,this.cursor.y);this.nextPick=now+80;this.updateActive();}
  const semanticBlend=1-Math.exp(-Math.max(0,dt)/.055);
  this.semanticAmount.value+=(this.semanticTarget-this.semanticAmount.value)*semanticBlend;
  if(this.semanticTarget===0&&this.semanticAmount.value<.001){this.semanticAmount.value=0;if(this.semanticMapActive){this.atlas.setHighlightedRegions([]);this.semanticMapActive=false;}}
  for(const skin of this.skins){
   if(this.active&&skin.id.value!==this.active.id){skin.id.value=this.active.id;skin.amount.value=0;}
   skin.amount.value+=((this.active?1:0)-skin.amount.value)*(1-Math.exp(-Math.max(0,dt)/.055));
  }
 }
 dispose(){
  this.disposed=true;this.canvas.removeEventListener('pointerdown',this.down,{capture:true});this.canvas.removeEventListener('pointermove',this.move);this.canvas.removeEventListener('pointerleave',this.leave);
  window.removeEventListener('pointerup',this.up);window.removeEventListener('pointercancel',this.cancel);window.removeEventListener('blur',this.blur);this.clear.removeEventListener('click',this.clearSelection);this.label.remove();this.atlas.dispose();
 }
}
