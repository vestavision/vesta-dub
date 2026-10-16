import {describe,it,expect,vi} from 'vitest';
import {prepareSpeech} from '../src/tts/FillerPreparation';
import {TurkishSpeechNormalizer} from '../src/tts/TurkishSpeechNormalizer';
import {DubbingScheduler} from '../src/audio/DubbingScheduler';
import {SpeakerManager} from '../src/speaker/SpeakerManager';
import type {SubtitleCue} from '../src/core/types';
describe('P7 conservative filler preparation',()=>{
 it('suppresses corroborated hesitations while preserving immutable display text and token offsets',()=>{
  const input='Um, fiyatı 100 dolar.';const p=prepareSpeech(input,{sourceText:'Um, it costs 100 dollars.'});
  expect(p.displayText).toBe(input);expect(p.filteredText).toBe('fiyatı 100 dolar.');expect(p.spokenText).toContain('yüz');
  expect(p.tokens.filter(t=>t.action==='remove').map(t=>input.slice(t.start,t.end))).toEqual(['Um']);expect(p.tokens[0].sourceMatch?.text).toBe('Um');
 });
 it('does not guess semantic omissions without source evidence',()=>{
  expect(prepareSpeech('Um, bunu yapalım.').removedTokenCount).toBe(0);
  for(const t of ['Hmm, emin değilim.','Ah, harika!','Oh, wow!','Uh-huh, evet.','mm-hmm','Ee, şimdi ne olacak?','er','Um?','Um...','UM, model adı.','Um, belki.','"um" kelimesi.','beş um'])expect(prepareSpeech(t,{sourceText:t}).filteredText).toBe(t);
  for(const t of ['uh','uh-uh','we heard uh oh','a 5 um measurement','Visit um.com today.','use foo_um now','Professor Um explained this'])expect(prepareSpeech(t,{sourceText:t}).filteredText).toBe(t);
  expect(prepareSpeech('this uh video',{sourceText:'this uh video'}).filteredText).toBe('this video');
 });
 it('keeps intentional repetition and suppresses only explicitly evidenced revision duplication',()=>{
  expect(prepareSpeech('çok çok iyi',{sourceText:'very very good'}).filteredText).toBe('çok çok iyi');
  const p=prepareSpeech('çok çok iyi',{verifiedAsrDuplicates:[{start:4,end:7,duplicateOf:'çok',evidenceId:'revision:1'}]});
  expect(p.filteredText).toBe('çok iyi');expect(p.tokens[1].category).toBe('asr-duplication');
 });
 it('normalizes retained text exactly as before and omits only clear filler-only input',()=>{
  for(const t of ['AI ve GPT, OpenAI ile MacBook üzerinde çalışır.','100 dolar ve 20 avro.','Tamam.'])expect(prepareSpeech(t,{sourceText:t}).spokenText).toBe(TurkishSpeechNormalizer.normalize(t).spokenText);
  const p=prepareSpeech('ııı, um.',{sourceText:'um, uh.'});expect(p.omitted).toBe(true);expect(p.spokenText).toBe('');
 });
 it('never requests empty TTS or silence and preserves neighboring cue timestamps',async()=>{
  const tts={synthesize:vi.fn()},audio={createAudioBuffer:vi.fn(),unduckVideo:vi.fn()};
  const scheduler=new DubbingScheduler(audio as never,tts as never,new SpeakerManager());
  const cues:SubtitleCue[]=[{id:'first',index:0,startTime:1,endTime:2,duration:1,originalText:'um',turkishText:'um'},{id:'next',index:1,startTime:2,endTime:5,duration:3,originalText:'Meaningful speech',turkishText:'Anlamlı konuşma.'}];
  const before=JSON.stringify(cues);scheduler.setCues(cues);expect(await scheduler['ensureSynthesized'](cues[0])).toBeNull();expect(await scheduler['ensureSynthesized'](cues[0])).toBeNull();
  expect(tts.synthesize).not.toHaveBeenCalled();expect(audio.createAudioBuffer).not.toHaveBeenCalled();expect(cues[1].startTime).toBe(2);expect(cues[1].endTime).toBe(5);expect(cues[0].turkishText).toBe('um');
  expect(JSON.parse(before).map((c:SubtitleCue)=>[c.startTime,c.endTime])).toEqual(cues.map(c=>[c.startTime,c.endTime]));
  tts.synthesize.mockResolvedValue({audio:Float32Array.from({length:4800},(_,i)=>Math.sin(i/10)*.1),sampleRate:48000,duration:.1});
  audio.createAudioBuffer.mockResolvedValue({duration:.1,length:4800,numberOfChannels:1});
  expect(await scheduler['ensureSynthesized'](cues[1])).not.toBeNull();expect(tts.synthesize).toHaveBeenCalledTimes(1);expect(cues[1].turkishText).toBe('Anlamlı konuşma.');
  scheduler.patchCueTranslation('first','Yeni konuşma.');expect(scheduler['fillerOmissions'].has('first')).toBe(false);expect(scheduler['attempted'].has('first')).toBe(false);
 });
});
