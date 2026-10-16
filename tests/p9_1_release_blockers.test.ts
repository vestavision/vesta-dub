import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrateStoredProvider } from '../src/speaker/VoiceMigration';
import {
  buildCloudTranslateRequest,
  CLOUD_TRANSLATE_URL,
  requestCloudTranslation,
} from '../src/translation/CloudTranslationClient';
import { normalizeTranslationKey } from '../src/translation/TranslationKey';

const KEY = 'unit-test-key-not-a-secret';

describe('P9.1 translation provider and voice removal', () => {
  it('rejects a missing or malformed key without a network call', async () => {
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      throw new Error('network');
    }) as typeof fetch;
    const missing = await requestCloudTranslation('Hello', '', fetchImpl);
    expect(missing).toMatchObject({ ok: false, code: 'setup_required' });
    expect(fetches).toBe(0);
    expect(normalizeTranslationKey('short')).toBeNull();
    expect(normalizeTranslationKey('https://evil.example/?key=secret')).toBeNull();
  });

  it('sends the key in a header and keeps it out of the URL', async () => {
    const built = buildCloudTranslateRequest('Hello there', KEY);
    expect(built.url).toBe(CLOUD_TRANSLATE_URL);
    expect(built.url.includes('?')).toBe(false);
    expect(built.url.includes(KEY)).toBe(false);
    const headers = built.init.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe(KEY);
    expect(JSON.parse(String(built.init.body))).toEqual({ q: 'Hello there', target: 'tr', format: 'text' });

    let seenUrl = '';
    const fetchImpl = (async (url: RequestInfo | URL) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ data: { translations: [{ translatedText: 'Merhaba &amp; dünya' }] } }), { status: 200 });
    }) as typeof fetch;
    const outcome = await requestCloudTranslation('Hello & world', KEY, fetchImpl);
    expect(seenUrl).toBe(CLOUD_TRANSLATE_URL);
    expect(seenUrl.includes(KEY)).toBe(false);
    expect(outcome).toEqual({ ok: true, translatedText: 'Merhaba & dünya' });
  });

  it('maps HTTP 429 and HTTP 403 without putting the key in the result', async () => {
    const limited = await requestCloudTranslation('Hello', KEY, (async () => new Response('no', {
      status: 429,
      headers: { 'Retry-After': '12' },
    })) as typeof fetch);
    expect(limited).toMatchObject({ ok: false, status: 429, retryAfterMs: 12_000 });
    const rejected = await requestCloudTranslation('Hello', KEY, (async () => new Response('denied', { status: 403 })) as typeof fetch);
    expect(rejected).toMatchObject({ ok: false, status: 403, code: 'rejected_key' });
    expect(JSON.stringify(rejected)).not.toContain(KEY);
  });

  it('keeps the unofficial client out of the release runtime and migrates Piper', () => {
    const client = readFileSync(new URL('../src/translation/CloudTranslationClient.ts', import.meta.url), 'utf8');
    const worker = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
    const translator = readFileSync(new URL('../src/subtitles/Translator.ts', import.meta.url), 'utf8');
    const popup = readFileSync(new URL('../entrypoints/popup/App.tsx', import.meta.url), 'utf8');
    for (const source of [client, worker, translator, popup]) {
      expect(source).not.toContain('translate.googleapis.com');
      expect(source).not.toContain('client=gtx');
    }
    expect(worker).toContain("accessLevel: 'TRUSTED_CONTEXTS'");
    expect(worker).not.toContain('TRUSTED_AND_UNTRUSTED_CONTEXTS');
    expect(popup).not.toContain('piper-fahrettin');
    expect(migrateStoredProvider('speaker-b', 'piper-fahrettin')).toBe('ema-lightning');
    expect(migrateStoredProvider('speaker-a', 'piper-fahrettin')).toBe('antalia');
    expect(migrateStoredProvider('speaker-a', 'ema-lightning')).toBe('ema-lightning');
  });
});
