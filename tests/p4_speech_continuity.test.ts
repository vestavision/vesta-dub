import { describe, it, expect, vi } from 'vitest';
import { DubbingScheduler } from '../src/audio/DubbingScheduler';
import { SpeakerManager } from '../src/speaker/SpeakerManager';
import { SubtitleCue } from '../src/core/types';

const makeCue = (id: string, text: string, start = 1.0, end = 3.0): SubtitleCue => ({
  id,
  index: 0,
  startTime: start,
  endTime: end,
  duration: end - start,
  originalText: text,
  turkishText: text,
  speakerId: 'speaker-a',
});

function setupScheduler() {
  const sources: any[] = [];
  const ctx: any = {
    state: 'running',
    currentTime: 10.0,
    createBufferSource: () => {
      const s = {
        buffer: null,
        playbackRate: { value: 1 },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as any,
      };
      sources.push(s);
      return s;
    },
  };
  const audioManager: any = {
    getContext: vi.fn(async () => ctx),
    createAudioBuffer: vi.fn(async (a: Float32Array, sr: number) => ({
      duration: a.length / sr,
      length: a.length,
      numberOfChannels: 1,
    })),
    getDubbingGain: () => ({}),
    duckVideo: vi.fn(),
    unduckVideo: vi.fn(),
  };
  let ttsResolver: any;
  const ttsManager: any = {
    synthesize: vi.fn(() => new Promise(r => { ttsResolver = r; })),
  };
  const scheduler = new DubbingScheduler(audioManager, ttsManager, new SpeakerManager());
  (scheduler as any).video = { currentTime: 1.0, paused: false, playbackRate: 1 } as any;
  scheduler.setEnabled(true);

  const finishSynthesis = async (durationSec = 1.5) => {
    ttsResolver({
      audio: new Float32Array(48000 * durationSec).fill(0.1),
      sampleRate: 48000,
      duration: durationSec,
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  return { scheduler, ctx, sources, audioManager, ttsManager, finishSynthesis };
}

describe('P4 Speech Continuity & Adaptive Pause Policy', () => {
  it('schedules subsequent phrases on AudioContext timeline with adaptive pause for sentence end', async () => {
    const { scheduler, ctx, sources, finishSynthesis } = setupScheduler();
    scheduler.setCaptionMode('live');

    // First phrase ending with period
    const cue1 = makeCue('cue-1', 'Merhaba dünya.', 1.0, 3.0);
    scheduler.appendLiveCue(cue1);
    (scheduler as any).update();
    await finishSynthesis(1.5);

    expect(sources).toHaveLength(1);
    expect(sources[0].start).toHaveBeenCalledWith(10.0, 0);

    // Advance video time to cue2 startTime
    (scheduler as any).lastTime = 3.5; (scheduler as any).lastTickMs = performance.now(); (scheduler as any).video.currentTime = 3.5;
    const cue2 = makeCue('cue-2', 'İkinci cümle burada.', 3.5, 5.5);
    scheduler.appendLiveCue(cue2);
    // End first source
    sources[0].onended();
    (scheduler as any).update();
    await finishSynthesis(1.0);

    expect(sources).toHaveLength(2);
    // Expected scheduleTime = 10.0 + 1.5s (buffer duration) + 0.35s (adaptive sentence pause) = 11.85s
    const secondStartTime = sources[1].start.mock.calls[0][0];
    expect(secondStartTime).toBeCloseTo(11.85, 2);
  });

  it('compresses adaptive pause when live queue is lagging behind video playback', async () => {
    const { scheduler, ctx, sources, finishSynthesis } = setupScheduler();
    scheduler.setCaptionMode('live');

    const cue1 = makeCue('cue-1', 'Gecikmeli ilk cümle.', 1.0, 3.0);
    scheduler.appendLiveCue(cue1);
    (scheduler as any).update();
    await finishSynthesis(1.0);

    // Simulate significant lag (video time is 6.5s, cue starts at 1.5s -> 5.0s lag)
    (scheduler as any).lastTime = 6.5; (scheduler as any).lastTickMs = performance.now(); (scheduler as any).video.currentTime = 6.5;

    const cue2 = makeCue('cue-2', 'Gecikmeli ikinci cümle.', 1.5, 3.5);
    scheduler.appendLiveCue(cue2);
    sources[0].onended();
    (scheduler as any).update();
    await finishSynthesis(1.0);

    expect(sources).toHaveLength(2);
    // When lateSec > 4.0, targetPause is compressed to 0.05s
    // scheduleTime = 10.0 + 1.0s (buffer 1) + 0.05s = 11.05s
    const secondStartTime = sources[1].start.mock.calls[0][0];
    expect(secondStartTime).toBeCloseTo(11.05, 2);
  });

  it('resets audio context timeline tracking on seek jump', async () => {
    const { scheduler, ctx, sources, finishSynthesis } = setupScheduler();
    scheduler.setCaptionMode('live');

    const cue1 = makeCue('cue-1', 'Önceki cümle.', 1.0, 3.0);
    scheduler.appendLiveCue(cue1);
    (scheduler as any).update();
    await finishSynthesis(1.0);

    // Seeking reset
    (scheduler as any).handleSeeking();
    expect((scheduler as any).lastSourceEndContextTime).toBe(0);
    expect((scheduler as any).lastSpokenText).toBe('');
  });
});
