/** Review-bundle acceptance checks over a real workshop-capture --bundle output (see review-bundle-qa.mjs). */
export declare const MIDPOINT_TARGET_DELTA_M:number;
export interface ReviewBundleQaResult{
 kind:'h3d-review-bundle-browser-qa';version:1;docDigest:string;shots:number;midpoints:number;files:string[];
 midpointWristResiduals:{file:string;time:number;side:'right'|'left';mm:number}[];
 interpolatedTargetCheck:{file:string;time:number;side:'right'|'left';nearestKeyTargetDeltaM:number;wristResidualMm:number};
 review:{initExit:number|null;checkExit:number|null;unviewedShots:number|null;blockedAsRequired:boolean;completeLedgerExit:number|null;completeLedgerShots:number|null;completeLedgerPass:boolean};
}
export declare function verifyReviewBundleCapture(outputDir:string,options?:{run?:typeof import('node:child_process').spawnSync;repoRoot?:string}):ReviewBundleQaResult;
