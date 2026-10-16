import { describe, it, expect, vi, afterEach } from 'vitest';
import { TranscriptSentenceAssembler } from '../src/subtitles/TranscriptSentenceAssembler';
import { prepareSpokenCues, selectSpokenSourceTrack, startupIndexes, translateCueIndexes } from '../src/subtitles/PreloadedTranscriptPipeline';
import { findSemanticCompromises, protectSource, translateSentences } from '../src/translation/ContextualTranslator';
import { DubbingScheduler } from '../src/audio/DubbingScheduler';
import { SpeakerManager } from '../src/speaker/SpeakerManager';
import { TurkishSpeechNormalizer } from '../src/tts/TurkishSpeechNormalizer';
import { SubtitleCue, SubtitleTrack } from '../src/core/types';

const cue = (index: number, start: number, end: number, text: string, speaker = 'speaker-a'): SubtitleCue => ({
  id: `raw-${index}`,
  index,
  startTime: start,
  endTime: end,
  duration: end - start,
  originalText: text,
  turkishText: text,
  speakerId: speaker,
});

describe('P5 transcript sentence reconstruction', () => {
  it('joins the reported weird/strange fragments without dropping either really', () => {
    const sentences = TranscriptSentenceAssembler.assemble([
      cue(0, 10.0, 11.2, "and so that's really"),
      cue(1, 11.2, 12.6, 'weird and strange and'),
      cue(2, 12.6, 13.8, "fundamentally we don't"),
      cue(3, 13.8, 15.0, 'really know'),
    ]);
    expect(sentences).toHaveLength(1);
    expect(sentences[0].text).toBe("and so that's really weird and strange and fundamentally we don't really know");
    expect(sentences[0].cueIds).toEqual(['raw-0', 'raw-1', 'raw-2', 'raw-3']);
    expect(sentences[0].startTime).toBeCloseTo(10, 2);
    expect(sentences[0].endTime).toBeCloseTo(15, 2);
  });

  it('keeps llms inside one sentence and drops a rolling ASR revision', () => {
    const sentences = TranscriptSentenceAssembler.assemble([
      cue(0, 20.0, 21.5, 'story short think of llms as'),
      cue(1, 21.2, 22.8, 'think of llms as kind of like'),
      cue(2, 22.6, 24.0, 'kind of like most mostly'),
      cue(3, 23.8, 25.5, "inscrutable artifacts they're not similar"),
    ]);
    const text = sentences.map(sentence => sentence.text).join(' ');
    expect(text).toContain('llms');
    expect(text.match(/llms/gi)).toHaveLength(1);
    expect(text).toContain('most mostly');
    expect(text).toContain("they're not similar");
    expect(text).not.toContain('think of llms as think of llms');
  });

  it('distinguishes a repeated word from a duplicate ASR fragment', () => {
    const repeated = TranscriptSentenceAssembler.assemble([
      cue(0, 1.0, 2.2, 'no no no.'),
      cue(1, 4.0, 5.0, 'no.'),
    ]);
    expect(repeated.map(sentence => sentence.text)).toEqual(['no no no.', 'no.']);

    const revision = TranscriptSentenceAssembler.assemble([
      cue(0, 1.0, 2.4, 'think of llms as kind of'),
      cue(1, 1.1, 2.5, 'think of llms as kind of'),
    ]);
    expect(revision).toHaveLength(1);
    expect(revision[0].text).toBe('think of llms as kind of');
    expect(revision[0].dedupedTokens).toBe(6);
  });

  it('does not end a sentence on Dr. and does not merge speakers', () => {
    const sentences = TranscriptSentenceAssembler.assemble([
      cue(0, 0, 1.2, 'Dr. Smith spoke today.', 'speaker-a'),
      cue(1, 1.4, 2.4, 'I agree.', 'speaker-b'),
    ]);
    expect(sentences.map(sentence => sentence.text)).toEqual(['Dr. Smith spoke today.', 'I agree.']);
  });

  it('assembles thousands of fragments without translating them', () => {
    const raw = Array.from({ length: 3407 }, (_, index) => cue(index, index * 1.05, index * 1.05 + 1, `token ${index} continues`));
    const started = performance.now();
    const cues = prepareSpokenCues(raw, 'en', 'vid');
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(250);
    expect(cues.length).toBeGreaterThan(100);
    expect(cues.length).toBeLessThan(raw.length);
    expect(cues.every(item => item.turkishText === '')).toBe(true);
    expect(cues[0].originalText).toContain('token 0');
  });
});

describe('P5 contextual translation', () => {
  it('protects LLMs and keeps weird distinct from strange', async () => {
    const source = 'think of LLMs as kind of weird and strange artifacts';
    const protectedSource = protectSource(source);
    expect(protectedSource.text).toContain('ZXLLMS');
    expect(protectedSource.text).toContain('ZXWEIRD');
    expect(protectedSource.text).toContain('ZXSTRANGE');
    expect(protectedSource.text).not.toMatch(/\bLLMs?\b/);

    const [result] = await translateSentences([source], async text => `çeviri ${text}`);
    expect(result.turkish).toContain('büyük dil modelleri');
    expect(result.turkish).toContain('tuhaf');
    expect(result.turkish).toContain('garip');
    expect(result.turkish.toLowerCase()).not.toContain('film');
  });

  it('flags the reported tuhaf ve tuhaf collapse as a semantic compromise', () => {
    const issues = findSemanticCompromises(
      'and so that is really weird and strange',
      've bu gerçekten çok tuhaf ve tuhaf',
    );
    expect(issues).toContain('unnatural_repetition:tuhaf');
  });

  it('uses a neighbor batch when the translator preserves line breaks', async () => {
    const results = await translateSentences(
      ['First sentence.', 'They improved it.'],
      async text => text.split('\n').map(line => `TR ${line}`).join('\n'),
    );
    expect(results[1].aligned).toBe(true);
    expect(results[1].turkish).toBe('TR They improved it.');
    expect(results[0].turkish).toBe('TR First sentence.');
  });

  it('translates only the startup window', async () => {
    const raw = Array.from({ length: 40 }, (_, index) => cue(index, index * 3, index * 3 + 2.5, `Sentence number ${index}.`));
    const prepared = prepareSpokenCues(raw, 'en');
    const indexes = startupIndexes(prepared, 30);
    expect(indexes.length).toBeLessThanOrEqual(8);
    expect(indexes.every(index => prepared[index].endTime >= 29)).toBe(true);
    let calls = 0;
    const translated = await translateCueIndexes(prepared, indexes, async text => {
      calls += 1;
      return `TR ${text}`;
    }, () => true);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(indexes.length);
    expect(indexes.filter(index => translated[index].turkishText.includes('Sentence number')).length).toBe(indexes.length);
    expect(translated.filter(item => !item.turkishText).length).toBe(translated.length - indexes.length);
  });

  it('prefers English ASR over a Turkish translation track', () => {
    const tracks: SubtitleTrack[] = [
      { id: 'tr', languageCode: 'tr', name: 'Turkish', kind: 'standard', baseUrl: 'https://example.test/tr' },
      { id: 'en', languageCode: 'en', name: 'English', kind: 'asr', baseUrl: 'https://example.test/en' },
    ];
    expect(selectSpokenSourceTrack(tracks)?.id).toBe('en');
  });
});

describe('P5 continuous scheduling and background clock', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function setup() {
    const sources: any[] = [];
    const ctx: any = {
      state: 'running',
      currentTime: 5,
      createBufferSource: () => {
        const source = {
          buffer: null,
          playbackRate: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null as null | (() => void),
        };
        sources.push(source);
        return source;
      },
    };
    const audio: any = {
      attachVideo: vi.fn(),
      getContext: vi.fn(async () => ctx),
      createAudioBuffer: vi.fn(async (samples: Float32Array, sampleRate: number) => ({
        duration: samples.length / sampleRate,
        length: samples.length,
        numberOfChannels: 1,
      })),
      getDubbingGain: () => ({}),
      duckVideo: vi.fn(),
      unduckVideo: vi.fn(),
    };
    const pending: Array<(value: unknown) => void> = [];
    const tts: any = { synthesize: vi.fn(() => new Promise(resolve => pending.push(resolve))) };
    const scheduler = new DubbingScheduler(audio, tts, new SpeakerManager());
    (scheduler as any).video = { currentTime: 1.2, paused: false, playbackRate: 1, addEventListener() {}, removeEventListener() {} };
    (scheduler as any).lastTime = 1.2;
    (scheduler as any).lastTickMs = performance.now();
    scheduler.setEnabled(true);
    const finishNext = async (durationSec: number) => {
      const resolve = pending.shift();
      if (!resolve) throw new Error('no pending synthesis');
      resolve({ audio: new Float32Array(48000 * durationSec).fill(0.1), sampleRate: 48000, duration: durationSec });
      for (let i = 0; i < 30; i++) await Promise.resolve();
    };
    return { scheduler, sources, audio, ctx, finishNext, tts };
  }

  it('pre-schedules the next sentence before the active source ends', async () => {
    const { scheduler, sources, audio, finishNext } = setup();
    scheduler.setCues([
      cue(0, 1, 4, 'Birinci cümle bitti.'),
      cue(1, 4.2, 8, 'İkinci cümle burada.'),
    ].map(item => ({ ...item, id: item.id, turkishText: item.originalText })));
    (scheduler as any).update();
    await finishNext(2);
    expect(sources[0].start).toHaveBeenCalledWith(5, 0);

    (scheduler as any).update();
    await finishNext(2);
    (scheduler as any).update();
    for (let i = 0; i < 30; i++) await Promise.resolve();

    expect(sources).toHaveLength(2);
    expect(sources[1].start.mock.calls[0][0]).toBeCloseTo(7.22, 2);
    expect(sources[1].start.mock.calls[0][1]).toBe(0);
    const unducks = audio.unduckVideo.mock.calls.length;
    sources[0].onended();
    expect((scheduler as any).activeSource).toBe(sources[1]);
    expect(audio.unduckVideo.mock.calls.length).toBe(unducks);
    const stats = scheduler.getContinuityStats();
    expect(stats.max).not.toBeNull();
    expect(stats.max as number).toBeLessThan(0.45);
  });

  it('cancels a queued successor on seek', async () => {
    const { scheduler, sources, finishNext } = setup();
    scheduler.setCues([
      { ...cue(0, 1, 4, 'Birinci cümle bitti.'), turkishText: 'Birinci cümle bitti.' },
      { ...cue(1, 4.2, 8, 'İkinci cümle burada.'), turkishText: 'İkinci cümle burada.' },
    ]);
    (scheduler as any).update();
    await finishNext(2);
    (scheduler as any).update();
    await finishNext(2);
    (scheduler as any).update();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(sources).toHaveLength(2);
    (scheduler as any).handleSeeking();
    expect(sources[1].stop).toHaveBeenCalled();
    expect((scheduler as any).queuedSource).toBeNull();
  });

  it('does not consume a ready successor at the synthesis frontier 14 seconds early', async () => {
    const { scheduler, sources, finishNext } = setup();
    scheduler.setCues([
      cue(0, 1, 4, 'Birinci cümle.'),
      cue(1, 14, 18, 'Gelecekteki cümle.'),
    ]);
    (scheduler as any).update();
    await finishNext(1);
    (scheduler as any).update();
    await finishNext(1);
    (scheduler as any).update();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(sources).toHaveLength(2);
    // ctx=5 / video=1.2: earliest allowed video start is 13, not 2.42.
    expect(sources[1].start.mock.calls[0][0]).toBeCloseTo(16.8, 3);
    expect(scheduler.trace.find(e=>e.stage==='buffer_scheduled'&&e.queued)?.plannedVideoStart).toBeCloseTo(13, 3);
    (scheduler as any).handleSeeking();
    expect(sources[1].stop).toHaveBeenCalled();
  });

  it('records a hidden transition without pausing the media element', () => {
    const { scheduler } = setup();
    const listeners: Record<string, () => void> = {};
    const documentStub = {
      visibilityState: 'visible',
      addEventListener: vi.fn((name: string, fn: () => void) => { listeners[name] = fn; }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('document', documentStub);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const video = {
      currentTime: 3,
      paused: false,
      playbackRate: 1,
      pause: vi.fn(),
      addEventListener() {},
      removeEventListener() {},
    };
    scheduler.attachVideo(video as unknown as HTMLVideoElement);
    scheduler.setEnabled(true);
    documentStub.visibilityState = 'hidden';
    listeners.visibilitychange();
    expect(video.pause).not.toHaveBeenCalled();
    expect(video.paused).toBe(false);
    expect(scheduler.trace.filter(event => event.stage === 'visibility_changed').at(-1)?.visibility).toBe('hidden');
    scheduler.detachVideo();
  });

  it('arms an interval clock when the document is hidden', () => {
    const { scheduler } = setup();
    const documentStub = {
      visibilityState: 'hidden',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('document', documentStub);
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    const interval = vi.spyOn(globalThis, 'setInterval');
    scheduler.attachVideo({ currentTime: 0, paused: true, playbackRate: 1, addEventListener() {}, removeEventListener() {} } as unknown as HTMLVideoElement);
    expect(interval).toHaveBeenCalled();
    expect(documentStub.addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    scheduler.detachVideo();
    interval.mockRestore();
  });
});

describe('P5 pronunciation text contract', () => {
  it('keeps display text and expands the reported technical terms', () => {
    const samples = [
      ['AI', 'ey ay'],
      ['ai', 'ey ay'],
      ['OpenAI', 'opın ey ay'],
      ['Meta AI', 'meta ey ay'],
      ['GPT', 'ci pi ti'],
      ['GPT-4', 'ci pi ti dört'],
      ['70B', 'yetmiş milyar'],
      ['270B', 'iki yüz yetmiş milyar'],
    ] as const;
    for (const [display, spoken] of samples) {
      const result = TurkishSpeechNormalizer.normalize(display);
      expect(result.displayText).toBe(display);
      expect(result.spokenText).toBe(spoken);
    }
  });
});
