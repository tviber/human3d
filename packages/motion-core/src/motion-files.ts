import {normalizeMotionFile,type MotionFile} from './motion-file';
import idle from '../../../assets/motions/idle.json';
import walk from '../../../assets/motions/walk.json';
import reach from '../../../assets/motions/reach.json';
import squat from '../../../assets/motions/squat.json';
import ready from '../../../assets/motions/ready.json';
import forehand from '../../../assets/motions/forehand.json';
import baseballThrow from '../../../assets/motions/baseball-throw.json';
import punch from '../../../assets/motions/punch.json';
import basicHalfSquat from '../../../assets/motions/basic-half-squat.json';
import basicFullSquat from '../../../assets/motions/basic-full-squat.json';
import basicLunge from '../../../assets/motions/basic-lunge.json';
import basicWeightShift from '../../../assets/motions/basic-weight-shift.json';
import basicPushTurn from '../../../assets/motions/basic-push-turn.json';
import basicWideSquat from '../../../assets/motions/basic-wide-squat.json';
import basicForwardFold from '../../../assets/motions/basic-forward-fold.json';
import basicArmsUp from '../../../assets/motions/basic-arms-up.json';

/** The bundled motion envelopes, normalized once at module load and kept in
 * display order. Plain static imports — node-safe, so the service, the lab
 * and the scripts all read the same assets/motions/ files; dynamics-motion
 * envelopes normalize their display fields out of `dynamics.action`. */
export const MOTION_FILES:MotionFile[]=[idle,walk,reach,squat,ready,forehand,baseballThrow,punch,
 basicHalfSquat,basicFullSquat,basicLunge,basicWeightShift,basicPushTurn,
 basicWideSquat,basicForwardFold,basicArmsUp]
 .map(f=>normalizeMotionFile(f))
 .sort((a,b)=>a.order-b.order);

export const motionFileById=(id:string)=>MOTION_FILES.find(f=>f.id===id);
