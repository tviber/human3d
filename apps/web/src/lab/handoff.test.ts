import {describe,it,expect} from 'vitest';
import {MOTIONS} from '@human3d/motion-core';
import {workshopEditability} from './handoff';
import {savedMotionSpec} from '../workshop/library';

describe('workshopEditability',()=>{
 it('opens the existing saved document instead of offering a new preset copy',()=>{
  const source=MOTIONS.find(m=>m.source?.kind==='document')!;
  if(source.source?.kind!=='document')throw new Error('Missing real document');
  const doc={...source.source.document,id:'我的动作 / 1'},spec=savedMotionSpec(doc);
  expect(workshopEditability(spec)).toEqual({editable:true,url:`/workshop.html?doc=${encodeURIComponent(doc.id)}`,reason:''});
 });
 it('offers navigation for bundled workshop-document motions, carrying the motion id',()=>{
  const forehand=MOTIONS.find(m=>m.id==='forehand')!;
  expect(forehand.source?.kind).toBe('document');
  expect(workshopEditability(forehand)).toEqual({editable:true,url:'/workshop.html?from=forehand',reason:''});
 });
 it('covers every editable motion with a from-parameterized url',()=>{
  const editable=MOTIONS.filter(m=>m.source?.kind==='document');
  // Generic set only: the 17 player presets were ablated (#30/#21) — the guard
  // still catches a registry that silently shrinks below the generic motions.
  expect(editable.length).toBeGreaterThan(10);
  for(const m of editable)
   expect(workshopEditability(m)).toEqual({editable:true,url:`/workshop.html?from=${encodeURIComponent(m.id)}`,reason:''});
 });
 it('explains the limitation AND carries context for the dynamics replay and external clip',()=>{
  for(const [id,fragment] of [['baseball-throw','肌骨正向仿真'],['punch','肌骨正向仿真'],['walk','外部剪辑']] as const){
   const motion=MOTIONS.find(m=>m.id===id)!;
   const why=workshopEditability(motion);
   expect(why.editable).toBe(false);
   expect(why.reason).toContain(fragment);
   // The header nav forwards the id even for non-editable motions — the
   // workshop's external card explains the limitation there.
   expect(why.url).toBe(`/workshop.html?from=${id}`);
  }
 });
 it('does not fabricate a handoff for imported pose packages (not in the registry)',()=>{
  const pkgWhy=workshopEditability({...MOTIONS[0],id:'imported',source:{kind:'pose-package',package:{}}});
  expect(pkgWhy.editable).toBe(false);
  expect(pkgWhy.reason).toContain('姿态包');
  expect(pkgWhy.url).toBe('/workshop.html');
 });
 it('falls back to a generic explanation and plain url when the source is absent',()=>{
  const why=workshopEditability({...MOTIONS[0],source:undefined});
  expect(why.editable).toBe(false);
  expect(why.reason.length).toBeGreaterThan(0);
  expect(why.url).toBe('/workshop.html');
 });
});
