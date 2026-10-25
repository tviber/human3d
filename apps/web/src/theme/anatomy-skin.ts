import {webPlatform, type AppPlatform} from '../platform/platform';
import {Color,DataTexture,MeshStandardMaterial,NearestFilter,NoColorSpace,RGBAFormat,UnsignedByteType,type SkinnedMesh,type Vector2} from 'three';

export interface MuscleRegion{id:number;key:string;name:string;englishName:string;surfaceTexels:number;surfaceExclusion?:string;sourceObjects:{name:string;node:string;group:string}[]}
export interface AnatomyMetadata{version:number;encoding:string;width:number;height:number;regions:MuscleRegion[];source:{name:string;url:string;license:string;licenseURL:string;attribution:string;geometrySHA256:string;conversionCommit:string;muscleComponentCount:number}}
export interface AnatomyAtlas{metadata:AnatomyMetadata;pixels:Uint8Array;texture:DataTexture;regionAt(uv:Vector2):MuscleRegion|undefined;dispose():void}

/** Categorical IDs use nearest sampling and no colour conversion, on both CPU
 * and GPU. R/G encode a 16-bit ID; B feathers the inside of region borders. */
export function createAnatomyAtlas(metadata:AnatomyMetadata,pixels:Uint8Array):AnatomyAtlas{
 const {width,height}=metadata;
 if(metadata.version!==2||metadata.encoding!=='rg16-b-coverage'||width<1||height<1||pixels.length!==width*height*4)throw new Error('肌肉分区资产无效');
 const regions=new Map(metadata.regions.map(r=>[r.id,r]));
 const texture=new DataTexture(pixels,width,height,RGBAFormat,UnsignedByteType);
 texture.colorSpace=NoColorSpace;texture.minFilter=texture.magFilter=NearestFilter;texture.generateMipmaps=false;texture.flipY=false;texture.needsUpdate=true;
 return {metadata,pixels,texture,regionAt(uv){
  if(!Number.isFinite(uv.x)||!Number.isFinite(uv.y))return undefined;
  const x=Math.min(width-1,Math.max(0,Math.floor(uv.x*width))),y=Math.min(height-1,Math.max(0,Math.floor(uv.y*height)));
  const i=(y*width+x)*4;return regions.get(pixels[i]+pixels[i+1]*256);
 },dispose(){texture.dispose();}};
}

export interface DecodedMask{naturalWidth:number;naturalHeight:number;pixels:Uint8Array}
/** Decodes the mask PNG straight to RGBA pixels (R/G = 16-bit id, B = border
 * coverage, same layout `createAnatomyAtlas` consumes). The web decoder wraps
 * <img> + a 2D-canvas readback; hosts without DOM inject their own pixel
 * decoder, keeping this module and the atlas path DOM-free. */
export type MaskImageDecoder=(url:string)=>Promise<DecodedMask>;
export const webMaskImageDecoder:MaskImageDecoder=async url=>{
 const image=await new Promise<HTMLImageElement>((resolve,reject)=>{
  const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('肌肉分区贴图加载失败'));img.src=url;
 });
 const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
 const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)throw new Error('无法读取肌肉分区贴图');
 ctx.drawImage(image,0,0);
 return {naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,pixels:new Uint8Array(ctx.getImageData(0,0,canvas.width,canvas.height).data)};
};

export async function loadAnatomyAtlas(platform:AppPlatform=webPlatform,decoder:MaskImageDecoder=webMaskImageDecoder):Promise<AnatomyAtlas>{
 const [response,decoded]=await Promise.all([platform.fetchAsset('/models/anatomy-regions.json'),decoder(platform.assetUrl('/models/anatomy-mask.png'))]);
 if(!response.ok)throw new Error('肌肉分区定义加载失败');
 const metadata=await response.json() as AnatomyMetadata;
 if(decoded.naturalWidth!==metadata.width||decoded.naturalHeight!==metadata.height)throw new Error('肌肉分区尺寸不一致');
 return createAnatomyAtlas(metadata,decoded.pixels);
}

export interface AnatomySkin{mesh:SkinnedMesh;id:{value:number};amount:{value:number}}
/** Display material only. UVs and authored regions travel with the skin;
 * selection is a uniform, never a mutation of skin weights or motion data. */
export function applyAnatomySkin(mesh:SkinnedMesh,atlas:AnatomyAtlas):AnatomySkin{
 if(!mesh.geometry.getAttribute('uv'))throw new Error('人体模型缺少 UV 坐标');
 const skin:AnatomySkin={mesh,id:{value:0},amount:{value:0}};
 const material=new MeshStandardMaterial({color:0xd8d1c7,roughness:.76,metalness:0});
 const tint=new Color(0xe99580);
 material.onBeforeCompile=shader=>{
  shader.uniforms.anatomyMap={value:atlas.texture};shader.uniforms.anatomyId=skin.id;shader.uniforms.anatomyAmount=skin.amount;shader.uniforms.anatomyTint={value:tint};
  shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 anatomyUv;').replace('#include <uv_vertex>','#include <uv_vertex>\nanatomyUv = uv;');
  shader.fragmentShader=shader.fragmentShader
   .replace('#include <common>','#include <common>\nuniform sampler2D anatomyMap; varying vec2 anatomyUv; uniform float anatomyId;\nuniform float anatomyAmount;\nuniform vec3 anatomyTint;')
   .replace('#include <map_fragment>',`#include <map_fragment>
    vec4 muscle = texture2D(anatomyMap, anatomyUv);
    float regionId = floor(muscle.r * 255.0 + 0.5) + floor(muscle.g * 255.0 + 0.5) * 256.0;
    float selected = (1.0 - step(0.5, abs(regionId - anatomyId))) * step(0.5, anatomyId);
    diffuseColor.rgb = mix(diffuseColor.rgb, anatomyTint, selected * anatomyAmount * muscle.b);`);
 };
 material.customProgramCacheKey=()=>'h3d-anatomy-highlight-v3';
 const old=Array.isArray(mesh.material)?mesh.material:[mesh.material];old.forEach(m=>m.dispose());mesh.material=material;
 return skin;
}
