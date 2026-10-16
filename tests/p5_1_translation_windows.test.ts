import { describe, it, expect } from 'vitest';
import { translateCueWindows } from '../src/subtitles/PreloadedTranscriptPipeline';
const cues=Array.from({length:4},(_,index)=>({id:`cue-${index}`,index,startTime:index,endTime:index+1,duration:1,originalText:`Source ${index}`,turkishText:''}));
describe('P5.1 preloaded translation publication',()=>{
 it('publishes the first window while the remainder is still pending',async()=>{
  let release!:(text:string)=>void;const pending=new Promise<string>(r=>release=r);
  const published:number[][]=[];let calls=0;
  const job=translateCueWindows(cues,[2,3,0,1],async text=>++calls===1?'Türkçe iki\nTürkçe üç':pending,()=>true,entries=>published.push(entries.map(e=>e.index)),2);
  for(let i=0;i<8;i++)await Promise.resolve();
  expect(published).toEqual([[2,3]]);release('Türkçe sıfır\nTürkçe bir');await job;expect(published).toEqual([[2,3],[0,1]]);
 });
 it('does not publish an in-flight window after its video or seek epoch expires',async()=>{
  let current=true;let release!:(text:string)=>void;const pending=new Promise<string>(r=>release=r);const published:number[]=[];
  const job=translateCueWindows(cues,[0],()=>pending,()=>current,entries=>published.push(...entries.map(e=>e.index)));
  current=false;release('Türkçe');await job;expect(published).toEqual([]);
 });
});
