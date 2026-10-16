/**
 * Real Bergamot EN→TR measurements. Node worker, not a mock translator.
 * Writes JSON to stdout. Does not call Cloud Translation.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { BergamotSession } from '../src/translation/BergamotSession.ts';

const root = path.resolve(import.meta.dirname, '..');
const chains = JSON.parse(readFileSync(path.join(root, 'tests/artifacts/caption-recovery/measured-cue-chains.json'), 'utf8'));
const buffers = {
  model: fileBuffer('model.bin'),
  shortlist: fileBuffer('lex.bin'),
  vocab: fileBuffer('vocab.bin'),
};

function fileBuffer(name) {
  const bytes = readFileSync(path.join('/tmp/vesta-entr', name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function openPort() {
  const worker = new Worker(pathToFileURL(path.join(root, 'public/bergamot/translator-worker.js')));
  return {
    postMessage: message => worker.postMessage(message),
    terminate: () => { void worker.terminate(); },
    addEventListener(type, handler) {
      if (type === 'message') worker.on('message', data => handler({ data }));
      else worker.on('error', error => handler({ message: error instanceof Error ? error.message : String(error) }));
    },
  };
}

const fixed = [
  { kind: 'short', text: 'Hello, how are you?' },
  { kind: 'longer', text: 'The meeting starts at three and we still need the final numbers before anyone leaves.' },
  { kind: 'technical', text: 'A neural network compresses the next word by predicting it.' },
  { kind: 'name', text: 'Ada Lovelace wrote notes on the analytical engine.' },
  { kind: 'acronym', text: 'The CPU and GPU share the same memory bus.' },
  { kind: 'question', text: 'Can you hear the original audio after we stop?' },
  { kind: 'order', text: 'Only after the model is cached does translation stay on the device.' },
  { kind: 'number', text: 'The sample rate is 48000 and the delay was 3.5 seconds.' },
  { kind: 'hesitation', text: 'I think we should um go now.' },
  { kind: 'incomplete', text: 'if you can predict uh sort of the next word' },
];

const retained = chains.cueChains.slice(0, 8).map(chain => ({
  kind: 'retained-cue',
  text: chain.originalText,
  retainedTurkish: chain.turkishText,
}));

const rssBefore = process.memoryUsage().rss;
const session = new BergamotSession(openPort());
const wasmStarted = performance.now();
await session.initialize();
const wasmMs = Math.round(performance.now() - wasmStarted);
const modelStarted = performance.now();
await session.loadModel(buffers);
const modelMs = Math.round(performance.now() - modelStarted);
const rssLoaded = process.memoryUsage().rss;

const rows = [];
for (const item of [...fixed, ...retained]) {
  const started = performance.now();
  const translated = await session.translate(item.text);
  rows.push({
    kind: item.kind,
    ms: Math.round(performance.now() - started),
    source: item.text,
    translated,
    retainedTurkish: item.retainedTurkish ?? null,
  });
}
const warm = rows.slice(1).map(row => row.ms);
const report = {
  runtime: 'node-worker-threads',
  webgpu: false,
  wasmMs,
  modelMs,
  firstTranslationMs: rows[0].ms,
  warmMedianMs: warm.sort((a, b) => a - b)[Math.floor(warm.length / 2)],
  warmMinMs: Math.min(...warm),
  warmMaxMs: Math.max(...warm),
  rssBefore,
  rssLoaded,
  rssAfter: process.memoryUsage().rss,
  rows,
};
session.terminate();
console.log(JSON.stringify(report, null, 2));
