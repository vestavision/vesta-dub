import { TurkishSpeechNormalizer } from "../tts/TurkishSpeechNormalizer";
import { prepareSpeech } from '../tts/FillerPreparation';
import { CaptionSourceCapabilities } from '../subtitles/CaptionSource';
import { SubtitleCue, DubbingMetrics, CueSyncMetadata, RuntimeStatus } from '../core/types';
import { AudioContextManager } from './AudioContextManager';
import { TTSManager } from '../tts/TTSManager';
import { SpeakerManager } from '../speaker/SpeakerManager';
import { AdaptiveSyncEngine, SyncDecision } from './AdaptiveSyncEngine';
import { AudioDSP } from '../dsp/AudioDSP';
import { SemanticRefiner } from '../translation/SemanticRefiner';
import { DogfoodSessionRecorder } from '../diagnostics/DogfoodSessionRecorder';
import { isPauseFeatureEnabled, noteExtensionEvent } from '../diagnostics/PauseIsolation';
import { LocalTelemetryRecorder } from '../telemetry/LocalTelemetryRecorder';
import { TranslationMethod } from '../telemetry/TelemetrySchema';
import { Translator } from '../subtitles/Translator';

export interface CacheEntry {
  buffer: AudioBuffer;
  decision: SyncDecision;
  duration: number;
  pitchDeviationCents?: number;
  synthLatencyMs: number;
  isRefined: boolean;
  refinedText?: string;
  originalSyllables: number;
  refinedSyllables: number;
  strategyUsed: string;
}

export class DubbingScheduler {
  private video: HTMLVideoElement | null = null;
  private cues: SubtitleCue[] = [];
  private ttsManager: TTSManager;
  private speakerManager: SpeakerManager;
  private audioManager: AudioContextManager;
  private syncEngine: AdaptiveSyncEngine;
  private semanticRefiner: SemanticRefiner;

  private enabled = false;
  private lookaheadSec = 14.0;
  private maxCacheSize = 25; // LRU bounded cache to avoid unbounded memory growth
  private activeSource: AudioBufferSourceNode | null = null;
  private activeCueId: string | null = null;
  private activeCueIndex = -1;

  // Video context for dogfood telemetry
  private currentVideoId = '';
  private currentTrackType: 'asr' | 'standard' | 'manual' = 'standard';
  private currentSourceLanguage = 'en';
  private currentTranslationMethod: TranslationMethod = 'youtube_tlang';

  private bufferCache = new Map<string, CacheEntry>();
  private pendingSyntheses = new Set<string>();
  private jobs = new Map<string, Promise<CacheEntry | null>>();
  private generation = 0;
  private starting = false;
  private attempted = new Set<string>();
  private liveSubmitted = new Set<string>();
  private fillerOmissions = new Map<string, string>();
  private mode: 'preloaded' | 'live' = 'preloaded';
  private onStatus?: (status: RuntimeStatus, reason?: string) => void;
  readonly trace: Record<string, unknown>[] = [];

  setStatusCallback(cb: (status: RuntimeStatus, reason?: string) => void): void { this.onStatus = cb; }
  private status(status: RuntimeStatus, reason?: string): void { this.onStatus?.(status, reason); }
  log(cue: SubtitleCue, stage: string, detail: Record<string, unknown> = {}): void {
    const event = { nativeRequestId: cue.acquisition?.requestId, correlationId: `${this.currentVideoId}:${cue.id}`, stage, wallMs: Date.now(), videoSec: this.video?.currentTime, activeSources: this.activeSource ? 1 : 0, ...detail };
    this.trace.push(event);
    if (this.trace.length > 500) this.trace.shift();
    console.log('[VestaDub Trace]', JSON.stringify(event));
  }
  setCaptionSource(source: CaptionSourceCapabilities): void { const mode = source.futureCuesAvailable ? 'preloaded' : 'live'; if (this.mode !== mode) this.setCaptionMode(mode); }
  setCaptionMode(mode: 'preloaded' | 'live'): void { this.mode = mode; if (this.enabled) this.status(mode === 'live' ? 'waiting_for_live_caption' : 'buffering'); }
  appendLiveCue(cue: SubtitleCue): void {
    this.mode = 'live';
    if (this.cues.some(c => c.id === cue.id)) return;
    if(this.cues.length>=100) { const removed=this.cues.shift()!; if(!this.attempted.has(removed.id)) this.log(removed,'cancelled',{reason:'live_queue_overflow'}); this.attempted.delete(removed.id);this.liveSubmitted.delete(removed.id);this.bufferCache.delete(removed.id);this.fillerOmissions.delete(removed.id); }
    this.cues = [...this.cues, cue].sort((a,b) => a.startTime-b.startTime);

  }
  private ensureSynthesized(cue: SubtitleCue): Promise<CacheEntry | null> {
    if (this.fillerOmissions.get(cue.id) === cue.turkishText) { this.attempted.add(cue.id); return Promise.resolve(null); }
    const cached = this.bufferCache.get(cue.id);
    if (cached) return Promise.resolve(cached);
    const existing = this.jobs.get(cue.id);
    if (existing) return existing;
    if(this.mode==='live' && this.liveSubmitted.has(cue.id)) return Promise.resolve(null);
    if(this.mode==='live') this.liveSubmitted.add(cue.id);
    const generation = this.generation;
    this.pendingSyntheses.add(cue.id);
    const job = this.synthesizeCue(cue, generation).finally(() => {
      if (this.jobs.get(cue.id) === job) { this.jobs.delete(cue.id); this.pendingSyntheses.delete(cue.id); }
    });
    this.jobs.set(cue.id, job);
    return job;
  }

  private lastTime = 0;
  private lastTickMs = performance.now();
  private isSeeking = false;
  private animFrameId: number | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private loopArmed = false;
  private queuedSource: AudioBufferSourceNode | null = null;
  private queuedCueId: string | null = null;
  private queuing = false;
  private heartbeatSource: AudioBufferSourceNode | null = null;
  private playbackGapsSec: number[] = [];
  private starvationCount = 0;
  private startupMarked = false;

  // Telemetry metrics tracking
  private recentDrifts: number[] = [];
  private recentOverflows: number[] = [];
  private underrunCount = 0;
  private lastSourceEndContextTime = 0;
  private lastSpokenText = '';

  private getAdaptivePauseSec(cue: SubtitleCue): number {
    if (!this.lastSpokenText.trim()) return 0;
    const text = this.lastSpokenText.trim();
    const isSentenceEnd = /[.!?]["')]*$/.test(text);
    const isClauseEnd = /[,;:]["')]*$/.test(text);
    // Preloaded sentences already group fragments. Pause only at real boundaries.
    // Live captions keep the P4 pause so short committed phrases stay separated.
    if (this.mode !== 'live') {
      return isSentenceEnd ? 0.22 : 0.06;
    }
    let targetPause = isSentenceEnd ? 0.35 : isClauseEnd ? 0.18 : 0.08;

    if (this.mode === 'live' && this.video) {
      const lateSec = Math.max(0, this.video.currentTime - cue.startTime);
      if (lateSec > 4.0) {
        targetPause = Math.min(targetPause, 0.05);
      } else if (lateSec > 2.0) {
        targetPause = Math.min(targetPause, 0.10);
      }
    }
    return targetPause;
  }

  private onMetrics?: (metrics: DubbingMetrics) => void;

  constructor(
    audioManager: AudioContextManager,
    ttsManager: TTSManager,
    speakerManager: SpeakerManager,
    syncEngine: AdaptiveSyncEngine = new AdaptiveSyncEngine(),
    semanticRefiner: SemanticRefiner = new SemanticRefiner()
  ) {
    this.audioManager = audioManager;
    this.ttsManager = ttsManager;
    this.speakerManager = speakerManager;
    this.syncEngine = syncEngine;
    this.semanticRefiner = semanticRefiner;
  }

  setMetricsCallback(cb: (metrics: DubbingMetrics) => void): void {
    this.onMetrics = cb;
  }

  setVideoContext(
    videoId: string,
    trackType: 'asr' | 'standard' | 'manual' = 'standard',
    sourceLanguage = 'en',
    translationMethod: TranslationMethod = 'youtube_tlang'
  ): void {
    this.currentVideoId = videoId;
    this.currentTrackType = trackType;
    this.currentSourceLanguage = sourceLanguage;
    this.currentTranslationMethod = translationMethod;
  }

  setCues(cues: SubtitleCue[]): void {
    this.invalidateSynthesis();
    this.starting = false;
    this.stopCurrentAudio('captions_replaced');
    this.mode = 'preloaded';
    this.jobs.clear();
    this.attempted.clear();
    this.liveSubmitted.clear();
    this.fillerOmissions.clear();
    this.cues = [...cues].sort((a,b) => a.startTime-b.startTime);
    this.startupMarked = false;
    for (const cue of this.cues) {
      this.log(cue, 'caption_received', { mode: 'preloaded', boundary: cue.assembly?.boundary, confidence: cue.assembly?.confidence });
      if (cue.turkishText?.trim()) this.log(cue, 'translation_ready', { text: cue.turkishText });
    }
    this.bufferCache.clear();
    this.pendingSyntheses.clear();
    this.activeCueIndex = -1;
    this.activeCueId = null;
    this.recentDrifts = [];
    this.recentOverflows = [];
    const slot = this.speakerManager.getSlot();
    this.onMetrics?.({ activeCueIndex: -1, currentCueText: '', currentSpeakerId: slot.name, activeProviderId: slot.providerId,
      synthesisLatencyMs: null, syncDriftMs: null, isOverflowing: false, realtimeFactor: null, bufferedCuesCount: 0,
      totalCuesCount: this.cues.length, p95StartDriftMs: null, p95OverflowMs: null, underrunCount: 0 });
  }

  attachVideo(video: HTMLVideoElement): void {
    this.detachVideo();
    this.video = video;
    this.lastTime = video.currentTime;
    this.lastTickMs = performance.now();
    this.audioManager.attachVideo(video);

    if (isPauseFeatureEnabled('mediaLifecycleListener')) {
      video.addEventListener('play', this.handlePlay);
      video.addEventListener('pause', this.handlePause);
      video.addEventListener('seeking', this.handleSeeking);
      video.addEventListener('seeked', this.handleSeeked);
      video.addEventListener('ratechange', this.handleRateChange);
    }

    if (isPauseFeatureEnabled('ttsScheduler')) this.startLoop();
  }

  detachVideo(): void {
    if (!this.video) return;
    this.stopCurrentAudio();
    this.stopLoop();

    this.video.removeEventListener('play', this.handlePlay);
    this.video.removeEventListener('pause', this.handlePause);
    this.video.removeEventListener('seeking', this.handleSeeking);
    this.video.removeEventListener('seeked', this.handleSeeked);
    this.video.removeEventListener('ratechange', this.handleRateChange);
    this.video = null;
  }

  private synthesisAbort = new AbortController();
  private invalidateSynthesis():void {
    ++this.generation;this.synthesisAbort.abort();this.synthesisAbort=new AbortController();
    this.jobs.clear();this.pendingSyntheses.clear();
  }

  /** Explicit voice/settings switch: never play cached audio from the previous voice. */
  refreshVoice():void {
    this.invalidateSynthesis();this.bufferCache.clear();this.starting=false;this.queuing=false;
    this.releaseInterruptedPreloadedCues();if(this.mode==='preloaded')this.attempted.clear();this.stopCurrentAudio('provider_changed');
    this.activeCueIndex=-1;this.activeCueId=null;
    this.status(this.enabled?'buffering':'idle');
  }

  setEnabled(enabled: boolean): void {
    const next = enabled && isPauseFeatureEnabled('ttsScheduler');
    this.enabled = next;
    this.invalidateSynthesis();
    this.starting = false;
    this.status(next ? (this.mode === 'live' ? 'waiting_for_live_caption' : 'buffering') : 'idle');
    noteExtensionEvent('dubbing_state', { enabled: next, requested: enabled });
    if (!next) {
      this.releaseInterruptedPreloadedCues();
      this.stopCurrentAudio('disabled');
      this.stopHeartbeat();
      this.audioManager.unduckVideo();
    } else {
      void this.pumpHeartbeat();
    }
  }

  /** Fill in Turkish text without resetting the playback epoch or the audio cache. */
  patchCueTranslation(cueId: string, turkishText: string, compromises?: string[]): void {
    const cue = this.cues.find(item => item.id === cueId);
    if (!cue || !turkishText.trim()) return;
    if (this.fillerOmissions.has(cueId) && this.fillerOmissions.get(cueId) !== turkishText.trim()) {
      this.fillerOmissions.delete(cueId); this.attempted.delete(cueId); this.liveSubmitted.delete(cueId);
    }
    cue.turkishText = turkishText.trim();
    if (cue.assembly) cue.assembly.semanticCompromises = compromises || [];
    this.log(cue, 'translation_ready', { text: cue.turkishText, compromises: compromises || [] });
  }

  recordStartup(detail: Record<string, unknown>): void {
    this.trace.push({ correlationId: `${this.currentVideoId}:startup`, stage: 'startup_latency', wallMs: Date.now(), videoSec: this.video?.currentTime, ...detail });
    if (this.trace.length > 500) this.trace.shift();
  }

  kick(): void {
    this.update();
  }

  getContinuityStats(): { gaps: number[]; p50: number | null; p95: number | null; max: number | null; underruns: number; starvation: number } {
    return {
      gaps: [...this.playbackGapsSec],
      p50: percentile(this.playbackGapsSec, 0.5),
      p95: percentile(this.playbackGapsSec, 0.95),
      max: this.playbackGapsSec.length ? Math.max(...this.playbackGapsSec) : null,
      underruns: this.underrunCount,
      starvation: this.starvationCount,
    };
  }

  private releaseInterruptedPreloadedCues(): void {
    if (this.mode === 'live') return;
    if (this.activeCueId) this.attempted.delete(this.activeCueId);
    if (this.queuedCueId) this.attempted.delete(this.queuedCueId);
  }

  private handlePlay = (): void => {
    this.lastTime=this.video?.currentTime || 0;this.lastTickMs=performance.now();
    DogfoodSessionRecorder.getInstance().onVideoPlay();
    this.audioManager.getContext().catch(e => this.status('error', `audio_context: ${e.message}`));
  };

  private handlePause = (): void => {
    DogfoodSessionRecorder.getInstance().onVideoPause();
    this.invalidateSynthesis();
    this.starting = false;
    this.releaseInterruptedPreloadedCues();
    this.stopCurrentAudio('pause');
    this.status('idle');
  };

  private handleSeeking = (): void => {
    this.isSeeking = true;
    this.invalidateSynthesis();
    this.starting = false;
    if(this.mode==='live') { for(const cue of this.cues) if(!this.attempted.has(cue.id)) this.log(cue,'cancelled',{reason:'seek_epoch_ended'}); this.cues=[];this.bufferCache.clear();this.liveSubmitted.clear(); }
    this.attempted.clear();
    this.jobs.clear();
    this.pendingSyntheses.clear();
    if (this.activeCueId) {
      DogfoodSessionRecorder.getInstance().recordCueInterrupted(this.activeCueId, 'user_seeking');
    }
    this.stopCurrentAudio('seek');
  };

  private handleSeeked = (): void => {
    this.isSeeking = false;
    this.activeCueIndex = -1;
    this.activeCueId = null;
    if (this.video) {
      this.lastTime = this.video.currentTime;
    }
  };

  private handleRateChange = (): void => {
    if (this.activeSource && this.video) {
      this.activeSource.playbackRate.value = this.video.playbackRate;
    }
  };

  private startLoop(): void {
    if (this.loopArmed) return;
    this.loopArmed = true;
    const tick = () => { this.update(); };
    const arm = () => {
      if (this.animFrameId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
      if (this.clockTimer !== null) {
        clearInterval(this.clockTimer);
        this.clockTimer = null;
      }
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      // Background tabs suspend requestAnimationFrame. An interval keeps the
      // lookahead queue fed. Chrome may clamp it to 1s; cues are pre-scheduled
      // on the AudioContext timeline so speech continues between ticks.
      if (hidden || typeof requestAnimationFrame !== 'function') {
        this.clockTimer = setInterval(tick, 250);
      } else {
        const frame = () => {
          tick();
          this.animFrameId = requestAnimationFrame(frame);
        };
        this.animFrameId = requestAnimationFrame(frame);
      }
    };
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.visibilityHandler = () => {
        this.trace.push({ correlationId: `${this.currentVideoId}:visibility`, stage: 'visibility_changed', wallMs: Date.now(), videoSec: this.video?.currentTime, visibility: document.visibilityState });
        arm();
        if (document.visibilityState === 'visible' && this.enabled) {
          this.audioManager.getContext().catch(error => this.status('error', `audio_context: ${error instanceof Error ? error.message : String(error)}`));
        }
        this.update();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    arm();
  }

  private stopLoop(): void {
    if (this.animFrameId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.animFrameId);
    this.animFrameId = null;
    if (this.clockTimer !== null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.loopArmed = false;
    this.stopHeartbeat();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatSource) return;
    const source = this.heartbeatSource;
    this.heartbeatSource = null;
    source.onended = null;
    try { source.stop(); } catch { /* already stopped */ }
  }

  /** Audio-thread pulse. onended still fires when the document is hidden. */
  private async pumpHeartbeat(): Promise<void> {
    if (!this.enabled || !this.loopArmed || this.heartbeatSource) return;
    try {
      const ctx = await this.audioManager.getContext(false);
      if (!ctx || ctx.state !== 'running' || typeof ctx.createBuffer !== 'function') return;
      const frames = Math.max(1, Math.floor(ctx.sampleRate * 0.5));
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.onended = () => {
        if (this.heartbeatSource !== source) return;
        this.heartbeatSource = null;
        this.update();
        void this.pumpHeartbeat();
      };
      this.heartbeatSource = source;
      source.start();
    } catch {
      this.heartbeatSource = null;
    }
  }

  /**
   * Main scheduler tick
   */
  private update(): void {
    if (!this.video || !this.enabled || this.video.paused || this.isSeeking || this.cues.length === 0) return;

    const currentTime = this.video.currentTime;

    // Detect large seek jump (> 1.2s)
    const tickMs=performance.now();
    const expectedAdvance=(tickMs-this.lastTickMs)/1000*this.video.playbackRate;
    if (Math.abs(currentTime - this.lastTime - expectedAdvance) > 1.2) {
      if (this.activeCueId) {
        DogfoodSessionRecorder.getInstance().recordCueInterrupted(this.activeCueId, 'seek_jump');
      }
      this.invalidateSynthesis();
      this.starting = false;
      this.attempted.clear();
      this.stopCurrentAudio('seek_jump');
      this.activeCueIndex = -1;
      this.activeCueId = null;
    }
    this.lastTime = currentTime;
    this.lastTickMs = tickMs;

    // Committed live work is ready now, including while the preceding phrase plays.
    // This is not future-caption lookahead. Submission is single-flight and occurrence-scoped.
    if(this.mode==='live' && this.pendingSyntheses.size===0) {
      const ready=this.findCueIndexAt(currentTime);
      if(ready>=0 && !this.bufferCache.has(this.cues[ready].id)) void this.ensureSynthesized(this.cues[ready]);
    }
    // 1. Preloaded track lookahead only.
    this.prefetchUpcoming(currentTime);
    this.queueReadySuccessor();

    // 2. Find cue matching current video time
    const cueIndex = this.findCueIndexAt(currentTime);

    if (cueIndex !== -1) {
      const cue = this.cues[cueIndex];
      if (!cue.turkishText?.trim()) {
        if (!this.trace.some(event => event.stage === 'translation_pending' && event.correlationId === `${this.currentVideoId}:${cue.id}`)) {
          this.log(cue, 'translation_pending', {});
        }
        return;
      }
      if (!this.activeSource && !this.starting && !this.attempted.has(cue.id)) {
        this.starting = true;
        const generation = this.generation;
        this.playCue(cue, cueIndex, currentTime).catch(e => { this.log(cue, 'playback_failed', { reason: e.message }); this.status('error', `playback: ${e.message}`); }).finally(() => { if (generation === this.generation) this.starting = false; });
      }
    }
  }

  /** Place the next ready sentence on the audio timeline before the current one ends. */
  private queueReadySuccessor(): void {
    if (this.mode === 'live' || !this.activeSource || this.queuedSource || this.queuing || !this.activeCueId) return;
    const index = this.cues.findIndex(cue => cue.id === this.activeCueId);
    const next = index >= 0 ? this.cues[index + 1] : undefined;
    if (!next || !next.turkishText?.trim() || this.attempted.has(next.id) || !this.bufferCache.has(next.id)) return;
    this.queuing = true;
    const generation = this.generation;
    void this.playCue(next, index + 1, this.video?.currentTime || next.startTime, { queueOnly: true }).finally(() => {
      if (generation === this.generation) this.queuing = false;
    });
  }

  private findCueIndexAt(time: number): number {
    if (this.mode === 'live') {
      // FIFO committed phrases. Expiry is explicit and uses a bounded delayed-live window.
      for (let i=0;i<this.cues.length;i++) {
        const cue=this.cues[i];
        if(this.attempted.has(cue.id)) continue;
        if(time>=cue.startTime+10) {this.attempted.add(cue.id);this.log(cue,'cancelled',{reason:'live_queue_expired',lateSec:time-cue.startTime});continue;}
        if(time>=cue.startTime) return i;
      }
      return -1;
    }
    return this.cues.findIndex(c => time >= c.startTime && time < c.endTime);
  }

  /**
   * Prefetch upcoming cues within lookahead window
   */
  private async prefetchUpcoming(currentTime: number): Promise<void> {
    if (this.mode === 'live') return; // Live acquisition is demand-driven; never prefetch revisions as future cues.
    const windowEnd = currentTime + this.lookaheadSec;
    const upcoming = this.cues.filter(
      c => c.turkishText?.trim() && c.endTime > currentTime && c.startTime <= windowEnd && !this.attempted.has(c.id)
    );

    // Evict items far behind current time to prevent memory bloat
    if (this.bufferCache.size > this.maxCacheSize) {
      for (const [id] of this.bufferCache.entries()) {
        const cue = this.cues.find(c => c.id === id);
        if (cue && (cue.endTime < currentTime - 10.0 || cue.startTime > currentTime + 30.0)) {
          this.bufferCache.delete(id);
        }
      }
    }

    this.updateCacheMemoryTelemetry();

    for (const cue of upcoming) {
      if (this.bufferCache.has(cue.id) || this.pendingSyntheses.has(cue.id)) {
        continue;
      }
      // Serialize model inference; live captions have no future lookahead.
      if (this.pendingSyntheses.size > 0) break;
      void this.ensureSynthesized(cue);
      break;
    }
  }

  private updateCacheMemoryTelemetry(): void {
    let totalBytes = 0;
    for (const entry of this.bufferCache.values()) {
      // 4 bytes per float32 sample * channels * length
      totalBytes += entry.buffer.length * entry.buffer.numberOfChannels * 4;
    }
    const estimatedCacheMb = totalBytes / (1024 * 1024);
    LocalTelemetryRecorder.getInstance().updateMemoryEstimate(estimatedCacheMb);
  }

  /**
   * Synthesize cue, apply AdaptiveSync evaluation, SemanticRefiner Strategy B, WSOLA pitch-preserving stretch, and gain staging
   */
  private async synthesizeCue(cue: SubtitleCue, generation = this.generation): Promise<CacheEntry | null> {
    const t0 = performance.now();
    const signal=this.synthesisAbort.signal;
    try {
      const speakerId = cue.speakerId || this.speakerManager.getDefaultSpeakerId();
      const slot = this.speakerManager.getSlot(speakerId);
      let textToSpeak = cue.turkishText?.trim();
      if (!textToSpeak) {
        if (!this.trace.some(event => event.stage === 'translation_pending' && event.correlationId === `${this.currentVideoId}:${cue.id}`)) {
          this.log(cue, 'translation_pending', {});
        }
        return null;
      }

      // P4.2: Turkish Speech Normalization
      const prep = prepareSpeech(cue.turkishText, { sourceText: cue.originalText });
      cue.speechPreparation = prep;
      cue.spokenText = prep.spokenText;
      textToSpeak = prep.spokenText;
      if (prep.removedTokenCount) this.log(cue, 'filler_prepared', { rulesVersion: prep.rulesVersion, tokens: prep.tokens, removedTokenCount: prep.removedTokenCount });
      if (prep.omitted) {
        if (generation === this.generation) { this.fillerOmissions.set(cue.id, cue.turkishText); this.attempted.add(cue.id); }
        this.log(cue, 'filler_only_omitted', { sourceStartMs: cue.startTime * 1000, sourceEndMs: cue.endTime * 1000 });
        return null;
      }

      if(!this.activeSource) this.status('loading_model');
      this.log(cue, 'tts_started', { text: textToSpeak, displayText: cue.turkishText, provider: slot.providerId });

      let result = await this.ttsManager.synthesize(slot.providerId, textToSpeak, {
        speed: slot.speed,
        signal,
      });

      if (!result.audio || result.audio.length === 0 || !result.audio.every(Number.isFinite) || !result.audio.some(v => Math.abs(v) > 1e-5)) {
        throw new Error('TTS returned empty audio samples');
      }

      signal.throwIfAborted();
      // Next cue start time for silence gap absorption
      const cueIdx = this.cues.findIndex(c => c.id === cue.id);
      const nextCue = this.cues[cueIdx + 1];
      let decision = this.syncEngine.evaluate(cue, result.duration, this.mode==='live' ? undefined : nextCue?.startTime);
      if(this.mode==='live') {decision.playbackSpeed=Math.max(1,Math.min(1.12,result.duration/cue.duration));decision.strategy=decision.playbackSpeed>1?'time_stretched':'normal';}
      // P4's accepted ceiling. Do not accelerate a whole sentence to hide scheduler starvation.
      if (decision.playbackSpeed > 1.12) {
        const spilled = Math.max(0, result.duration / 1.12 - decision.availableWindow);
        decision = { ...decision, playbackSpeed: 1.12, strategy: 'time_stretched', isCompromised: true, compromiseSec: Number(spilled.toFixed(2)), overflowSec: Number(spilled.toFixed(2)) };
      }

      let isRefined = false;
      let refinedText = textToSpeak;
      let strategyUsed = 'strategy-a';
      let originalSyllables = Math.round(textToSpeak.length / 3);
      let refinedSyllables = originalSyllables;

      // If severe overflow or concise phrasing requested, attempt Strategy B semantic refinement
      if (this.mode !== 'live' && (decision.strategy === 'concise_resynthesized' || decision.isCompromised)) {
        try {
          const refineRes = await this.semanticRefiner.refine(
            cue,
            'strategy-b',
            result.duration,
            nextCue?.startTime,
            slot.providerId
          );
          const refinedSpoken=slot.providerId==='ema-lightning' ? prepareSpeech(refineRes.text,{sourceText:cue.originalText}).spokenText : refineRes.text;
          if (refineRes.isModified && refineRes.safetyResult.isValid && refinedSpoken) {
            textToSpeak = refinedSpoken;
            const conciseResult = await this.ttsManager.synthesize(slot.providerId, textToSpeak, {
              speed: slot.speed,
        signal,
            });
            result = conciseResult;
            decision = this.syncEngine.evaluate(cue, result.duration, nextCue?.startTime);
            decision.conciseText = refineRes.text;
            decision.strategy = 'concise_resynthesized';
            isRefined = true;
            refinedText = refineRes.text;
            strategyUsed = refineRes.strategyUsed;
            refinedSyllables = Math.max(1, originalSyllables - refineRes.syllablesSaved);
          }
        } catch (e) {
          console.warn('[VestaDub] Semantic refinement fallback:', e);
        }
      }

      // Fallback for concise phrasing from P2-A if Strategy B didn't apply but P2-A suggested one
      const conciseSpoken=decision.conciseText ? (slot.providerId==='ema-lightning' ? prepareSpeech(decision.conciseText,{sourceText:cue.originalText}).spokenText : decision.conciseText) : '';
      if (this.mode !== 'live' && decision.strategy === 'concise_resynthesized' && conciseSpoken && conciseSpoken !== textToSpeak) {
        textToSpeak = conciseSpoken;
        const conciseResult = await this.ttsManager.synthesize(slot.providerId, textToSpeak, {
          speed: slot.speed,
        signal,
        });
        result = conciseResult;
        decision = this.syncEngine.evaluate(cue, result.duration, nextCue?.startTime);
      }

      // Apply WSOLA Pitch-Preserving Time Stretching if speed !== 1.0
      let processedSamples = result.audio;
      if (Math.abs(decision.playbackSpeed - 1.0) > 0.01) {
        processedSamples = AudioDSP.timeStretch(result.audio, result.sampleRate, decision.playbackSpeed);
      }

      // Apply Loudness Gain Staging & Soft-Knee Peak Limiting (zero clipping, matched RMS)
      const stageResult = AudioDSP.gainStageAndLimit(processedSamples, {
        targetRms: 0.10,
        maxPeak: 0.96,
        provider: slot.providerId === 'ema-lightning' ? 'ema' : 'antalia',
      });

      this.log(cue, 'tts_completed', { samples: result.audio.length, sampleRate: result.sampleRate, peak: result.audio.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0), timings: result.timings });
      const audioBuffer = await this.audioManager.createAudioBuffer(stageResult.samples, result.sampleRate);
      this.log(cue, 'buffer_created', { samples: audioBuffer.length, duration: audioBuffer.duration });
      const synthLatencyMs = Math.round(performance.now() - t0);

      const entry: CacheEntry = {
        buffer: audioBuffer,
        decision,
        duration: audioBuffer.duration,
        pitchDeviationCents: undefined, // No per-cue pitch measurement
        synthLatencyMs,
        isRefined,
        refinedText,
        originalSyllables,
        refinedSyllables,
        strategyUsed,
      };

      if (generation !== this.generation) { if(this.mode==='live') this.attempted.add(cue.id);this.log(cue, 'cancelled', { reason: 'stale_synthesis' }); return null; }
      this.bufferCache.set(cue.id, entry);
      if(this.bufferCache.size>this.maxCacheSize) this.bufferCache.delete(this.bufferCache.keys().next().value!);
      return entry;
    } catch (err: any) {
      if(signal.aborted || generation!==this.generation){this.log(cue,'cancelled',{reason:'stale_synthesis'});return null;}
      this.attempted.add(cue.id);
      this.log(cue, 'playback_failed', { reason: err.message, failureStage: 'tts' });
      this.status('error', `tts: ${err.message}`);
      console.warn(`[VestaDub] Synthesis error for cue ${cue.id}:`, err);
      DogfoodSessionRecorder.getInstance().recordError(err.message || 'Synthesis error');
      return null;
    }
  }

  /**
   * Play cue with adaptive playback rate and telemetry
   */
  private async playCue(cue: SubtitleCue, cueIndex: number, currentTime: number, options: { queueOnly?: boolean } = {}): Promise<void> {
    const generation = this.generation;
    const queueOnly = options.queueOnly === true;
    if(this.mode==='live') this.attempted.add(cue.id);
    const recorder = DogfoodSessionRecorder.getInstance();
    recorder.recordCueScheduled(cue.id, cueIndex);

    // Guard: Audio should not begin after its relevant scene has ended.
    // A queued successor is allowed to start before its video timestamp.
    if (!queueOnly && currentTime >= (this.mode === 'live' ? cue.startTime + 10 : cue.endTime)) {
      recorder.recordCueMissed(cue.id, cueIndex);
      return;
    }

    const cached = this.bufferCache.get(cue.id);
    let entry: CacheEntry | null = cached || null;
    const isCacheHit = !!cached;
    let wasUnderrun = false;

    if (!entry) {
      const lateSec = Math.max(0, currentTime - cue.startTime);
      // A cache miss at the cue boundary is normal lookahead, not a stall.
      // Starvation is a miss after the sentence should already have been speaking.
      if (lateSec > 0.35) {
        this.underrunCount++;
        this.starvationCount++;
        wasUnderrun = true;
        this.log(cue, 'queue_starvation', { lateSec });
      }
      entry = await this.ensureSynthesized(cue);
      if (!entry) {
        if (this.fillerOmissions.get(cue.id) === cue.turkishText) return;
        recorder.recordCueFailed(
          {
            cueId: cue.id,
            cueIndex,
            timestampMs: performance.now(),
            videoId: this.currentVideoId,
            captionTrackType: this.currentTrackType,
            sourceLanguage: this.currentSourceLanguage,
            translationMethod: this.currentTranslationMethod,
            translationStatus: 'failure',
            sourceTiming: {
              startTime: cue.startTime,
              endTime: cue.endTime,
              duration: cue.duration,
            },
            schedulingTiming: {
              scheduledStartSec: cue.startTime,
              actualStartSec: currentTime,
              startDriftMs: Math.round(Math.abs(currentTime - cue.startTime) * 1000),
            },
            ttsProvider: 'antalia',
            ttsLatencyMs: 0,
            refinement: {
              originalSyllables: 0,
              refinedSyllables: 0,
              isRefined: false,
              strategyUsed: 'none',
            },
            wsolaFactor: 1.0,
            expectedDurationSec: cue.duration,
            actualPlaybackDurationSec: 0,
            endOverflowMs: 0,
            underrun: true,
            cacheHit: false,
          },
          'synthesis_failed'
        );
        return;
      }
    }

    const buffer = entry.buffer;
    const decision = entry.decision;
    const pitchDeviationCents = entry.pitchDeviationCents;

    const ctx = await this.audioManager.getContext();
    if (generation !== this.generation || !this.enabled || !this.video || this.video.paused || this.isSeeking) {
      this.log(cue, 'cancelled', { reason: 'lifecycle_changed' }); return;
    }
    const now = this.video.currentTime;
    const deadline = this.mode === 'live' ? cue.startTime + 10 : cue.endTime;
    if (!queueOnly && (now < cue.startTime || now >= deadline)) {
      this.attempted.add(cue.id);
      this.log(cue, 'cancelled', { reason: 'expired_after_synthesis', deadline });
      this.status('buffering', 'cue_expired'); return;
    }
    if (ctx.state !== 'running') throw new Error(`AudioContext ${ctx.state}; click the video to activate audio`);
    if (!queueOnly) {
      this.activeCueId = cue.id;
      this.activeCueIndex = cueIndex;
    }
    this.attempted.add(cue.id);

    // Timing drift telemetry
    const actualStartTime = this.video ? this.video.currentTime : cue.startTime;
    const driftMs = Math.round(Math.abs(actualStartTime - cue.startTime) * 1000);
    this.recentDrifts.push(driftMs);
    if (this.recentDrifts.length > 50) this.recentDrifts.shift();

    const isOverflowing = decision.overflowSec > 0;
    this.recentOverflows.push(decision.overflowSec);
    if (this.recentOverflows.length > 50) this.recentOverflows.shift();

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Pitch is already preserved via WSOLA in the buffer
    const videoRate = this.video ? this.video.playbackRate : 1.0;
    source.playbackRate.value = videoRate;
    source.connect(this.audioManager.getDubbingGain());

    // Never skip the opening of a sentence to chase the video clock.
    const offset = 0;

    if (offset < buffer.duration) {
      const pauseSec = this.getAdaptivePauseSec(cue);
      const earliest = this.lastSourceEndContextTime > 0 ? this.lastSourceEndContextTime + pauseSec : ctx.currentTime;
      // Chaining short translated cues can otherwise run all the way to the
      // 14-second synthesis frontier, exhaust the active chain, then wait for
      // the next native timestamp. Keep at most one second of early speech.
      const nativeEarliest = queueOnly
        ? ctx.currentTime + Math.max(0, cue.startTime - now - 1) / videoRate
        : ctx.currentTime;
      const scheduleTime = Math.max(ctx.currentTime, earliest, nativeEarliest);
      const gapSec = this.lastSourceEndContextTime > 0 ? Math.max(0, scheduleTime - (this.lastSourceEndContextTime + pauseSec)) : 0;
      if (this.lastSourceEndContextTime > 0) this.playbackGapsSec.push(Number(gapSec.toFixed(3)));
      if (gapSec > 0.45) this.log(cue, 'continuity_gap', { gapSec, pauseSec });
      this.log(cue, 'buffer_scheduled', { contextState: ctx.state, contextSec: scheduleTime, plannedVideoStart: now + (scheduleTime - ctx.currentTime) * videoRate, nativeCueStart: cue.startTime, offset, duration: buffer.duration, pauseSec, gapSec, queued: queueOnly, wsola: decision.playbackSpeed });
      source.start(scheduleTime, offset);
      this.attempted.add(cue.id);
      if (queueOnly) {
        this.queuedSource = source;
        this.queuedCueId = cue.id;
      } else {
        this.activeSource = source;
        this.activeCueId = cue.id;
        this.activeCueIndex = cueIndex;
      }
      this.lastSourceEndContextTime = scheduleTime + Math.max(0, buffer.duration - offset);
      this.lastSpokenText = cue.turkishText || cue.originalText || '';
      this.log(cue, 'source_started',{observationToStartMs:cue.acquisition ? Date.now()-cue.acquisition.wallMs : null});
      this.status('playing');
      recorder.recordCueStarted(cue.id);
      this.audioManager.duckVideo();

      source.onended = () => {
        if (this.queuedSource === source) {
          this.queuedSource = null;
          this.queuedCueId = null;
        }
        if (this.activeSource === source) {
          source.disconnect();
          if (this.queuedSource) {
            this.activeSource = this.queuedSource;
            this.activeCueId = this.queuedCueId;
            this.activeCueIndex = this.cues.findIndex(item => item.id === this.queuedCueId);
            this.queuedSource = null;
            this.queuedCueId = null;
            this.log(cue, 'source_ended', { natural: true, handoff: true });
            this.status('playing');
          } else {
            this.activeSource = null;
            this.log(cue, 'source_ended', { natural: true });
            this.status(this.mode === 'live' ? 'waiting_for_live_caption' : 'buffering');
            this.audioManager.unduckVideo();
          }

          // Record genuine completion
          recorder.recordCueCompleted({
            cueId: cue.id,
            cueIndex,
            timestampMs: performance.now(),
            videoId: this.currentVideoId,
            captionTrackType: this.currentTrackType,
            sourceLanguage: this.currentSourceLanguage,
            translationMethod: this.currentTranslationMethod,
            translationStatus: cue.turkishText && cue.turkishText !== cue.originalText ? 'success' : 'fallback',
            sourceTiming: {
              startTime: cue.startTime,
              endTime: cue.endTime,
              duration: cue.duration,
            },
            schedulingTiming: {
              scheduledStartSec: cue.startTime,
              actualStartSec: actualStartTime,
              startDriftMs: driftMs,
            },
            ttsProvider: this.speakerManager.getSlot(cue.speakerId).providerId,
            ttsLatencyMs: entry!.synthLatencyMs,
            refinement: {
              originalSyllables: entry!.originalSyllables,
              refinedSyllables: entry!.refinedSyllables,
              isRefined: entry!.isRefined,
              strategyUsed: entry!.strategyUsed,
            },
            wsolaFactor: decision.playbackSpeed,
            expectedDurationSec: cue.duration,
            actualPlaybackDurationSec: buffer.duration,
            endOverflowMs: Math.round(decision.overflowSec * 1000),
            underrun: wasUnderrun,
            cacheHit: isCacheHit,
          });
        }
      };
    }

    if (offset >= buffer.duration) { source.disconnect(); this.log(cue, 'cancelled', { reason: 'audio_offset_expired', offset }); this.status('buffering', 'audio_offset_expired'); return; }

    // Update metadata on cue object
    cue.syncMetadata = {
      originalDuration: cue.duration,
      audioDuration: buffer.duration,
      availableWindow: decision.availableWindow,
      requiredSpeed: Number((buffer.duration / decision.availableWindow).toFixed(2)),
      actualSpeed: decision.playbackSpeed,
      startDriftMs: driftMs,
      overflowSec: decision.overflowSec,
      strategyUsed: decision.strategy,
      conciseTextUsed: decision.conciseText,
      isCompromised: decision.isCompromised,
      compromiseSec: decision.compromiseSec,
      pitchDeviationCents,
    };

    // Calculate p95 statistics
    const p95Drift = this.calculateP95(this.recentDrifts);
    const p95Overflow = this.calculateP95(this.recentOverflows);

    if (this.onMetrics) {
      const slot = this.speakerManager.getSlot(cue.speakerId);
      this.onMetrics({
        activeCueIndex: cueIndex,
        currentCueText: cue.turkishText || cue.originalText,
        currentSpeakerId: slot.name,
        activeProviderId: slot.providerId,
        synthesisLatencyMs: entry.synthLatencyMs,
        syncDriftMs: driftMs,
        isOverflowing,
        realtimeFactor: (entry.synthLatencyMs / 1000) / buffer.duration,
        bufferedCuesCount: this.bufferCache.size,
        totalCuesCount: this.cues.length,
        p95StartDriftMs: p95Drift,
        p95OverflowMs: Math.round(p95Overflow * 1000),
        underrunCount: this.underrunCount,
        activeStrategy: decision.strategy,
        scheduledSpeed: decision.playbackSpeed,
        isCompromised: decision.isCompromised,
        compromiseSec: decision.compromiseSec,
        pitchDeviationCents,
      });
    }
  }

  private calculateP95(vals: number[]): number {
    if (vals.length === 0) return 0;
    const sorted = [...vals].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return Math.round(sorted[Math.min(idx, sorted.length - 1)] || 0);
  }

  private stopNode(node: AudioBufferSourceNode | null): void {
    if (!node) return;
    node.onended = null;
    try {
      node.stop();
      node.disconnect();
    } catch {
      // Source already terminated
    }
  }

  private stopCurrentAudio(reason = 'stop_or_replaced'): void {
    if (this.activeSource) {
      if (this.activeCueId) {
        DogfoodSessionRecorder.getInstance().recordCueInterrupted(this.activeCueId, 'stop_or_replaced');
      }
      const cue = this.cues.find(c => c.id === this.activeCueId);
      if (cue) this.log(cue, 'cancelled', { reason });
      this.stopNode(this.activeSource);
      this.activeSource = null;
    }
    if (this.queuedSource) {
      const queued = this.cues.find(c => c.id === this.queuedCueId);
      if (queued) this.log(queued, 'cancelled', { reason: `${reason}_queued` });
      this.stopNode(this.queuedSource);
      this.queuedSource = null;
      this.queuedCueId = null;
    }
    this.lastSourceEndContextTime = 0;
    this.lastSpokenText = '';
    this.audioManager.unduckVideo();
  }

  destroy(): void {
    this.setEnabled(false);
    this.detachVideo();
    this.bufferCache.clear();
    this.pendingSyntheses.clear();
    this.audioManager.close();
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}
