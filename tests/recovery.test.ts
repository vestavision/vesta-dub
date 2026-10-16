import {describe,it,expect,vi,beforeEach} from 'vitest';
import {DubbingScheduler} from '../src/audio/DubbingScheduler';
import {SpeakerManager} from '../src/speaker/SpeakerManager';
import {istft} from '../src/tts/AntaliaEngine';
import {AudioDSP} from '../src/dsp/AudioDSP';
const cue=(id='one',start=1,end=4)=>({id,index:0,startTime:start,endTime:end,duration:end-start,originalText:'Hello',turkishText:'Merhaba dünya.',speakerId:'speaker-a'});
function setup(){
 const sources:any[]=[];
 const ctx:any={state:'running',currentTime:2,createBufferSource:()=>{const s={buffer:null,playbackRate:{value:1},connect:vi.fn(),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn(),onended:null};sources.push(s);return s;}};
 const audio:any={getContext:vi.fn(async()=>ctx),createAudioBuffer:vi.fn(async(a:Float32Array,sr:number)=>({duration:a.length/sr,length:a.length,numberOfChannels:1})),getDubbingGain:()=>({}),duckVideo:vi.fn(),unduckVideo:vi.fn()};
 let resolve:any;const tts:any={synthesize:vi.fn(()=>new Promise(r=>resolve=r))};
 const s:any=new DubbingScheduler(audio,tts,new SpeakerManager());
 s.video={currentTime:1.2,paused:false,playbackRate:1};s.enabled=true;s.lastTime=1.2;s.cues=[cue()];
 const finish=async()=>{resolve({audio:new Float32Array(48000).fill(.1),sampleRate:48000,duration:1});for(let i=0;i<15;i++)await Promise.resolve();};
 return {s,tts,audio,ctx,sources,finish};
}
describe('Production scheduler recovery',()=>{
 beforeEach(()=>vi.stubGlobal('chrome',undefined));
 it('shares one inference across prefetch and repeated animation ticks',async()=>{const x=setup();for(let i=0;i<20;i++)x.s.update();expect(x.tts.synthesize).toHaveBeenCalledTimes(1);await x.finish();expect(x.sources).toHaveLength(1);expect(x.sources[0].start).toHaveBeenCalledTimes(1);});
 it('incremental captions do not stop active audio or erase cache',()=>{const x=setup();const source={stop:vi.fn()};x.s.activeSource=source;x.s.bufferCache.set('one',{});x.s.appendLiveCue(cue('two',2,5));x.s.appendLiveCue(cue('two',2,5));expect(source.stop).not.toHaveBeenCalled();expect(x.s.bufferCache.has('one')).toBe(true);expect(x.s.cues).toHaveLength(2);});
 it('plays late live captions from offset zero within bounded latency',async()=>{const x=setup();x.s.mode='live';x.s.video.currentTime=4.2;x.s.lastTime=4.2;x.s.update();await x.finish();expect(x.sources[0].start).toHaveBeenCalledWith(2,0);});
 it('rejects expired completion instead of playing stale speech',async()=>{const x=setup();x.s.update();x.s.video.currentTime=5;await x.finish();expect(x.sources).toHaveLength(0);expect(x.s.trace.some((e:any)=>e.reason==='expired_after_synthesis')).toBe(true);});
 it.each(['pause','disable','seek','navigation'])('cancels pending audio on %s',async why=>{const x=setup();x.s.update();if(why==='pause'){x.s.video.paused=true;x.s.handlePause();}if(why==='disable')x.s.setEnabled(false);if(why==='seek')x.s.handleSeeking();if(why==='navigation')x.s.setCues([]);await x.finish();expect(x.sources).toHaveLength(0);expect(x.audio.duckVideo).not.toHaveBeenCalled();});
 it('does not depend on popup lifetime and records natural completion',async()=>{const x=setup();x.s.update();await x.finish();x.sources[0].onended();expect(x.s.trace.some((e:any)=>e.stage==='source_ended'&&e.natural)).toBe(true);expect(x.audio.unduckVideo).toHaveBeenCalled();});
 it('suspended context never ducks or starts a source',async()=>{const x=setup();x.ctx.state='suspended';x.s.update();await x.finish();expect(x.sources).toHaveLength(0);expect(x.audio.duckVideo).not.toHaveBeenCalled();expect(x.s.trace.some((e:any)=>e.stage==='playback_failed')).toBe(true);});
 it('missing Turkish text waits without inference',async()=>{const x=setup();x.s.cues[0].turkishText='';x.s.update();for(let i=0;i<10;i++)await Promise.resolve();expect(x.tts.synthesize).not.toHaveBeenCalled();expect(x.s.trace.some((e:any)=>e.stage==='translation_pending')).toBe(true);expect(x.s.trace.some((e:any)=>e.stage==='playback_failed')).toBe(false);});
});
describe('Antalia reconstruction',()=>{
 it('matches an independent real inverse DFT and squared-window overlap-add',()=>{
 const T=6,N=2048,H=512,bins=1025;const re=new Float32Array(bins*T),im=new Float32Array(bins*T);for(let t=0;t<T;t++){re[13*T+t]=1+t*.1;im[13*T+t]=.7;re[31*T+t]=.2;im[31*T+t]=-.3;}
 const y=new Float64Array(N+H*(T-1)),env=new Float64Array(y.length);
 for(let t=0;t<T;t++)for(let n=0;n<N;n++){let v=0;for(const k of [13,31])v+=2*(re[k*T+t]*Math.cos(2*Math.PI*k*n/N)-im[k*T+t]*Math.sin(2*Math.PI*k*n/N))/N;const w=.5*(1-Math.cos(2*Math.PI*n/N));y[t*H+n]+=v*w;env[t*H+n]+=w*w;}
 const got=istft(re,im,T);let error=0;for(let i=0;i<(T-1)*H;i++)error=Math.max(error,Math.abs(got[i]-y[N/2+i]/env[N/2+i]));expect(error).toBeLessThan(1e-8);
 });
 it('WSOLA at 1x preserves every sample without aliasing input',()=>{const a=Float32Array.from([.1,-.2,.3,0]);const b=AudioDSP.timeStretch(a,48000,1);expect(b).toEqual(a);expect(b).not.toBe(a);});
});

import {LiveCaptionHarvester} from '../src/subtitles/LiveCaptionHarvester';
import {Translator} from '../src/subtitles/Translator';
import {translateAcquiredCue} from '../src/subtitles/CaptionTranslation';
describe('Caption translation lifecycle',()=>{
 it('discards translation after its acquisition generation changes',async()=>{
  let resolve:any;vi.spyOn(Translator,'toTurkish').mockImplementation(()=>new Promise(r=>resolve=r));
  let current=true;const job=translateAcquiredCue(cue(),()=>current);current=false;resolve('Merhaba');expect(await job).toBeNull();vi.restoreAllMocks();
 });
 it('propagates translation failure without emitting source-language speech',async()=>{
  vi.spyOn(Translator,'toTurkish').mockRejectedValue(new Error('network unavailable'));
  await expect(translateAcquiredCue(cue(),()=>true)).rejects.toThrow('network unavailable');vi.restoreAllMocks();
 });
});
describe('Status and overlap',()=>{
 it('live source selects the oldest committed cue and performs no lookahead inference',async()=>{const x=setup();x.s.mode='live';x.s.cues=[cue('old',1,4),cue('new',1.1,4)];await x.s.prefetchUpcoming(1.2);expect(x.tts.synthesize).not.toHaveBeenCalled();expect(x.s.findCueIndexAt(1.2)).toBe(0);x.s.attempted.add('old');expect(x.s.findCueIndexAt(1.2)).toBe(1);});
 it('recovers from replacing cues during pending synthesis',async()=>{const x=setup();x.s.update();x.s.setCues([cue('new')]);await x.finish();x.s.update();expect(x.tts.synthesize).toHaveBeenCalledTimes(2);await x.finish();expect(x.sources).toHaveLength(1);expect(x.s.trace.some((e:any)=>e.stage==='source_started'&&e.correlationId===':new')).toBe(true);});
 it('enablement does not claim playing',()=>{const x=setup();const cb=vi.fn();x.s.setStatusCallback(cb);x.s.setCaptionMode('live');x.s.setEnabled(true);expect(cb).toHaveBeenLastCalledWith('waiting_for_live_caption',undefined);expect(x.sources).toHaveLength(0);});
 it('overlapping cues wait for the active source rather than double playback',async()=>{const x=setup();x.s.update();await x.finish();x.s.appendLiveCue(cue('two',1,4));x.s.update();expect(x.sources).toHaveLength(1);});
 it('does not mistake a blocked animation loop for a seek',()=>{const x=setup();x.s.mode='live';x.s.cues=[];x.s.activeSource={stop:vi.fn()};const source=x.s.activeSource;x.s.cues=[cue()];x.s.lastTickMs=performance.now()-3000;x.s.video.currentTime=4.2;x.s.update();expect(source.stop).not.toHaveBeenCalled();});
 it('never resubmits an interrupted live phrase on resume',async()=>{const x=setup();x.s.mode='live';x.s.update();await x.finish();x.s.handlePause();x.s.update();expect(x.tts.synthesize).toHaveBeenCalledTimes(1);});
 it('logs stale committed phrases rather than silently skipping them',()=>{const x=setup();x.s.mode='live';expect(x.s.findCueIndexAt(12)).toBe(-1);expect(x.s.trace.some((e:any)=>e.reason==='live_queue_expired')).toBe(true);});
 it('synthesizes a committed successor while audio is active without overlapping starts',async()=>{const x=setup();x.s.mode='live';x.s.update();await x.finish();x.s.appendLiveCue(cue('two',1.2,4));x.s.update();expect(x.tts.synthesize).toHaveBeenCalledTimes(2);await x.finish();expect(x.sources).toHaveLength(1);x.sources[0].onended();x.s.update();for(let i=0;i<15;i++)await Promise.resolve();expect(x.sources).toHaveLength(2);expect(x.tts.synthesize).toHaveBeenCalledTimes(2);});
 it('does not label completed historical live phrases as cancelled on seek',()=>{const x=setup();x.s.mode='live';x.s.attempted.add('one');x.s.appendLiveCue(cue('pending'));x.s.handleSeeking();expect(x.s.trace.some((e:any)=>e.correlationId===':one'&&e.reason==='seek_epoch_ended')).toBe(false);expect(x.s.trace.some((e:any)=>e.correlationId===':pending'&&e.reason==='seek_epoch_ended')).toBe(true);});
 it('model initialization failure is reported once with the cue identity',async()=>{const x=setup();x.tts.synthesize.mockRejectedValue(new Error('model initialization failed'));x.s.update();for(let i=0;i<15;i++)await Promise.resolve();x.s.update();expect(x.tts.synthesize).toHaveBeenCalledTimes(1);expect(x.s.trace.some((e:any)=>e.failureStage==='tts'&&e.reason==='model initialization failed')).toBe(true);});
});
