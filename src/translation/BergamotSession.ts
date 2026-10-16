import type { LocalModelBuffers } from './LocalTranslationModel';

export interface BergamotPort {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error', handler: (event: { data?: unknown; message?: string }) => void): void;
}

interface WorkerResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

/** Classic worker shipped in public/bergamot. No remote script is loaded. */
export function openExtensionBergamotPort(): BergamotPort {
  const runtime = (globalThis as { chrome?: { runtime?: { getURL?: (path: string) => string } } }).chrome?.runtime;
  if (!runtime?.getURL) throw new Error('bergamot worker is only available in the extension');
  return new Worker(runtime.getURL('bergamot/translator-worker.js'));
}

export class BergamotSession {
  private serial = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private failed = false;

  constructor(private readonly port: BergamotPort) {
    port.addEventListener('message', event => {
      const data = event.data as WorkerResponse | undefined;
      if (!data || typeof data.id !== 'number') return;
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error.message || 'bergamot worker failed'));
      else pending.resolve(data.result);
    });
    port.addEventListener('error', () => {
      this.fail(new Error('bergamot worker failed'));
    });
  }

  async initialize(): Promise<void> {
    await this.call('initialize', [{ useNativeIntGemm: false, cacheSize: 0 }], 60_000);
  }

  async loadModel(buffers: LocalModelBuffers): Promise<void> {
    await this.call('loadTranslationModel', [
      { from: 'en', to: 'tr' },
      {
        model: buffers.model,
        shortlist: buffers.shortlist,
        vocabs: [buffers.vocab],
        config: { 'gemm-precision': 'int8shiftAlphaAll' },
      },
    ], 60_000);
  }

  async translate(text: string): Promise<string> {
    const result = await this.call('translate', [{
      models: [{ from: 'en', to: 'tr' }],
      texts: [{ text, html: false, qualityScores: false }],
    }], 30_000);
    const translated = (result as Array<{ target?: { text?: string } }> | undefined)?.[0]?.target?.text;
    if (typeof translated !== 'string' || !translated.trim()) throw new Error('empty translation');
    return translated.trim();
  }

  terminate(): void {
    this.fail(new Error('bergamot worker closed'));
    try { this.port.terminate(); } catch { /* already closed */ }
  }

  private fail(error: Error): void {
    this.failed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private call(name: string, args: unknown[], timeoutMs: number): Promise<unknown> {
    if (this.failed) return Promise.reject(new Error('bergamot worker closed'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('bergamot worker timed out'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try {
        this.port.postMessage({ id, name, args });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('bergamot worker failed'));
      }
    });
  }
}
