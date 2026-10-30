/** Single source of truth for workshop limits. The UI clamps inputs to these
 * values, the document validator rejects documents outside them (they are
 * quarantined, never dropped), and the service applies the same caps. */
export const WORKSHOP_LIMITS={minDuration:.2,maxDuration:10,maxKeys:120,loopGap:.01} as const;
/** Authorable head rotation relative to the neck, in degrees. */
export const HEAD_ROTATION_LIMITS={yaw:[-80,80],pitch:[-45,45]} as const;

/** Clamp a user-entered duration into the supported range. Non-finite input
 * falls back to the minimum instead of producing an unsaveable document. */
export function clampDuration(value:number){
  if(!Number.isFinite(value))return WORKSHOP_LIMITS.minDuration;
  return Math.min(WORKSHOP_LIMITS.maxDuration,Math.max(WORKSHOP_LIMITS.minDuration,value));
}
