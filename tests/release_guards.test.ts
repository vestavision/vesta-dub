import { afterEach, describe, expect, it } from 'vitest';
import { MAX_TRANSLATE_CHARS, validateTranslateRequest } from '../src/translation/CloudTranslationClient';
import { ModelStorage } from '../src/tts/ModelStorage';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('release request guards', () => {
  it('accepts only same-extension translation payloads inside the size cap', () => {
    expect(validateTranslateRequest({ text: ' hello ' }, 'ext', 'ext')).toEqual({ ok: true, text: 'hello' });
    expect(validateTranslateRequest({ text: '' }, 'ext', 'ext')).toEqual({ ok: true, text: '' });
    expect(validateTranslateRequest({ text: 'x'.repeat(MAX_TRANSLATE_CHARS + 1) }, 'ext', 'ext').ok).toBe(false);
    expect(validateTranslateRequest({ text: 'hello' }, 'other', 'ext').ok).toBe(false);
    expect(validateTranslateRequest({ text: 12 }, 'ext', 'ext').ok).toBe(false);
    expect(validateTranslateRequest(null, 'ext', 'ext').ok).toBe(false);
  });

  it('does not download model weights when the extension bundle is missing', async () => {
    const fetches: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetches.push(String(input));
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { getURL: (assetPath: string) => `chrome-extension://vesta/${assetPath}` },
    };

    await expect(ModelStorage.fetchCached('antalia/vocoder.fp16.onnx', 'https://example.invalid/vocoder.onnx'))
      .rejects.toThrow(/does not download weights/);
    expect(fetches).toEqual(['chrome-extension://vesta/models/antalia/vocoder.fp16.onnx']);
  });
});
