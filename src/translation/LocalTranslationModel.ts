/**
 * Pinned Mozilla Firefox Translations English→Turkish model.
 * Registry generated 2026-10-15. Architecture: tiny. Direction: en → tr.
 * Files are gzip on the wire and uncompressed before inference.
 */

export const LOCAL_TRANSLATION_MODEL_ID = 'mozilla-firefox-translations-en-tr-tiny-spring-2024';

export const LOCAL_TRANSLATION_BASE_URL = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/';

const MODEL_DIR = 'models/en-tr/spring-2024_LiFGeNrEQpKdNlziG2qP_A/exported/';

export interface LocalModelFile {
  name: 'model' | 'shortlist' | 'vocab';
  url: string;
  gzipBytes: number;
  gzipSha256: string;
  rawBytes: number;
  rawSha256: string;
}

export const LOCAL_TRANSLATION_FILES: readonly LocalModelFile[] = [
  {
    name: 'model',
    url: `${LOCAL_TRANSLATION_BASE_URL}${MODEL_DIR}model.entr.intgemm.alphas.bin.gz`,
    gzipBytes: 13_159_314,
    gzipSha256: '52d10136b1a4804879989aa9ee146e83ced75aa0ce2d371b4e582473ed6b9020',
    rawBytes: 17_141_051,
    rawSha256: 'ea3cd4ee09de190df265c78d84260e277a9a8a3ddff05eb55d72afe7fc0fdbf4',
  },
  {
    name: 'shortlist',
    url: `${LOCAL_TRANSLATION_BASE_URL}${MODEL_DIR}lex.50.50.entr.s2t.bin.gz`,
    gzipBytes: 1_546_258,
    gzipSha256: 'cf74d4edec0b51affd30a43e6bd2c2274bf4ce7fd54c24fd293db2c5c4bf043d',
    rawBytes: 3_261_300,
    rawSha256: '3aba0be842bd4c192659c781e6fdce8eb9b2b1fff29a40d22f75da369d59f46f',
  },
  {
    name: 'vocab',
    url: `${LOCAL_TRANSLATION_BASE_URL}${MODEL_DIR}vocab.entr.spm.gz`,
    gzipBytes: 395_473,
    gzipSha256: '01e55973e65a34c5efbdce3968857d4e53998b4bef131c5125a19f8e44d8f87c',
    rawBytes: 798_793,
    rawSha256: 'a220363d60391f7ce3df8ec9785424dbc00c24d5786d1a4308cf8ca3ed3385c2',
  },
];

export const LOCAL_TRANSLATION_DOWNLOAD_BYTES = LOCAL_TRANSLATION_FILES.reduce((sum, file) => sum + file.gzipBytes, 0);

export interface LocalModelBuffers {
  model: ArrayBuffer;
  shortlist: ArrayBuffer;
  vocab: ArrayBuffer;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function gunzipBytes(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export async function verifyRawModelFile(file: LocalModelFile, raw: ArrayBuffer): Promise<void> {
  if (raw.byteLength !== file.rawBytes) throw new Error('model size mismatch');
  const hash = await sha256Hex(raw);
  if (hash !== file.rawSha256) throw new Error('model hash mismatch');
}

async function readBody(response: Response, onChunk: (loaded: number) => void): Promise<ArrayBuffer> {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onChunk(buffer.byteLength);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    if (!step.value) continue;
    chunks.push(step.value);
    loaded += step.value.byteLength;
    onChunk(loaded);
  }
  const combined = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

/** Download one pinned file. The gzip hash and the uncompressed hash must both match. */
export async function downloadModelFile(
  file: LocalModelFile,
  fetchImpl: typeof fetch,
  onChunk: (loaded: number) => void,
): Promise<ArrayBuffer> {
  if (file.url.includes('?')) throw new Error('model url must not carry a query');
  const response = await fetchImpl(file.url, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`model download failed: HTTP ${response.status}`);
  const gzip = await readBody(response, onChunk);
  if (gzip.byteLength !== file.gzipBytes) throw new Error('gzip size mismatch');
  if (await sha256Hex(gzip) !== file.gzipSha256) throw new Error('gzip hash mismatch');
  const raw = await gunzipBytes(gzip);
  await verifyRawModelFile(file, raw);
  return raw;
}
