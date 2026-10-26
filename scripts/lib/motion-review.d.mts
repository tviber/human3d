/** Structured motion-review record + bounded-rework gate (see motion-review.mjs). */
export declare const REVIEW_KIND:string;
export declare const REVIEW_VERSION:number;
export declare const MAX_ROUNDS:number;
export declare const WRIST_RESIDUAL_FLAG_MM:number;
export declare const FAILURE_CATEGORIES:string[];
export declare const CATEGORY_NOTES:Record<string,string>;
export interface ReviewShot{file:string;time:number;view:string;keyId:string|null;shotRole:'key'|'midpoint';visual:null|'ok'|'suspect';note:string}
export interface ReviewFinding{id:string;time:number;keyId:string|null;view:string;part:string;category:string;auto?:boolean;evidence:string;solveStatus:'numeric-valid'|'numeric-invalid';referenceStatus:'unverified'|'consistent'|'inconsistent';suggestion:string;uncertainty:string}
export interface ReviewRecord{kind:string;version:number;round:number;docDigest:string|null;revision:string|null;doc:unknown;capture:{manifestSource:string|null;shots:number;views:string[]};reference:{available:boolean;aligned:boolean;note:string;frames?:string[]};shots:ReviewShot[];findings:ReviewFinding[];numerical:{worstWristResidualMm:number;flagged:{file:string;time:number;view:string;side:string;mm:number}[]};handoff:{reasons:string[];humanItems:string[]}|null}
export declare function initReview(manifest:unknown,opts?:{round?:number;reference?:{available:boolean;aligned:boolean;note:string;frames?:string[]}}):ReviewRecord;
export declare function checkReview(review:unknown):{valid:boolean;ok:boolean;verdict:'pass'|'fail-with-handoff';problems:string[]};
export declare function initFromManifestFile(manifestPath:string,opts?:{round?:number;referenceFrames?:string[];out?:string}):{review:ReviewRecord;target:string};
export declare function checkReviewFile(reviewPath:string):{review:ReviewRecord;result:{ok:boolean;verdict:string;problems:string[]}};
