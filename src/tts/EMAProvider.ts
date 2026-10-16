import type { SynthesisOptions, SynthesisResult } from '../core/types';
import type { TTSProvider } from './TTSProvider';
import { createEMA, EMA_SAMPLE_RATE, type EMAVocabulary } from './EMAEngine';

// Bundled only: no model/voice substitution or remote inference fallback.
export class EMAProvider implements TTSProvider {
  readonly id = 'ema-lightning' as const;
  readonly name = 'EMA Lightning (Deneysel · 48 kHz)';
  readonly sampleRate = EMA_SAMPLE_RATE;
  readonly sizeBytes = 37_397_589;
  private engine: Awaited<ReturnType<typeof createEMA>> | null = null;
  private loadingPromise: Promise<void> | null = null;
  private generation = 0;
  private active: Promise<unknown> = Promise.resolve();
  get isLoaded(): boolean { return this.engine !== null; }

  async load(onProgress?: (loaded:number,total:number)=>void):Promise<void> {
    if(this.engine)return;
    if(this.loadingPromise)return this.loadingPromise;
    const generation=this.generation;
    const job=(async()=>{
      let loaded=0;
      const read=async(file:string)=>{
        const response=await fetch(chrome.runtime.getURL(`models/ema-lightning/${file}`));
        if(!response.ok)throw new Error(`EMA asset ${file}: HTTP ${response.status}`);
        return response.arrayBuffer();
      };
      const vocabulary=JSON.parse(new TextDecoder().decode(await read('vocab.json'))) as EMAVocabulary;
      const models=await Promise.all(['text_stage.onnx','sound_stage.onnx','decoder.onnx'].map(async file=>{
        const buffer=await read(file);loaded+=buffer.byteLength;onProgress?.(loaded,this.sizeBytes);return buffer;
      }));
      if(generation!==this.generation)throw new DOMException('EMA load cancelled','AbortError');
      const engine=await createEMA({vocabulary,models});
      if(generation!==this.generation){await engine.dispose();throw new DOMException('EMA load cancelled','AbortError');}
      this.engine=engine;
    })();
    this.loadingPromise=job;
    try{await job;}finally{if(this.loadingPromise===job)this.loadingPromise=null;}
  }

  synthesize(text:string,options:SynthesisOptions={}):Promise<SynthesisResult> {
    const generation=this.generation;
    const job=this.active.catch(()=>{}).then(async()=>{
      options.signal?.throwIfAborted();
      if(generation!==this.generation)throw new DOMException('EMA synthesis cancelled','AbortError');
      await this.load();options.signal?.throwIfAborted();
      if(generation!==this.generation||!this.engine)throw new DOMException('EMA synthesis cancelled','AbortError');
      const result=await this.engine.synthesize(text,options);
      if(generation!==this.generation)throw new DOMException('EMA synthesis cancelled','AbortError');
      return result;
    });
    this.active=job;return job;
  }

  async dispose():Promise<void> {
    ++this.generation;
    await this.active.catch(()=>{});
    await this.loadingPromise?.catch(()=>{});
    const engine=this.engine;this.engine=null;
    await engine?.dispose();
  }
}
