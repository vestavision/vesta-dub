import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type BergamotPort } from '../src/translation/BergamotSession';
import { MemoryTranslationCache } from '../src/translation/LocalTranslationCache';
import { LocalTranslationEngine } from '../src/translation/LocalTranslationEngine';
import { LocalTranslationError } from '../src/translation/LocalTranslationError';
import {
  downloadModelFile,
  LOCAL_TRANSLATION_FILES,
  sha256Hex,
  verifyRawModelFile,
} from '../src/translation/LocalTranslationModel';
import { translationRoute } from '../src/translation/TranslationMode';
import { Translator } from '../src/subtitles/Translator';
import { TRANSLATION_MODE_STORAGE } from '../src/translation/TranslationMode';

const root = path.resolve(import.meta.dirname, '..');
const modelDir = '/tmp/vesta-entr';
const modelReady = existsSync(path.join(modelDir, 'model.bin'))
  && existsSync(path.join(modelDir, 'lex.bin'))
  && existsSync(path.join(modelDir, 'vocab.bin'));

function fileBuffer(name: string): ArrayBuffer {
  const bytes = readFileSync(path.join(modelDir, name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function openNodePort(): BergamotPort {
  const worker = new Worker(pathToFileURL(path.join(root, 'public/bergamot/translator-worker.js')));
  return {
    postMessage: message => worker.postMessage(message),
    terminate: () => { void worker.terminate(); },
    addEventListener(type, handler) {
      if (type === 'message') worker.on('message', data => handler({ data }));
      else worker.on('error', error => handler({ message: error instanceof Error ? error.message : String(error) }));
    },
  };
}

describe('local-first translation routing', () => {
  it('keeps local as the default and does not route to cloud without an explicit mode', () => {
    expect(translationRoute('local', null)).toBe('local');
    expect(translationRoute('local', 'present-key-value-not-used')).toBe('local');
    expect(translationRoute('cloud', null)).toBe('cloud_setup');
    expect(translationRoute('cloud', 'present-key-value-not-used')).toBe('cloud');
  });

  it('does not reuse a cached translation after the mode changes', async () => {
    const store: Record<string, unknown> = { [TRANSLATION_MODE_STORAGE]: 'local' };
    let calls = 0;
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: { get: async (key: string) => ({ [key]: store[key] }) } },
      runtime: {
        lastError: undefined,
        sendMessage: (message: { text?: string }, callback: (response: unknown) => void) => {
          calls += 1;
          callback({ success: true, translatedText: `TR ${message.text}` });
        },
      },
    };
    Translator.resetForTests();
    await expect(Translator.toTurkish('Hello there')).resolves.toBe('TR Hello there');
    store[TRANSLATION_MODE_STORAGE] = 'cloud';
    await expect(Translator.toTurkish('Hello there')).resolves.toBe('TR Hello there');
    expect(calls).toBe(2);
    Translator.resetForTests();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('rejects a model file whose hash does not match the pin', async () => {
    const file = LOCAL_TRANSLATION_FILES[0];
    const gzip = gzipSync(Buffer.from('not the model'));
    const fetches: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      fetches.push(String(url));
      expect(init?.credentials).toBe('omit');
      expect(String(url).includes('?')).toBe(false);
      expect(String(url).startsWith('https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/')).toBe(true);
      return new Response(gzip, { status: 200 });
    }) as typeof fetch;
    await expect(downloadModelFile(file, fetchImpl, () => {})).rejects.toThrow(/hash|size/);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).not.toContain('translation.googleapis.com');
  });

  it('drops a corrupt cache and does not translate when the model host is unreachable', async () => {
    const cache = new MemoryTranslationCache();
    await cache.write({
      model: new ArrayBuffer(16),
      shortlist: new ArrayBuffer(16),
      vocab: new ArrayBuffer(16),
    });
    await expect(cache.read()).resolves.toBeNull();
    await expect(cache.present()).resolves.toBe(false);
    const urls: string[] = [];
    const engine = new LocalTranslationEngine({
      cache,
      openPort: () => { throw new Error('worker must stay closed'); },
      fetchImpl: (async (url: RequestInfo | URL) => {
        urls.push(String(url));
        return new Response('no', { status: 500 });
      }) as typeof fetch,
    });
    await expect(engine.translate('Hello, how are you?')).rejects.toBeInstanceOf(LocalTranslationError);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every(url => url.startsWith('https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/'))).toBe(true);
    expect(JSON.stringify(urls)).not.toContain('translation.googleapis.com');
    expect(JSON.stringify(urls)).not.toContain('Hello');
  });

  it.skipIf(!modelReady)('translates English to Turkish on the Bergamot CPU runtime', async () => {
    const buffers = {
      model: fileBuffer('model.bin'),
      shortlist: fileBuffer('lex.bin'),
      vocab: fileBuffer('vocab.bin'),
    };
    for (const file of LOCAL_TRANSLATION_FILES) {
      const bytes = file.name === 'model' ? buffers.model : file.name === 'shortlist' ? buffers.shortlist : buffers.vocab;
      await verifyRawModelFile(file, bytes);
      expect(await sha256Hex(bytes)).toBe(file.rawSha256);
    }
    const cache = new MemoryTranslationCache();
    await cache.write(buffers);
    let fetches = 0;
    const engine = new LocalTranslationEngine({
      cache,
      openPort: openNodePort,
      fetchImpl: (async () => { fetches += 1; throw new Error('network'); }) as typeof fetch,
      idleMs: 60_000,
    });
    const coldStarted = performance.now();
    const hello = await engine.translate('Hello, how are you?');
    const coldMs = performance.now() - coldStarted;
    const warmStarted = performance.now();
    const meeting = await engine.translate('The meeting starts at 3.');
    const warmMs = performance.now() - warmStarted;
    expect(hello).toMatch(/merhaba/i);
    expect(meeting.toLocaleLowerCase('tr')).toMatch(/toplantı|başlı/);
    expect(fetches).toBe(0);
    engine.cancel();
    expect(coldMs).toBeGreaterThan(0);
    expect(warmMs).toBeGreaterThan(0);
    expect(warmMs).toBeLessThan(coldMs);
  }, 180_000);

  it.skipIf(!modelReady)('reports a stored model as ready without opening the worker', async () => {
    const cache = new MemoryTranslationCache();
    await cache.write({
      model: fileBuffer('model.bin'),
      shortlist: fileBuffer('lex.bin'),
      vocab: fileBuffer('vocab.bin'),
    });
    let opened = 0;
    const engine = new LocalTranslationEngine({
      cache,
      openPort: () => {
        opened += 1;
        throw new Error('worker must stay closed');
      },
    });
    await engine.noteCached();
    expect(engine.snapshot()).toMatchObject({
      state: 'ready',
      cached: true,
      persisted: true,
      error: null,
    });
    await engine.noteCached();
    expect(opened).toBe(0);
  });

  it('does not claim the model is ready when nothing is stored', async () => {
    const engine = new LocalTranslationEngine({
      cache: new MemoryTranslationCache(),
      openPort: () => { throw new Error('worker must stay closed'); },
    });
    await engine.noteCached();
    expect(engine.snapshot().state).toBe('idle');
    expect(engine.snapshot().cached).toBe(false);
  });

  it('reports a failed model download without echoing the caption or calling cloud', async () => {
    const cache = new MemoryTranslationCache();
    let fetches = 0;
    const engine = new LocalTranslationEngine({
      cache,
      openPort: () => { throw new Error('worker unavailable'); },
      fetchImpl: (async () => {
        fetches += 1;
        return new Response('no', { status: 500 });
      }) as typeof fetch,
    });
    const error = await engine.translate('Hello').catch(reason => reason);
    expect(error).toBeInstanceOf(LocalTranslationError);
    expect(error.reason).toBe('download');
    expect(fetches).toBeGreaterThan(0);
    expect(String(error.message)).not.toContain('Hello');
  });
});

