import {describe,it,expect} from 'vitest';
import {MOTIONS} from '@human3d/motion-core';
import {workshopEditability} from './handoff';
import {savedMotionSpec} from '../motions/saved-motion';

describe('workshopEditability',()=>{
 it('opens the existing saved document instead of offering a new preset copy',()=>{
  const source=MOTIONS.find(m=>m.source?.kind==='document')!;
  if(source.source?.kind!=='document')throw new Error('Missing real document');
  const doc={...source.source.document,id:'我的动作 / 1'},spec=savedMotionSpec(doc);
  expect(workshopEditability(spec)).toEqual({editable:true,url:`/workshop.html?doc=${encodeURIComponent(doc.id)}`,reason:''});
 });
 it('keeps bundled actions playable in the lab without exposing a workshop preset copy',()=>{
  const forehand=MOTIONS.find(m=>m.id==='forehand')!;
  expect(forehand.source?.kind).toBe('document');
  expect(workshopEditability(forehand)).toEqual({editable:false,url:'/workshop.html',reason:'内置动作仅供实验室预览；工作台从空白动作开始创作。'});
 });
 it('does not offer any bundled document motion as a workshop preset',()=>{
  const editable=MOTIONS.filter(m=>m.source?.kind==='document');
  expect(editable.length).toBeGreaterThan(10);
  for(const m of editable)
   expect(workshopEditability(m)).toEqual({editable:false,url:'/workshop.html',reason:'内置动作仅供实验室预览；工作台从空白动作开始创作。'});
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
