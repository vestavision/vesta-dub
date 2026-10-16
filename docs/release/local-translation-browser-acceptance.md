# Local translation browser acceptance

This file records extension-runtime inference. It does not record YouTube playback.

Date: 2026-10-16. Browser: Brave, user agent `Chrome/155.0.0.0`. Profile: a temporary directory created by `scripts/p9.2-browser-inference.mjs` and deleted at the start of the run. The normal Brave profile was not opened. No YouTube watch page was loaded. No Cloud Translation request was sent.

## What passed

| Check | Result |
| --- | --- |
| Fresh popup mode | `local` |
| Options | `Yerel çeviri — Varsayılan`, `Google Cloud — Kendi anahtarım` |
| Local description | `Ücretsiz. Çeviri cihazında yapılır. API anahtarı gerekmez.` |
| Size shown before download | `İlk kullanımda 15,1 MB indirilir. İndirme bir kez yapılır. Sonraki çeviri bu cihazda çalışır ve altyazı metnini dışarı göndermez.` |
| API key field on Local | 0 |
| API key field on Cloud, then back on Local | 1, then 0 |
| Cloud description | `İsteğe bağlı. Google Cloud API anahtarınızı kullanır ve ücretlendirme uygulanabilir.` |
| External-transmission warning | `Altyazı metni Google Cloud Translation servisine gönderilir. Anahtar yalnızca bu tarayıcı oturumunda tutulur ve sayfaya yazılmaz.` |
| Download | Button **Modeli indir** reached `Model bu cihazda hazır. Çeviri yerelde yapılır.` in 4,616 ms. Status bytes 15,101,045. `persisted: true`. |
| Cold translation | 209 ms, `Merhaba, nasılsın?`, mode `local` |
| Warm translation | 26 ms, `Toplantı 3'te başlıyor.`, mode `local` |
| Cancel, then the same line | 175 ms, same Turkish line |
| New process, Playwright aborting `storage.googleapis.com` | 199 ms, `Merhaba, nasılsın?` |
| Popup frame gap during cold translation | 19 ms maximum `requestAnimationFrame` gap |
| Corrupt vocab after a new process, model host forced to 127.0.0.1 | 30 ms, `success: false`, `code: local_unavailable`, `reason: download`. Vocab byte length was 16 before close and 16 on restart. |
| Recovery with the host reachable again | 3,456 ms, `Merhaba, nasılsın?` |
| Cloud and unofficial translate requests | 0 and 0 |

The popup thread was not blocked for a long frame during that cold call. The YouTube page thread was not instrumented, because YouTube was not open. Inference runs in the offscreen document's worker, not in the content script.

## What the request log does not prove

Playwright saw zero Mozilla model URLs. The same listener also failed to block the offscreen download: an earlier run corrupted the vocab, relaunched with `route.abort` on `storage.googleapis.com`, and still received Turkish in about 3.9 seconds. That was a redownload the route did not see.

The recorded fail-closed result uses Chromium `--host-resolver-rules=MAP storage.googleapis.com 127.0.0.1`. Under that rule the corrupt cache did not translate, and no caption was sent to Cloud Translation. The following launch, with normal name resolution, downloaded again and translated.

A live session that already holds verified bytes does not re-read IndexedDB on every cue. Replacing the stored vocab while that process is alive leaves the current translation on the verified copy. The next process checks the bytes.

## Not this test

- Manual activation on a real watch page
- Turkish speech through Antalia or EMA
- Pause, resume, seek, SPA navigation, a second tab, or volume restoration on YouTube
- Five minutes of background playback
- The normal Brave profile

Those steps are in `docs/release/browser-acceptance.md`. They were not run. A screenshot or this extension-page translation is not that listening pass.
