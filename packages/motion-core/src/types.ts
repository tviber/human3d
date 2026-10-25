import type {MotionCapabilities} from './motion-file';
import type {DynamicsRecords,MuscleActionFile} from './muscle-action';
import type {WorkshopDoc} from './document';
export type AuthoredMotionId='idle'|'walk'|'reach'|'squat'|'ready'|'forehand'|'baseball-throw'|'punch'
 |'basic-half-squat'|'basic-full-squat'|'basic-lunge'|'basic-weight-shift'|'basic-push-turn'
 |'basic-wide-squat'|'basic-forward-fold'|'basic-arms-up';
export type MotionId=AuthoredMotionId|(string & {});
export type ViewId='front'|'side'|'back'|'threeQuarter'|'hand'|'free';
export interface BoneInfo{name:string;sourceName:string;parent:string|null;head:number[];tail:number[]}
export interface RigInfo{height:number;bones:BoneInfo[];vertices:number;triangles:number;license:string}
/** Where a spec's trajectory comes from: an external clip asset, an inline
 * workshop document, a dynamics replay, or a delivered pose package. A
 * dynamics source carries the envelope's action parameters and record URLs;
 * a bare `{kind:'dynamics'}` spec is still legal — the replay then falls back
 * to the per-action `/dynamics/<id>/<case>.{json,bin}` convention. */
export type MotionSourceSpec=
 |{kind:'clip';clip:string;meta?:string}
 |{kind:'document';document:WorkshopDoc}
 |{kind:'dynamics';action?:MuscleActionFile;records?:DynamicsRecords}
 |{kind:'pose-package';package:unknown};
export interface MotionSpec{id:MotionId;name:string;english:string;duration:number;description:string;method:string;focus:string[];phases:{time:number;label:string}[];capabilities?:MotionCapabilities;source?:MotionSourceSpec;oneShot?:boolean;objectDescription?:string}
export interface DebugOptions{surface:boolean;skeleton:boolean;axes:boolean;targets:boolean;trail:boolean;muscles:boolean}
