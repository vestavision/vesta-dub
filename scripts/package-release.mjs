/**
 * Build the unpacked extension and a zip from that same output.
 * Research assets and the duplicate wasm/ mirror are removed before packaging.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, '.output/chrome-mv3');
const releaseDir = path.join(root, 'release');
const zipPath = path.join(releaseDir, 'vesta-dub-0.1.1-rc.zip');

const sync = spawnSync('node', ['scripts/sync-bergamot.mjs'], { cwd: root, stdio: 'inherit' });
if (sync.status !== 0) process.exit(sync.status ?? 1);

const build = spawnSync('npx', ['wxt', 'build'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

for (const relative of ['assets/p6-source-worklet.js']) {
  fs.rmSync(path.join(output, relative), { force: true });
}
if (fs.existsSync(path.join(output, 'ort-wasm-simd-threaded.wasm'))) {
  fs.rmSync(path.join(output, 'wasm'), { recursive: true, force: true });
}

const required = [
  'manifest.json',
  'icons/icon-128.png',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'ort-wasm-simd-threaded.wasm',
  'models/antalia/text.fp16.onnx',
  'models/antalia/cond.fp16.onnx',
  'models/antalia/flow.fp16.onnx',
  'models/antalia/vocoder.fp16.onnx',
  'models/antalia/NOTICE',
  'models/ema-lightning/decoder.onnx',
  'models/ema-lightning/text_stage.onnx',
  'models/ema-lightning/sound_stage.onnx',
  'models/ema-lightning/vocab.json',
  'models/ema-lightning/LICENSE',
  'models/ema-lightning/NOTICE',
  'bergamot/translator-worker.js',
  'bergamot/bergamot-translator-worker.js',
  'bergamot/bergamot-translator-worker.wasm',
  'bergamot/NOTICE',
  'offscreen.html',
];
const forbidden = [
  'assets/p6-source-worklet.js',
  'wasm/ort-wasm-simd-threaded.wasm',
  'models/piper/tr_TR-fahrettin-medium.onnx',
  'models/piper/tr_TR-fahrettin-medium.onnx.json',
];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

for (const relative of required) {
  if (!fs.existsSync(path.join(output, relative))) {
    console.error(`Missing production file: ${relative}`);
    process.exit(1);
  }
}
for (const relative of forbidden) {
  if (fs.existsSync(path.join(output, relative))) {
    console.error(`Research or duplicate file still packaged: ${relative}`);
    process.exit(1);
  }
}

for (const file of walk(output).filter(file => file.endsWith('.js'))) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes('huggingface.co') || source.includes('p6-capture') || source.includes('translate.googleapis.com') || source.includes('client=gtx') || source.includes('bergamot.s3.amazonaws.com')) {
    console.error(`Production script still contains a remote model URL, research worklet, or unofficial translate client: ${path.relative(output, file)}`);
    process.exit(1);
  }
}
for (const file of walk(output)) {
  const relative = path.relative(output, file).split(path.sep).join('/');
  if (relative.includes('piper/') || relative.toLowerCase().includes('fahrettin')) {
    console.error(`Withdrawn voice asset still packaged: ${relative}`);
    process.exit(1);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
if (manifest.version !== '0.1.1' || manifest.manifest_version !== 3) {
  console.error('Manifest version is not the 0.1.1 MV3 candidate.');
  process.exit(1);
}
const hosts = manifest.host_permissions ?? [];
if (hosts.some(host => /huggingface\.co|openai\.com|elevenlabs|translate\.googleapis\.com/i.test(host))) {
  console.error(`Unexpected model, speech, or unofficial translate host permission: ${hosts.join(', ')}`);
  process.exit(1);
}
const permissions = manifest.permissions ?? [];
if (!permissions.includes('offscreen') || !permissions.includes('storage') || !permissions.includes('tabs')) {
  console.error(`Extension permissions are not the expected set: ${permissions.join(', ')}`);
  process.exit(1);
}
if (!hosts.includes('https://translation.googleapis.com/*')) {
  console.error(`Cloud Translation host permission is missing: ${hosts.join(', ')}`);
  process.exit(1);
}
const modelHost = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/*';
if (!hosts.includes(modelHost)) {
  console.error(`Pinned local translation model host is missing: ${hosts.join(', ')}`);
  process.exit(1);
}

function inventory(directory) {
  return walk(directory).map(file => {
    const relative = path.relative(directory, file).split(path.sep).join('/');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const size = fs.statSync(file).size;
    return { relative, hash, size };
  }).sort((a, b) => a.relative.localeCompare(b.relative));
}

const unpacked = inventory(output);
fs.mkdirSync(releaseDir, { recursive: true });
fs.rmSync(zipPath, { force: true });
const stamp = spawnSync('find', [output, '-exec', 'touch', '-t', '202610160000', '{}', '+'], { stdio: 'inherit' });
if (stamp.status !== 0) process.exit(stamp.status ?? 1);
const zip = spawnSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: output, stdio: 'inherit' });
if (zip.status !== 0) process.exit(zip.status ?? 1);

const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'vesta-rc-'));
const unzip = spawnSync('unzip', ['-q', zipPath, '-d', extracted], { stdio: 'inherit' });
if (unzip.status !== 0) process.exit(unzip.status ?? 1);
const packed = inventory(extracted);
fs.rmSync(extracted, { recursive: true, force: true });

const unpackedList = unpacked.map(item => `${item.hash}  ${item.size}  ${item.relative}`).join('\n');
const packedList = packed.map(item => `${item.hash}  ${item.size}  ${item.relative}`).join('\n');
if (unpackedList !== packedList) {
  console.error('Unpacked build and zip contents differ.');
  process.exit(1);
}

const zipHash = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
const zipSize = fs.statSync(zipPath).size;
fs.writeFileSync(path.join(releaseDir, 'vesta-dub-0.1.1-rc.sha256'), `${zipHash}  vesta-dub-0.1.1-rc.zip\n`);
const publicZip = path.join(releaseDir, 'vesta-dub-0.1.1.zip');
fs.copyFileSync(zipPath, publicZip);
fs.writeFileSync(path.join(releaseDir, 'vesta-dub-0.1.1.sha256'), `${zipHash}  vesta-dub-0.1.1.zip\n`);
fs.writeFileSync(path.join(releaseDir, 'manifest.txt'), `${unpackedList}\n`);

const modelBytes = unpacked.filter(item => item.relative.startsWith('models/')).reduce((sum, item) => sum + item.size, 0);
console.log(JSON.stringify({
  version: manifest.version,
  files: unpacked.length,
  zipBytes: zipSize,
  zipSha256: zipHash,
  publicZip: 'vesta-dub-0.1.1.zip',
  modelBytes,
  hostPermissions: hosts,
  unpackedMatchesZip: true,
}, null, 2));
