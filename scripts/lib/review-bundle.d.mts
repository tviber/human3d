/** Deterministic review-bundle helpers (see review-bundle.mjs). */
export declare const REVIEW_BUNDLE_REVISION:string;
export declare function canonicalJson(value:unknown):string;
export declare function docDigest(normalizedDoc:unknown,revision?:string):string;
export declare function timesForBundle(doc:{duration:number;keys:{time:number}[]}):number[];
export declare function shotRole(doc:{keys:{time:number}[]},time:number):'key'|'midpoint';
export declare function bundleBlock(opts:{doc:{id?:string;duration:number;keys:{time:number}[]};normalizedDoc:unknown;docPath:string}):{revision:string;docDigest:string;docSource:string;keyTimes:number[];note:string};
