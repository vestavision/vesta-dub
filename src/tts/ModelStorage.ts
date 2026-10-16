/**
 * IndexedDB storage for caching ONNX model weights and assets locally
 * Ensures models are only downloaded once and work offline.
 */

const DB_NAME = 'vesta_dub_models_db';
const STORE_NAME = 'model_blobs';
const DB_VERSION = 1;

export class ModelStorage {
  private static dbPromise: Promise<IDBDatabase> | null = null;

  private static getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.error('[VestaDub] IndexedDB open failed:', request.error);
        reject(request.error);
      };
    });

    return this.dbPromise;
  }

  /**
   * Get an ArrayBuffer from cache by key
   */
  static async get(key: string): Promise<ArrayBuffer | null> {
    if (typeof indexedDB === 'undefined') return null;
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);

        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('[VestaDub] ModelStorage.get failed:', e);
      return null;
    }
  }

  /**
   * Store an ArrayBuffer in cache
   */
  static async set(key: string, buffer: ArrayBuffer): Promise<void> {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(buffer, key);

        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('[VestaDub] ModelStorage.set failed:', e);
    }
  }

  /**
   * Check if a key exists in cache
   */
  static async has(key: string): Promise<boolean> {
    // Status polling must not deserialize 15–63 MB weight blobs while dubbing is inactive.
    try {
      const db = await this.getDB();
      return await new Promise<boolean>((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).count(key);
        request.onsuccess = () => resolve(request.result > 0);
        request.onerror = () => reject(request.error);
      });
    } catch { return false; }
  }

  /**
   * Clear all cached models
   */
  static async clear(): Promise<void> {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.clear();

        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('[VestaDub] ModelStorage.clear failed:', e);
    }
  }

  /**
   * Fetch with cache and optional progress tracking.
   * Inside the extension: IndexedDB, then the bundled asset. A missing bundle
   * is an error. The extension does not download model weights from the network.
   * `fallbackUrl` is only for Node benchmarks that are not running as an extension.
   */
  static async fetchCached(
    key: string,
    fallbackUrl: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<ArrayBuffer> {
    // 1. Check IndexedDB
    const cached = await this.get(key);
    if (cached) {
      if (onProgress) onProgress(cached.byteLength, cached.byteLength);
      return cached;
    }

    // 2. Bundled extension asset. Never replace a missing bundle with a remote file.
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      const localPath = `models/${key}`;
      const localUrl = chrome.runtime.getURL(localPath);
      const response = await fetch(localUrl);
      if (!response.ok) {
        throw new Error(`Bundled model missing: ${key} (HTTP ${response.status}). Vesta does not download weights from the network.`);
      }
      const buffer = await response.arrayBuffer();
      await this.set(key, buffer);
      if (onProgress) onProgress(buffer.byteLength, buffer.byteLength);
      return buffer;
    }

    // 3. Explicit non-extension fallback. Production providers pass an empty URL.
    if (!fallbackUrl) {
      throw new Error(`Bundled model missing: ${key}. Vesta does not download weights from the network.`);
    }
    const response = await fetch(fallbackUrl);
    if (!response.ok) {
      throw new Error(`Failed to load ${key} from ${fallbackUrl}: HTTP ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;
    let loaded = 0;

    if (!response.body) {
      const buffer = await response.arrayBuffer();
      await this.set(key, buffer);
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.length;
        if (onProgress) onProgress(loaded, total || loaded);
      }
    }

    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const buffer = combined.buffer;
    await this.set(key, buffer);
    return buffer;
  }
}
