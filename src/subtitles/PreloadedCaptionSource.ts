import { CaptionSource, CaptionSourceCapabilities, CaptionSourceContext, CaptionSourceHandlers } from './CaptionSource';
import { YouTubeSubtitleAdapter } from './YouTubeSubtitleAdapter';

export class PreloadedCaptionSource implements CaptionSource {
  private generation = 0;
  private capabilities: CaptionSourceCapabilities = {
    kind: 'preloaded_track', futureCuesAvailable: false, expectedAcquisitionLatencyMs: null,
    language: 'tr', confidence: null, availability: 'idle', timestamps: 'supplied', failureReason: null,
  };
  constructor(private adapter: Pick<YouTubeSubtitleAdapter, 'loadCues' | 'getVideoId'>) {}
  getCapabilities(): CaptionSourceCapabilities { return {...this.capabilities}; }
  async start(context: CaptionSourceContext, handlers: CaptionSourceHandlers): Promise<void> {
    const generation = ++this.generation;
    this.capabilities = {...this.capabilities, availability:'loading', futureCuesAvailable:false, failureReason:null};
    handlers.onStatus?.(this.getCapabilities());
    try {
      if (!context.track) throw new Error('MISSING_TRACK');
      const cues = await this.adapter.loadCues(context.track);
      if (generation !== this.generation || this.adapter.getVideoId() !== context.videoId) return;
      this.capabilities = {...this.capabilities, availability:cues.length ? 'available':'unavailable', futureCuesAvailable: cues.length > 0, failureReason:cues.length ? null:'NO_PRELOADED_CUES'};
      handlers.onStatus?.(this.getCapabilities());
      handlers.onCues(cues.map(c=>({...c,id:`${context.videoId}:${c.id}`})), true);
    } catch (error) {
      if (generation !== this.generation) return;
      this.capabilities = {...this.capabilities,availability:'unavailable',failureReason:String(error)};
      handlers.onStatus?.(this.getCapabilities());
      throw error;
    }
  }
  stop(): void { this.generation++; this.capabilities={...this.capabilities,availability:'idle',futureCuesAvailable:false}; }
}
