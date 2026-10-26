import type {Group,Vector3} from 'three';
import type {HumanRig} from '../rig';
import type {HandleGrip} from '../grip';

import {attachRacket,RACKET_HANDLE,RACKET_TIP_LOCAL} from './racket';

/** Held-prop registry. A prop is a plugin the hand can hold: it owns its
 * geometry, the handle the fingers wrap (`handle`), the point the solver
 * measures as its tip (`tipLocal`, prop-local metres) and how it mounts on a
 * wrist (`attach`). The rig, solver and hand-wrap code only see this
 * descriptor, so adding a prop means adding an entry here. */
export type PropKind='racket';
export interface PropDescriptor{
 kind:PropKind;
 handle:HandleGrip;
 tipLocal:Vector3;
 /** Create the prop and mount it on the wrist of `side` (rig-owned).
  * `bevel` is the racket-specific facet index a prop may honour; props without
  * facets ignore it. */
 attach(rig:HumanRig,side?:'L'|'R',bevel?:number):Group;
}
export const PROPS:Readonly<Record<PropKind,PropDescriptor>>={
 racket:{kind:'racket',handle:RACKET_HANDLE,tipLocal:RACKET_TIP_LOCAL,attach:attachRacket},
};
/** Attach a registered prop to the wrist of `side` (default right). */
export function attachProp(rig:HumanRig,kind:PropKind,side:'L'|'R'='R',bevel?:number):Group{
 return PROPS[kind].attach(rig,side,bevel);
}
export {attachRacket,mountRacket,RACKET_HANDLE,RACKET_TIP_LOCAL,RACKET_BEVELS,RACKET_BEVEL_DEFAULT,normalizeBevel,bevelRoll,bevelDirection,bevelAnchor} from './racket';
