import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { Translator } from '../src/subtitles/Translator';
import { translateSentences } from '../src/translation/ContextualTranslator';
import { readTranslateResponse } from '../src/translation/CloudTranslationClient';
import { TranslationSetupRequiredError } from '../src/translation/TranslationRateLimit';
import { PreloadedTranslationRateLimit, translateCueIndexes, translateCueWindows } from '../src/subtitles/PreloadedTranscriptPipeline';
import {
  MAX_RETRY_AFTER_MS,
  nextRateLimitWaitMs,
  parseRetryAfterHeader,
  rateLimitUserMessage,
  TranslationRateLimitError,
  translationCacheKey,
  translationClock,
} from '../src/translation/TranslationRateLimit';

const successBody = JSON.parse(readFileSync(new URL('./fixtures/translation/translate_a_success.json', import.meta.url), 'utf8'));
const rateLimitBody = readFileSync(new URL('./fixtures/translation/translate_a_429.html', import.meta.url), 'utf8');
const originalFetch = globalThis.fetch;
const originalChrome = (globalThis as { chrome?: unknown }).chrome;

function cues(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `cue-${index}`,
    index,
    startTime: index * 3,
    endTime: index * 3 + 2.5,
    duration: 2.5,
    originalText: `Sentence number ${index} is ready.`,
    turkishText: '',
  }));
}

function restoreClock(): void {
  translationClock.now = () => Date.now();
  translationClock.sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });
  translationClock.random = () => Math.random();
}

beforeEach(() => {
  Translator.resetForTests();
  restoreClock();
});

afterEach(() => {
  Translator.resetForTests();
  restoreClock();
  globalThis.fetch = originalFetch;
  if (originalChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome;
  else (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

describe('P5.4 translation rate-limit fixtures', () => {
  it('parses a Cloud Translation payload and a recorded 429 without treating the HTML or the old client array as Turkish', async () => {
    const success = await readTranslateResponse({
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: [{ translatedText: 'Merhaba dünya' }] } }),
    });
    expect(success).toEqual({ ok: true, translatedText: 'Merhaba dünya' });
    const legacy = await readTranslateResponse({
      ok: true,
      status: 200,
      json: async () => successBody,
    });
    expect(legacy.ok).toBe(false);

    let parsedBody = false;
    const blocked = await readTranslateResponse({
      ok: false,
      status: 429,
      headers: { get: name => (name.toLowerCase() === 'retry-after' ? '30' : null) },
      json: async () => { parsedBody = true; return successBody; },
    });
    expect(parsedBody).toBe(false);
    expect(blocked).toMatchObject({ ok: false, status: 429, retryAfterMs: 30_000, error: 'HTTP 429' });
    expect(JSON.stringify(blocked)).not.toContain('Merhaba');
    expect(rateLimitBody).toContain('automated queries');
  });

  it('does not fetch again when the worker reports HTTP 429', async () => {
    const sleeps: number[] = [];
    translationClock.random = () => 0;
    translationClock.sleep = async ms => { sleeps.push(ms); };
    let fetches = 0;
    globalThis.fetch = (async () => { fetches += 1; throw new Error('direct fetch should not run'); }) as unknown as typeof fetch;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: (_message: unknown, callback: (response: unknown) => void) => {
          callback({ success: false, error: 'HTTP 429', status: 429, retryAfterMs: 30_000 });
        },
      },
    };

    const error = await Translator.toTurkish('Hello from the source cue.').catch(reason => reason);
    expect(error).toBeInstanceOf(TranslationRateLimitError);
    expect(error.retryAfterMs).toBe(30_000);
    expect(String(error.message)).not.toContain('Hello from the source cue.');
    expect(fetches).toBe(0);
    expect(sleeps).toEqual([]);
    expect(Translator.transportAttempts).toBe(1);

    await expect(Translator.toTurkish('A different sentence.')).rejects.toBeInstanceOf(TranslationRateLimitError);
    expect(Translator.transportAttempts).toBe(1);
  });

  it('retries once after a short Retry-After and then stops', async () => {
    const sleeps: number[] = [];
    let now = 10_000;
    translationClock.now = () => now;
    translationClock.random = () => 0;
    translationClock.sleep = async ms => { sleeps.push(ms); };
    const scripted = [1_000, 2_000, 30_000];
    let calls = 0;
    let fetches = 0;
    globalThis.fetch = (async () => { fetches += 1; throw new Error('direct fetch should not run'); }) as unknown as typeof fetch;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: (_message: unknown, callback: (response: unknown) => void) => {
          const retryAfterMs = scripted[Math.min(calls, scripted.length - 1)];
          calls += 1;
          callback({ success: false, error: 'HTTP 429', status: 429, retryAfterMs });
        },
      },
    };

    const error = await Translator.toTurkish('Source sentence.').catch(reason => reason);
    expect(error).toBeInstanceOf(TranslationRateLimitError);
    expect(calls).toBe(2);
    expect(fetches).toBe(0);
    expect(sleeps).toEqual([1000]);
    expect(error.retryAfterMs).toBe(2000);
    expect(Translator.transportAttempts).toBe(2);

    await expect(Translator.toTurkish('Next sentence.')).rejects.toMatchObject({ blocked: true });
    expect(calls).toBe(2);

    now += 2000;
    await expect(Translator.toTurkish('Next sentence.')).rejects.toBeInstanceOf(TranslationRateLimitError);
    expect(calls).toBe(3);
  });

  it('shares one in-flight request and caches by language plus request text', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: (message: { text: string }, callback: (response: unknown) => void) => {
          calls += 1;
          void gate.then(() => callback({ success: true, translatedText: `TR ${message.text}` }));
        },
      },
    };

    const first = Translator.toTurkish(' alpha ');
    const second = Translator.toTurkish('alpha');
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await expect(first).resolves.toBe('TR alpha');
    await expect(second).resolves.toBe('TR alpha');
    await Translator.toTurkish('alpha');
    await Translator.toTurkish('alpha\nbeta');
    expect(calls).toBe(2);
    expect(translationCacheKey('tr', ' alpha ')).toBe(translationCacheKey('tr', 'alpha'));
    expect(translationCacheKey('en', 'alpha')).not.toBe(translationCacheKey('tr', 'alpha'));
  });

  it('keeps a single endpoint attempt in flight even when batch concurrency is higher', async () => {
    let active = 0;
    let maxActive = 0;
    const pending: Array<() => void> = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: (message: { text: string }, callback: (response: unknown) => void) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          pending.push(() => {
            active -= 1;
            callback({ success: true, translatedText: `TR ${message.text}` });
          });
        },
      },
    };

    const job = Translator.batchToTurkish(['one', 'two', 'three'], 5);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(pending).toHaveLength(1);
    pending.shift()?.();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    pending.shift()?.();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    pending.shift()?.();
    await expect(job).resolves.toEqual(['TR one', 'TR two', 'TR three']);
    expect(maxActive).toBe(1);
  });

  it('evicts the oldest success and does not cache a 429 as Turkish', async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: (message: { text: string }, callback: (response: unknown) => void) => {
          callback({ success: true, translatedText: `TR ${message.text}` });
        },
      },
    };
    for (let i = 0; i < 1001; i++) await Translator.toTurkish(`unique sentence ${i}`);
    expect(Translator.transportAttempts).toBe(1001);
    await Translator.toTurkish('unique sentence 1000');
    expect(Translator.transportAttempts).toBe(1001);
    await Translator.toTurkish('unique sentence 0');
    expect(Translator.transportAttempts).toBe(1002);

    Translator.resetForTests();
    let now = 50_000;
    translationClock.now = () => now;
    translationClock.random = () => 0;
    translationClock.sleep = async () => {};
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: (_message: unknown, callback: (response: unknown) => void) => {
          callback({ success: false, error: 'HTTP 429', status: 429, retryAfterMs: 30_000 });
        },
      },
    };
    await expect(Translator.toTurkish('not cached')).rejects.toBeInstanceOf(TranslationRateLimitError);
    now += 30_000;
    await expect(Translator.toTurkish('not cached')).rejects.toBeInstanceOf(TranslationRateLimitError);
    expect(Translator.transportAttempts).toBe(2);
  });

  it('does not fetch when the worker does not answer', async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return { ok: true, status: 200, json: async () => successBody };
    }) as unknown as typeof fetch;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        get lastError() { return { message: 'worker unavailable' }; },
        sendMessage: (_message: unknown, callback: (response: unknown) => void) => callback(undefined),
      },
    };
    await expect(Translator.toTurkish('Hello world')).rejects.toBeInstanceOf(TranslationSetupRequiredError);
    expect(fetches).toBe(0);
    await expect(Translator.toTurkish('Hello world')).rejects.toMatchObject({ reason: 'unavailable' });
    expect(fetches).toBe(0);
  });
});

describe('P5.4 sentence request amplification', () => {
  it('does not fan a 429 batch out into one request per sentence', async () => {
    let calls = 0;
    const error = await translateSentences(
      ['First.', 'Second.', 'Third.', 'Fourth.'],
      async () => { calls += 1; throw new Error('Translation HTTP error 429'); },
    ).catch(reason => reason);
    expect(error).toBeInstanceOf(TranslationRateLimitError);
    expect(calls).toBe(1);
    expect(error.partial).toHaveLength(4);
    expect(error.partial.every((item: { turkish: string }) => item.turkish === '')).toBe(true);
    expect(error.partial.every((item: { compromises: string[] }) => item.compromises.includes('translation_rate_limited'))).toBe(true);
  });

  it('still splits a successful batch that does not align', async () => {
    let calls = 0;
    const results = await translateSentences(['First.', 'Second.', 'Third.'], async text => {
      calls += 1;
      return calls === 1 ? 'tek satir' : `TR ${text}`;
    });
    expect(calls).toBe(4);
    expect(results.map(item => item.turkish)).toEqual(['TR First.', 'TR Second.', 'TR Third.']);
  });

  it('stops the rest of a cue list on the first 429 and keeps earlier Turkish text', async () => {
    let calls = 0;
    const published: number[][] = [];
    const job = translateCueWindows(cues(9), cues(9).map((_, index) => index), async text => {
      calls += 1;
      if (calls > 1) throw new TranslationRateLimitError(4_000);
      return text.split('\n').map(line => `TR ${line}`).join('\n');
    }, () => true, entries => published.push(entries.map(entry => entry.index)), 3);

    await expect(job).rejects.toBeInstanceOf(PreloadedTranslationRateLimit);
    expect(calls).toBe(2);
    expect(published[0]).toEqual([0, 1, 2]);

    let partialCalls = 0;
    const partial = translateCueIndexes(cues(6), [0, 1, 2, 3, 4, 5], async text => {
      partialCalls += 1;
      if (partialCalls > 1) throw new TranslationRateLimitError(5_000);
      return text.split('\n').map(line => `TR ${line}`).join('\n');
    }, () => true);
    const error = await partial.catch(reason => reason);
    expect(error).toBeInstanceOf(PreloadedTranslationRateLimit);
    expect(partialCalls).toBe(2);
    expect(error.cues.slice(0, 3).every((cue: { turkishText: string }) => cue.turkishText.startsWith('TR '))).toBe(true);
    expect(error.cues.slice(3).every((cue: { turkishText: string; originalText: string }) => cue.turkishText === '' && cue.turkishText !== cue.originalText)).toBe(true);
  });

  it('reuses a cached sentence after a later request for the same text', async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: (message: { text: string }, callback: (response: unknown) => void) => {
          callback({ success: true, translatedText: `TR ${message.text}` });
        },
      },
    };
    const prepared = cues(2);
    const translate = (text: string) => Translator.toTurkish(text);
    await translateCueIndexes(prepared, [0, 1], translate, () => true);
    const attempts = Translator.transportAttempts;
    await translateCueIndexes(prepared, [0, 1], translate, () => true);
    expect(Translator.transportAttempts).toBe(attempts);
  });
});

describe('P5.4 backoff and recovery copy', () => {
  it('honors Retry-After over exponential jitter and caps the wait', () => {
    expect(nextRateLimitWaitMs({ attemptIndex: 4, retryAfterMs: 5_000, random: 0.99 })).toBe(5_000);
    expect(nextRateLimitWaitMs({ attemptIndex: 0, retryAfterMs: null, random: 0 })).toBe(1_000);
    expect(nextRateLimitWaitMs({ attemptIndex: 0, retryAfterMs: null, random: 0.5 })).toBe(1_125);
    expect(nextRateLimitWaitMs({ attemptIndex: 3, retryAfterMs: null, random: 0 })).toBe(8_000);
    expect(nextRateLimitWaitMs({ attemptIndex: 10, retryAfterMs: null, random: 0 })).toBe(60_000);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterHeader(new Date(now + 15_000).toUTCString(), now)).toBe(15_000);
    expect(parseRetryAfterHeader('later', now)).toBeNull();
    expect(parseRetryAfterHeader(String(MAX_RETRY_AFTER_MS / 1000 + 5), now)).toBe(MAX_RETRY_AFTER_MS);
    const message = rateLimitUserMessage({ retryAfterMs: 30_000 });
    expect(message).toContain('HTTP 429');
    expect(message).toContain('will not substitute English');
    expect(message).toContain('paused for about 30s');
    expect(message).toContain('no automatic resume');
    expect(message).not.toContain('Playback can continue');
  });
});
