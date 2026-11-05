import {AmbientLight,Bone,DirectionalLight,Group,HemisphereLight,Mesh,MeshStandardMaterial,Object3D,PlaneGeometry,PerspectiveCamera,Quaternion,Scene,Vector3,WebGLRenderer,SRGBColorSpace,PCFSoftShadowMap} from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {sampleMotion,type ManualMotion,type ManualPose} from './document';

export class ManualEditorEngine{
 private readonly scene=new Scene();
 private readonly camera=new PerspectiveCamera(34,1,.01,100);
 private readonly renderer:WebGLRenderer;
 private readonly controls:OrbitControls;
 private readonly resizeObserver:ResizeObserver;
 private animationFrame=0;
 private disposed=false;
 private avatar?:Group;
 private basePosition=new Vector3();
 private readonly bones=new Map<string,Bone>();
 private readonly restRotations=new Map<string,Bone['quaternion']>();
 private motion?:ManualMotion;
 private time=0;
 private playing=false;
 private lastTick=performance.now();
 private lastReport=0;
 onReady?:(boneNames:string[])=>void;
 onTick?:(time:number,playing:boolean)=>void;
 onError?:(error:Error)=>void;

 constructor(private readonly host:HTMLElement){
  this.renderer=new WebGLRenderer({antialias:true,alpha:false});
  this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.75));
  this.renderer.outputColorSpace=SRGBColorSpace;this.renderer.setClearColor(0x182330,1);
  this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=PCFSoftShadowMap;
  this.renderer.domElement.setAttribute('aria-label','手工姿势编辑画布');this.host.appendChild(this.renderer.domElement);
  this.scene.add(new HemisphereLight(0xe5eff4,0x59636e,2.1));
  const key=new DirectionalLight(0xffedcf,3.2);key.position.set(-3,5,4);key.castShadow=true;key.shadow.mapSize.setScalar(1024);key.shadow.camera.left=-3;key.shadow.camera.right=3;key.shadow.camera.top=3;key.shadow.camera.bottom=-3;key.shadow.normalBias=.015;this.scene.add(key);
  const fill=new DirectionalLight(0xa9d4ef,1.4);fill.position.set(3,2,-3);this.scene.add(fill);
  const floor=new Mesh(new PlaneGeometry(80,80),new MeshStandardMaterial({color:0xc8c7c0,roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.015;floor.receiveShadow=true;this.scene.add(floor);
  this.camera.position.set(0,1.05,3.55);
  this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.target.set(0,.73,0);this.controls.enableDamping=true;this.controls.dampingFactor=.075;this.controls.minDistance=.45;this.controls.maxDistance=7;this.controls.maxPolarAngle=Math.PI*.53;
  this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(host);this.resize();this.animate();
 }

 async load(){
  try{
   const gltf=await new GLTFLoader().loadAsync('/models/chibi-sports-avatar.glb');
   if(this.disposed){this.disposeObject(gltf.scene);return;}
   this.avatar=gltf.scene;this.avatar.rotation.y=-Math.PI/2;this.avatar.scale.setScalar(1.7);this.avatar.updateMatrixWorld(true);this.basePosition.copy(this.avatar.position);
   this.avatar.traverse(object=>{
    if((object as Bone).isBone){const bone=object as Bone;this.bones.set(bone.name,bone);this.restRotations.set(bone.name,bone.quaternion.clone());}
    if(object instanceof Mesh){object.castShadow=true;object.receiveShadow=true;if(object.material instanceof MeshStandardMaterial){object.material.roughness=Math.max(object.material.roughness,.68);object.material.metalness=0;}}
   });
   this.scene.add(this.avatar);this.onReady?.([...this.bones.keys()].sort((a,b)=>a.localeCompare(b)));
   if(this.motion)this.applyPose(sampleMotion(this.motion,this.time));
  }catch(error){this.onError?.(error instanceof Error?error:new Error(String(error)));}
 }

 update(motion:ManualMotion,time:number,playing:boolean){
  this.motion=motion;this.time=Math.max(0,Math.min(motion.duration,time));this.playing=playing;
  if(!playing&&this.avatar)this.applyPose(sampleMotion(motion,this.time));
 }
 seek(time:number){this.time=Math.max(0,Math.min(this.motion?.duration??0,time));if(this.motion&&this.avatar)this.applyPose(sampleMotion(this.motion,this.time));}
 setPlaying(playing:boolean){this.playing=playing;this.lastTick=performance.now();}
 private applyPose(pose:ManualPose){
  if(!this.avatar)return;
  this.avatar.position.copy(this.basePosition).add(new Vector3(...pose.root));
  for(const [name,bone]of this.bones){
   const rest=this.restRotations.get(name);if(!rest)continue;
   const delta=pose.bones[name];
   if(delta)bone.quaternion.copy(rest).multiply(new Quaternion(delta[0],delta[1],delta[2],delta[3]));
   else bone.quaternion.copy(rest);
  }
  this.avatar.updateMatrixWorld(true);
 }
 private animate=()=>{
  if(this.disposed)return;
  const now=performance.now();let dt=Math.min((now-this.lastTick)/1000,.05);this.lastTick=now;
  if(this.playing&&this.motion){
   this.time+=dt;
   if(this.time>this.motion.duration){if(this.motion.loop)this.time%=this.motion.duration;else{this.time=this.motion.duration;this.playing=false;}}
   this.applyPose(sampleMotion(this.motion,this.time));
  }
  this.controls.update();this.renderer.render(this.scene,this.camera);
  if(now-this.lastReport>80){this.lastReport=now;this.onTick?.(this.time,this.playing);}
  this.animationFrame=requestAnimationFrame(this.animate);
 };
 private resize(){const width=this.host.clientWidth,height=this.host.clientHeight;if(!width||!height)return;this.camera.aspect=width/height;this.camera.updateProjectionMatrix();this.renderer.setSize(width,height,false);}
 private disposeObject(root:Object3D){root.traverse(object=>{if(object instanceof Mesh){object.geometry.dispose();const materials=Array.isArray(object.material)?object.material:[object.material];materials.forEach(material=>material.dispose());}});}
 dispose(){this.disposed=true;cancelAnimationFrame(this.animationFrame);this.resizeObserver.disconnect();this.controls.dispose();this.disposeObject(this.scene);this.renderer.dispose();this.renderer.domElement.remove();}
}
