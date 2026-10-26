/** Crop/grid/point/side-by-side/sheet helpers for the agent review loop (see review-crop.mjs). */
export declare const GRID_COLOR:[number,number,number];
export declare const POINT_COLOR:[number,number,number];
export interface RgbaImage{width:number;height:number;rgba:Uint8Array}
export declare function overlayGrid(image:RgbaImage,step?:number):RgbaImage;
export declare function overlayPoint(image:RgbaImage,at:{x:number;y:number},color?:[number,number,number]):RgbaImage;
export declare function sideBySide(images:RgbaImage[],gap?:number):RgbaImage;
export declare function composeSheet(images:RgbaImage[],cols?:number,gap?:number):RgbaImage;
export declare function processImage(opts:{input:string;region?:string;scale?:number;grid?:boolean|number;points?:string[];output:string}):{width:number;height:number};
export declare function compareSideBySide(opts:{left:string;right:string;region?:string;scale?:number;gap?:number;output:string}):{width:number;height:number};
export declare function sheetFromManifest(opts:{manifest:string;output:string;cols?:number}):{count:number;width:number;height:number};
