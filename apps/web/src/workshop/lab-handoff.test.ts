import {describe,it,expect} from 'vitest';
import {MOTION_FILES} from '@human3d/motion-core';
import {handoffConsumedByCreate,handoffHasCard,resolveLabHandoff} from './lab-handoff';

describe('resolveLabHandoff',()=>{
 it('resolves a bundled workshop-motion id to a preset handoff',()=>{
  const forehand=MOTION_FILES.find(f=>f.id==='forehand')!;
  expect(forehand.kind).toBe('workshop-motion');
  expect(resolveLabHandoff('?from=forehand')).toEqual({kind:'preset',file:forehand});
 });
 it('resolves an editable preset even when the param carries extra query fields',()=>{
  const handoff=resolveLabHandoff('?from=idle&other=1');
  expect(handoff?.kind).toBe('preset');
 });
 it('explains dynamics replays and external clips instead of fabricating editable data',()=>{
  for(const id of ['baseball-throw','punch','walk']){
   const file=MOTION_FILES.find(f=>f.id===id)!;
   const handoff=resolveLabHandoff(`?from=${id}`);
   expect(handoff).toEqual({kind:'external',file});
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
 it('covers every lab-editable motion id with a preset handoff and nothing else',()=>{
  const editable=MOTION_FILES.filter(f=>f.kind==='workshop-motion'&&f.document);
  // Generic set only: the 17 player presets were ablated (#30/#21).
  expect(editable.length).toBeGreaterThan(10);
  for(const f of editable)expect(resolveLabHandoff(`?from=${encodeURIComponent(f.id)}`)?.kind).toBe('preset');
 });
});

describe('handoffConsumedByCreate',()=>{
 const idle=resolveLabHandoff('?from=idle')!;
 const forehand=resolveLabHandoff('?from=forehand')!;
 const external=resolveLabHandoff('?from=baseball-throw')!;
 it('consumes the handoff only when the creation used the offered preset',()=>{
  expect(handoffConsumedByCreate(forehand,'forehand')).toBe(true);
  expect(handoffConsumedByCreate(forehand,'idle')).toBe(false);
 });
 it('never consumes external, unknown or absent handoffs',()=>{
  expect(handoffConsumedByCreate(external,'baseball-throw')).toBe(false);
  expect(handoffConsumedByCreate({kind:'unknown',id:'bogus'},'bogus')).toBe(false);
  expect(handoffConsumedByCreate(null,'idle')).toBe(false);
 });
 it('covers every preset handoff against its own id',()=>{
  const presets=MOTION_FILES.filter(f=>f.kind==='workshop-motion'&&f.document);
  for(const f of presets)expect(handoffConsumedByCreate({kind:'preset',file:f},f.id)).toBe(true);
 });
});

describe('handoffHasCard',()=>{
 it('is true for preset and external handoffs — both render an offer card',()=>{
  expect(handoffHasCard(resolveLabHandoff('?from=idle'))).toBe(true);
  expect(handoffHasCard(resolveLabHandoff('?from=baseball-throw'))).toBe(true);
  expect(handoffHasCard(resolveLabHandoff('?from=walk'))).toBe(true);
 });
 it('is false for unknown ids and absent handoffs — nothing renders, nothing raises',()=>{
  expect(handoffHasCard(resolveLabHandoff('?from=bogus'))).toBe(false);
  expect(handoffHasCard(null)).toBe(false);
 });
});
