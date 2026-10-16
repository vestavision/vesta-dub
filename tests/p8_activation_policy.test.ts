import {describe,expect,it} from 'vitest';
import {ActivationPolicy,activationPreference,watchVideoId} from '../src/activation/ActivationPolicy';
const A='zjkBMFhNj_g',B='BYXbuik3dgA';
describe('P8 migration and URL identity',()=>{
 for(const legacy of [undefined,null,true,{enabled:true},'always',{version:0,mode:'always'},{version:1,mode:'other'}]){
  it(`never treats legacy/unknown preference ${JSON.stringify(legacy)} as consent`,()=>{
   expect(activationPreference(legacy)).toEqual({version:1,mode:'manual'});
   const p=new ActivationPolicy(activationPreference(legacy).mode);p.visit(A);expect(p.snapshot().activeVideoId).toBeNull();
  });
 }
 it('preserves explicit v1 modes idempotently',()=>{
  for(const mode of ['manual','tab','always']){const pref=activationPreference({version:1,mode});expect(pref.mode).toBe(mode);expect(activationPreference(pref)).toEqual(pref);}
 });
 it('ignores timestamps while rejecting unrelated/unsupported pages',()=>{
  expect(watchVideoId(`https://www.youtube.com/watch?v=${A}&t=119s`)).toBe(A);
  expect(watchVideoId(`https://www.youtube.com/watch?v=${A}&t=8&list=123`)).toBe(A);
  for(const url of ['https://www.youtube.com/','https://www.youtube.com/shorts/'+A,'https://www.youtube.com/embed/'+A,'https://example.com/watch?v='+A,'https://youtube.com.evil.test/watch?v='+A,'https://www.youtube.com/watch?v=invalid'])expect(watchVideoId(url)).toBeNull();
 });
});
describe('P8 document-owned activation matrix',()=>{
 it('Stop during initial preference loading wins over a later restored Always preference',()=>{
  const p=new ActivationPolicy();p.visit(A,false);p.stop();p.setMode('always');p.visit(A);
  expect(p.snapshot().activeVideoId).toBeNull();p.visit(B);expect(p.snapshot().activeVideoId).toBe(B);
 });
 it('an unconfirmed URL excursion cannot defeat Stop for the still-current actual player',()=>{
  const p=new ActivationPolicy('always');p.visit(A);p.confirmVideo(A);p.stop();
  p.visit(B);p.visit(A);p.confirmVideo(A);expect(p.snapshot().activeVideoId).toBeNull();
  p.visit(B);p.confirmVideo(B);p.visit(A);expect(p.snapshot().activeVideoId).toBe(A);
 });
 it('an Always edit racing initial preference restoration consumes the current lifecycle without Start',()=>{
  const p=new ActivationPolicy();p.visit(A,false);p.setMode('always');p.visit(A);
  expect(p.snapshot().activeVideoId).toBeNull();p.visit(B);expect(p.snapshot().activeVideoId).toBe(B);
  const fresh=new ActivationPolicy('always');fresh.visit(A);expect(fresh.snapshot().activeVideoId).toBe(A);
 });
 it('Stop on an unsupported page can revoke pending tab continuation',()=>{
  const p=new ActivationPolicy('tab');p.visit(A);p.start(A);p.visit(null);
  expect(p.snapshot().activeVideoId).toBeNull();expect(p.snapshot().continuationAllowed).toBe(true);
  p.stop();p.visit(B);expect(p.snapshot().activeVideoId).toBeNull();
 });
 it('BFCache logical session reset revokes manual/tab consent and invalidates old async epochs',()=>{
  for(const mode of ['manual','tab','always'] as const){
   const p=new ActivationPolicy(mode);p.visit(A);p.start(A);const before=p.snapshot();p.resetDocument();
   expect(p.snapshot().documentId).not.toBe(before.documentId);expect(p.isCurrent(before.epoch,A)).toBe(false);
   p.visit(A);expect(p.snapshot().activeVideoId).toBe(mode==='always'?A:null);
  }
 });
 it('manual Start targets the current video, is idempotent, and never carries into another video',()=>{
  const p=new ActivationPolicy();p.visit(A);expect(p.start(B)).toBe(false);expect(p.start(A)).toBe(true);
  const epoch=p.snapshot().epoch;expect(p.start(A)).toBe(false);expect(p.snapshot().epoch).toBe(epoch);
  p.visit(B);expect(p.snapshot().activeVideoId).toBeNull();
 });
 it('same-video seek, pause/resume, timestamp, focus, popup and worker activity are not new lifecycles',()=>{
  const p=new ActivationPolicy();p.visit(A);p.start(A);p.phase('active');const before=p.snapshot();
  for(let i=0;i<10;i++)expect(p.visit(A)).toBe(false);
  expect(p.snapshot()).toEqual(before);expect(new ActivationPolicy().snapshot().activeVideoId).toBeNull();
 });
 it('manual reload, a second tab with the same URL and a reopened tab have no inherited consent',()=>{
  const original=new ActivationPolicy();original.visit(A);original.start(A);
  for(let i=0;i<3;i++){const fresh=new ActivationPolicy();fresh.visit(A);expect(fresh.snapshot().activeVideoId).toBeNull();expect(fresh.snapshot().continuationAllowed).toBe(false);}
 });
 it('tab continuation requires a Start in that document and survives same-tab watch navigation/back/forward',()=>{
  const p=new ActivationPolicy('tab');p.visit(A);expect(p.snapshot().activeVideoId).toBeNull();p.start(A);
  for(const id of [B,A,B]){p.visit(id);expect(p.snapshot().activeVideoId).toBe(id);}
  const other=new ActivationPolicy('tab');other.visit(B);expect(other.snapshot().activeVideoId).toBeNull();
 });
 it('Stop revokes tab continuation; closing/reloading/restarting cannot reconstruct it',()=>{
  const p=new ActivationPolicy('tab');p.visit(A);p.start(A);p.stop();p.visit(B);expect(p.snapshot().activeVideoId).toBeNull();
  expect(p.snapshot().continuationAllowed).toBe(false);
  const reload=new ActivationPolicy('tab');reload.visit(B);expect(reload.snapshot().activeVideoId).toBeNull();
 });
 it('Always starts once per genuine eligible lifecycle and Stop wins over every same-video event',()=>{
  const p=new ActivationPolicy('always');p.visit(A);expect(p.snapshot().activeVideoId).toBe(A);p.stop();
  for(let i=0;i<10;i++)p.visit(A);expect(p.snapshot().activeVideoId).toBeNull();expect(p.snapshot().suppressedVideoId).toBe(A);
  p.visit(B);expect(p.snapshot().activeVideoId).toBe(B);p.visit(null);expect(p.snapshot().activeVideoId).toBeNull();p.visit(B);expect(p.snapshot().activeVideoId).toBe(B);
 });
 it('changing mode never starts the current video or restores a stopped session',()=>{
  const p=new ActivationPolicy();p.visit(A);p.setMode('always');p.visit(A);expect(p.snapshot().activeVideoId).toBeNull();
  p.start(A);p.stop();p.setMode('manual');p.setMode('always');p.visit(A);expect(p.snapshot().activeVideoId).toBeNull();
 });
 it('selecting tab mode during a manual session does not invent tab continuation',()=>{
  const p=new ActivationPolicy();p.visit(A);p.start(A);p.setMode('tab');expect(p.snapshot().activeVideoId).toBe(A);p.visit(B);expect(p.snapshot().activeVideoId).toBeNull();
 });
 it('explicit Start may override Always suppression, but failures never loop',()=>{
  const p=new ActivationPolicy('always');p.visit(A);p.stop();p.start(A);expect(p.snapshot().activeVideoId).toBe(A);
  p.fail();p.visit(A);expect(p.snapshot().phase).toBe('failed');expect(p.snapshot().activeVideoId).toBeNull();p.visit(B);expect(p.snapshot().activeVideoId).toBe(B);
 });
 it('old asynchronous work cannot belong to a navigation, Stop/restart, or failed-session epoch',()=>{
  const p=new ActivationPolicy('tab');p.visit(A);p.start(A);const old=p.snapshot().epoch;
  p.visit(B);expect(p.isCurrent(old,A)).toBe(false);const current=p.snapshot().epoch;
  p.stop();p.start(B);expect(p.isCurrent(current,B)).toBe(false);const active=p.snapshot().epoch;p.fail(true);expect(p.isCurrent(active,B)).toBe(false);
 });
});
