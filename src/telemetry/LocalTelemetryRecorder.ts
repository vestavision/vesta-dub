import {
  CueTelemetryEvent,
  SessionTelemetrySummary,
  AnonymizedSessionExport,
  ExecutionEnvironmentMode,
  TELEMETRY_SCHEMA_VERSION,
} from './TelemetrySchema';

export class LocalTelemetryRecorder {
  private static instance: LocalTelemetryRecorder | null = null;
  private currentSession: SessionTelemetrySummary | null = null;
  private cueEvents: CueTelemetryEvent[] = [];
  private maxEventsBufferSize = 500; // Circular buffer to bound memory strictly

  private isEnabled = false;
  private includeRawTextDebug = false;

  private constructor() {
    this.loadStateFromStorage();
  }

  static getInstance(): LocalTelemetryRecorder {
    if (!this.instance) {
      this.instance = new LocalTelemetryRecorder();
    }
    return this.instance;
  }

  private async loadStateFromStorage(): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const stored = await chrome.storage.local.get([
          'vesta_dogfood_opt_in',
          'vesta_dogfood_raw_text',
          'vesta_dogfood_current_session',
        ]);
        this.isEnabled = !!stored.vesta_dogfood_opt_in;
        this.includeRawTextDebug = !!stored.vesta_dogfood_raw_text;
        if (stored.vesta_dogfood_current_session) {
          this.currentSession = stored.vesta_dogfood_current_session;
        }
      } catch (err) {
        console.warn('[VestaDub Telemetry] Failed to load initial storage state:', err);
      }
    }
  }

  isOptedIn(): boolean {
    return this.isEnabled;
  }

  async setOptIn(enabled: boolean): Promise<void> {
    this.isEnabled = enabled;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ vesta_dogfood_opt_in: enabled });
    }
  }

  setIncludeRawTextDebug(enabled: boolean): void {
    this.includeRawTextDebug = enabled;
  }

  startSession(mode: ExecutionEnvironmentMode = 'real_live_youtube'): string {
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.cueEvents = [];

    this.currentSession = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      sessionId,
      environmentMode: mode,
      startTimeIso: new Date().toISOString(),
      wallClockDurationMs: 0,
      videoPlaybackDurationMs: 0,
      pausedDurationMs: 0,
      cueCounts: {
        processed: 0,
        successfullyDubbed: 0,
        failed: 0,
        missed: 0,
        repeated: 0,
        untranslated: 0,
        underruns: 0,
        syncCompromises: 0,
      },
      performance: {
        playbackMeasurementCount: 0,
        p50StartDriftMs: 0,
        p95StartDriftMs: 0,
        p95OverflowMs: 0,
        avgTtsLatencyMs: 0,
        cacheHitRatePct: 0,
      },
      lifecycle: {
        spaNavigationsCount: 0,
        serviceWorkerRestartsCount: 0,
      },
      memory: {
        estimatedCacheMb: 0,
      },
    };

    this.saveCheckpoint();
    return sessionId;
  }

  getCurrentSession(): SessionTelemetrySummary | null {
    return this.currentSession;
  }

  recordCueEvent(eventData: Omit<CueTelemetryEvent, 'schemaVersion' | 'sessionId' | 'rawTextIncluded'>): void {
    if (!this.isEnabled || !this.currentSession) return;

    // Apply strict privacy scrubbing on raw subtitles
    const sanitizedEvent: CueTelemetryEvent = {
      ...eventData,
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      sessionId: this.currentSession.sessionId,
      rawTextIncluded: this.includeRawTextDebug,
      debugOriginalText: this.includeRawTextDebug ? eventData.debugOriginalText : undefined,
      debugTurkishText: this.includeRawTextDebug ? eventData.debugTurkishText : undefined,
    };

    // Maintain circular buffer
    if (this.cueEvents.length >= this.maxEventsBufferSize) {
      this.cueEvents.shift();
    }
    this.cueEvents.push(sanitizedEvent);

    // Update aggregate counters
    const counts = this.currentSession.cueCounts;
    counts.processed++;

    if (sanitizedEvent.playbackOutcome === 'completed') {
      counts.successfullyDubbed++;
    } else if (sanitizedEvent.playbackOutcome === 'failed') {
      counts.failed++;
    }

    if (sanitizedEvent.translationMethod === 'untranslated') {
      counts.untranslated++;
    }
    if (sanitizedEvent.underrun) {
      counts.underruns++;
    }
    if (sanitizedEvent.endOverflowMs > 50) {
      counts.syncCompromises++;
    }

    // Recompute p50 & p95 drifts
    this.updatePerformanceMetrics();
    this.saveCheckpoint();
  }

  private updatePerformanceMetrics(): void {
    if (!this.currentSession || this.cueEvents.length === 0) return;

    const completed = this.cueEvents.filter(e => e.playbackOutcome === 'completed');
    this.currentSession.performance.playbackMeasurementCount = completed.length;
    if (!completed.length) return;
    const drifts = completed.map(e => e.schedulingTiming.startDriftMs).sort((a, b) => a - b);
    const overflows = completed.map(e => e.endOverflowMs).sort((a, b) => a - b);
    const latencies = completed.map(e => e.ttsLatencyMs);
    const hits = this.cueEvents.filter(e => e.cacheHit).length;

    const p50Idx = Math.floor(drifts.length * 0.5);
    const p95Idx = Math.floor(drifts.length * 0.95);
    const p95OverflowIdx = Math.floor(overflows.length * 0.95);

    this.currentSession.performance.p50StartDriftMs = drifts[p50Idx] || 0;
    this.currentSession.performance.p95StartDriftMs = drifts[Math.min(p95Idx, drifts.length - 1)] || 0;
    this.currentSession.performance.p95OverflowMs = overflows[Math.min(p95OverflowIdx, overflows.length - 1)] || 0;

    const avgLat = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;
    this.currentSession.performance.avgTtsLatencyMs = Math.round(avgLat);
    this.currentSession.performance.cacheHitRatePct = Math.round((hits / this.cueEvents.length) * 100);
  }

  updateSessionDurations(wallClockMs: number, playbackMs: number, pausedMs: number): void {
    if (!this.currentSession) return;
    this.currentSession.wallClockDurationMs = wallClockMs;
    this.currentSession.videoPlaybackDurationMs = playbackMs;
    this.currentSession.pausedDurationMs = pausedMs;
  }

  recordNavigationEvent(): void {
    if (!this.currentSession) return;
    this.currentSession.lifecycle.spaNavigationsCount++;
    this.saveCheckpoint();
  }

  recordWorkerRestartEvent(): void {
    if (!this.currentSession) return;
    this.currentSession.lifecycle.serviceWorkerRestartsCount++;
    this.saveCheckpoint();
  }

  recordError(errorMsg: string): void {
    if (!this.currentSession) return;
    this.currentSession.lifecycle.lastRecoverableError = errorMsg;
    this.saveCheckpoint();
  }

  updateMemoryEstimate(estimatedCacheMb: number, jsHeapMb?: number): void {
    if (!this.currentSession) return;
    this.currentSession.memory.estimatedCacheMb = Number(estimatedCacheMb.toFixed(2));
    if (jsHeapMb !== undefined) {
      if (!this.currentSession.memory.initialJsHeapMb) {
        this.currentSession.memory.initialJsHeapMb = jsHeapMb;
      }
      this.currentSession.memory.finalJsHeapMb = jsHeapMb;
      this.currentSession.memory.peakJsHeapMb = Math.max(
        this.currentSession.memory.peakJsHeapMb || 0,
        jsHeapMb
      );
    }
  }

  endSession(): SessionTelemetrySummary | null {
    if (!this.currentSession) return null;
    this.currentSession.endTimeIso = new Date().toISOString();
    const summary = { ...this.currentSession };
    this.saveCheckpoint();
    return summary;
  }

  exportAnonymizedReport(): AnonymizedSessionExport | null {
    if (!this.currentSession) return null;
    return {
      exportVersion: TELEMETRY_SCHEMA_VERSION,
      exportDateIso: new Date().toISOString(),
      summary: { ...this.currentSession },
      events: [...this.cueEvents],
    };
  }

  async clearData(): Promise<void> {
    this.currentSession = null;
    this.cueEvents = [];
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.remove([
        'vesta_dogfood_current_session',
        'vesta_dogfood_events',
      ]);
    }
  }

  private saveCheckpoint(): void {
    if (typeof chrome !== 'undefined' && chrome.storage?.local && this.currentSession) {
      chrome.storage.local.set({
        vesta_dogfood_current_session: this.currentSession,
        // Only keep last 50 events in storage to strictly bound storage quota
        vesta_dogfood_recent_events: this.cueEvents.slice(-50),
      }).catch(() => {});
    }
  }
}
