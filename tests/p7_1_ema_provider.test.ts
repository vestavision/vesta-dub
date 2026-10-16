import {beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({create:vi.fn(),synthesize:vi.fn(),dispose:vi.fn()}));
vi.mock('../src/tts/EMAEngine',()=>({EMA_SAMPLE_RATE:48000,createEMA:mock.create}));
import {EMAProvider} from '../src/tts/EMAProvider';
beforeEach(()=>{
 vi.clearAllMocks();
 mock.create.mockResolvedValue({synthesize:mock.synthesize,dispose:mock.dispose});
 mock.synthesize.mockResolvedValue({audio:new Float32Array([.1]),sampleRate:48000,duration:1/48000});
 vi.stubGlobal('chrome',{runtime:{getURL:(p:string)=>'chrome-extension://test/'+p}});
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,arrayBuffer:async()=>url.endsWith('vocab.json')?new TextEncoder().encode('{}').buffer:new ArrayBuffer(4)})));
});
describe('P7.1 EMA lifecycle',()=>{
 it('deduplicates concurrent loads and uses bundled assets only',async()=>{
  const p=new EMAProvider();await Promise.all([p.load(),p.load(),p.load()]);
  expect(mock.create).toHaveBeenCalledTimes(1);expect(fetch).toHaveBeenCalledTimes(4);
  expect(vi.mocked(fetch).mock.calls.every(([url])=>String(url).startsWith('chrome-extension://test/models/ema-lightning/'))).toBe(true);
  await p.dispose();expect(p.isLoaded).toBe(false);expect(mock.dispose).toHaveBeenCalledTimes(1);
 });
 it('releases an engine when disposal races initialization',async()=>{
  let resolve!:(value:unknown)=>void;
  mock.create.mockImplementation(()=>new Promise(r=>resolve=r));
  const p=new EMAProvider(),loading=p.load();const failure=expect(loading).rejects.toMatchObject({name:'AbortError'});
  await vi.waitFor(()=>expect(mock.create).toHaveBeenCalled());
  const disposed=p.dispose();resolve({synthesize:mock.synthesize,dispose:mock.dispose});
  await failure;await disposed;expect(p.isLoaded).toBe(false);expect(mock.dispose).toHaveBeenCalledTimes(1);
 });
 it('does not run cancelled jobs and releases failed initialization for retry',async()=>{
  const p=new EMAProvider(),abort=new AbortController();abort.abort();
  await expect(p.synthesize('iptal',{signal:abort.signal})).rejects.toMatchObject({name:'AbortError'});
  expect(mock.create).not.toHaveBeenCalled();
  mock.create.mockRejectedValueOnce(new Error('load failure'));await expect(p.load()).rejects.toThrow('load failure');
  await p.load();expect(p.isLoaded).toBe(true);await p.dispose();
 });
 it('waits for in-flight synthesis before releasing sessions and rejects its stale result',async()=>{
  let resolve!:(value:unknown)=>void;mock.synthesize.mockImplementation(()=>new Promise(r=>resolve=r));
  const p=new EMAProvider(),job=p.synthesize('Merhaba.');const failure=expect(job).rejects.toMatchObject({name:'AbortError'});
  await vi.waitFor(()=>expect(mock.synthesize).toHaveBeenCalled());const disposed=p.dispose();
  expect(mock.dispose).not.toHaveBeenCalled();resolve({audio:new Float32Array([.1]),duration:1/48000,sampleRate:48000});
  await failure;await disposed;expect(mock.dispose).toHaveBeenCalledTimes(1);
 });
});
