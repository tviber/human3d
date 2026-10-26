import {describe,it,expect} from 'vitest';
import {bevelBadgeState,BEVEL_BADGE_SCALE,BEVEL_SELECTED_SCALE,BEVEL_FACING_CUTOFF,BEVEL_STRONG_FACING} from './bevel-badges';
import {RACKET_BEVELS,bevelDirection} from '@human3d/motion-core';

/* The eight badges on an octagonal handle sit ~21 mm apart while a legible
 * badge is ~26 mm: drawing all of them at once is unreadable and names facets
 * the viewer cannot see (issue #32 review, P2). These pin the replacement
 * rule: camera-facing half only, plus the selected facet always, enlarged. */
describe('bevel badge visibility',()=>{
 it('hides facets pointing away from the camera',()=>{
  expect(bevelBadgeState(-1,false).visible).toBe(false);
  expect(bevelBadgeState(-.5,false).visible).toBe(false);
  expect(bevelBadgeState(BEVEL_FACING_CUTOFF-.01,false).visible).toBe(false);
 });
 it('shows facets facing the camera, dimmed at grazing angles',()=>{
  expect(bevelBadgeState(.9,false)).toEqual({visible:true,scale:BEVEL_BADGE_SCALE,opacity:.95});
  expect(bevelBadgeState(0,false).visible).toBe(true);
  expect(bevelBadgeState(0,false).opacity).toBe(.45);
  expect(bevelBadgeState(BEVEL_STRONG_FACING+.01,false).opacity).toBe(.95);
 });
 it('always shows the selected facet, enlarged and opaque, even facing away',()=>{
  const selected=bevelBadgeState(-1,true);
  expect(selected).toEqual({visible:true,scale:BEVEL_SELECTED_SCALE,opacity:1});
  expect(selected.scale).toBeGreaterThan(BEVEL_BADGE_SCALE);
 });
 it('leaves at most the front half plus the selected facet visible',()=>{
  // Sweep all eight facets against a camera in each of four directions.
  for(const cameraAzimuth of [0,Math.PI/2,Math.PI,-Math.PI/2]){
   const toCam={x:Math.sin(cameraAzimuth),z:Math.cos(cameraAzimuth)};
   for(const selected of [1,4,8]){
    const visible=[];
    for(let bevel=1;bevel<=RACKET_BEVELS;bevel++){
     const d=bevelDirection('R',bevel);
     const facing=d.x*toCam.x+d.z*toCam.z;
     if(bevelBadgeState(facing,bevel===selected).visible)visible.push(bevel);
    }
    // Strictly fewer than all eight on every camera angle — no overlap wall.
    expect(visible.length,`camera ${cameraAzimuth} selected ${selected}: ${visible}`).toBeLessThan(RACKET_BEVELS);
    expect(visible).toContain(selected);
    // And the back-facing facets are genuinely gone, not just dimmed.
    expect(visible.length).toBeLessThanOrEqual(6);
   }
  }
 });
});
