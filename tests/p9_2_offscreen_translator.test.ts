import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LocalTranslationError, TranslationCancelledError } from '../src/translation/LocalTranslationError';
import type { LocalTranslationStatus } from '../src/translation/LocalTranslationEngine';
import {
  handleOffscreenRequest,
  OFFSCREEN_CANCEL,
  OFFSCREEN_PREPARE,
  OFFSCREEN_STATUS,
  OFFSCREEN_TRANSLATE,
  type OffscreenTranslationHost,
} from '../src/translation/OffscreenController';

function status(partial: Partial<LocalTranslationStatus> = {}): LocalTranslationStatus {
  return {
    state: 'idle',
    progress: 0,
    loadedBytes: 0,
    totalBytes: 15_101_045,
    cached: false,
    persisted: false,
    error: null,
    ...partial,
  };
}

function host(overrides: Partial<OffscreenTranslationHost> = {}): OffscreenTranslationHost {
  return {
    noteCached: async () => {},
    prepare: async () => {},
    translate: async text => `TR ${text}`,
    cancel: () => {},
    snapshot: () => status(),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('offscreen local translation', () => {
  it('translates in the offscreen host and does not echo a failed caption', async () => {
    const responses: unknown[] = [];
    const ok = handleOffscreenRequest(
      { type: OFFSCREEN_TRANSLATE, text: 'Hello there' },
      host(),
      response => responses.push(response),
    );
    expect(ok).toBe(true);
    await settle();
    expect(responses).toEqual([{ success: true, translatedText: 'TR Hello there' }]);

    const failed: unknown[] = [];
    handleOffscreenRequest(
      { type: OFFSCREEN_TRANSLATE, text: 'Hello there' },
      host({ translate: async () => { throw new LocalTranslationError('runtime'); } }),
      response => failed.push(response),
    );
    await settle();
    expect(failed).toEqual([{
      success: false,
      code: 'local_unavailable',
      reason: 'runtime',
      error: 'Local translation unavailable',
    }]);
    expect(JSON.stringify(failed)).not.toContain('Hello there');
  });

  it('reports cancellation without treating it as a model failure', async () => {
    const responses: unknown[] = [];
    handleOffscreenRequest(
      { type: OFFSCREEN_TRANSLATE, text: 'Hello' },
      host({ translate: async () => { throw new TranslationCancelledError(); } }),
      response => responses.push(response),
    );
    await settle();
    expect(responses[0]).toMatchObject({ success: false, code: 'cancelled' });
  });

  it('prepares, cancels, and reads cache status without translating', async () => {
    let cancelled = 0;
    let prepared = 0;
    const engine = host({
      prepare: async () => { prepared += 1; },
      cancel: () => { cancelled += 1; },
      snapshot: () => status({ state: 'ready', cached: true, persisted: true, progress: 1 }),
    });
    const responses: unknown[] = [];
    expect(handleOffscreenRequest({ type: OFFSCREEN_PREPARE }, engine, response => responses.push(response))).toBe(true);
    expect(handleOffscreenRequest({ type: OFFSCREEN_CANCEL }, engine, response => responses.push(response))).toBe(true);
    expect(handleOffscreenRequest({ type: OFFSCREEN_STATUS }, engine, response => responses.push(response))).toBe(true);
    expect(handleOffscreenRequest({ type: 'TRANSLATE_TEXT', text: 'Hello' }, engine, response => responses.push(response))).toBe(false);
    await settle();
    expect(prepared).toBe(1);
    expect(cancelled).toBe(1);
    expect(responses).toContainEqual({ cancelled: true });
    expect(responses).toContainEqual({ started: true, status: status({ state: 'ready', cached: true, persisted: true, progress: 1 }) });
    expect(responses).toContainEqual({ status: status({ state: 'ready', cached: true, persisted: true, progress: 1 }) });
  });

  it('keeps the Bergamot worker out of the service worker', () => {
    const worker = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
    const offscreen = readFileSync(new URL('../entrypoints/offscreen/main.ts', import.meta.url), 'utf8');
    expect(worker).not.toContain('new Worker');
    expect(worker).not.toContain('openExtensionBergamotPort');
    expect(worker).toContain("reasons: ['WORKERS']");
    expect(worker).toContain('OFFSCREEN_STATUS_PUSH');
    expect(worker).toContain('LOCAL_TRANSLATION_STATUS_KEY');
    expect(offscreen).toContain('openExtensionBergamotPort');
    expect(offscreen).toContain('OFFSCREEN_STATUS_PUSH');
    expect(offscreen).not.toContain('chrome.storage.local.set');
  });
});
