/**
 * Turkish translation transport.
 * One in-flight request through the service worker, single-flight per source text,
 * and a bounded success cache. A worker HTTP answer is final: a 429 is not
 * fetched again. There is no page-world request and no unofficial endpoint.
 * Seek and navigation do not drop the cache.
 */

import { LocalTranslationError, TranslationCancelledError, type LocalTranslationReason } from '../translation/LocalTranslationError';
import { normalizeTranslationMode, TRANSLATION_MODE_STORAGE } from '../translation/TranslationMode';
import {
  MAX_INLINE_RETRY_MS,
  nextRateLimitWaitMs,
  TranslationRateLimitError,
  TranslationSetupRequiredError,
  translationCacheKey,
  translationClock,
} from '../translation/TranslationRateLimit';

interface WorkerResponse {
  success?: boolean;
  translatedText?: string;
  error?: string;
  status?: number | null;
  retryAfterMs?: number | null;
  code?: 'setup_required' | 'rejected_key' | 'unavailable' | 'local_unavailable' | 'cancelled' | null;
  reason?: LocalTranslationReason | null;
}

const TARGET_LANGUAGE = 'tr';
const CACHE_LIMIT = 1000;

export class Translator {
  private static cache = new Map<string, string>();
  private static inflight = new Map<string, Promise<string>>();
  private static tail: Promise<void> = Promise.resolve();
  private static circuitUntil = 0;
  private static consecutiveRateLimits = 0;
  /** Counts endpoint attempts. Circuit rejections are not attempts. */
  static transportAttempts = 0;

  static async toTurkish(text: string): Promise<string> {
    const trimmed = text.trim();
    if (!trimmed) return '';
    const key = translationCacheKey(`${TARGET_LANGUAGE}:${await this.translationScope()}`, trimmed);
    const cached = this.readCache(key);
    if (cached !== undefined) return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const job = this.fetchWithPolicy(key, trimmed);
    this.inflight.set(key, job);
    try {
      return await job;
    } finally {
      if (this.inflight.get(key) === job) this.inflight.delete(key);
    }
  }

  static async batchToTurkish(texts: string[], concurrency = 1): Promise<string[]> {
    const results: string[] = new Array(texts.length);
    let index = 0;
    const worker = async () => {
      while (index < texts.length) {
        const i = index++;
        results[i] = await this.toTurkish(texts[i]);
      }
    };
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), texts.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  static resetForTests(): void {
    this.cache.clear();
    this.inflight.clear();
    this.tail = Promise.resolve();
    this.circuitUntil = 0;
    this.consecutiveRateLimits = 0;
    this.transportAttempts = 0;
  }

  private static async fetchWithPolicy(key: string, text: string): Promise<string> {
    try {
      return this.finish(key, await this.attempt(text, false));
    } catch (error) {
      if (!(error instanceof TranslationRateLimitError) || error.blocked) throw error;
      const wait = this.noteRateLimit(error);
      if (wait > MAX_INLINE_RETRY_MS) throw new TranslationRateLimitError(wait);
      await translationClock.sleep(wait);
      try {
        return this.finish(key, await this.attempt(text, true));
      } catch (retryError) {
        if (retryError instanceof TranslationRateLimitError && !retryError.blocked) {
          throw new TranslationRateLimitError(this.noteRateLimit(retryError));
        }
        throw retryError;
      }
    }
  }

  private static finish(key: string, translated: string): string {
    this.remember(key, translated);
    this.circuitUntil = 0;
    this.consecutiveRateLimits = 0;
    return translated;
  }

  private static noteRateLimit(error: TranslationRateLimitError): number {
    const wait = nextRateLimitWaitMs({
      attemptIndex: this.consecutiveRateLimits,
      retryAfterMs: error.retryAfterMs,
      random: translationClock.random(),
    });
    this.consecutiveRateLimits = Math.min(this.consecutiveRateLimits + 1, 8);
    this.circuitUntil = translationClock.now() + wait;
    return wait;
  }

  private static attempt(text: string, ignoreCircuit: boolean): Promise<string> {
    return this.enqueue(async () => {
      const now = translationClock.now();
      if (!ignoreCircuit && this.circuitUntil > now) {
        throw new TranslationRateLimitError(this.circuitUntil - now, undefined, true);
      }
      this.transportAttempts += 1;
      return this.dispatch(text);
    });
  }

  private static enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private static async dispatch(text: string): Promise<string> {
    if (!this.workerAvailable()) throw new TranslationSetupRequiredError('unavailable');
    const response = await this.askWorker(text);
    if (!response) throw new TranslationSetupRequiredError('unavailable');
    return this.outcomeFromWorker(response);
  }

  private static workerAvailable(): boolean {
    const runtime = (globalThis as { chrome?: { runtime?: { sendMessage?: unknown; lastError?: unknown } } }).chrome?.runtime;
    return typeof runtime?.sendMessage === 'function';
  }

  private static askWorker(text: string): Promise<WorkerResponse | null> {
    return new Promise(resolve => {
      try {
        const runtime = (globalThis as { chrome?: { runtime?: { sendMessage?: typeof chrome.runtime.sendMessage; lastError?: { message?: string } } } }).chrome?.runtime;
        if (!runtime?.sendMessage) { resolve(null); return; }
        runtime.sendMessage({ type: 'TRANSLATE_TEXT', text }, response => {
          if (runtime.lastError || !response) resolve(null);
          else resolve(response as WorkerResponse);
        });
      } catch {
        resolve(null);
      }
    });
  }

  private static outcomeFromWorker(response: WorkerResponse): string {
    if (response.code === 'cancelled') throw new TranslationCancelledError();
    if (response.code === 'local_unavailable') {
      const reason = response.reason === 'hash' || response.reason === 'download' ? response.reason : 'runtime';
      throw new LocalTranslationError(reason);
    }
    if (response.code === 'setup_required') throw new TranslationSetupRequiredError('missing_key');
    if (response.code === 'rejected_key' || response.status === 401 || response.status === 403) {
      throw new TranslationSetupRequiredError('rejected_key');
    }
    if (response.code === 'unavailable') throw new TranslationSetupRequiredError('unavailable');
    if (response.success && response.translatedText?.trim()) return response.translatedText.trim();
    if (response.status === 429 || (typeof response.error === 'string' && /\b429\b/.test(response.error))) {
      throw new TranslationRateLimitError(typeof response.retryAfterMs === 'number' ? response.retryAfterMs : null);
    }
    throw new Error(response.error || 'Translation failed');
  }

  /** Cache entries are scoped by mode so a local result is never reused as a cloud result. */
  private static async translationScope(): Promise<string> {
    try {
      const get = (globalThis as { chrome?: { storage?: { local?: { get?: (key: string) => Promise<Record<string, unknown>> } } } }).chrome?.storage?.local?.get;
      if (typeof get !== 'function') return 'local';
      const stored = await get(TRANSLATION_MODE_STORAGE);
      return normalizeTranslationMode(stored?.[TRANSLATION_MODE_STORAGE]);
    } catch {
      return 'local';
    }
  }

  private static readCache(key: string): string | undefined {
    const value = this.cache.get(key);
    if (value === undefined) return undefined;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  private static remember(key: string, value: string): void {
    if (!value.trim()) return;
    if (this.cache.has(key)) this.cache.delete(key);
    while (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }
}
