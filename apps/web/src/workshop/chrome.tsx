import {DndContext, PointerSensor, useSensor, useSensors} from '@dnd-kit/core';
import {SortableContext, useSortable, verticalListSortingStrategy} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {GripVertical, Plus, Trash2} from 'lucide-react';
import type {WorkshopDoc} from '@human3d/motion-core';

function LibRow({id, name, meta, selected, onSelect, onDuplicate, onRemove}:{id:string;name:string;meta:string;selected:boolean;onSelect:()=>void;onDuplicate:()=>void;onRemove:()=>void}){
 const {attributes, listeners, setNodeRef, transform, transition}=useSortable({id});
 return <div ref={setNodeRef} className={`ws-lib-row ${selected?'sel':''}`} style={{transform:CSS.Transform.toString(transform), transition}}>
  <button type="button" className="ws-drag" aria-label={`拖动排序 ${name}`} {...attributes} {...listeners}><GripVertical size={12}/></button>
  <button className="ws-lib-name" onClick={onSelect} title={id}><span>{name}</span><small>{meta}</small></button>
  <button aria-label={`复制 ${name}`} title="复制" onClick={onDuplicate}><Plus size={12}/></button>
  <button aria-label={`删除 ${name}`} title="删除" onClick={onRemove}><Trash2 size={12}/></button>
 </div>;
}

/** Library order is a sortable list. The name button stays a click target;
 * only the grip starts a drag, so QA's name click is unchanged. */
export function LibraryList({docs, activeId, onSelect, onDuplicate, onRemove, onReorder}:{docs:WorkshopDoc[];activeId:string;onSelect:(id:string)=>void;onDuplicate:(id:string)=>void;onRemove:(id:string)=>void;onReorder:(activeId:string, overId:string)=>void}){
 const sensors=useSensors(useSensor(PointerSensor, {activationConstraint:{distance:6}}));
 return <DndContext sensors={sensors} onDragEnd={e=>{const over=e.over?.id;if(over&&e.active.id!==over)onReorder(String(e.active.id), String(over));}}>
  <SortableContext items={docs.map(d=>d.id)} strategy={verticalListSortingStrategy}>
   <div className="ws-lib scroll-region">
    {docs.map(doc=><LibRow key={doc.id} id={doc.id} name={doc.name} meta={`${doc.keys.length} 关键帧 · ${doc.duration.toFixed(2)}s`} selected={doc.id===activeId} onSelect={()=>onSelect(doc.id)} onDuplicate={()=>onDuplicate(doc.id)} onRemove={()=>onRemove(doc.id)}/>)}
   </div>
  </SortableContext>
 </DndContext>;
}
