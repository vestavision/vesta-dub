/**
 * Copy the pinned Bergamot WASM runtime into public/bergamot.
 * The files are static extension assets. They are not fetched at runtime.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'node_modules/@browsermt/bergamot-translator/worker');
const target = path.join(root, 'public/bergamot');
mkdirSync(target, { recursive: true });

for (const name of [
  'translator-worker.js',
  'bergamot-translator-worker.js',
  'bergamot-translator-worker.wasm',
]) {
  copyFileSync(path.join(source, name), path.join(target, name));
}

writeFileSync(path.join(target, 'package.json'), `${JSON.stringify({
  private: true,
  type: 'commonjs',
  description: 'Keeps the Bergamot worker in CommonJS when Node loads it. The extension loads the same files as a classic worker.',
}, null, 2)}\n`);

writeFileSync(path.join(target, 'NOTICE'), `Bergamot Translator worker files
Package: @browsermt/bergamot-translator 0.4.9
License: Mozilla Public License 2.0
Source: https://github.com/browsermt/bergamot-translator
Published WASM version string: v0.4.5+4917c11

These are the published worker files. Vesta Dub does not modify them.
The English-to-Turkish model weights are not in this directory.
`);
