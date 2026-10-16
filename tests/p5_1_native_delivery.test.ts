import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseHTML } from 'linkedom';
import { YouTubeSubtitleAdapter } from '../src/subtitles/YouTubeSubtitleAdapter';
import { PreloadedCaptionSource } from '../src/subtitles/PreloadedCaptionSource';
const text = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Real words remain intact.' }] }] });
function setup() {
 const {window,document}=parseHTML('<html><body></body></html>');
 vi.stubGlobal('CustomEvent',window.CustomEvent);vi.stubGlobal('window',window);vi.stubGlobal('document',document);
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,status:200,headers:new Headers(),text:async()=>''}));
 const adapter=new YouTubeSubtitleAdapter();vi.spyOn(adapter,'getVideoId').mockReturnValue('video');
 const emit=(detail:any)=>window.dispatchEvent(new window.CustomEvent('vesta-caption-payload',{detail}));
 const track={id:'en',name:'English',languageCode:'en',baseUrl:'https://www.youtube.com/api/timedtext?v=video&lang=en'};
 return {adapter,emit,track};
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('P5.1 native payload retention between load attempts',()=>{
 it('retains delivery outside an active load without sharing MAIN expandos',async()=>{
  const {adapter,emit,track}=setup();emit({videoId:'video',languageCode:'en',text,requestId:'xhr:7'});
  const cues=await adapter.loadCues(track);expect(cues).toHaveLength(1);expect(cues[0].acquisition?.requestId).toBe('xhr:7');expect(fetch).not.toHaveBeenCalled();
 });
 it('empty, invalid, duplicate and translated events cannot replace admitted source',async()=>{
  const {adapter,emit,track}=setup();emit({videoId:'video',languageCode:'en',text});
  for(const payload of ['', '{"events":[]}',text])emit({videoId:'video',languageCode:'en',text:payload});
  emit({videoId:'video',languageCode:'tlang:tr',text:text.replace('Real words','Wrong translation')});
  expect((await adapter.loadCues(track))[0].originalText).toBe('Real words remain intact.');
 });
 it('discovers current MAIN metadata instead of a stale SPA script',async()=>{
  const {adapter}=setup();
  window.addEventListener('vesta-request-tracks',()=>window.dispatchEvent(new CustomEvent('vesta-track-metadata',{detail:{videoId:'video',tracks:[{baseUrl:'https://www.youtube.com/api/timedtext?v=video&lang=en',languageCode:'en',name:{simpleText:'English'}}]}})));
  const tracks=await adapter.getAvailableTracks();expect(tracks).toHaveLength(1);expect(tracks[0].baseUrl).toContain('v=video');
 });
 it('uses validated native identity while current player metadata is unavailable',async()=>{
  const {adapter,emit}=setup();emit({videoId:'video',languageCode:'en',text});
  const tracks=await adapter.getAvailableTracks();expect(tracks).toHaveLength(1);expect(tracks[0].baseUrl).toBe('https://www.youtube.com/api/timedtext?v=video&lang=en&fmt=json3');expect(fetch).not.toHaveBeenCalled();
 });
 it('rejects stale track URLs before native or direct acquisition',async()=>{
  const {adapter,track}=setup();expect(await adapter.loadCues({...track,baseUrl:'https://www.youtube.com/api/timedtext?v=old&lang=en'})).toEqual([]);expect(fetch).not.toHaveBeenCalled();expect(adapter.getDiagnosticLogs()[0].explicitFailureReason).toBe('VIDEO_ID_MISMATCH');
 });
 it('admits retained track into preloaded source and clears it on navigation',async()=>{
  const {adapter,emit,track}=setup();emit({videoId:'other',languageCode:'en',text});emit({videoId:'video',languageCode:'en',text});
  const source=new PreloadedCaptionSource(adapter);let ids:string[]=[];
  await source.start({videoId:'video',track},{onCues:cues=>{ids=cues.map(c=>c.id);}});
  expect(ids).toEqual(['video:cue-0']);expect(source.getCapabilities().futureCuesAvailable).toBe(true);
  adapter.reset();expect(await adapter.loadCues(track)).toEqual([]);
 });
});
