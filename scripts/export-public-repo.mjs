/**
 * Copy the public-beta tree to a sibling directory.
 * This does not modify this repository's Git objects and it does not push.
 *
 *   node scripts/export-public-repo.mjs
 *   VESTA_PUBLIC_DEST=/absolute/path node scripts/export-public-repo.mjs
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const source = path.resolve(import.meta.dirname, '..');
const dest = path.resolve(process.env.VESTA_PUBLIC_DEST || path.join(source, '..', 'vesta-dub-public'));

const PIPER_GIT_BLOBS = new Set([
  '034599b1241214da842ec5f02a7265bb242efcac',
  'b495964d27195aae03726391b35a6ab1a513859f',
]);

const excludedTests = new Set([
  'tests/live_caption_committer.test.ts',
  'tests/p5_5_pause_isolation.test.ts',
  'tests/p6_2_speaker_review.test.ts',
  'tests/p6_3_boundary_review.test.ts',
  'tests/p6_3_later_review.test.ts',
  'tests/p8_1_corpus.test.ts',
  'tests/p8_1_review.test.ts',
  'tests/p8_2_boundaries.test.ts',
  'tests/dsp/test_p2a_acoustic_benchmarks.ts',
  'tests/dsp/test_p25_acoustic_and_listening_pack.ts',
  'tests/test_p1_eval_suite.ts',
  'tests/translation/test_p2b_benchmarks.ts',
  'tests/translation/test_p25_semantic_challenge_audit.ts',
  'tests/verify_phase1_models.mjs',
]);

const scriptAllow = new Set([
  'scripts/export-public-repo.mjs',
  'scripts/p5.2-sentence-shadow.ts',
  'scripts/p9.2-browser-inference.mjs',
  'scripts/p9.2-local-translation-bench.mjs',
  'scripts/package-release.mjs',
  'scripts/sync-bergamot.mjs',
]);

if (dest === source || dest.startsWith(source + path.sep)) {
  console.error('refusing to write inside the development repository');
  process.exit(1);
}
if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
  console.error(`destination is not empty: ${dest}`);
  process.exit(1);
}

function rel(file) {
  return path.relative(source, file).split(path.sep).join('/');
}

function skip(file) {
  const name = rel(file);
  if (name === '' || name === '.') return false;
  const base = path.posix.basename(name);
  if (base === '.git' || name.startsWith('.git/')) return true;
  if (base === 'node_modules' || name.startsWith('node_modules/')) return true;
  if (base === '.output' || name.startsWith('.output/')) return true;
  if (base === '.wxt' || name.startsWith('.wxt/')) return true;
  if (base === 'dist' || name.startsWith('dist/')) return true;
  if (base === 'tools' || name.startsWith('tools/')) return true;
  if (name === 'tests/artifacts' || name.startsWith('tests/artifacts/')) return true;
  if (name === 'public/wasm' || name.startsWith('public/wasm/')) return true;
  if (name === 'youtube_page.png' || base === '.DS_Store') return true;
  if (name === '.env' || name.startsWith('.env.') || base.endsWith('.pem') || base.endsWith('.key')) return true;
  if (name.startsWith('release/') && (name.endsWith('.zip') || name.endsWith('.sha256') || name === 'release/manifest.txt')) return true;
  if (name.startsWith('docs/') && !name.startsWith('docs/release/') && name.endsWith('.md')) return true;
  if (name.startsWith('scripts/')) {
    if (scriptAllow.has(name)) return false;
    const stat = fs.statSync(file);
    return stat.isFile();
  }
  if (name.startsWith('tests/') && name.endsWith('.mjs')) return true;
  if (excludedTests.has(name)) return true;
  return false;
}

fs.mkdirSync(dest, { recursive: true });
fs.cpSync(source, dest, {
  recursive: true,
  filter: file => !skip(file),
});

function removeEmpty(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (fs.statSync(full).isDirectory()) removeEmpty(full);
  }
  if (directory !== dest && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
}
removeEmpty(dest);

const hits = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const name = path.relative(dest, full).split(path.sep).join('/');
    if (entry.isSymbolicLink()) {
      hits.push(`symlink ${name}`);
      continue;
    }
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    const lowered = name.toLowerCase();
    if (lowered.includes('fahrettin') && (lowered.endsWith('.onnx') || lowered.endsWith('.json'))) {
      hits.push(`piper filename ${name}`);
    }
    if (lowered.includes('/piper/') || lowered.startsWith('piper/')) {
      hits.push(`piper path ${name}`);
    }
    const data = fs.readFileSync(full);
    const blob = crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
    if (PIPER_GIT_BLOBS.has(blob)) hits.push(`piper blob ${blob} ${name}`);
    const privateKey = Buffer.from(`-----BEGIN ${'PRIVATE KEY'}-----`);
    const rsaKey = Buffer.from(`-----BEGIN ${'RSA PRIVATE KEY'}-----`);
    if (data.includes(privateKey) || data.includes(rsaKey)) {
      hits.push(`private key text ${name}`);
    }
  }
}
walk(dest);

const zipSource = path.join(source, 'release/vesta-dub-0.1.1.zip');
const zipDest = path.join(dest, 'release/vesta-dub-0.1.1.zip');
if (fs.existsSync(zipSource)) {
  fs.mkdirSync(path.join(dest, 'release'), { recursive: true });
  fs.copyFileSync(zipSource, zipDest);
  const sum = path.join(source, 'release/vesta-dub-0.1.1.sha256');
  if (fs.existsSync(sum)) fs.copyFileSync(sum, path.join(dest, 'release/vesta-dub-0.1.1.sha256'));
  const listing = spawnSync('unzip', ['-Z1', zipDest], { encoding: 'utf8' });
  if (listing.status !== 0) hits.push('could not list the release zip');
  for (const line of listing.stdout.split('\n')) {
    const lowered = line.toLowerCase();
    if (lowered.includes('fahrettin') || lowered.includes('piper/')) hits.push(`piper zip entry ${line}`);
  }
}

if (hits.length > 0) {
  console.error(hits.join('\n'));
  process.exit(1);
}

console.log(JSON.stringify({ dest, files: countFiles(dest) }));

function countFiles(directory) {
  let count = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) count += countFiles(full);
    else count += 1;
  }
  return count;
}
