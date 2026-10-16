import { BergamotSession, type BergamotPort } from './BergamotSession';
import { LocalTranslationError, TranslationCancelledError } from './LocalTranslationError';
import type { TranslationFileCache } from './LocalTranslationCache';
import {
  downloadModelFile,
  LOCAL_TRANSLATION_DOWNLOAD_BYTES,
  LOCAL_TRANSLATION_FILES,
  type LocalModelBuffers,
} from './LocalTranslationModel';

export const LOCAL_TRANSLATION_STATUS_KEY = 'vesta_local_translation_status';
const IDLE_MS = 60_000;

export interface LocalTranslationStatus {
  state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  progress: number;
  loadedBytes: number;
  totalBytes: number;
  cached: boolean;
  persisted: boolean;
  error: 'download' | 'hash' | 'runtime' | 'storage' | null;
}

export interface LocalTranslationEngineOptions {
  cache: TranslationFileCache;
  openPort: () => BergamotPort;
  fetchImpl?: typeof fetch;
  onStatus?: (status: LocalTranslationStatus) => void;
  idleMs?: number;
}

/**
 * On-device English→Turkish translation. This object never calls a cloud translator.
 * The Bergamot worker is created on the first request and closed after it has been idle.
 */
export class LocalTranslationEngine {
  private readonly cache: TranslationFileCache;
  private readonly openPort: () => BergamotPort;
  private readonly fetchImpl: typeof fetch;
  private readonly onStatus?: (status: LocalTranslationStatus) => void;
  private readonly idleMs: number;
  private buffers: LocalModelBuffers | null = null;
  private persisted = false;
  private session: BergamotSession | null = null;
  private modelInWorker = false;
  private loading: Promise<LocalModelBuffers> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private epoch = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private status: LocalTranslationStatus = {
    state: 'idle',
    progress: 0,
    loadedBytes: 0,
    totalBytes: LOCAL_TRANSLATION_DOWNLOAD_BYTES,
    cached: false,
    persisted: false,
    error: null,
  };

  constructor(options: LocalTranslationEngineOptions) {
    this.cache = options.cache;
    this.openPort = options.openPort;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onStatus = options.onStatus;
    this.idleMs = options.idleMs ?? IDLE_MS;
  }

  snapshot(): LocalTranslationStatus {
    return { ...this.status };
  }

  /** Mark a previously stored model as ready without loading the WASM runtime. */
  async noteCached(): Promise<void> {
    if (this.buffers || this.status.state === 'downloading' || this.status.state === 'loading' || this.status.cached) return;
    if (!await this.cache.present()) return;
    this.persisted = true;
    this.publish({
      state: 'ready',
      progress: 1,
      loadedBytes: LOCAL_TRANSLATION_DOWNLOAD_BYTES,
      totalBytes: LOCAL_TRANSLATION_DOWNLOAD_BYTES,
      cached: true,
      persisted: true,
      error: null,
    });
  }

  /** Download and verify the model without translating. Safe to call more than once. */
  prepare(): Promise<void> {
    return this.enqueue(async epoch => {
      await this.ensureBuffers(epoch);
    });
  }

  translate(text: string): Promise<string> {
    const trimmed = text.trim();
    if (!trimmed) return Promise.resolve('');
    return this.enqueue(async epoch => {
      const buffers = await this.ensureBuffers(epoch);
      this.publish({ ...this.status, state: 'loading', error: null });
      const session = await this.ensureSession(buffers);
      if (epoch !== this.epoch) throw new TranslationCancelledError();
      let translated: string;
      try {
        translated = await session.translate(trimmed);
      } catch (error) {
        if (epoch !== this.epoch) throw new TranslationCancelledError();
        this.dropSession();
        this.publish({ ...this.status, state: 'error', error: 'runtime' });
        if (error instanceof LocalTranslationError || error instanceof TranslationCancelledError) throw error;
        throw new LocalTranslationError('runtime');
      }
      if (epoch !== this.epoch) throw new TranslationCancelledError();
      this.publish({
        state: 'ready',
        progress: 1,
        loadedBytes: LOCAL_TRANSLATION_DOWNLOAD_BYTES,
        totalBytes: LOCAL_TRANSLATION_DOWNLOAD_BYTES,
        cached: true,
        persisted: this.persisted,
        error: this.persisted ? null : 'storage',
      });
      this.armIdle();
      return translated;
    });
  }

  /** Drop queued work and the live worker. Cached bytes stay on disk. */
  cancel(): void {
    this.epoch += 1;
    this.dropSession();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private enqueue<T>(task: (epoch: number) => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const run = this.tail.then(async () => {
      if (epoch !== this.epoch) throw new TranslationCancelledError();
      return task(epoch);
    }, async () => {
      if (epoch !== this.epoch) throw new TranslationCancelledError();
      return task(epoch);
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async ensureBuffers(epoch: number): Promise<LocalModelBuffers> {
    if (this.buffers) return this.buffers;
    if (!this.loading) this.loading = this.loadBuffers();
    try {
      const buffers = await this.loading;
      if (epoch !== this.epoch) throw new TranslationCancelledError();
      return buffers;
    } finally {
      this.loading = null;
    }
  }

  private async loadBuffers(): Promise<LocalModelBuffers> {
    const cached = await this.cache.read();
    if (cached) {
      this.buffers = cached;
      this.persisted = true;
      this.publish({
        state: 'ready',
        progress: 1,
        loadedBytes: LOCAL_TRANSLATION_DOWNLOAD_BYTES,
        totalBytes: LOCAL_TRANSLATION_DOWNLOAD_BYTES,
        cached: true,
        persisted: true,
        error: null,
      });
      return cached;
    }

    let completed = 0;
    const parts = new Map<string, ArrayBuffer>();
    this.publish({
      state: 'downloading',
      progress: 0,
      loadedBytes: 0,
      totalBytes: LOCAL_TRANSLATION_DOWNLOAD_BYTES,
      cached: false,
      persisted: false,
      error: null,
    });
    try {
      for (const file of LOCAL_TRANSLATION_FILES) {
        const startedAt = completed;
        const raw = await downloadModelFile(file, this.fetchImpl, loaded => {
          const capped = Math.min(loaded, file.gzipBytes);
          this.publish({
            ...this.status,
            state: 'downloading',
            loadedBytes: startedAt + capped,
            progress: (startedAt + capped) / LOCAL_TRANSLATION_DOWNLOAD_BYTES,
          });
        });
        parts.set(file.name, raw);
        completed += file.gzipBytes;
      }
    } catch (error) {
      const reason = error instanceof Error && /hash|size/.test(error.message) ? 'hash' : 'download';
      await this.cache.clear();
      this.publish({ ...this.status, state: 'error', error: reason, cached: false });
      throw new LocalTranslationError(reason);
    }

    const buffers: LocalModelBuffers = {
      model: parts.get('model')!,
      shortlist: parts.get('shortlist')!,
      vocab: parts.get('vocab')!,
    };
    this.persisted = await this.cache.write(buffers);
    this.buffers = buffers;
    this.publish({
      state: 'ready',
      progress: 1,
      loadedBytes: LOCAL_TRANSLATION_DOWNLOAD_BYTES,
      totalBytes: LOCAL_TRANSLATION_DOWNLOAD_BYTES,
      cached: true,
      persisted: this.persisted,
      error: this.persisted ? null : 'storage',
    });
    return buffers;
  }

  private async ensureSession(buffers: LocalModelBuffers): Promise<BergamotSession> {
    if (this.session && this.modelInWorker) return this.session;
    this.dropSession();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    let session: BergamotSession | null = null;
    try {
      session = new BergamotSession(this.openPort());
      await session.initialize();
      await session.loadModel(buffers);
    } catch {
      session?.terminate();
      this.publish({ ...this.status, state: 'error', error: 'runtime' });
      throw new LocalTranslationError('runtime');
    }
    this.session = session;
    this.modelInWorker = true;
    return session;
  }

  private dropSession(): void {
    this.modelInWorker = false;
    const session = this.session;
    this.session = null;
    session?.terminate();
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.dropSession();
    }, this.idleMs);
  }

  private publish(status: LocalTranslationStatus): void {
    this.status = status;
    try { this.onStatus?.({ ...status }); } catch { /* status is advisory */ }
  }
}
