import { SynthesisOptions, SynthesisResult, TTSProviderId } from '../core/types';
import { TTSProvider } from './TTSProvider';
import { AntaliaProvider } from './AntaliaProvider';
import { EMAProvider } from './EMAProvider';

export class TTSManager {
  private static instance: TTSManager | null = null;
  private providers: Map<TTSProviderId, TTSProvider> = new Map();
  private audioCache: Map<string, SynthesisResult> = new Map();
  private pending = new Map<string, {job:Promise<SynthesisResult>;signal?:AbortSignal}>();
  private epoch = 0;
  private inferenceTail: Promise<unknown> = Promise.resolve();
  private maxCacheSize = 50; // LRU bounded cache to prevent unbounded memory growth during long sessions

  private constructor() {}

  static getInstance(): TTSManager {
    if (!this.instance) {
      this.instance = new TTSManager();
    }
    return this.instance;
  }

  getProvider(id: TTSProviderId): TTSProvider {
    if (id !== 'antalia' && id !== 'ema-lightning') {
      throw new Error('Piper Fahrettin is not available. Choose Antalia or EMA Lightning.');
    }
    const existing = this.providers.get(id);
    if (existing) return existing;
    const created: TTSProvider = id === 'ema-lightning' ? new EMAProvider() : new AntaliaProvider();
    this.providers.set(id, created);
    return created;
  }

  getAllProviders(): TTSProvider[] {
    return Array.from(this.providers.values());
  }

  getCacheKey(providerId: TTSProviderId, text: string, speed = 1.0): string {
    return `${providerId}:${speed.toFixed(2)}:${text.trim()}`;
  }

  hasCached(providerId: TTSProviderId, text: string, speed = 1.0): boolean {
    return this.audioCache.has(this.getCacheKey(providerId, text, speed));
  }

  getCached(providerId: TTSProviderId, text: string, speed = 1.0): SynthesisResult | undefined {
    return this.audioCache.get(this.getCacheKey(providerId, text, speed));
  }

  async warm(providerId: TTSProviderId): Promise<void> {
    const provider = this.getProvider(providerId);
    const started = Date.now();
    console.log('[VestaDub Startup]', JSON.stringify({ stage: 'provider_warm_started', wallMs: started, providerId, providerReportsLoaded: provider.isLoaded }));
    const epoch=this.epoch;
    const job=this.inferenceTail.catch(()=>{}).then(async()=>{if(epoch!==this.epoch)throw new DOMException('Stale warmup','AbortError');await provider.load();});
    this.inferenceTail=job;await job;
    console.log('[VestaDub Startup]', JSON.stringify({ stage: 'provider_warm_ready', wallMs: Date.now(), providerId, elapsedMs: Date.now() - started }));
  }

  async synthesize(
    providerId: TTSProviderId,
    text: string,
    options: SynthesisOptions = {}
  ): Promise<SynthesisResult> {
    options.signal?.throwIfAborted();
    const epoch=this.epoch;
    const cacheKey = this.getCacheKey(providerId, text, options.speed ?? 1.0);
    if (this.audioCache.has(cacheKey)) {
      const cached = this.audioCache.get(cacheKey)!;
      // Re-insert to refresh LRU order
      this.audioCache.delete(cacheKey);
      this.audioCache.set(cacheKey, cached);
      return cached;
    }

    const existing = this.pending.get(cacheKey);
    if (existing && existing.signal === options.signal) {
      const result=await existing.job;options.signal?.throwIfAborted();
      if(epoch!==this.epoch)throw new DOMException('Stale shared TTS result','AbortError');
      return result;
    }
    const provider = this.getProvider(providerId);
    const job = this.inferenceTail.catch(() => {}).then(async () => {
      options.signal?.throwIfAborted();
      if(epoch!==this.epoch)throw new DOMException('Stale TTS job','AbortError');
      return provider.synthesize(text, options);
    });
    this.pending.set(cacheKey, {job,signal:options.signal});
    this.inferenceTail = job;
    let result: SynthesisResult;
    try { result = await job; } finally { if(this.pending.get(cacheKey)?.job===job)this.pending.delete(cacheKey); }
    options.signal?.throwIfAborted();
    if(epoch!==this.epoch)throw new DOMException('Stale TTS result','AbortError');

    // Evict oldest item if exceeding maxCacheSize
    if (this.audioCache.size >= this.maxCacheSize) {
      const oldestKey = this.audioCache.keys().next().value;
      if (oldestKey) {
        this.audioCache.delete(oldestKey);
      }
    }

    this.audioCache.set(cacheKey, result);
    return result;
  }

  clearAudioCache(): void {
    this.audioCache.clear();
  }

  /** Discard old voice jobs and release unused sessions after in-flight ONNX returns. */
  releaseUnusedProviders(keep:TTSProviderId[]):Promise<void> {
    const epoch=++this.epoch;this.pending.clear();this.audioCache.clear();
    const job=this.inferenceTail.catch(()=>{}).then(async()=>{
      if(epoch!==this.epoch)return;
      for(const [id,provider] of this.providers)if(!keep.includes(id))await provider.dispose();
    });
    this.inferenceTail=job;return job;
  }

  async disposeAll(): Promise<void> {
    await this.releaseUnusedProviders([]);
  }
}
