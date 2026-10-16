import {describe,it,expect,vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {readSpeechCaption,LiveCaptionHarvester} from '../src/subtitles/LiveCaptionHarvester';
import {PreloadedCaptionSource} from '../src/subtitles/PreloadedCaptionSource';
import {futureAsrCapabilities} from '../src/subtitles/CaptionSource';
const html=(text:string)=>`<div id="movie_player"><div class="ytp-caption-window-container"><div class="caption-window" id="caption-window-1" lang="en"><span class="caption-visual-line"><span class="ytp-caption-segment">${text}</span></span></div><div class="caption-window" id="caption-window-_0" lang="tr"><span class="caption-visual-line"><span class="ytp-caption-segment">Ayarlar için simgesini tıklayın</span></span></div></div></div>`;
describe('Caption acquisition capabilities',()=>{
 it('extracts speech and source language while excluding the actual YouTube settings overlay',()=>{const {document}=parseHTML(html('you can talk to this language model'));expect(readSpeechCaption(document as unknown as ParentNode)).toEqual({text:'you can talk to this language model',language:'en',lines:['you can talk to this language model']});});
 it('deduplicates exact mutations, survives player replacement, and stops cleanly',async()=>{
  vi.useFakeTimers();const {document,window}=parseHTML(html('first real speech line'));
  vi.stubGlobal('document',document);vi.stubGlobal('location',{href:'https://www.youtube.com/watch?v=video'});vi.stubGlobal('MutationObserver',window.MutationObserver);
  const onCues=vi.fn();const source=new LiveCaptionHarvester();source.start({videoId:'video',video:{paused:false,currentTime:1} as HTMLVideoElement},{onCues});
  await source.processDomCaptions();expect(onCues).toHaveBeenCalledTimes(1);expect(source.getCapabilities().futureCuesAvailable).toBe(false);
  document.getElementById('movie_player')!.outerHTML=html('second speech line');await vi.advanceTimersByTimeAsync(250);expect(onCues).toHaveBeenCalledTimes(2);
  source.stop();document.getElementById('movie_player')!.outerHTML=html('third speech line');await vi.advanceTimersByTimeAsync(500);expect(onCues).toHaveBeenCalledTimes(2);
  vi.useRealTimers();vi.unstubAllGlobals();
 });
 it('marks missing rendered captions explicitly rather than claiming usable future data',async()=>{
  const {document}=parseHTML('<div id="movie_player"></div>');vi.stubGlobal('document',document);vi.stubGlobal('location',{href:'https://www.youtube.com/watch?v=video'});
  const source:any=new LiveCaptionHarvester();source.video={paused:false,currentTime:3};source.videoId='video';source.active=true;await source.processDomCaptions();expect(source.getCapabilities().failureReason).toBe('NO_RENDERED_SPEECH_CAPTION');vi.unstubAllGlobals();
 });
 it('preloaded source does not publish an old video response after cancellation',async()=>{
  let finish:any;const adapter={getVideoId:()=> 'video',loadCues:()=>new Promise<any[]>(r=>finish=r)};const source=new PreloadedCaptionSource(adapter);const onCues=vi.fn();const task=source.start({videoId:'video',track:{id:'en',languageCode:'en',name:'English'}},{onCues});source.stop();finish([{id:'cue',originalText:'real',turkishText:'gerçek'}]);await task;expect(onCues).not.toHaveBeenCalled();expect(source.getCapabilities().futureCuesAvailable).toBe(false);
 });
 it('future ASR explicitly declares unimplemented, unknown latency/confidence and no lookahead',()=>{expect(futureAsrCapabilities()).toMatchObject({futureCuesAvailable:false,availability:'unavailable',expectedAcquisitionLatencyMs:null,confidence:null,failureReason:'NOT_IMPLEMENTED'});});
});
