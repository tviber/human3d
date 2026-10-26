/** Which bevel badges are worth drawing, and how. Pure math so it can be
 * tested without a WebGL context: the workshop feeds it each badge's local
 * outward direction and the camera direction, and it decides visibility,
 * scale and opacity.
 *
 * Why not draw all eight: the handle is an octagon, so adjacent facet centres
 * sit ~21 mm apart while a legible badge is ~26 mm — at any camera angle the
 * far-side numbers either overlap the near ones or (with depthTest off) punch
 * through the grip and name facets the viewer cannot see. Showing only the
 * camera-facing half, plus the selected facet at all times, keeps the numbers
 * readable and meaningful. The selected one is drawn larger because it is the
 * answer to "which facet is against my palm".
 */

/** Camera-facing cutoff: badges whose facet points at least this far away from
 * the viewer are hidden. Slightly negative so a facet at grazing angle still
 * shows rather than popping out a few degrees early. */
export const BEVEL_FACING_CUTOFF=-.15;
/** Above this, a visible badge is drawn fully opaque; below it, dimmed. */
export const BEVEL_STRONG_FACING=.35;
export const BEVEL_BADGE_SCALE=.026;
export const BEVEL_SELECTED_SCALE=.04;

export interface BevelBadgeState{visible:boolean;scale:number;opacity:number}

/** Decide one badge's state.
 * @param facing dot product of the facet's outward world normal and the
 *   unit vector from the grip to the camera (>0 = facing the viewer)
 * @param selected whether this is the bevel currently chosen in the panel */
export function bevelBadgeState(facing:number,selected:boolean):BevelBadgeState{
 if(selected)return {visible:true,scale:BEVEL_SELECTED_SCALE,opacity:1};
 return {visible:facing>BEVEL_FACING_CUTOFF,scale:BEVEL_BADGE_SCALE,
  opacity:facing>BEVEL_STRONG_FACING?.95:.45};
}
