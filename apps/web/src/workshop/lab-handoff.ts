import {motionFileById} from '@human3d/motion-core';
import type {MotionFile} from '@human3d/motion-core';

/** The `?from=<motion-id>` parameter the lab passes when handing the motion
 * the user was watching over to the workshop. Read-only view-layer concern
 * (same convention as matchMedia): hosts without a URL just yield null. */

export const HANDOFF_PARAM='from';

/** What the lab handed over:
 * - `external` — a known motion without workshop keys (dynamics replay or
 *   external clip): explain the limitation, never fabricate editable data.
 * - `unknown` — a malformed, foreign, or bundled motion id: no preset copy is
 *   offered and the workshop opens as usual. */
export type LabHandoff=
 |{kind:'external';file:MotionFile}
 |{kind:'unknown';id:string};

export const resolveLabHandoff=(search:string):LabHandoff|null=>{
 const id=new URLSearchParams(search).get(HANDOFF_PARAM)?.trim();
 if(!id)return null;
 const file=motionFileById(id);
 if(!file)return{kind:'unknown',id};
 return file.kind==='workshop-motion'&&file.document?{kind:'unknown',id}:{kind:'external',file};
};

/** Only non-editable external motions need a handoff card. Bundled motion
 * examples no longer open a preset action in the Workshop. */
export const handoffHasCard=(handoff:LabHandoff|null):handoff is Extract<LabHandoff,{kind:'external'}>=>
 handoff?.kind==='external';

/** Drop the handoff parameter from the URL (history-only — no reload) so a
 * dismissed external motion does not keep reappearing after refresh. */
export const clearLabHandoff=()=>{
 try{
  const url=new URL(globalThis.location.href);
  if(!url.searchParams.has(HANDOFF_PARAM))return;
  url.searchParams.delete(HANDOFF_PARAM);
  globalThis.history.replaceState(null,'',url);
 }catch{/* hosts without history/location keep the offer for this session only */}
};
