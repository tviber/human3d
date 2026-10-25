import {create} from 'zustand';
import type {ViewId} from '@human3d/motion-core';

export interface WorkshopOpts{
 handles:boolean;trajectories:boolean;balance:boolean;
 onion:boolean;onionCount:number;onionMode:'keys'|'step';onionStep:number;
}

export interface WorkshopUiState{
 selected:string;
 newName:string;
 view:ViewId;
 opts:WorkshopOpts;
 setSelected:(id:string)=>void;
 setNewName:(name:string)=>void;
 setView:(view:ViewId)=>void;
 setOpts:(patch:WorkshopOpts|((prev:WorkshopOpts)=>WorkshopOpts))=>void;
}

const initialOpts:WorkshopOpts={handles:true, trajectories:false, balance:false, onion:false, onionCount:2, onionMode:'keys', onionStep:.1};

/** Workshop chrome that is not the document: selection, camera preset, display
 * options, and the "new motion" field. The document itself stays in MotionLibrary. */
export const useWorkshopUi=create<WorkshopUiState>((set)=>({
 selected:'k-contact',
 newName:'',
 view:'threeQuarter',
 opts:initialOpts,
 setSelected:selected=>set({selected}),
 setNewName:newName=>set({newName}),
 setView:view=>set({view}),
 setOpts:patch=>set(s=>({opts:typeof patch==='function'?patch(s.opts):patch})),
}));
