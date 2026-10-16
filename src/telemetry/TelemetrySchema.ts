/**
 * Vesta Dub — Versioned Local Telemetry Schema (v1.0.0)
 *
 * Privacy Guarantees:
 * - 100% Local Storage: Zero external network transmissions.
 * - Privacy-Safe: Excludes personal browsing history, titles, and user identity.
 * - Subtitle Text Privacy: Raw text is stripped by default; only syllable/character counts recorded.
 * - Pseudonymous: Local session UUIDs only.
 */

export const TELEMETRY_SCHEMA_VERSION = '1.0.0';

export type ExecutionEnvironmentMode =
  | 'real_live_youtube'
  | 'controlled_browser_fixture'
  | 'accelerated_simulation'
  | 'offline_acoustic_benchmark';

export type PlaybackOutcome =
  | 'scheduled'
  | 'started'
  | 'completed'
  | 'interrupted'
  | 'failed';

export type TranslationMethod =
  | 'native_tr'
  | 'youtube_tlang'
  | 'google_proxy'
  | 'untranslated';

export interface CueTelemetryEvent {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  sessionId: string;
  cueId: string;
  cueIndex: number;
  timestampMs: number; // monotonic relative or epoch
  videoId: string;
  captionTrackType: 'asr' | 'standard' | 'manual';
  sourceLanguage: string;
  translationMethod: TranslationMethod;
  translationStatus: 'success' | 'failure' | 'fallback';

  sourceTiming: {
    startTime: number;
    endTime: number;
    duration: number;
  };

  schedulingTiming: {
    scheduledStartSec: number;
    actualStartSec: number;
    startDriftMs: number;
  };

  ttsProvider: 'antalia' | 'ema-lightning' | 'piper-fahrettin';
  ttsLatencyMs: number;

  refinement: {
    originalSyllables: number;
    refinedSyllables: number;
    isRefined: boolean;
    strategyUsed: string;
  };

  wsolaFactor: number;
  expectedDurationSec: number;
  actualPlaybackDurationSec: number;
  endOverflowMs: number;
  playbackOutcome: PlaybackOutcome;
  underrun: boolean;
  cacheHit: boolean;
  errorReason?: string;

  // Optional debug text, strictly false by default for user privacy
  rawTextIncluded: boolean;
  debugOriginalText?: string;
  debugTurkishText?: string;
}

export interface SessionTelemetrySummary {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  sessionId: string;
  environmentMode: ExecutionEnvironmentMode;
  startTimeIso: string;
  endTimeIso?: string;
  wallClockDurationMs: number;
  videoPlaybackDurationMs: number;
  pausedDurationMs: number;

  cueCounts: {
    processed: number;
    successfullyDubbed: number;
    failed: number;
    missed: number;
    repeated: number;
    untranslated: number;
    underruns: number;
    syncCompromises: number;
  };

  performance: {
    playbackMeasurementCount?: number;
    p50StartDriftMs: number;
    p95StartDriftMs: number;
    p95OverflowMs: number;
    avgTtsLatencyMs: number;
    cacheHitRatePct: number;
  };

  lifecycle: {
    spaNavigationsCount: number;
    serviceWorkerRestartsCount: number;
    lastRecoverableError?: string;
  };

  memory: {
    initialJsHeapMb?: number;
    finalJsHeapMb?: number;
    peakJsHeapMb?: number;
    estimatedCacheMb: number;
  };
}

export interface AnonymizedSessionExport {
  exportVersion: string;
  exportDateIso: string;
  summary: SessionTelemetrySummary;
  events: CueTelemetryEvent[];
}
