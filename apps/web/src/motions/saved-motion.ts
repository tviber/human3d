import type {MotionSpec,WorkshopDoc} from '@human3d/motion-core';
import {sortedKeys} from '@human3d/motion-core';

export const SAVED_MOTION_PREFIX='local:';

/** Convert a saved workshop document into the shared lab playback entry. */
export function savedMotionSpec(doc:WorkshopDoc):MotionSpec{
 return {id:SAVED_MOTION_PREFIX+doc.id,name:doc.name,english:'我的动作',duration:doc.duration,description:'在动作工作台中创建并保存的动作，可继续编辑或删除。',method:'工作台关键帧 · 本机保存',focus:['手工编辑'],oneShot:!doc.loop,
  phases:sortedKeys(doc).map(k=>({time:k.time,label:k.label||'关键帧'})),source:{kind:'document',document:doc},
  capabilities:doc.keys.some(k=>k.constraints.grip)?{prop:{kind:'racket',trail:true,handView:true,side:doc.gripSide??'R',...(doc.gripBevel!==undefined?{bevel:doc.gripBevel}:{}),...(doc.gripTilt!==undefined?{gripTilt:doc.gripTilt}:{})}}:undefined};
}
