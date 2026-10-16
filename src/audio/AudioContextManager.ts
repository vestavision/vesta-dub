/**
 * AudioContextManager
 * Manages Web Audio API context, node routing, gain nodes, brickwall limiter, and ducking for the YouTube video.
 */

import { isPauseFeatureEnabled, noteExtensionEvent } from '../diagnostics/PauseIsolation';

export class AudioContextManager {
  private ctx: AudioContext | null = null;
  private dubbingGain: GainNode | null = null;
  private limiterNode: DynamicsCompressorNode | null = null;
  private originalVideo: HTMLVideoElement | null = null;
  private originalVideoBaseVolume = 1.0;
  private originalVideoMuted = false;
  private isDucked = false;
  private duckingEnabled = true;
  private contextObserved = false;
  private duckingVolume = 0.15; // Duck down to 15% during dubbing speech

  async getContext(resume = true): Promise<AudioContext> {
    if (!this.ctx) {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtxClass();
      this.dubbingGain = this.ctx.createGain();

      // Hardware safety limiter node to prevent DAC clipping
      this.limiterNode = this.ctx.createDynamicsCompressor();
      this.limiterNode.threshold.setValueAtTime(-1.0, this.ctx.currentTime); // -1 dBFS
      this.limiterNode.knee.setValueAtTime(3.0, this.ctx.currentTime);
      this.limiterNode.ratio.setValueAtTime(20.0, this.ctx.currentTime);
      this.limiterNode.attack.setValueAtTime(0.002, this.ctx.currentTime); // 2ms attack
      this.limiterNode.release.setValueAtTime(0.05, this.ctx.currentTime); // 50ms release

      this.dubbingGain.connect(this.limiterNode);
      this.limiterNode.connect(this.ctx.destination);
    }
    if (resume && this.ctx.state === 'suspended') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.ctx.resume(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('AudioContext resume timed out; click the YouTube player')), 2000); })]);
      } finally { if (timer) clearTimeout(timer); }
      if ((this.ctx.state as AudioContextState) !== 'running') throw new Error(`AudioContext ${this.ctx.state}`);
    }
    this.observeContext();
    return this.ctx;
  }

  private observeContext(): void {
    if (!this.ctx || this.contextObserved || !isPauseFeatureEnabled('diagnostics')) return;
    this.contextObserved = true;
    const ctx = this.ctx;
    ctx.addEventListener('statechange', () => noteExtensionEvent('audiocontext_state', { state: ctx.state }));
    noteExtensionEvent('audiocontext_state', { state: ctx.state });
  }

  getDubbingGain(): GainNode {
    if (!this.dubbingGain) {
      throw new Error('AudioContextManager not initialized.');
    }
    return this.dubbingGain;
  }

  setDubbingVolume(volume: number): void {
    if (this.dubbingGain && this.ctx) {
      const safeVol = Math.max(0, Math.min(1, volume));
      this.dubbingGain.gain.setValueAtTime(safeVol, this.ctx.currentTime);
    }
  }

  attachVideo(video: HTMLVideoElement): void {
    this.originalVideo = video;
    this.originalVideoMuted = video.muted;
    this.originalVideoBaseVolume = typeof video.volume === 'number' ? video.volume : 1.0;
  }

  setDuckingLevel(level: number): void {
    this.duckingVolume = Math.max(0, Math.min(1, level));
    if (this.isDucked && this.originalVideo && !this.originalVideoMuted) this.originalVideo.volume = this.originalVideoBaseVolume * this.duckingVolume;
  }

  setDuckingEnabled(enabled: boolean): void {
    this.duckingEnabled = enabled;
    if (!enabled) this.unduckVideo();
  }

  duckVideo(): void {
    if (!this.duckingEnabled || !this.originalVideo || this.isDucked) return;
    this.isDucked = true;
    this.originalVideoMuted = this.originalVideo.muted;
    this.originalVideoBaseVolume = this.originalVideo.volume;

    if (this.originalVideo.muted || this.originalVideo.volume === 0) {
      noteExtensionEvent('extension_volume', { action: 'duck-skipped', muted: this.originalVideo.muted, volume: this.originalVideo.volume });
      return;
    }

    const targetVol = this.originalVideoBaseVolume * this.duckingVolume;
    this.originalVideo.volume = Math.max(0, Math.min(1, targetVol));
    noteExtensionEvent('extension_volume', { action: 'duck', from: this.originalVideoBaseVolume, to: this.originalVideo.volume });
  }

  unduckVideo(): void {
    if (!this.originalVideo || !this.isDucked) return;
    this.isDucked = false;

    // Ducking changes volume only. Preserve a muted player's saved slider level
    // and never turn an unmuted zero-volume player into a muted player.
    this.originalVideo.volume = Math.max(0, Math.min(1, this.originalVideoBaseVolume));
    noteExtensionEvent('extension_volume', { action: 'restore', to: this.originalVideo.volume });
  }

  /**
   * Create an AudioBuffer from PCM float32 samples
   */
  async createAudioBuffer(pcmSamples: Float32Array, sampleRate: number): Promise<AudioBuffer> {
    const ctx = await this.getContext(false);
    const buffer = ctx.createBuffer(1, pcmSamples.length, sampleRate);
    buffer.getChannelData(0).set(pcmSamples);
    return buffer;
  }

  async startDiagnosticCapture(): Promise<() => Promise<Blob>> {
    const ctx = await this.getContext();
    const destination = ctx.createMediaStreamDestination();
    this.limiterNode!.connect(destination);
    const recorder = new MediaRecorder(destination.stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
    return () => new Promise((resolve, reject) => {
      recorder.onstop = () => { this.limiterNode!.disconnect(destination); destination.stream.getTracks().forEach(t => t.stop()); resolve(new Blob(chunks, {type: recorder.mimeType})); };
      recorder.onerror = e => reject(e);
      recorder.stop();
    });
  }

  async close(): Promise<void> {
    this.unduckVideo();
    if (this.ctx && this.ctx.state !== 'closed') {
      await this.ctx.close();
      this.ctx = null;
      this.dubbingGain = null;
      this.limiterNode = null;
    }
  }
}
