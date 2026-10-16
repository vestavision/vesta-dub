# Privacy and permissions

Vesta Dub is an independent extension. It is not operated by YouTube or Google.

## What stays on the device

- The YouTube video and its audio. The extension changes the video element's volume while dubbing and restores the previous level on stop, failure, or teardown. It does not record the tab.
- Synthesized speech. Antalia-2 Mini and EMA Lightning run with ONNX Runtime Web inside the browser. Piper Fahrettin is not shipped.
- Voice weights after they are read from the extension package. They are cached in IndexedDB so the next start does not parse the package again. A missing voice file is not downloaded.
- The English-to-Turkish translation model, after its one-time download. Verified bytes live in a separate IndexedDB database, `vesta_local_translation`. Inference runs in an offscreen worker on this device.
- The activation preference and per-video voice slots, in `chrome.storage.local`.
- The Cloud Translation API key, only in `chrome.storage.session`, and only for the current browser session. Session storage is restricted to trusted extension contexts. Content scripts cannot read it. The key is cleared when the browser closes or the extension reloads. It is not in the package, the URL, the page, or the logs.
- Optional diagnostic traces, only after the diagnostics toggle is used. Export is a local file. Nothing is uploaded.

The extension does not request microphone access. It does not send microphone audio or tab audio to a server. There is no analytics SDK and no account.

## What leaves the device

On the default local engine, caption text does not leave the device for translation.

The first local translation downloads three static model files, 15,101,045 bytes compressed, from:

`https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/`

Those requests are GET requests for pinned files. They do not include caption text, a YouTube account, or a Vesta account. `credentials` is `omit`. The gzip hash and the uncompressed hash must both match before the bytes are kept. Later translations read the local cache and do not repeat the download. This is not a claim of zero network use: the download uses the network, and YouTube captions use the network.

Caption text is sent off the device only when the user selects Google Cloud and saves a key. The call is the documented Cloud Translation API v2 method:

`POST https://translation.googleapis.com/language/translate/v2`

The JSON body is `{ "q": "<caption text>", "target": "tr", "format": "text" }`. The API key is the `X-Goog-Api-Key` header. The URL has no key and no query string. The body does not include the YouTube account, a Vesta account, or the audio. The service worker does not log the text or the key. Cookies are not sent (`credentials: "omit"`).

Google then receives the caption text and bills the Google Cloud project that owns the key. The first 500,000 NMT characters per month are covered by Google's monthly credit, then the published NMT price applies. See `docs/release/translation-setup.md`. The popup states that caption text is transmitted before the user relies on this mode.

A local failure does not make that POST. If Cloud is selected and the key is missing, the key is rejected, the service worker does not answer, or the API returns HTTP 429, the English line is not spoken. The dub stops and the original volume is restored. There is no fallback to an unofficial translate URL, and there is no fallback from Cloud to Local or from Local to Cloud.

YouTube caption requests use the page's own signed timedtext URLs and the page credentials. Those requests go to YouTube because the player is loading captions. Vesta stores the response body in the page only long enough to parse cues.

## What is not collected

- Browsing history beyond the watch page the user started
- Search queries
- Cookies, other than what the browser already attaches to YouTube caption requests
- Keystrokes
- A user identifier created for analytics

The popup reads the active tab so it can talk to the content script on that YouTube page. It does not keep a history log.

## Permissions the user sees

| Permission | User-facing reason |
| --- | --- |
| Storage | Remember manual, tab, or always-on activation, the voice chosen for a video, and the translation mode |
| Tabs | Find the YouTube tab the popup should start or stop |
| Offscreen | Run the local translation worker. The service worker cannot start it. |
| youtube.com | Read captions on a watch page and play the dub there |
| translation.googleapis.com | Send caption text only after the user selects Google Cloud and saves a key |
| Mozilla translations host | Download the pinned English-to-Turkish model once. The request is the model file, not the caption. |

## User controls

- Default activation is manual. Nothing starts until the user presses start.
- Stop cancels synthesis, drops the current dub audio, and restores volume.
- Changing voice releases providers that are no longer selected.
- Purging models clears the IndexedDB cache. The packaged weights remain in the extension until it is removed.
- Diagnostics and dogfood recording are off until the user opens that toggle.

## Store disclosure draft

Use this wording only if the owner later submits a listing. It describes the current build.

Vesta Dub reads captions on YouTube watch pages you start and synthesizes Turkish speech locally. The default translation also runs on your device after a one-time download of the translation model. Caption text is sent to Google Cloud Translation only if you choose that option and provide your own API key. It does not sell data and it does not use the data for advertising. Caption text is used only to produce the dub you requested. A Cloud key stays in the extension for the browser session.
