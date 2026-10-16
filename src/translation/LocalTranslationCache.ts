import { LOCAL_TRANSLATION_FILES, verifyRawModelFile, type LocalModelBuffers } from './LocalTranslationModel';

const DB_NAME = 'vesta_local_translation';
const STORE = 'files';
const DB_VERSION = 1;

export interface TranslationFileCache {
  present(): Promise<boolean>;
  read(): Promise<LocalModelBuffers | null>;
  write(buffers: LocalModelBuffers): Promise<boolean>;
  clear(): Promise<void>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDbTranslationCache implements TranslationFileCache {
  async present(): Promise<boolean> {
    if (typeof indexedDB === 'undefined') return false;
    try {
      const db = await openDb();
      const keys = await requestResult<IDBValidKey[]>(db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys());
      return LOCAL_TRANSLATION_FILES.every(file => keys.includes(file.name));
    } catch {
      return false;
    }
  }

  async read(): Promise<LocalModelBuffers | null> {
    if (typeof indexedDB === 'undefined') return null;
    try {
      const db = await openDb();
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const [model, shortlist, vocab] = await Promise.all([
        requestResult<ArrayBuffer | undefined>(store.get('model')),
        requestResult<ArrayBuffer | undefined>(store.get('shortlist')),
        requestResult<ArrayBuffer | undefined>(store.get('vocab')),
      ]);
      if (!model || !shortlist || !vocab) return null;
      const buffers = { model, shortlist, vocab };
      await verifyCached(buffers);
      return buffers;
    } catch {
      await this.clear();
      return null;
    }
  }

  async write(buffers: LocalModelBuffers): Promise<boolean> {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.put(buffers.model, 'model');
        store.put(buffers.shortlist, 'shortlist');
        store.put(buffers.vocab, 'vocab');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      return true;
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // A failed delete still leaves inference on the verified bytes in memory.
    }
  }
}

export class MemoryTranslationCache implements TranslationFileCache {
  private stored: LocalModelBuffers | null = null;

  async present(): Promise<boolean> {
    return this.stored !== null;
  }

  async read(): Promise<LocalModelBuffers | null> {
    if (!this.stored) return null;
    try {
      await verifyCached(this.stored);
      return this.stored;
    } catch {
      this.stored = null;
      return null;
    }
  }

  async write(buffers: LocalModelBuffers): Promise<boolean> {
    this.stored = buffers;
    return true;
  }

  async clear(): Promise<void> {
    this.stored = null;
  }
}

async function verifyCached(buffers: LocalModelBuffers): Promise<void> {
  const byName = { model: buffers.model, shortlist: buffers.shortlist, vocab: buffers.vocab };
  for (const file of LOCAL_TRANSLATION_FILES) {
    await verifyRawModelFile(file, byName[file.name]);
  }
}
