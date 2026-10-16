import {
  ExecutionEnvironmentMode,
  PlaybackOutcome,
  SessionTelemetrySummary,
  CueTelemetryEvent,
  TranslationMethod,
  TELEMETRY_SCHEMA_VERSION,
} from '../telemetry/TelemetrySchema';
import { LocalTelemetryRecorder } from '../telemetry/LocalTelemetryRecorder';

export interface CueLifecycleRecord {
  cueId: string;
  cueIndex: number;
  scheduledTimeMs: number;
  startTimeMs?: number;
  endTimeMs?: number;
  outcome: PlaybackOutcome;
  interruptionReason?: string;
  failureReason?: string;
}

export class DogfoodSessionRecorder {
  private static instance: DogfoodSessionRecorder | null = null;
  private telemetry: LocalTelemetryRecorder;

  private isRecording = false;
  private environmentMode: ExecutionEnvironmentMode = 'real_live_youtube';
  private sessionId = '';

  // Monotonic time tracking
  private sessionStartWallClockMs = 0;
  private sessionStartMonotonicMs = 0;
  private lastTickMonotonicMs = 0;
  private accumulatedWallClockMs = 0;
  private accumulatedPlaybackMs = 0;
  private accumulatedPausedMs = 0;

  private isVideoPlaying = false;
  private lastStateTransitionMonotonicMs = 0;

  // Active cues tracking to detect missed, repeated, dropped
  private scheduledCues = new Map<string, CueLifecycleRecord>();
  private completedCueIds = new Set<string>();
  private activeCueId: string | null = null;

  // Monotonic timer tick interval
  private tickIntervalId: any = null;

  private constructor() {
    this.telemetry = LocalTelemetryRecorder.getInstance();
    this.restoreSessionState();
  }

  static getInstance(): DogfoodSessionRecorder {
    if (!this.instance) {
      this.instance = new DogfoodSessionRecorder();
    }
    return this.instance;
  }

  private async restoreSessionState(): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const stored = await chrome.storage.local.get([
          'vesta_recorder_state',
          'vesta_recorder_active',
        ]);
        if (stored.vesta_recorder_active && stored.vesta_recorder_state) {
          const state = stored.vesta_recorder_state;
          this.isRecording = true;
          this.sessionId = state.sessionId;
          this.environmentMode = state.environmentMode;
          this.accumulatedWallClockMs = state.accumulatedWallClockMs || 0;
          this.accumulatedPlaybackMs = state.accumulatedPlaybackMs || 0;
          this.accumulatedPausedMs = state.accumulatedPausedMs || 0;
          this.sessionStartWallClockMs = state.sessionStartWallClockMs || Date.now();
          this.sessionStartMonotonicMs = performance.now();
          this.lastTickMonotonicMs = performance.now();
          this.lastStateTransitionMonotonicMs = performance.now();
          this.isVideoPlaying = false; // assume paused until video event fires

          // Notify telemetry of worker restart
          this.telemetry.recordWorkerRestartEvent();
          this.startHeartbeat();
        }
      } catch (err) {
        console.warn('[DogfoodSessionRecorder] Failed to restore checkpoint:', err);
      }
    }
  }

  startSession(mode: ExecutionEnvironmentMode = 'real_live_youtube'): string {
    this.environmentMode = mode;
    this.sessionId = this.telemetry.startSession(mode);
    this.isRecording = true;

    const nowMonotonic = performance.now();
    const nowWall = Date.now();

    this.sessionStartWallClockMs = nowWall;
    this.sessionStartMonotonicMs = nowMonotonic;
    this.lastTickMonotonicMs = nowMonotonic;
    this.lastStateTransitionMonotonicMs = nowMonotonic;
    this.accumulatedWallClockMs = 0;
    this.accumulatedPlaybackMs = 0;
    this.accumulatedPausedMs = 0;
    this.isVideoPlaying = false;

    this.scheduledCues.clear();
    this.completedCueIds.clear();
    this.activeCueId = null;

    this.startHeartbeat();
    this.saveCheckpoint();

    return this.sessionId;
  }

  stopSession(): SessionTelemetrySummary | null {
    if (!this.isRecording) return null;

    this.updateMonotonicAccumulators();
    this.isRecording = false;
    this.stopHeartbeat();

    this.telemetry.updateSessionDurations(
      Math.round(this.accumulatedWallClockMs),
      Math.round(this.accumulatedPlaybackMs),
      Math.round(this.accumulatedPausedMs)
    );

    const summary = this.telemetry.endSession();
    this.clearCheckpoint();

    return summary;
  }

  isSessionActive(): boolean {
    return this.isRecording;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getEnvironmentMode(): ExecutionEnvironmentMode {
    return this.environmentMode;
  }

  // --- Monotonic Clock Accumulators ---

  private updateMonotonicAccumulators(): void {
    if (!this.isRecording) return;
    const now = performance.now();
    const delta = Math.max(0, now - this.lastTickMonotonicMs);
    this.lastTickMonotonicMs = now;

    this.accumulatedWallClockMs += delta;

    if (this.isVideoPlaying) {
      this.accumulatedPlaybackMs += delta;
    } else {
      this.accumulatedPausedMs += delta;
    }

    this.telemetry.updateSessionDurations(
      Math.round(this.accumulatedWallClockMs),
      Math.round(this.accumulatedPlaybackMs),
      Math.round(this.accumulatedPausedMs)
    );
  }

  onVideoPlay(): void {
    if (!this.isRecording) return;
    this.updateMonotonicAccumulators();
    this.isVideoPlaying = true;
    this.lastStateTransitionMonotonicMs = performance.now();
  }

  onVideoPause(): void {
    if (!this.isRecording) return;
    this.updateMonotonicAccumulators();
    this.isVideoPlaying = false;
    this.lastStateTransitionMonotonicMs = performance.now();
  }

  onNavigation(url?: string): void {
    if (!this.isRecording) return;
    this.updateMonotonicAccumulators();
    this.telemetry.recordNavigationEvent();

    // Check for any currently active or scheduled cues that need interruption
    if (this.activeCueId) {
      this.recordCueInterrupted(this.activeCueId, 'spa_navigation');
    }
  }

  // --- Cue Lifecycle Instrumentation ---

  recordCueScheduled(cueId: string, cueIndex: number): void {
    if (!this.isRecording) return;

    if (this.completedCueIds.has(cueId)) {
      // Detected a repeated cue!
      const current = this.telemetry.getCurrentSession();
      if (current) current.cueCounts.repeated++;
    }

    this.scheduledCues.set(cueId, {
      cueId,
      cueIndex,
      scheduledTimeMs: performance.now(),
      outcome: 'scheduled',
    });
  }

  recordCueStarted(cueId: string): void {
    if (!this.isRecording) return;

    const record = this.scheduledCues.get(cueId);
    if (record) {
      record.startTimeMs = performance.now();
      record.outcome = 'started';
    }
    this.activeCueId = cueId;
  }

  recordCueCompleted(
    eventData: Omit<CueTelemetryEvent, 'schemaVersion' | 'sessionId' | 'rawTextIncluded' | 'playbackOutcome'>
  ): void {
    if (!this.isRecording) return;

    const record = this.scheduledCues.get(eventData.cueId);
    if (record) {
      record.endTimeMs = performance.now();
      record.outcome = 'completed';
      this.completedCueIds.add(eventData.cueId);
    }

    if (this.activeCueId === eventData.cueId) {
      this.activeCueId = null;
    }

    this.telemetry.recordCueEvent({
      ...eventData,
      playbackOutcome: 'completed',
    });
  }

  recordCueInterrupted(cueId: string, reason: string): void {
    if (!this.isRecording) return;

    const record = this.scheduledCues.get(cueId);
    if (record) {
      record.endTimeMs = performance.now();
      record.outcome = 'interrupted';
      record.interruptionReason = reason;
    }

    if (this.activeCueId === cueId) {
      this.activeCueId = null;
    }
  }

  recordCueFailed(
    eventData: Omit<CueTelemetryEvent, 'schemaVersion' | 'sessionId' | 'rawTextIncluded' | 'playbackOutcome'>,
    reason: string
  ): void {
    if (!this.isRecording) return;

    const record = this.scheduledCues.get(eventData.cueId);
    if (record) {
      record.outcome = 'failed';
      record.failureReason = reason;
    }

    this.telemetry.recordCueEvent({
      ...eventData,
      playbackOutcome: 'failed',
      errorReason: reason,
    });
  }

  recordCueMissed(cueId: string, cueIndex: number): void {
    if (!this.isRecording) return;
    const current = this.telemetry.getCurrentSession();
    if (current) current.cueCounts.missed++;
  }

  recordError(errorMsg: string): void {
    this.telemetry.recordError(errorMsg);
  }

  // --- Heartbeat & Persistence ---

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.tickIntervalId = setInterval(() => {
      this.updateMonotonicAccumulators();
      this.saveCheckpoint();
    }, 2000);
  }

  private stopHeartbeat(): void {
    if (this.tickIntervalId) {
      clearInterval(this.tickIntervalId);
      this.tickIntervalId = null;
    }
  }

  private saveCheckpoint(): void {
    if (typeof chrome !== 'undefined' && chrome.storage?.local && this.isRecording) {
      const state = {
        sessionId: this.sessionId,
        environmentMode: this.environmentMode,
        sessionStartWallClockMs: this.sessionStartWallClockMs,
        accumulatedWallClockMs: this.accumulatedWallClockMs,
        accumulatedPlaybackMs: this.accumulatedPlaybackMs,
        accumulatedPausedMs: this.accumulatedPausedMs,
        lastSavedAt: Date.now(),
      };
      chrome.storage.local.set({
        vesta_recorder_active: true,
        vesta_recorder_state: state,
      }).catch(() => {});
    }
  }

  private clearCheckpoint(): void {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.remove([
        'vesta_recorder_active',
        'vesta_recorder_state',
      ]).catch(() => {});
    }
  }

  getLiveStats() {
    this.updateMonotonicAccumulators();
    const session = this.telemetry.getCurrentSession();

    return {
      isRecording: this.isRecording,
      sessionId: this.sessionId,
      environmentMode: this.environmentMode,
      wallClockDurationSec: Math.round(this.accumulatedWallClockMs / 1000),
      videoPlaybackDurationSec: Math.round(this.accumulatedPlaybackMs / 1000),
      pausedDurationSec: Math.round(this.accumulatedPausedMs / 1000),
      counts: session?.cueCounts || {
        processed: 0,
        successfullyDubbed: 0,
        failed: 0,
        missed: 0,
        repeated: 0,
        untranslated: 0,
        underruns: 0,
        syncCompromises: 0,
      },
      performance: session?.performance || {
        p50StartDriftMs: 0,
        p95StartDriftMs: 0,
        p95OverflowMs: 0,
        avgTtsLatencyMs: 0,
        cacheHitRatePct: 0,
      },
      lastRecoverableError: session?.lifecycle.lastRecoverableError,
    };
  }
}
