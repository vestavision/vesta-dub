import { SubtitleCue, SubtitleTrack } from '../core/types';

export type CaptionSourceKind = 'preloaded_track' | 'live_dom' | 'local_asr';
export interface CaptionSourceCapabilities {
  kind: CaptionSourceKind;
  futureCuesAvailable: boolean;
  expectedAcquisitionLatencyMs: number | null;
  language: string | null;
  confidence: number | null;
  availability: 'idle' | 'loading' | 'available' | 'unavailable';
  timestamps: 'supplied' | 'estimated';
  failureReason: string | null;
}
export interface CaptionSourceContext { videoId: string; video?: HTMLVideoElement; track?: SubtitleTrack; }
export interface CaptionSourceHandlers {
  onCues(cues: SubtitleCue[], replace: boolean): void;
  onStatus?(capabilities: CaptionSourceCapabilities): void;
}
export interface CaptionSource {
  getCapabilities(): CaptionSourceCapabilities;
  start(context: CaptionSourceContext, handlers: CaptionSourceHandlers): void | Promise<void>;
  stop(): void;
}
export const futureAsrCapabilities = (): CaptionSourceCapabilities => ({
  kind: 'local_asr', futureCuesAvailable: false, expectedAcquisitionLatencyMs: null,
  language: null, confidence: null, availability: 'unavailable', timestamps: 'estimated',
  failureReason: 'NOT_IMPLEMENTED',
});
