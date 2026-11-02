import {DoubleSide,Group,Matrix4,Mesh,MeshStandardMaterial,SkinnedMesh,SphereGeometry,SRGBColorSpace,TextureLoader,Vector3,type Object3D,type Texture} from 'three';
import {GLTFLoader,type GLTF} from 'three/addons/loaders/GLTFLoader.js';
import {webPlatform,type AppPlatform} from '../platform/platform';
import type {HairLock} from './hair-cards';
import {HairSpring} from './hair-spring';

export type SkinId='default'|'ssj';

/** Colour the original surface under the scene lights, retaining its muscle-mask shader. */
function skinMaterial(map:Texture,source?:MeshStandardMaterial){
 const material=source?.clone()??new MeshStandardMaterial();
 material.map=map;material.color.set(0xffffff);material.roughness=.88;material.metalness=0;
 if(source){material.onBeforeCompile=source.onBeforeCompile;material.customProgramCacheKey=()=>source.customProgramCacheKey();}
 return material;
}

/** Load the generated head-local card asset and restore Three's custom flex attribute. */
function makeHair(root:Object3D,asset:GLTF){
 const head=root.getObjectByName('head');if(!head)throw new Error('人体模型缺少头骨');
 let source:Mesh|undefined;asset.scene.traverse(object=>{if(!source&&object instanceof Mesh)source=object;});
 if(!source)throw new Error('超赛发型 GLB 缺少发片网格');
 const metadata=source.userData as {hairLocks?:{root:number[];tip:number[]}[];hairCollider?:number[]};
 if(!metadata.hairLocks?.length||metadata.hairCollider?.length!==16||metadata.hairLocks.some(lock=>lock.root?.length!==3||lock.tip?.length!==3))throw new Error('超赛发型 GLB 缺少弹簧骨骼元数据');
 const geometry=source.geometry.clone(),flex=geometry.getAttribute('_hairflex')??geometry.getAttribute('hairFlex');
 const position=geometry.getAttribute('position');
 if(!flex||!position||flex.count!==position.count)throw new Error('超赛发型 GLB 缺少发片弹性数据');
 for(let i=0;i<flex.count;i++){
  const id=flex.getX(i),weight=flex.getY(i);
  if(!Number.isInteger(id)||id<0||id>=metadata.hairLocks.length||!Number.isFinite(weight)||weight<0||weight>1)throw new Error('超赛发型 GLB 含有无效的弹性数据');
 }
 geometry.setAttribute('hairFlex',flex);geometry.deleteAttribute('_hairflex');
 const locks:HairLock[]=metadata.hairLocks.map(lock=>({root:new Vector3().fromArray(lock.root),tip:new Vector3().fromArray(lock.tip)}));
 const collider=new Matrix4().fromArray(metadata.hairCollider);
 geometry.computeBoundingBox();geometry.computeBoundingSphere();
 const hair=new Group();hair.name='ssj-hair';
 const material=new MeshStandardMaterial({color:0xf3c647,roughness:.76,metalness:0,vertexColors:true,side:DoubleSide});
 const mesh=new Mesh(geometry,material);mesh.name='ssj-hair-cards';mesh.castShadow=true;mesh.frustumCulled=false;hair.add(mesh);head.add(hair);return {hair,physics:new HairSpring(geometry,locks,collider)};
}

/** Project the generated face detail onto eyeballs in the same rest-space registration. */
function makeEyes(root:Object3D,texture:Texture,bindPose:Map<string,Matrix4>){
 return ['L','R'].map(side=>{
  const bone=root.getObjectByName(`eye_${side}`);if(!bone)throw new Error('人体模型缺少眼骨');
  const geometry=new SphereGeometry(.0106,24,16),position=geometry.getAttribute('position'),uv=geometry.getAttribute('uv');
  const local=bindPose.get(`eye_${side}`)!;
  for(let i=0;i<position.count;i++){
   const p=new Vector3().fromBufferAttribute(position,i).applyMatrix4(local);
   uv.setXY(i,(p.x+.07)/.14,(1.71-p.y)/.08);
  }
  const eye=new Mesh(geometry,skinMaterial(texture));bone.add(eye);return eye;
 });
}

/** Replaces surface materials only; the original body geometry and rig stay in use. */
export class SkinSwap{
 private readonly entries:{mesh:SkinnedMesh;original:MeshStandardMaterial;replacement?:MeshStandardMaterial}[]=[];
 private readonly bindPose=new Map<string,Matrix4>();
 private assets?:Promise<Texture[]>;private hairAsset?:Promise<GLTF>;private textures?:Texture[];private hair?:Group;private eyes:Mesh[]=[];private originalEyes:Mesh[]=[];
 private hairPhysics?:HairSpring;
 private requested:SkinId='default';private active:SkinId='default';private surface=true;private disposed=false;
 constructor(private readonly root:Object3D,private platform:AppPlatform=webPlatform){
  root.updateWorldMatrix(true,true);
  const toRoot=new Matrix4().copy(root.matrixWorld).invert();
  for(const name of ['head','eye_L','eye_R']){
   const bone=root.getObjectByName(name);if(!bone)throw new Error(`人体模型缺少骨骼 ${name}`);
   this.bindPose.set(name,new Matrix4().multiplyMatrices(toRoot,bone.matrixWorld));
  }
  root.traverse(o=>{if(o instanceof Mesh&&o.name==='human-eye')this.originalEyes.push(o);if(o instanceof SkinnedMesh){
   if(!o.geometry.getAttribute('uv')||!(o.material instanceof MeshStandardMaterial))throw new Error('人体蒙皮材质或 UV 不受支持');
   this.entries.push({mesh:o,original:o.material});
  }});
  if(!this.entries.length)throw new Error('人体模型缺少蒙皮');
 }
 get skin(){return this.active;}
 async set(skin:SkinId){
  if(this.disposed)return;
  this.requested=skin;
  if(skin==='ssj'){
   const texturesPromise=this.assets??=this.load();
   const hairPromise=this.hair?Promise.resolve<GLTF|undefined>(undefined):this.hairAsset??=this.loadHair();
   const [textures,hairAsset]=await Promise.all([texturesPromise,hairPromise]);
   if(this.disposed||this.requested!==skin)return;
   for(const entry of this.entries)if(!entry.replacement){
    entry.replacement=skinMaterial(textures[0],entry.original);
   }
   if(!this.hair){
    if(!hairAsset)throw new Error('超赛发型模型尚未加载');
    const created=makeHair(this.root,hairAsset);this.hair=created.hair;this.hairPhysics=created.physics;this.hairAsset=undefined;
   }
   if(!this.eyes.length)this.eyes=makeEyes(this.root,textures[1],this.bindPose);
  }
  for(const entry of this.entries)entry.mesh.material=skin==='ssj'?entry.replacement!:entry.original;
  this.active=skin;this.setSurfaceVisible(this.surface);this.resetHair();
 }
 update(dt:number){if(this.hair?.visible&&this.root.visible){this.hair.updateWorldMatrix(true,false);this.hairPhysics?.update(dt,this.hair.matrixWorld);}}
 resetHair(){if(this.hair){this.hair.updateWorldMatrix(true,false);this.hairPhysics?.reset(this.hair.matrixWorld);}}
 settleHair(){if(this.hair?.visible){this.hair.updateWorldMatrix(true,false);this.hairPhysics?.settle(this.hair.matrixWorld);}}
 private async load(){
  const loader=new TextureLoader();
  const results=await Promise.allSettled(['/models/skins/ssj-body.png','/models/skins/ssj-eyes.png'].map(path=>loader.loadAsync(this.platform.assetUrl(path))));
  const textures=results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
  if(results.some(r=>r.status==='rejected')){
   textures.forEach(t=>t.dispose());this.assets=undefined;throw new Error('超赛贴图加载失败，请重试');
  }
  for(const texture of textures){texture.colorSpace=SRGBColorSpace;texture.flipY=false;texture.anisotropy=4;}
  this.textures=textures;
  if(this.disposed){textures.forEach(t=>t.dispose());this.textures=undefined;}
  return textures;
 }
 private async loadHair(){
  try{return await new GLTFLoader().loadAsync(this.platform.assetUrl('/models/skins/ssj-hair.glb'));}
  catch{this.hairAsset=undefined;throw new Error('超赛发型模型加载失败，请重试');}
 }
 setSurfaceVisible(visible:boolean){
  const wasVisible=this.hair?.visible;
  this.surface=visible;const dressed=this.active==='ssj';
  if(this.hair)this.hair.visible=dressed&&visible;
  this.eyes.forEach(eye=>{eye.visible=dressed&&visible;});this.originalEyes.forEach(eye=>{eye.visible=!dressed&&visible;});
  if(this.hair?.visible&&!wasVisible)this.resetHair();
 }
 dispose(){
  if(this.disposed)return;this.disposed=true;
  for(const entry of this.entries){entry.mesh.material=entry.original;entry.replacement?.dispose();}
  this.hair?.traverse(o=>{if(o instanceof Mesh){o.geometry.dispose();(o.material as MeshStandardMaterial).dispose();}});this.hair?.removeFromParent();
  this.eyes.forEach(eye=>{eye.removeFromParent();eye.geometry.dispose();(eye.material as MeshStandardMaterial).dispose();});
  this.originalEyes.forEach(eye=>{eye.visible=true;});this.textures?.forEach(t=>t.dispose());
  this.textures=undefined;this.assets=undefined;this.hairAsset=undefined;
 }
}
