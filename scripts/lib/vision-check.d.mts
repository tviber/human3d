/** Vision-coordinate sanity check for the agent motion-review loop (see vision-check.mjs). */
export declare const VISION_CHECK_WIDTH:number;
export declare const VISION_CHECK_HEIGHT:number;
export declare const VISION_CHECK_MARKER_COUNT:number;
export declare const VISION_PASS_PX:number;
export declare const VISION_WARN_PX:number;
export declare const SCOPE_NOTE:string;
export interface VisionFixture{width:number;height:number;rgba:Uint8Array;truth:{markers:{id:number;x:number;y:number}[];rect:{x:number;y:number;w:number;h:number}}}
export interface VisionAnswers{markers:{id:number;x:number;y:number}[];rect?:{x:number;y:number;w:number;h:number}}
export interface VisionGrade{verdict:'pass'|'warn'|'fail';markers:{id:number;errorPx:number}[];rect:{errorPx:number}|null;swapped:[number,number][];maxErrorPx:number;feedback:string[]}
export declare function generateFixture():VisionFixture;
export declare function fixturePng():Buffer;
export declare function gradeVision(answers:VisionAnswers,truth:VisionFixture['truth']):VisionGrade;
