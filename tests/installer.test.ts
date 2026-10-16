import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'install.sh');
const realZip = path.join(root, 'release/vesta-dub-0.1.0-rc.zip');
const pinnedZip = 'eb9b06430c475ee5dc8d9ec77b0135b56d155341c4157ac54dee6993139f237a';
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobId(bytes: Buffer | string): string {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}

function manifestFixture(): string {
  return '{"manifest_version":3,"name":"Vesta Dub","version":"0.1.0"}\n';
}

function writeExtensionZip(dir: string, files: Record<string, string>): string {
  const source = path.join(dir, 'pack');
  mkdirSync(source, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(source, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  const zipPath = path.join(dir, 'vesta-dub-0.1.0.zip');
  const zip = spawnSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: source, encoding: 'utf8' });
  expect(zip.status).toBe(0);
  return zipPath;
}

function writeRawZip(dir: string, python: string): string {
  const zipPath = path.join(dir, 'vesta-dub-0.1.0.zip');
  const writer = path.join(dir, 'write-zip.py');
  writeFileSync(writer, python);
  const run = spawnSync('python3', [writer, zipPath], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  return zipPath;
}

function publish(dir: string, zipPath: string, publishedHash?: string): string {
  const hash = publishedHash ?? sha256(readFileSync(zipPath));
  if (path.basename(zipPath) !== 'vesta-dub-0.1.0.zip' || path.dirname(zipPath) !== dir) {
    writeFileSync(path.join(dir, 'vesta-dub-0.1.0.zip'), readFileSync(zipPath));
  }
  writeFileSync(path.join(dir, 'vesta-dub-0.1.0.sha256'), `${hash}  vesta-dub-0.1.0.zip\n`);
  return hash;
}

function serve(dir: string, mode: 'ok' | 'partial' = 'ok'): Promise<{ url: string; hits: { n: number } }> {
  const hits = { n: 0 };
  const server = createServer((request, response) => {
    hits.n += 1;
    const name = path.basename(request.url?.split('?')[0] || '');
    const file = path.join(dir, name);
    if (!existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = readFileSync(file);
    if (mode === 'partial') {
      response.writeHead(200, { 'Content-Length': String(body.length) });
      response.write(body.subarray(0, 20));
      response.destroy();
      return;
    }
    response.writeHead(200, { 'Content-Length': body.length });
    response.end(body);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      cleanups.push(() => server.close());
      resolve({ url: `http://127.0.0.1:${port}`, hits });
    });
  });
}

function fakeBrowsers(names: Array<'brave' | 'chrome'>): string {
  const dir = tempDir('vesta-browsers-');
  for (const name of names) {
    const file = path.join(dir, name === 'brave' ? 'brave' : 'google-chrome');
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);
  }
  return dir;
}

function fakeUname(system: 'Linux' | 'Darwin'): string {
  const dir = tempDir('vesta-uname-');
  const file = path.join(dir, 'uname');
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "-s" ]; then printf '%s\\n' '${system}'; exit 0; fi\nexec /usr/bin/uname "$@"\n`);
  chmodSync(file, 0o755);
  return dir;
}

function run(args: string[], env: Record<string, string | undefined>, home = tempDir('vesta-home-')) {
  const merged: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: process.env.TMPDIR || '/tmp',
    LANG: 'C',
    VESTA_DUB_OPEN_BROWSER: '0',
    VESTA_DUB_HOME: home,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return new Promise<{ status: number | null; stdout: string; stderr: string; home: string }>(resolve => {
    const child = spawn('sh', [script, ...args], { env: merged });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr, home }));
  });
}

describe('vesta dub installer', () => {
  it('prints help and the pinned version', async () => {
    const help = await run(['--help'], {});
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Load unpacked');
    expect(help.stdout).toContain('does not');
    const version = await run(['--version'], {});
    expect(version.stdout.trim()).toBe('0.1.0');
  });

  it('rejects a version other than 0.1.0 and a release URL it does not trust', async () => {
    const version = await run([], { VESTA_DUB_VERSION: '0.2.0;rm -rf /' });
    expect(version.status).toBe(2);
    expect(version.stderr).toContain('only prepares 0.1.0');
    const remote = await run([], { VESTA_DUB_RELEASE_BASE: 'https://evil.example/vesta-dub' });
    expect(remote.status).toBe(2);
    expect(remote.stderr).toContain('refusing release URL');
    const query = await run([], { VESTA_DUB_RELEASE_BASE: 'http://127.0.0.1:9?x=1' });
    expect(query.status).toBe(2);
    const override = await run([], { VESTA_DUB_EXPECTED_SHA256: 'a'.repeat(64) });
    expect(override.status).toBe(2);
    expect(override.stderr).toContain('refusing to override');
  });

  it('dry-run writes nothing', async () => {
    const home = tempDir('vesta-home-');
    const result = await run(['--dry-run'], {
      VESTA_DUB_FAKE_BROWSERS: fakeBrowsers(['brave']),
      VESTA_DUB_RELEASE_BASE: 'http://127.0.0.1:9',
    }, home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status: dry-run');
    expect(result.stdout).toContain('browser: brave');
    expect(result.stdout).toContain('not downloaded or installed');
    expect(existsSync(path.join(home, 'extensions'))).toBe(false);
  });

  it('detects Brave, Chrome, and a missing explicit browser without touching a profile', async () => {
    const brave = await run(['--browser', 'brave', '--dry-run'], { VESTA_DUB_FAKE_BROWSERS: fakeBrowsers(['brave']) });
    expect(brave.status).toBe(0);
    expect(brave.stdout).toContain('browser: brave');
    expect(brave.stdout).toContain('brave://extensions');
    const chrome = await run(['--browser', 'chrome', '--dry-run'], { VESTA_DUB_FAKE_BROWSERS: fakeBrowsers(['chrome']) });
    expect(chrome.status).toBe(0);
    expect(chrome.stdout).toContain('browser: chrome');
    expect(chrome.stdout).toContain('chrome://extensions');
    const missing = await run(['--browser', 'brave', '--dry-run'], { VESTA_DUB_FAKE_BROWSERS: fakeBrowsers(['chrome']) });
    expect(missing.status).toBe(5);
    expect(missing.stderr).toContain('requested browser was not found');
    expect(missing.stdout).not.toContain('status: prepared');
  });

  it('prepares a fresh extension, reuses it, and keeps a newer version', async () => {
    const release = tempDir('vesta-release-');
    const zip = writeExtensionZip(release, { 'manifest.json': manifestFixture(), 'background.js': '/* fixture */\n' });
    const hash = publish(release, zip);
    const server = await serve(release);
    const browsers = fakeBrowsers(['brave']);
    const home = tempDir('vesta-home-');
    const env = {
      VESTA_DUB_RELEASE_BASE: server.url,
      VESTA_DUB_EXPECTED_SHA256: hash,
      VESTA_DUB_FAKE_BROWSERS: browsers,
    };
    const first = await run([], env, home);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('status: prepared');
    expect(first.stdout).toContain('reused: no');
    expect(first.stdout).toContain('did not load the extension into the browser');
    expect(first.stdout).not.toContain('status: installed');
    const manifest = JSON.parse(readFileSync(path.join(home, 'extensions/0.1.0/manifest.json'), 'utf8')) as { version: string };
    expect(manifest.version).toBe('0.1.0');
    expect(readFileSync(path.join(home, 'extensions/0.1.0.stamp'), 'utf8')).toContain(hash);
    const hitsAfterFirst = server.hits.n;

    const second = await run([], env, home);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('reused: yes');
    expect(server.hits.n).toBe(hitsAfterFirst);

    const newerHome = tempDir('vesta-home-');
    mkdirSync(path.join(newerHome, 'extensions/0.2.0'), { recursive: true });
    writeFileSync(path.join(newerHome, 'current-version'), '0.2.0\n');
    const newer = await run([], { ...env, VESTA_DUB_RELEASE_BASE: 'http://127.0.0.1:1' }, newerHome);
    expect(newer.status, newer.stderr).toBe(0);
    expect(newer.stdout).toContain('status: kept-newer');
    expect(existsSync(path.join(newerHome, 'extensions/0.1.0'))).toBe(false);
  });

  it('uses the macOS and Linux user directories', async () => {
    const release = tempDir('vesta-release-');
    const hash = publish(release, writeExtensionZip(release, { 'manifest.json': manifestFixture() }));
    const server = await serve(release);
    const linuxHome = tempDir('vesta-linux-');
    const linux = await run([], {
      HOME: linuxHome,
      VESTA_DUB_HOME: undefined,
      XDG_DATA_HOME: '',
      PATH: `${fakeUname('Linux')}:${process.env.PATH}`,
      VESTA_DUB_RELEASE_BASE: server.url,
      VESTA_DUB_EXPECTED_SHA256: hash,
      VESTA_DUB_FAKE_BROWSERS: fakeBrowsers([]),
    }, linuxHome);
    expect(linux.status, linux.stderr).toBe(0);
    expect(linux.stdout).toContain('browser: none');
    expect(existsSync(path.join(linuxHome, '.local/share/vesta-dub/extensions/0.1.0/manifest.json'))).toBe(true);

    const macHome = tempDir('vesta-mac-');
    const mac = await run([], {
      HOME: macHome,
      VESTA_DUB_HOME: undefined,
      PATH: `${fakeUname('Darwin')}:${process.env.PATH}`,
      VESTA_DUB_RELEASE_BASE: server.url,
      VESTA_DUB_EXPECTED_SHA256: hash,
      VESTA_DUB_FAKE_BROWSERS: fakeBrowsers(['chrome']),
    }, macHome);
    expect(mac.status, mac.stderr).toBe(0);
    expect(mac.stdout).toContain('browser: chrome');
    expect(existsSync(path.join(macHome, 'Library/Application Support/Vesta Dub/extensions/0.1.0/manifest.json'))).toBe(true);
  });

  it('rejects a bad checksum, a corrupt archive, a short download, and a missing manifest', async () => {
    const release = tempDir('vesta-release-');
    const zip = writeExtensionZip(release, { 'manifest.json': manifestFixture() });
    const hash = sha256(readFileSync(zip));
    writeFileSync(path.join(release, 'vesta-dub-0.1.0.sha256'), `${'b'.repeat(64)}  vesta-dub-0.1.0.zip\n`);
    const mismatch = await serve(release);
    const browsers = fakeBrowsers(['brave']);
    const wrong = await run([], {
      VESTA_DUB_RELEASE_BASE: mismatch.url,
      VESTA_DUB_EXPECTED_SHA256: hash,
      VESTA_DUB_FAKE_BROWSERS: browsers,
    });
    expect(wrong.status).toBe(3);
    expect(wrong.stderr).toContain('does not match the pinned SHA-256');
    expect(existsSync(path.join(wrong.home, 'extensions/0.1.0'))).toBe(false);

    const corruptDir = tempDir('vesta-release-');
    writeFileSync(path.join(corruptDir, 'vesta-dub-0.1.0.zip'), Buffer.from('this is not a zip'));
    const corruptHash = publish(corruptDir, path.join(corruptDir, 'vesta-dub-0.1.0.zip'));
    const corruptServer = await serve(corruptDir);
    const corrupt = await run([], {
      VESTA_DUB_RELEASE_BASE: corruptServer.url,
      VESTA_DUB_EXPECTED_SHA256: corruptHash,
      VESTA_DUB_FAKE_BROWSERS: browsers,
    });
    expect(corrupt.status).toBe(3);
    expect(corrupt.stderr).toContain('not a zip');
    expect(existsSync(path.join(corrupt.home, 'extensions/0.1.0'))).toBe(false);

    const partialDir = tempDir('vesta-release-');
    const partialHash = publish(partialDir, writeExtensionZip(partialDir, { 'manifest.json': manifestFixture() }));
    const partialServer = await serve(partialDir, 'partial');
    const partial = await run([], {
      VESTA_DUB_RELEASE_BASE: partialServer.url,
      VESTA_DUB_EXPECTED_SHA256: partialHash,
      VESTA_DUB_FAKE_BROWSERS: browsers,
    });
    expect(partial.status).toBe(4);
    expect(existsSync(path.join(partial.home, 'extensions/0.1.0'))).toBe(false);
    expect(existsSync(path.join(partial.home, 'extensions/0.1.0.partial'))).toBe(false);

    const offline = await run([], {
      VESTA_DUB_RELEASE_BASE: 'http://127.0.0.1:1',
      VESTA_DUB_EXPECTED_SHA256: hash,
      VESTA_DUB_FAKE_BROWSERS: browsers,
    });
    expect(offline.status).toBe(4);
    expect(offline.stderr).toContain('could not download');

    const missingDir = tempDir('vesta-release-');
    const missingHash = publish(missingDir, writeExtensionZip(missingDir, { 'readme.txt': 'no manifest\n' }));
    const missingServer = await serve(missingDir);
    const missing = await run([], {
      VESTA_DUB_RELEASE_BASE: missingServer.url,
      VESTA_DUB_EXPECTED_SHA256: missingHash,
      VESTA_DUB_FAKE_BROWSERS: browsers,
    });
    expect(missing.status).toBe(3);
    expect(missing.stderr).toContain('manifest.json');
  });

  it('rejects path traversal, symlinks, Piper names, and a forbidden file hash', async () => {
    const browsers = fakeBrowsers(['brave']);
    const parentDir = tempDir('vesta-release-');
    writeRawZip(parentDir, `
import sys, zipfile
zf = zipfile.ZipFile(sys.argv[1], "w")
zf.writestr("../escaped.txt", b"nope")
zf.close()
`);
    const parentHash = publish(parentDir, path.join(parentDir, 'vesta-dub-0.1.0.zip'));
    const parentServer = await serve(parentDir);
    const parent = await run([], {
      VESTA_DUB_RELEASE_BASE: parentServer.url,
      VESTA_DUB_EXPECTED_SHA256: parentHash,
      VESTA_DUB_FAKE_BROWSERS: browsers,
    });
    expect(parent.status).toBe(3);
    expect(parent.stderr).toContain('parent path');
    expect(existsSync(path.join(parent.home, 'extensions/escaped.txt'))).toBe(false);

    const linkDir = tempDir('vesta-release-');
    writeRawZip(linkDir, `
import os, stat, sys, zipfile
zf = zipfile.ZipFile(sys.argv[1], "w")
info = zipfile.ZipInfo("manifest.json")
info.external_attr = (stat.S_IFLNK | 0o777) << 16
zf.writestr(info, "/tmp/not-a-manifest")
zf.close()
`);
    const linkHash = publish(linkDir, path.join(linkDir, 'vesta-dub-0.1.0.zip'));
    const linkServer = await serve(linkDir);
    const link = await run([], {
      VESTA_DUB_RELEASE_BASE: linkServer.url,
      VESTA_DUB_EXPECTED_SHA256: linkHash,
      VESTA_DUB_FAKE_BROWSERS: browsers,
    });
    expect(link.status).toBe(3);
    expect(link.stderr).toContain('symbolic link');

    const piperDir = tempDir('vesta-release-');
    const piperHash = publish(piperDir, writeExtensionZip(piperDir, {
      'manifest.json': manifestFixture(),
      'models/piper/tr_TR-fahrettin-medium.onnx': 'not the real weight',
    }));
    const piperServer = await serve(piperDir);
    const piper = await run([], {
      VESTA_DUB_RELEASE_BASE: piperServer.url,
      VESTA_DUB_EXPECTED_SHA256: piperHash,
      VESTA_DUB_FAKE_BROWSERS: browsers,
    });
    expect(piper.status).toBe(3);
    expect(piper.stderr.toLowerCase()).toContain('piper');
    expect(existsSync(path.join(piper.home, 'extensions/0.1.0'))).toBe(false);
    expect(existsSync(path.join(piper.home, 'extensions/0.1.0.partial'))).toBe(false);

    const hashDir = tempDir('vesta-release-');
    const body = 'not-a-model';
    const forbidden = sha256(body);
    const forbiddenHash = publish(hashDir, writeExtensionZip(hashDir, {
      'manifest.json': manifestFixture(),
      'readme.txt': body,
    }));
    const hashServer = await serve(hashDir);
    const hashed = await run([], {
      VESTA_DUB_RELEASE_BASE: hashServer.url,
      VESTA_DUB_EXPECTED_SHA256: forbiddenHash,
      VESTA_DUB_FORBIDDEN_SHA256: forbidden,
      VESTA_DUB_FAKE_BROWSERS: browsers,
    });
    expect(hashed.status).toBe(3);
    expect(hashed.stderr).toContain('withdrawn Piper file');

    const gitDir = tempDir('vesta-release-');
    const gitBody = 'synthetic-weight';
    const gitId = gitBlobId(gitBody);
    const gitZipHash = publish(gitDir, writeExtensionZip(gitDir, {
      'manifest.json': manifestFixture(),
      'assets/note.bin': gitBody,
    }));
    const gitServer = await serve(gitDir);
    const gitHit = await run([], {
      VESTA_DUB_RELEASE_BASE: gitServer.url,
      VESTA_DUB_EXPECTED_SHA256: gitZipHash,
      VESTA_DUB_FORBIDDEN_GIT_BLOB: gitId,
      VESTA_DUB_FAKE_BROWSERS: browsers,
    });
    expect(gitHit.status).toBe(3);
    expect(gitHit.stderr).toContain('withdrawn Piper file');
    expect(existsSync(path.join(gitHit.home, 'extensions/0.1.0'))).toBe(false);
    expect(existsSync(path.join(gitHit.home, 'extensions/0.1.0.partial'))).toBe(false);
  });

  it('does not replace a directory whose stamp differs', async () => {
    const release = tempDir('vesta-release-');
    const hash = publish(release, writeExtensionZip(release, { 'manifest.json': manifestFixture() }));
    const server = await serve(release);
    const home = tempDir('vesta-home-');
    mkdirSync(path.join(home, 'extensions/0.1.0'), { recursive: true });
    writeFileSync(path.join(home, 'extensions/0.1.0/manifest.json'), manifestFixture());
    writeFileSync(path.join(home, 'extensions/0.1.0.stamp'), `0.1.0\n${'c'.repeat(64)}\n`);
    const result = await run([], {
      VESTA_DUB_RELEASE_BASE: server.url,
      VESTA_DUB_EXPECTED_SHA256: hash,
      VESTA_DUB_FAKE_BROWSERS: fakeBrowsers(['brave']),
    }, home);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('move it aside');
    expect(server.hits.n).toBe(0);
  });

  it('refuses a symlinked destination', async () => {
    const home = tempDir('vesta-home-');
    const elsewhere = tempDir('vesta-elsewhere-');
    mkdirSync(path.join(home, 'extensions'), { recursive: true });
    symlinkSync(elsewhere, path.join(home, 'extensions/0.1.0'));
    const result = await run(['--dry-run'], { VESTA_DUB_FAKE_BROWSERS: fakeBrowsers(['brave']) }, home);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('symlink');
    expect(existsSync(elsewhere)).toBe(true);
    expect(existsSync(path.join(home, 'extensions/0.1.0'))).toBe(true);
  });

  it('prepares the real 0.1.0 archive when the local release zip is present', async () => {
    if (!existsSync(realZip)) return;
    expect(sha256(readFileSync(realZip))).toBe(pinnedZip);
    const release = tempDir('vesta-release-');
    writeFileSync(path.join(release, 'vesta-dub-0.1.0.zip'), readFileSync(realZip));
    publish(release, path.join(release, 'vesta-dub-0.1.0.zip'), pinnedZip);
    const server = await serve(release);
    const home = tempDir('vesta-home-');
    const result = await run([], {
      VESTA_DUB_RELEASE_BASE: server.url,
      VESTA_DUB_FAKE_BROWSERS: fakeBrowsers(['brave']),
    }, home);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('status: prepared');
    expect(result.stdout).toContain(pinnedZip);
    const manifest = JSON.parse(readFileSync(path.join(home, 'extensions/0.1.0/manifest.json'), 'utf8')) as { version: string; manifest_version: number };
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.manifest_version).toBe(3);
    expect(existsSync(path.join(home, 'extensions/0.1.0/models/piper'))).toBe(false);
    const names = spawnSync('find', [path.join(home, 'extensions/0.1.0'), '-iname', '*fahrettin*', '-o', '-iname', '*piper*'], { encoding: 'utf8' });
    expect(names.stdout.trim()).toBe('');
  }, 180_000);
});
