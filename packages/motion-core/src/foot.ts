import {Euler,Quaternion,Vector3} from 'three';
import {DEG} from './kinematics';

export type Side='L'|'R';

/** Foot geometry from the rest rig: the ankle joint and every toe joint,
 * expressed as offsets from the ankle, plus a virtual heel contact point.
 * The heel sits at the rest sole plane, a quarter of forefoot reach behind
 * the ankle; this gives the rig without a heel bone a real rear pivot. */
export interface FootGeometry{side:Side;names:string[];offsets:Vector3[];heelOffset:Vector3;groundY:number}
/** Maximum torso rise during a toe stand; the knees absorb the remaining
 * foot articulation. */
export const MAX_TOE_BODY_RISE_M=.025;
export function footGeometry(rest:ReadonlyMap<string,Vector3>,side:Side):FootGeometry{
  const ankle=rest.get(`foot_${side}`);
  if(!ankle)throw new Error(`rest pose has no foot_${side}`);
  const names=[...rest.keys()].filter(n=>n===`foot_${side}`||(n.startsWith('toe')&&n.endsWith(`_${side}`)));
  const offsets=names.map(n=>rest.get(n)!.clone().sub(ankle));
  const groundY=Math.min(...names.map(n=>rest.get(n)!.y));
  const heelDepth=Math.max(0,...offsets.map(o=>o.z))*.25;
  const heelOffset=new Vector3(0,groundY-ankle.y,-heelDepth);
  return {side,names,offsets,heelOffset,groundY};
}
/** Foot orientation from the pose's pitch/yaw in degrees — same Euler order the solver uses. */
export function footRotation(yaw:number,pitch:number){return new Quaternion().setFromEuler(new Euler(pitch*DEG,yaw*DEG,0,'YXZ'));}
/** Lowest foot point relative to the ankle (metres, negative = below the ankle). */
export function soleOffset(g:FootGeometry,yaw:number,pitch:number){
  const q=footRotation(yaw,pitch);
  return Math.min(g.heelOffset.clone().applyQuaternion(q).y,...g.offsets.map(o=>o.clone().applyQuaternion(q).y));
}
/** Lowest sole point in world space, combining named toe joints with the
 * virtual heel. `lowestNamedY` is measured from the solved rig. */
export function footLowestY(g:FootGeometry,lowestNamedY:number,ankleY:number,worldRotation:Quaternion){
  return Math.min(lowestNamedY,ankleY+g.heelOffset.clone().applyQuaternion(worldRotation).y);
}
/** Vertical body rise for a toe-supported foot. Keep it smooth at flat-foot
 * and saturation boundaries so looping pitch curves do not create root
 * acceleration spikes. Negative pitch is heel support and never raises root. */
export function toeSupportRise(pitch:number){
  if(pitch<=0)return 0;
  const engagement=Math.min(1,pitch/12);
  return MAX_TOE_BODY_RISE_M*engagement*engagement*(3-2*engagement);
}
/** Sole height above the rest-standing sole plane: 0 at rest. This is the
 * quantity the lift handle edits, so the handle and the check measure the
 * same thing (the sole, not the ankle). */
export function footLift(g:FootGeometry,ankleY:number,yaw:number,pitch:number){
  return ankleY+soleOffset(g,yaw,pitch)-g.groundY;
}
/** Ankle height that places the sole `lift` metres above the rest sole plane. */
export function ankleYForLift(g:FootGeometry,lift:number,yaw:number,pitch:number){
  return lift+g.groundY-soleOffset(g,yaw,pitch);
}
/** Depth of the lowest solved foot point below the rest sole plane (0 when clear). */
export function footDepth(g:FootGeometry,lowestY:number){return Math.max(0,g.groundY-lowestY);}
export const FOOT_CLEARANCE_M=.02;
