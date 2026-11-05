import {describe,it,expect} from 'vitest';
import {MOTION_FILES} from '@human3d/motion-core';
import {handoffHasCard,resolveLabHandoff} from './lab-handoff';

describe('resolveLabHandoff',()=>{
 it('does not offer bundled workshop motions as editable preset copies',()=>{
  const forehand=MOTION_FILES.find(f=>f.id==='forehand')!;
  expect(forehand.kind).toBe('workshop-motion');
  expect(resolveLabHandoff('?from=forehand')).toEqual({kind:'unknown',id:'forehand'});
  expect(resolveLabHandoff('?from=idle&other=1')).toEqual({kind:'unknown',id:'idle'});
 });
 it('resolves dynamics replays and external clips as read-only handoffs',()=>{
  for(const id of ['baseball-throw','punch','walk']){
   const file=MOTION_FILES.find(f=>f.id===id)!;
   expect(resolveLabHandoff(`?from=${id}`)).toEqual({kind:'external',file});
  }
 });
 it('returns unknown for a malformed or foreign motion id',()=>{
  expect(resolveLabHandoff('?from=bogus-id')).toEqual({kind:'unknown',id:'bogus-id'});
 });
 it('returns null without the parameter, on an empty value, or on a bare parameter',()=>{
  expect(resolveLabHandoff('')).toBeNull();
  expect(resolveLabHandoff('?other=1')).toBeNull();
  expect(resolveLabHandoff('?from=')).toBeNull();
  expect(resolveLabHandoff('?from=%20')).toBeNull();
 });
 it('never creates a card for bundled motion documents',()=>{
  for(const file of MOTION_FILES.filter(f=>f.kind==='workshop-motion'&&f.document)){
   const handoff=resolveLabHandoff(`?from=${encodeURIComponent(file.id)}`);
   expect(handoff?.kind).toBe('unknown');
   expect(handoffHasCard(handoff)).toBe(false);
  }
 });
});

describe('handoffHasCard',()=>{
 it('shows cards only for known non-editable external motions',()=>{
  expect(handoffHasCard(resolveLabHandoff('?from=baseball-throw'))).toBe(true);
  expect(handoffHasCard(resolveLabHandoff('?from=walk'))).toBe(true);
  expect(handoffHasCard(resolveLabHandoff('?from=forehand'))).toBe(false);
 });
 it('is false for unknown ids and absent handoffs',()=>{
  expect(handoffHasCard(resolveLabHandoff('?from=bogus'))).toBe(false);
  expect(handoffHasCard(null)).toBe(false);
 });
});
