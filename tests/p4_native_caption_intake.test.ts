import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseHTML } from 'linkedom';
import { YouTubeSubtitleAdapter } from '../src/subtitles/YouTubeSubtitleAdapter';
import { PreloadedCaptionSource } from '../src/subtitles/PreloadedCaptionSource';
import { SubtitleTrack } from '../src/core/types';

describe('P4.1 Native Caption Response Integration & Intake Adapter', () => {
  let adapter: YouTubeSubtitleAdapter;
  let source: PreloadedCaptionSource;
  let mockWin: any;

  const mockTrack: SubtitleTrack = {
    id: 'track-en',
    languageCode: 'en',
    name: 'English (auto-generated)',
    kind: 'asr',
    baseUrl: 'https://www.youtube.com/api/timedtext?v=zjkBMFhNj_g&lang=en',
  };

  const sampleJson3 = JSON.stringify({
    wireMagic: 'pb3',
    events: [
      { tStartMs: 160, dDurationMs: 3500, segs: [{ utf8: 'Hi everyone, welcome to the talk.' }] },
      { tStartMs: 3800, dDurationMs: 4200, segs: [{ utf8: 'Today we discuss large language models.' }] },
      { tStartMs: 8200, dDurationMs: 5000, segs: [{ utf8: 'Let us start with pretraining.' }] },
    ],
  });

  beforeEach(() => {
    const { window, document } = parseHTML('<!DOCTYPE html><html><body></body></html>');
    mockWin = window;
    mockWin.__vesta_caption_cache = {};
    vi.stubGlobal('window', mockWin);
    vi.stubGlobal('document', document);
    vi.stubGlobal('location', { href: 'https://www.youtube.com/watch?v=zjkBMFhNj_g' });

    adapter = new YouTubeSubtitleAdapter();
    source = new PreloadedCaptionSource(adapter);
    vi.spyOn(adapter, 'getVideoId').mockReturnValue('zjkBMFhNj_g');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('1. Successfully intakes native response payload from window cache and extracts cues', async () => {
    mockWin.__vesta_caption_cache['zjkBMFhNj_g'] = {
      videoId: 'zjkBMFhNj_g',
      languageCode: 'en',
      text: sampleJson3,
      url: 'https://www.youtube.com/api/timedtext?v=zjkBMFhNj_g&lang=en',
      timestamp: Date.now(),
    };

    const cues = await adapter.loadCues(mockTrack);
    expect(cues).toHaveLength(3);
    expect(cues[0].startTime).toBe(0.16);
    expect(cues[0].endTime).toBe(3.66);
    expect(cues[0].originalText).toBe('Hi everyone, welcome to the talk.');
    expect(cues[1].startTime).toBe(3.8);
    expect(cues[2].startTime).toBe(8.2);

    const logs = adapter.getDiagnosticLogs();
    const successLog = logs.find(l => l.requestedEndpoint === 'main_world_bridge_intercept');
    expect(successLog).toBeDefined();
    expect(successLog?.cuesExtracted).toBe(3);
    expect(successLog?.responseStatus).toBe(200);
  });

  it('2. Rejects cached payloads belonging to a different videoId (SPA navigation safety)', async () => {
    // Cache has stale data from another video
    mockWin.__vesta_caption_cache['other_video_123'] = {
      videoId: 'other_video_123',
      languageCode: 'en',
      text: sampleJson3,
      url: 'https://www.youtube.com/api/timedtext?v=other_video_123&lang=en',
      timestamp: Date.now(),
    };

    // Mock direct fetch returning 403 when cache doesn't match
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'Forbidden',
    });

    const cues = await adapter.loadCues(mockTrack);
    expect(cues).toHaveLength(0); // Old video data was NOT admitted!
  });

  it('3. PreloadedCaptionSource exposes futureCuesAvailable=true when cues are loaded', async () => {
    mockWin.__vesta_caption_cache['zjkBMFhNj_g'] = {
      videoId: 'zjkBMFhNj_g',
      languageCode: 'en',
      text: sampleJson3,
      url: 'https://www.youtube.com/api/timedtext?v=zjkBMFhNj_g&lang=en',
      timestamp: Date.now(),
    };

    let deliveredCues: any[] = [];
    let statusHistory: any[] = [];

    await source.start(
      { videoId: 'zjkBMFhNj_g', track: mockTrack },
      {
        onCues: (c) => { deliveredCues = c; },
        onStatus: (s) => { statusHistory.push(s); },
      }
    );

    expect(deliveredCues).toHaveLength(3);
    expect(source.getCapabilities().futureCuesAvailable).toBe(true);
    expect(source.getCapabilities().availability).toBe('available');
    expect(source.getCapabilities().timestamps).toBe('supplied');
  });

  it('4. Rejects corrupted / invalid json3 payloads without crashing', async () => {
    mockWin.__vesta_caption_cache['zjkBMFhNj_g'] = {
      videoId: 'zjkBMFhNj_g',
      languageCode: 'en',
      text: '{ "events": "not_an_array" }',
      url: 'https://www.youtube.com/api/timedtext?v=zjkBMFhNj_g&lang=en',
      timestamp: Date.now(),
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      text: async () => '',
    });

    const cues = await adapter.loadCues(mockTrack);
    expect(cues).toHaveLength(0);
  });

  it('5. Handles large multi-thousand cue payloads without running batch translation in loadCues', async () => {
    // Generate 3407 events simulating reference video zjkBMFhNj_g
    const events = Array.from({ length: 3407 }, (_, i) => ({
      tStartMs: i * 1050,
      dDurationMs: 1000,
      segs: [{ utf8: `Sentence token index ${i}` }],
    }));

    mockWin.__vesta_caption_cache['zjkBMFhNj_g'] = {
      videoId: 'zjkBMFhNj_g',
      languageCode: 'en',
      text: JSON.stringify({ events }),
      url: 'https://www.youtube.com/api/timedtext?v=zjkBMFhNj_g&lang=en',
      timestamp: Date.now(),
    };

    const t0 = performance.now();
    const cues = await adapter.loadCues(mockTrack);
    const durationMs = performance.now() - t0;

    expect(cues).toHaveLength(3407);
    expect(durationMs).toBeLessThan(500); // Must be near-instantaneous (no blocking translation)
    expect(cues[0].startTime).toBe(0);
    expect(cues[3406].startTime).toBe(3406 * 1.05);
  });
});
