import type {MotionSpec} from '@human3d/motion-core';
import {SAVED_MOTION_PREFIX} from '../motions/saved-motion';

/** Lab → workshop handoff resolution for the CURRENT motion.
 *
 * Only a motion saved in the local library opens as an editable workshop doc.
 * Bundled examples remain playable in the lab but the workshop starts from a
 * neutral editable document rather than copying a preset.
 *
 * Non-editable BUNDLED motions (dynamics replays, external clips) still carry
 * their id: the workshop explains there why editing is unavailable, so the
 * header nav never drops the context. Imported pose packages are not in the
 * registry — navigating with their id would land on an unknown handoff, so
 * their url stays plain. */

export interface WorkshopEditability{editable:boolean;url:string;reason:string}

const WHY:Partial<Record<NonNullable<MotionSpec['source']>['kind'],string>>={
 dynamics:'此动作来自肌骨正向仿真回放，暂不支持在动作工作台编辑。',
 clip:'此动作是外部剪辑动画，暂不支持在动作工作台编辑。',
 'pose-package':'姿态包是求解后的采样结果，暂不支持在动作工作台编辑。',
};

export const workshopEditability=(spec:MotionSpec):WorkshopEditability=>{
 const source=spec.source,kind=source?.kind;
 if(source?.kind==='document'&&spec.id.startsWith(SAVED_MOTION_PREFIX))
  return {editable:true,url:`/workshop.html?doc=${encodeURIComponent(source.document.id)}`,reason:''};
 if(kind==='document')
  return {editable:false,url:'/workshop.html',reason:'内置动作仅供实验室预览；工作台从空白动作开始创作。'};
 const reason=(kind&&WHY[kind])||'此动作暂不支持在动作工作台编辑。';
 const bundled=(kind==='dynamics'||kind==='clip');
 return {editable:false,url:bundled?`/workshop.html?from=${encodeURIComponent(spec.id)}`:'/workshop.html',reason};
};
