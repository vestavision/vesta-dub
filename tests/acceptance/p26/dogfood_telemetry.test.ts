import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LocalTelemetryRecorder } from '../../../src/telemetry/LocalTelemetryRecorder';
import { DogfoodSessionRecorder } from '../../../src/diagnostics/DogfoodSessionRecorder';
import {
  TELEMETRY_SCHEMA_VERSION,
  ExecutionEnvironmentMode,
  CueTelemetryEvent,
} from '../../../src/telemetry/TelemetrySchema';

describe('P2.6 Dogfood Telemetry & Session Recorder Acceptance Suite', () => {
  let telemetry: LocalTelemetryRecorder;
  let recorder: DogfoodSessionRecorder;

  beforeEach(() => {
    // Clear any previous state
    telemetry = LocalTelemetryRecorder.getInstance();
    recorder = DogfoodSessionRecorder.getInstance();
    telemetry.setOptIn(true);
    telemetry.setIncludeRawTextDebug(false);
  });

  afterEach(() => {
    recorder.stopSession();
    telemetry.clearData();
  });

  it('Gate B.1: Telemetry Schema & Version Integrity', () => {
    expect(TELEMETRY_SCHEMA_VERSION).toBe('1.0.0');

    const sessionId = telemetry.startSession('real_live_youtube');
    expect(sessionId).toMatch(/^sess_\d+_[a-z0-9]+$/);

    const session = telemetry.getCurrentSession();
    expect(session).not.toBeNull();
    expect(session?.schemaVersion).toBe('1.0.0');
    expect(session?.environmentMode).toBe('real_live_youtube');
    expect(session?.cueCounts.processed).toBe(0);
    expect(session?.cueCounts.successfullyDubbed).toBe(0);
  });

  it('Gate B.2: Privacy Preservation — Raw Text Scrubbing by Default', () => {
    telemetry.startSession('real_live_youtube');

    // Record an event with original and Turkish subtitle text
    telemetry.recordCueEvent({
      cueId: 'cue-privacy-test-1',
      cueIndex: 1,
      timestampMs: 1000,
      videoId: 'dQw4w9WgXcQ',
      captionTrackType: 'standard',
      sourceLanguage: 'en',
      translationMethod: 'youtube_tlang',
      translationStatus: 'success',
      sourceTiming: { startTime: 1.0, endTime: 3.5, duration: 2.5 },
      schedulingTiming: { scheduledStartSec: 1.0, actualStartSec: 1.02, startDriftMs: 20 },
      ttsProvider: 'antalia',
      ttsLatencyMs: 45,
      refinement: { originalSyllables: 8, refinedSyllables: 8, isRefined: false, strategyUsed: 'strategy-a' },
      wsolaFactor: 1.0,
      expectedDurationSec: 2.5,
      actualPlaybackDurationSec: 2.45,
      endOverflowMs: 0,
      playbackOutcome: 'completed',
      underrun: false,
      cacheHit: true,
      debugOriginalText: 'Sensitive subtitle text about personal browsing',
      debugTurkishText: 'Kişisel gezinme hakkında hassas altyazı metni',
    });

    const exported = telemetry.exportAnonymizedReport();
    expect(exported).not.toBeNull();
    expect(exported?.events).toHaveLength(1);

    const event = exported!.events[0];
    expect(event.rawTextIncluded).toBe(false);
    expect(event.debugOriginalText).toBeUndefined();
    expect(event.debugTurkishText).toBeUndefined();
    expect(event.videoId).toBe('dQw4w9WgXcQ'); // Video ID preserved, full URL omitted
  });

  it('Gate B.3: Bounded Memory & Circular Buffer Invariance', () => {
    telemetry.startSession('real_live_youtube');

    // Emit 600 events to verify maximum buffer capping at 500
    for (let i = 0; i < 600; i++) {
      telemetry.recordCueEvent({
        cueId: `cue-bulk-${i}`,
        cueIndex: i,
        timestampMs: 1000 + i * 100,
        videoId: 'dQw4w9WgXcQ',
        captionTrackType: 'standard',
        sourceLanguage: 'en',
        translationMethod: 'youtube_tlang',
        translationStatus: 'success',
        sourceTiming: { startTime: i * 2, endTime: i * 2 + 2, duration: 2.0 },
        schedulingTiming: { scheduledStartSec: i * 2, actualStartSec: i * 2, startDriftMs: 5 },
        ttsProvider: 'antalia',
        ttsLatencyMs: 30,
        refinement: { originalSyllables: 6, refinedSyllables: 6, isRefined: false, strategyUsed: 'strategy-a' },
        wsolaFactor: 1.0,
        expectedDurationSec: 2.0,
        actualPlaybackDurationSec: 2.0,
        endOverflowMs: 0,
        playbackOutcome: 'completed',
        underrun: false,
        cacheHit: true,
      });
    }

    const exported = telemetry.exportAnonymizedReport();
    expect(exported?.events.length).toBeLessThanOrEqual(500);
    expect(exported?.summary.cueCounts.processed).toBe(600);
    expect(exported?.summary.cueCounts.successfullyDubbed).toBe(600);
  });

  it('Gate B.4: Real-time Recorder Strictly Distinguishes Real Live Playback vs Accelerated Simulation', () => {
    // Mode 1: Accelerated Simulation
    recorder.startSession('accelerated_simulation');
    expect(recorder.getEnvironmentMode()).toBe('accelerated_simulation');
    recorder.stopSession();

    // Mode 2: Real Live YouTube
    recorder.startSession('real_live_youtube');
    expect(recorder.getEnvironmentMode()).toBe('real_live_youtube');
    expect(recorder.getEnvironmentMode()).not.toBe('accelerated_simulation');

    // Simulate playback duration vs paused duration transitions
    recorder.onVideoPlay();
    expect(recorder.isSessionActive()).toBe(true);
    recorder.onVideoPause();

    const stats = recorder.getLiveStats();
    expect(stats.environmentMode).toBe('real_live_youtube');
    expect(stats.wallClockDurationSec).toBeGreaterThanOrEqual(0);

    recorder.stopSession();
    expect(recorder.isSessionActive()).toBe(false);
  });

  it('Gate B.5: Cue State Transitions — Scheduled -> Started -> Completed vs Interrupted vs Failed', () => {
    recorder.startSession('real_live_youtube');

    // 1. Scheduled -> Started -> Completed
    recorder.recordCueScheduled('cue-100', 1);
    recorder.recordCueStarted('cue-100');
    recorder.recordCueCompleted({
      cueId: 'cue-100',
      cueIndex: 1,
      timestampMs: 1500,
      videoId: 'demo-vid',
      captionTrackType: 'standard',
      sourceLanguage: 'en',
      translationMethod: 'youtube_tlang',
      translationStatus: 'success',
      sourceTiming: { startTime: 10, endTime: 12, duration: 2 },
      schedulingTiming: { scheduledStartSec: 10, actualStartSec: 10.01, startDriftMs: 10 },
      ttsProvider: 'antalia',
      ttsLatencyMs: 35,
      refinement: { originalSyllables: 5, refinedSyllables: 5, isRefined: false, strategyUsed: 'strategy-a' },
      wsolaFactor: 1.0,
      expectedDurationSec: 2,
      actualPlaybackDurationSec: 1.95,
      endOverflowMs: 0,
      underrun: false,
      cacheHit: true,
    });

    // 2. Scheduled -> Started -> Interrupted by user seek
    recorder.recordCueScheduled('cue-101', 2);
    recorder.recordCueStarted('cue-101');
    recorder.recordCueInterrupted('cue-101', 'user_seeking');

    // 3. Scheduled -> Failed
    recorder.recordCueScheduled('cue-102', 3);
    recorder.recordCueFailed(
      {
        cueId: 'cue-102',
        cueIndex: 3,
        timestampMs: 2500,
        videoId: 'demo-vid',
        captionTrackType: 'standard',
        sourceLanguage: 'en',
        translationMethod: 'youtube_tlang',
        translationStatus: 'failure',
        sourceTiming: { startTime: 14, endTime: 16, duration: 2 },
        schedulingTiming: { scheduledStartSec: 14, actualStartSec: 14, startDriftMs: 0 },
        ttsProvider: 'antalia',
        ttsLatencyMs: 0,
        refinement: { originalSyllables: 0, refinedSyllables: 0, isRefined: false, strategyUsed: 'none' },
        wsolaFactor: 1.0,
        expectedDurationSec: 2,
        actualPlaybackDurationSec: 0,
        endOverflowMs: 0,
        underrun: true,
        cacheHit: false,
      },
      'synthesis_failed'
    );

    // 4. Repeated cue detection
    recorder.recordCueScheduled('cue-100', 1);

    const stats = recorder.getLiveStats();
    expect(stats.counts.processed).toBe(2); // Completed + Failed recorded in telemetry
    expect(stats.counts.successfullyDubbed).toBe(1);
    expect(stats.counts.failed).toBe(1);
    expect(stats.counts.repeated).toBe(1);

    recorder.stopSession();
  });

  it('Gate B.6: Anonymized Export Format & Clean Storage Wipe', async () => {
    recorder.startSession('real_live_youtube');
    recorder.recordCueScheduled('cue-export-1', 0);
    recorder.recordCueStarted('cue-export-1');
    recorder.recordCueCompleted({
      cueId: 'cue-export-1',
      cueIndex: 0,
      timestampMs: 200,
      videoId: 'vid123',
      captionTrackType: 'standard',
      sourceLanguage: 'en',
      translationMethod: 'youtube_tlang',
      translationStatus: 'success',
      sourceTiming: { startTime: 0, endTime: 2, duration: 2 },
      schedulingTiming: { scheduledStartSec: 0, actualStartSec: 0, startDriftMs: 0 },
      ttsProvider: 'antalia',
      ttsLatencyMs: 25,
      refinement: { originalSyllables: 4, refinedSyllables: 4, isRefined: false, strategyUsed: 'strategy-a' },
      wsolaFactor: 1.0,
      expectedDurationSec: 2,
      actualPlaybackDurationSec: 2,
      endOverflowMs: 0,
      underrun: false,
      cacheHit: true,
    });

    const exportData = telemetry.exportAnonymizedReport();
    expect(exportData).not.toBeNull();
    expect(exportData?.exportVersion).toBe('1.0.0');
    expect(exportData?.summary.cueCounts.successfullyDubbed).toBe(1);
    expect(exportData?.events).toHaveLength(1);

    await telemetry.clearData();
    expect(telemetry.getCurrentSession()).toBeNull();
  });
});
