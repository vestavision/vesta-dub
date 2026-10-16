# Security audit for 0.1.0

Date of review: 2026-10-16. Scope: the production extension path (`entrypoints/`, `src/` modules imported by those entry points, `wxt.config.ts`, and `public/` assets that the package script keeps). Research scripts were inspected only to keep them out of the package.

No critical vulnerability was found in the dubbing path. Publication is still blocked for the licensing and translation reasons in the readiness note. This audit did not include a professional penetration test.

## Permissions

| Permission | Why it is present | Assessment |
| --- | --- | --- |
| `storage` | Activation preference, per-video voice slots, IndexedDB is separate but storage holds small preferences | Needed |
| `tabs` | Popup looks up the active tab and sends messages to that tab | Needed for the popup. It can see tab URLs. The popup only messages a YouTube watch tab. |
| `https://www.youtube.com/*` | Content script and caption requests | Matches the single supported site |
| `offscreen` | Local translation worker. Reason `WORKERS`. The service worker cannot construct `Worker`. | Needed for the default engine. The document is not in `web_accessible_resources`. It does not capture the tab. |
| `https://translation.googleapis.com/*` | Cloud Translation v2 from the service worker | Used only when the stored mode is exactly `cloud` and a key exists. The unofficial host was removed. |
| `https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/*` | Pinned static model files | The permission is this prefix, not all of `storage.googleapis.com`. Requests reject a query string. |

Not requested: microphone, tabCapture, desktopCapture, cookies, webRequest, debugger, history, identity, or native messaging.

`web_accessible_resources` exposes models, ONNX wasm and mjs files, and icons to YouTube origins. A page on YouTube can fetch those static files. It cannot fetch the P6 worklet, because that file is no longer in the extension. Caption text is not in those files.

## Network

Production network calls:

- YouTube timedtext and player caption URLs, with page credentials, from the content script. These are the same caption responses the page already loads.
- `translation.googleapis.com` for caption text, only on the explicit Cloud path. The service worker POSTs JSON. The API key is an `X-Goog-Api-Key` header, never a query parameter. The request has a 5 second timeout and `credentials: "omit"`. There is no page-world fetch and no fallback if the worker does not answer. Local failure does not use this host.
- The pinned Mozilla model host, for three static files. The worker JavaScript and WASM are packaged. The download path does not `eval` a response and does not load a remote script. Gzip and raw SHA-256 are both required. A mismatch clears the cache.
- Voice providers still have no weight-download URL. If a bundled voice file is missing, loading throws.

The service worker accepts `TRANSLATE_TEXT` and `TRANSLATION_STATUS` only when `sender.id` is this extension. Translation text must be a string of at most 4,000 characters. The worker does not log the text or the key. `TRANSLATION_STATUS` returns the mode, whether a Cloud key is present (`configured`), and the local model status. It does not return the key or the caption. On startup and on install the worker sets `chrome.storage.session` access to `TRUSTED_CONTEXTS`. It does not grant `TRUSTED_AND_UNTRUSTED_CONTEXTS`. Chrome documents that session storage is hidden from content scripts unless that wider level is set ([storage API](https://developer.chrome.com/docs/extensions/reference/api/storage), reviewed 2026-10-16).

Messages whose type starts with `OFFSCREEN_` are not handled as page commands, except `OFFSCREEN_STATUS_PUSH`. That message carries the model progress object and no caption text. The service worker writes it to `chrome.storage.local`. The offscreen document does not write that key itself: a direct write from the offscreen document did not reach the popup in Brave 155.

## Page boundary

`bridge.content.ts` runs in the MAIN world at `document_start` and observes timedtext responses the player already requested. It does not forge tokens. It dispatches `vesta-caption-payload` with the response body.

The isolated content script accepts that event only while dubbing is on, no track is selected yet, the video id matches, and the body is a string of at most 1.5 million characters. A script on the YouTube page can dispatch a similar event. The practical result is spoken text, not HTML injection and not remote code. The popup uses Preact text binding for cue text. Production code does not assign caption text to `innerHTML`.

Pause-isolation flags default to the production hooks. The diagnostic probe stays off unless the user enables it. Missing storage keeps production features on.

## Storage and traces

Preferences and voice slots are in `chrome.storage.local`. Model bytes are in IndexedDB on the extension origin. Dogfood telemetry is off until the diagnostics tab opts in, and the export path is a local download. Console logging of committed caption text was removed. The in-memory scheduler trace can still hold spoken text for the local diagnostic export. That export is labeled as containing subtitle text.

## Secrets

A search of the current source, excluding `node_modules`, `tests/artifacts`, and package lockfiles, did not find private keys, API tokens, or `.env` files. Git history was not rewritten. The author email on commits is `contact@salih.guru`. Treat that as a public identity already stored in Git, not as a newly exposed secret. No credential rotation was performed.

`tests/artifacts/` is about 3.6 GB locally and is now gitignored. It was not deleted. It must not be added back for a public push. Some of it is generated audio and caption-derived review material.

## Supply chain

ONNX Runtime and the Bergamot worker are bundled. The extension does not load remote JavaScript. The translation weights are static files from a pinned host. A response is kept only after the gzip and raw hashes match, and it is never evaluated as script. `ModelStorage` used to fall back from a missing voice bundle to Hugging Face. That fallback is now limited to Node processes that have no `chrome.runtime`. The extension build throws instead.

## Residual risk

- Local translation failure does not call Cloud Translation. Cloud Translation, when the user has selected it, can rate-limit or reject a key. The session stops. A missing worker answer is a failure, not a second fetch. A 429 from the worker is final for that attempt aside from one short inline retry already in the translator.
- MAIN-world caption observation trusts response bodies that the page can also see.
- Piper Fahrettin is not in the package. The Git blob described in the licensing audit is still a publication blocker.
- A user-supplied API key can be read from the extension service worker by someone who already controls that browser profile. It is not in the repository. Restrict the key to the Cloud Translation API and set a quota.
