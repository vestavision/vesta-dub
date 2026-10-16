/**
 * Load the unpacked MV3 build and translate English to Turkish in that browser.
 * This is extension-runtime inference. It is not a YouTube playback test.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const extensionPath = path.resolve(root, '.output/chrome-mv3');
const profile = path.join(os.tmpdir(), 'vesta-p92-browser');
const reportPath = '/tmp/vesta-entr/browser-inference.json';
const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
  console.error(`Missing unpacked extension: ${extensionPath}`);
  process.exit(1);
}

fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });

const requests = [];
const report = {
  startedAt: new Date().toISOString(),
  extensionPath,
  profile: 'isolated-temp',
  normalProfileTouched: false,
  youtubePlayed: false,
  cloudRequests: 0,
  unofficialTranslateRequests: 0,
  modelRequests: [],
  ui: {},
  inference: {},
  cacheReuse: {},
  corrupt: {},
  memory: {},
  webgpu: null,
  pageFrameGapMs: null,
  errors: [],
};

function launchOptions(extraArgs = []) {
  return {
    headless: false,
    viewport: { width: 420, height: 760 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--enable-precise-memory-info',
      ...extraArgs,
    ],
    ...(fs.existsSync(brave) ? { executablePath: brave } : {}),
  };
}

async function vocabBytes(page) {
  return page.evaluate(async () => {
    const open = indexedDB.open('vesta_local_translation', 1);
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const bytes = await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly');
      const request = tx.objectStore('files').get('vocab');
      request.onsuccess = () => resolve(request.result instanceof ArrayBuffer ? request.result.byteLength : 0);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return bytes;
  });
}

function watch(context) {
  context.on('request', request => {
    const url = request.url().split('?')[0];
    if (url.startsWith('chrome-extension:') || url.startsWith('data:') || url.startsWith('blob:')) return;
    requests.push({ url, method: request.method() });
    if (url.startsWith('https://translation.googleapis.com/')) report.cloudRequests += 1;
    if (url.includes('translate.googleapis.com') || url.includes('client=gtx')) report.unofficialTranslateRequests += 1;
    if (url.startsWith('https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/')) {
      report.modelRequests.push(url);
    }
  });
}

async function extensionPage(context) {
  const worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'))
    || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  const popupName = ['popup.html', 'entrypoints/popup.html'].find(name => fs.existsSync(path.join(extensionPath, name))) || 'popup.html';
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${popupName}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#translation-mode') || document.querySelector('button.text-button'), null, { timeout: 15000 });
  const skip = page.locator('button.text-button', { hasText: 'Atla' });
  if (await skip.count()) await skip.click();
  await page.waitForSelector('#translation-mode', { timeout: 15000 });
  return { worker, extensionId, page };
}

async function translate(page, text) {
  const started = Date.now();
  const response = await page.evaluate(async value => chrome.runtime.sendMessage({ type: 'TRANSLATE_TEXT', text: value }), text);
  return { ms: Date.now() - started, response };
}

async function status(page) {
  return page.evaluate(async () => chrome.runtime.sendMessage({ type: 'TRANSLATION_STATUS' }));
}

async function heap(worker) {
  return worker.evaluate(() => {
    const memory = performance.memory;
    return memory ? {
      usedJSHeapSize: memory.usedJSHeapSize,
      totalJSHeapSize: memory.totalJSHeapSize,
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
    } : null;
  }).catch(error => ({ error: String(error) }));
}

const context = await chromium.launchPersistentContext(profile, launchOptions());
watch(context);
await context.route('https://translation.googleapis.com/**', route => {
  report.cloudRequests += 1;
  return route.abort();
});
await context.route('https://translate.googleapis.com/**', route => {
  report.unofficialTranslateRequests += 1;
  return route.abort();
});

try {
  const { worker, extensionId, page } = await extensionPage(context);
  report.extensionId = extensionId;
  report.browser = await page.evaluate(() => navigator.userAgent);
  report.webgpu = await page.evaluate(() => Boolean(navigator.gpu));
  report.memory.before = await heap(worker);

  const notes = page.locator('#translation-mode').locator('xpath=ancestor::section[1]');
  report.ui.defaultMode = await page.locator('#translation-mode').inputValue();
  report.ui.options = await page.locator('#translation-mode option').allTextContents();
  report.ui.localCopy = await notes.locator('.inline-note').allTextContents();
  report.ui.keyFieldOnLocal = await page.locator('#translate-api-key').count();

  await page.selectOption('#translation-mode', 'cloud');
  await page.waitForSelector('#translate-api-key', { timeout: 5000 });
  report.ui.cloudCopy = await notes.locator('.inline-note').allTextContents();
  report.ui.keyFieldOnCloud = await page.locator('#translate-api-key').count();
  await page.selectOption('#translation-mode', 'local');
  await page.waitForSelector('#translation-mode');
  await page.waitForFunction(() => !document.querySelector('#translate-api-key'));
  report.ui.keyFieldAfterReturn = await page.locator('#translate-api-key').count();
  report.ui.modeAfterReturn = await page.locator('#translation-mode').inputValue();

  const downloadStarted = Date.now();
  await page.getByRole('button', { name: 'Modeli indir' }).evaluate(node => node.click());
  const deadline = Date.now() + 180000;
  let statusText = '';
  while (Date.now() < deadline) {
    statusText = await page.locator('#translation-mode').locator('xpath=ancestor::section[1]').innerText();
    if (/bu cihazda hazır|doğrulanamadı|çalıştıramadı|indirilemedi/i.test(statusText)) break;
    await page.waitForTimeout(250);
  }
  report.inference.downloadMs = Date.now() - downloadStarted;
  report.inference.statusAfterDownload = statusText;
  if (!/bu cihazda hazır|doğrulanamadı|çalıştıramadı|indirilemedi/i.test(statusText)) {
    throw new Error(`model status did not settle: ${statusText}`);
  }
  report.inference.modelRequestCountAfterDownload = report.modelRequests.length;
  report.memory.afterDownload = await heap(worker);

  const gapPromise = page.evaluate(() => new Promise(resolve => {
    let last = performance.now();
    let maxGap = 0;
    const started = performance.now();
    const tick = now => {
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (now - started > 2500) resolve(Math.round(maxGap));
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  const cold = await translate(page, 'Hello, how are you?');
  report.pageFrameGapMs = await gapPromise;
  report.inference.cold = { ms: cold.ms, response: cold.response };
  const warm = await translate(page, 'The meeting starts at 3.');
  report.inference.warm = { ms: warm.ms, response: warm.response };
  report.memory.afterTranslate = await heap(worker);

  const beforeReuse = report.modelRequests.length;
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'CANCEL_LOCAL_TRANSLATION' }));
  const afterCancel = await translate(page, 'The meeting starts at 3.');
  report.cacheReuse.afterCancel = {
    ms: afterCancel.ms,
    response: afterCancel.response,
    newModelRequests: report.modelRequests.length - beforeReuse,
  };

  await context.close();

  const offline = await chromium.launchPersistentContext(profile, launchOptions());
  watch(offline);
  await offline.route('https://storage.googleapis.com/**', route => route.abort());
  await offline.route('https://translation.googleapis.com/**', route => {
    report.cloudRequests += 1;
    return route.abort();
  });
  await offline.route('https://translate.googleapis.com/**', route => {
    report.unofficialTranslateRequests += 1;
    return route.abort();
  });
  const second = await extensionPage(offline);
  const cachedStatus = await status(second.page);
  const cached = await translate(second.page, 'Hello, how are you?');
  report.cacheReuse.offlineRelaunch = {
    status: cachedStatus,
    ms: cached.ms,
    response: cached.response,
    modelRequests: report.modelRequests.length,
  };
  report.memory.afterRelaunch = await heap(second.worker);

  await second.page.evaluate(async () => {
    const open = indexedDB.open('vesta_local_translation', 1);
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(new ArrayBuffer(16), 'vocab');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  report.corrupt.vocabBytesBeforeClose = await vocabBytes(second.page);
  await offline.close();

  // Playwright route.abort does not see fetches from the offscreen document.
  // The resolver rule blocks that host for every process in this launch.
  const blocked = await chromium.launchPersistentContext(profile, launchOptions([
    '--host-resolver-rules=MAP storage.googleapis.com 127.0.0.1,EXCLUDE localhost',
  ]));
  watch(blocked);
  await blocked.route('https://storage.googleapis.com/**', route => route.abort());
  await blocked.route('https://translation.googleapis.com/**', route => {
    report.cloudRequests += 1;
    return route.abort();
  });
  await blocked.route('https://translate.googleapis.com/**', route => {
    report.unofficialTranslateRequests += 1;
    return route.abort();
  });
  const blockedPage = await extensionPage(blocked);
  report.corrupt.vocabBytesOnRestart = await vocabBytes(blockedPage.page);
  const corruptStarted = report.modelRequests.length;
  const corrupt = await translate(blockedPage.page, 'Hello, how are you?');
  report.corrupt.withNetworkBlocked = {
    ms: corrupt.ms,
    response: corrupt.response,
    newModelRequests: report.modelRequests.length - corruptStarted,
    restarted: true,
    modelHostResolvedToLoopback: true,
  };
  await blocked.close();

  const recovery = await chromium.launchPersistentContext(profile, launchOptions());
  watch(recovery);
  await recovery.route('https://translation.googleapis.com/**', route => {
    report.cloudRequests += 1;
    return route.abort();
  });
  await recovery.route('https://translate.googleapis.com/**', route => {
    report.unofficialTranslateRequests += 1;
    return route.abort();
  });
  const third = await extensionPage(recovery);
  const recoveredStarted = report.modelRequests.length;
  const recovered = await translate(third.page, 'Hello, how are you?');
  report.corrupt.redownload = {
    ms: recovered.ms,
    response: recovered.response,
    newModelRequests: report.modelRequests.length - recoveredStarted,
  };
  await recovery.close();
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  try { await context.close(); } catch { /* already closed */ }
}

const coldText = report.inference.cold?.response?.translatedText || '';
const warmText = report.inference.warm?.response?.translatedText || '';
const recoveredText = report.corrupt.redownload?.response?.translatedText || '';
if (!/merhaba/i.test(coldText)) report.errors.push(`cold translation failed: ${JSON.stringify(report.inference.cold?.response ?? null)}`);
if (!/toplant/i.test(warmText)) report.errors.push(`warm translation failed: ${JSON.stringify(report.inference.warm?.response ?? null)}`);
if (report.corrupt.withNetworkBlocked?.response?.success) {
  report.errors.push('corrupt cache translated while the model host was blocked');
}
if (!/merhaba/i.test(recoveredText)) report.errors.push(`corrupt recovery failed: ${JSON.stringify(report.corrupt.redownload?.response ?? null)}`);
report.finishedAt = new Date().toISOString();
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  reportPath,
  cloudRequests: report.cloudRequests,
  unofficialTranslateRequests: report.unofficialTranslateRequests,
  modelRequests: report.modelRequests.length,
  cold: report.inference.cold?.response?.translatedText ?? null,
  warm: report.inference.warm?.response?.translatedText ?? null,
  offline: report.cacheReuse.offlineRelaunch?.response?.translatedText ?? null,
  corrupt: report.corrupt.withNetworkBlocked?.response ?? null,
  errors: report.errors,
}, null, 2));
if (report.errors.length) process.exit(1);
