import { parseRetryAfterHeader } from './TranslationRateLimit';
import { normalizeTranslationKey } from './TranslationKey';

/**
 * Cloud Translation API v2, the supported Basic REST method.
 * The API key travels only in the X-Goog-Api-Key header. It is never placed in the URL.
 * https://cloud.google.com/docs/authentication/api-keys-use
 * https://cloud.google.com/translate/docs/reference/rest/v2/translate
 */
export const CLOUD_TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2';

/** One batch of a few caption lines. Longer text is rejected instead of being split into more requests. */
export const MAX_TRANSLATE_CHARS = 4_000;

export function validateTranslateRequest(
  message: { text?: unknown } | null | undefined,
  senderId: string | undefined,
  extensionId: string,
): { ok: true; text: string } | { ok: false; error: string } {
  if (!extensionId || senderId !== extensionId) return { ok: false, error: 'Rejected translation sender' };
  if (!message || typeof message.text !== 'string') return { ok: false, error: 'Rejected translation payload' };
  const text = message.text.trim();
  if (text.length > MAX_TRANSLATE_CHARS) return { ok: false, error: 'Translation text is too long' };
  return { ok: true, text };
}

export interface TranslateSuccess {
  ok: true;
  translatedText: string;
}

export interface TranslateFailure {
  ok: false;
  error: string;
  status: number | null;
  retryAfterMs: number | null;
  code?: 'setup_required' | 'rejected_key' | 'unavailable';
}

export type TranslateOutcome = TranslateSuccess | TranslateFailure;

export interface TranslateResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export function buildCloudTranslateRequest(text: string, apiKey: string): { url: string; init: RequestInit } {
  const key = normalizeTranslationKey(apiKey);
  if (!key) throw new Error('Translation setup required');
  return {
    url: CLOUD_TRANSLATE_URL,
    init: {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Goog-Api-Key': key,
      },
      body: JSON.stringify({ q: text, target: 'tr', format: 'text' }),
      signal: AbortSignal.timeout(5000),
    },
  };
}

function decodeTranslationText(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, digits: string) => {
      const code = Number(digits);
      return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Accept only the documented v2 JSON object. The old consumer array payload is not a translation. */
export function extractTranslatedText(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const translations = (data as { data?: { translations?: unknown } }).data?.translations;
  if (!Array.isArray(translations)) return '';
  return translations.map(item => {
    if (!item || typeof item !== 'object') return '';
    const text = (item as { translatedText?: unknown }).translatedText;
    return typeof text === 'string' ? decodeTranslationText(text) : '';
  }).join('').trim();
}

export async function readTranslateResponse(response: TranslateResponseLike): Promise<TranslateOutcome> {
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'rejected_key' as const : undefined;
    return {
      ok: false,
      error: `HTTP ${response.status}`,
      status: response.status,
      retryAfterMs: parseRetryAfterHeader(response.headers?.get('Retry-After') ?? null),
      code,
    };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: 'Invalid translation response', status: response.status, retryAfterMs: null };
  }
  const translatedText = extractTranslatedText(data);
  if (!translatedText) {
    return { ok: false, error: 'Empty translation response', status: response.status, retryAfterMs: null };
  }
  return { ok: true, translatedText };
}

export async function requestCloudTranslation(
  text: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TranslateOutcome> {
  const key = normalizeTranslationKey(apiKey);
  if (!key) {
    return { ok: false, error: 'Translation setup required', status: null, retryAfterMs: null, code: 'setup_required' };
  }
  const request = buildCloudTranslateRequest(text, key);
  if (request.url.includes('?') || request.url.includes(key) || request.url !== CLOUD_TRANSLATE_URL) {
    return { ok: false, error: 'Translation request was refused', status: null, retryAfterMs: null, code: 'unavailable' };
  }
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl(request.url, request.init);
  } catch {
    return { ok: false, error: 'Translation request failed', status: null, retryAfterMs: null, code: 'unavailable' };
  }
  return readTranslateResponse(response);
}
