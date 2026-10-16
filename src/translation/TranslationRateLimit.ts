/**
 * HTTP 429 from Cloud Translation, and a missing or rejected API key.
 * Callers must surface these errors. They must not replace them with source text.
 */

export const MAX_INLINE_RETRY_MS = 15_000;
export const MAX_BACKOFF_MS = 60_000;
/** Ignore a Retry-After that would pin a tab for more than a day. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export const translationClock = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); }),
  random: (): number => Math.random(),
};

export class TranslationRateLimitError extends Error {
  readonly status = 429 as const;

  constructor(
    readonly retryAfterMs: number | null,
    readonly partial?: unknown,
    /** True when the circuit breaker rejected the call before any network attempt. */
    readonly blocked = false,
  ) {
    super('Translation rate limited (HTTP 429)');
    this.name = 'TranslationRateLimitError';
  }
}

export function isTranslationRateLimit(error: unknown): error is TranslationRateLimitError {
  if (error instanceof TranslationRateLimitError) return true;
  return error instanceof Error && /\b429\b/.test(error.message) && /HTTP|rate/i.test(error.message);
}

export function translationCacheKey(targetLanguage: string, text: string): string {
  // The request text is the context: a batch key is the neighbor lines joined together.
  return `tl=${targetLanguage}\u0000${text.trim()}`;
}

export function parseRetryAfterHeader(value: string | null, nowMs = translationClock.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) return null;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - nowMs), MAX_RETRY_AFTER_MS);
}

/** Wait for Retry-After when the provider sends one. Otherwise exponential backoff plus jitter. Never shorter than Retry-After. */
export function nextRateLimitWaitMs(options: { attemptIndex: number; retryAfterMs: number | null; random: number }): number {
  if (options.retryAfterMs !== null && Number.isFinite(options.retryAfterMs) && options.retryAfterMs >= 0) {
    return Math.min(options.retryAfterMs, MAX_RETRY_AFTER_MS);
  }
  const exponent = Math.min(Math.max(0, options.attemptIndex), 6);
  const backoff = Math.min(MAX_BACKOFF_MS, 1000 * (2 ** exponent));
  const jitter = Math.floor(Math.min(1, Math.max(0, options.random)) * 250);
  return Math.min(MAX_BACKOFF_MS, backoff + jitter);
}

export function formatRateLimitWait(retryAfterMs: number | null): string {
  const seconds = Math.max(1, Math.ceil((retryAfterMs ?? 60_000) / 1000));
  if (seconds < 90) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)} min`;
}

export function rateLimitUserMessage(error: Pick<TranslationRateLimitError, 'retryAfterMs'>): string {
  const wait = formatRateLimitWait(error.retryAfterMs);
  return `Translation rate limited (HTTP 429). Dubbing stopped and will not substitute English. Original video volume is restored. New translation requests are paused for about ${wait}. Start dubbing again after that pause. There is no automatic resume.`;
}

export function isRateLimitMessage(message: string | null | undefined): boolean {
  return Boolean(message && message.startsWith('Translation rate limited (HTTP 429).'));
}

export type TranslationSetupReason = 'missing_key' | 'rejected_key' | 'unavailable';

export class TranslationSetupRequiredError extends Error {
  readonly code = 'setup_required' as const;

  constructor(readonly reason: TranslationSetupReason) {
    super(setupRequiredUserMessage(reason));
    this.name = 'TranslationSetupRequiredError';
  }
}

export function isTranslationSetupRequired(error: unknown): error is TranslationSetupRequiredError {
  return error instanceof TranslationSetupRequiredError;
}

export function setupRequiredUserMessage(reason: TranslationSetupReason): string {
  if (reason === 'rejected_key') {
    return 'Translation setup required. The Cloud Translation API key was rejected. Dubbing stopped and will not substitute English. Original video volume is restored. Replace the key in the Vesta popup. There is no automatic resume.';
  }
  if (reason === 'unavailable') {
    return 'Translation setup required. The translation service did not answer. Dubbing stopped and will not substitute English. Original video volume is restored. There is no unofficial fallback and no automatic resume.';
  }
  return 'Translation setup required. Add a Cloud Translation API key in the Vesta popup. Dubbing stopped and will not substitute English. Original video volume is restored. There is no automatic resume.';
}
