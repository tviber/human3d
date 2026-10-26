/** Zero-dependency PNG codec for the agent review tooling (see png.mjs). */
export declare function encodePng(width:number,height:number,rgba:Uint8Array):Buffer;
export declare function decodePng(buffer:Buffer):{width:number;height:number;rgba:Uint8Array};
export declare function cropRegion(image:{width:number;height:number;rgba:Uint8Array},region:{x:number;y:number;w:number;h:number},scale?:number):{width:number;height:number;rgba:Uint8Array};
