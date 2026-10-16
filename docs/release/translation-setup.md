# Translation setup for 0.1.0

The default engine is local. Open the popup, leave **Yerel çeviri — Varsayılan** selected, and press **Modeli indir** or start a dub. The extension shows the 15.1 MB size first, downloads the pinned model once, and then translates on the device. No API key is requested. Details are in `docs/release/local-translation-model.md`.

Google Cloud Translation API v2 is optional. Choose **Google Cloud — Kendi anahtarım** before any key field appears. The extension does not call `translate.googleapis.com`, and it does not fall back to that host, or to Cloud, when local translation fails.

No API key is stored in this repository. This release did not send a live Cloud request. A live request can create a Google Cloud charge after the monthly free credit.

## Why this provider

Checked on 2026-10-16:

- Cloud Translation Basic (v2) accepts API keys. Advanced (v3) does not. Source: [Authenticate to Cloud Translation](https://cloud.google.com/translate/docs/authentication).
- The documented REST call is `POST https://translation.googleapis.com/language/translate/v2` with header `X-Goog-Api-Key`. The `key` query parameter exists and puts the key in the URL. Vesta does not use it. Source: [Use API keys with REST](https://cloud.google.com/docs/authentication/api-keys-use).
- NMT text translation: the first 500,000 characters per month are free as a monthly credit, then $20 per million characters. Source: [Cloud Translation pricing](https://cloud.google.com/translate/pricing). Omitting the source language still charges the submitted characters, not a second detection fee. Vesta omits `source` and sets `target` to `tr` and `format` to `text`.
- Turkish is a supported NMT target. The request is one JSON object, `{ "q": "<caption text>", "target": "tr", "format": "text" }`.
- Errors are HTTP status codes. Vesta treats 401 and 403 as a rejected key, and 429 as the existing rate-limit stop. The body is not spoken and is not logged.

DeepL's official API was not selected. Its auth page says not to use an API key in client-side code or publicly distributed code ([Access and authentication](https://developers.deepl.com/docs/getting-started/auth), reviewed 2026-10-16). An unpacked extension is client-side software. DeepLX and other undocumented free endpoints were not considered.

A Google Cloud API key is still a bearer secret. Anyone who can open the extension's service worker can read the value the user pasted. The package does not contain one. The owner should restrict the key to the Cloud Translation API and set a character quota.

## What the extension does with the key

1. The popup writes the key only to `chrome.storage.session` under `vesta_cloud_translate_key`.
2. The service worker sets session access to `TRUSTED_CONTEXTS` on startup and on install. Content scripts cannot read session storage at that level ([chrome.storage](https://developer.chrome.com/docs/extensions/reference/api/storage)).
3. Only the service worker adds the `X-Goog-Api-Key` header.
4. The popup asks `TRANSLATION_STATUS` and receives `{ configured: true }` or `{ configured: false }`. The key is not in that reply.
5. Closing the browser, or reloading the extension, clears the key. The user pastes it again.

A missing key, a rejected key, or a silent service worker stops dubbing, restores the original video volume, and does not speak the English caption. A track whose language is already Turkish does not need a key.

## Owner steps for the optional Cloud provider

Do these in the Google Cloud console. Do not paste the key into a commit, an issue, or a log.

1. Create or choose a Google Cloud project you control.
2. Enable billing on that project if Google requires it for the API. The free monthly character credit still needs a billing account on many projects. Confirm the current requirement in the console before you continue.
3. Enable **Cloud Translation API** (the Basic v2 API).
4. Create an API key. Restrict the API to Cloud Translation API only. Set a daily or monthly character quota you are willing to pay for past 500,000 characters.
5. Do not restrict the key by HTTP referrer. The request comes from the extension service worker, not from a website origin. Referrer restrictions would make a valid key fail.
6. Build or load the unpacked extension from `npm run package:release` (`.output/chrome-mv3`).
7. Open the Vesta popup on a YouTube watch page. Under **Çeviri anahtarı**, paste the key and choose **Bu oturuma kaydet**. The field is a password field and is cleared after a successful save.
8. Start dubbing on a video with English captions. Confirm Turkish speech. Then stop and confirm the original volume returns.
9. Remove the key with **Anahtarı sil** and start again. The popup must say a key is required. English must not be spoken. Volume must return.
10. If you rotate or delete the key in Google Cloud, remove it from the popup as well.

Until step 7 is done, English-caption dubbing on the Cloud setting is supposed to stop with the setup message. That is not a broken build. The default Local setting does not use this key. Switching back to Local does not send the caption to Google.

## What not to do

- Do not commit the key, put it in `wxt.config.ts`, or add it to a host URL.
- Do not call the API from a script in this repository just to see if the key works, unless you accept the possible charge.
- Do not reintroduce `translate.googleapis.com` or `client=gtx` as a fallback.
- Do not set session storage access to `TRUSTED_AND_UNTRUSTED_CONTEXTS`.
