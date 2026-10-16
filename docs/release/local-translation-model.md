# Local English-to-Turkish model

Decision date: 2026-10-16. The default translator is this model. Google Cloud Translation stays optional and is never selected automatically.

## Identity

| Item | Value |
| --- | --- |
| Product id | `mozilla-firefox-translations-en-tr-tiny-spring-2024` |
| Upstream | Mozilla Firefox Translations, registry key `en-tr` |
| Registry | `https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json` |
| Registry `generated` | `2026-10-15T00:51:24Z` |
| Architecture | `tiny` |
| Release status | `Release` |
| Direction | English → Turkish (`sourceLanguage: en`, `targetLanguage: tr`) |
| Parameters | 16,907,062 (encoder 6,314,532, decoder 2,400,528) |
| Precision | `int8shiftAlphaAll` (`model.entr.intgemm.alphas`) |
| Runtime | Bergamot WASM from `@browsermt/bergamot-translator@0.4.9` |
| WASM version string | `v0.4.5+4917c11` |
| Worker files | `public/bergamot/`. The extension does not modify them. |

`en-tr` and `tr-en` are different registry entries. This build loads only `en-tr`.

Mozilla publishes flores200-plus numbers on that registry entry. This project did not recompute them: BLEU 30.2077, chrF 62.2023, chrF++ 58.6562, COMET-22 0.875, spBLEU 41.2647. Those are Mozilla's scores, not a Vesta quality claim.

## Pinned files

Download size is the gzip total, 15,101,045 bytes. The popup shows that as 15,1 MB before the download starts. Only these three static files are fetched. The worker JavaScript and the WASM binary are inside the extension package.

| Name | Gzip bytes | Gzip SHA-256 | Raw bytes | Raw SHA-256 |
| --- | --- | --- | --- | --- |
| `model.entr.intgemm.alphas.bin.gz` | 13,159,314 | `52d10136b1a4804879989aa9ee146e83ced75aa0ce2d371b4e582473ed6b9020` | 17,141,051 | `ea3cd4ee09de190df265c78d84260e277a9a8a3ddff05eb55d72afe7fc0fdbf4` |
| `lex.50.50.entr.s2t.bin.gz` | 1,546,258 | `cf74d4edec0b51affd30a43e6bd2c2274bf4ce7fd54c24fd293db2c5c4bf043d` | 3,261,300 | `3aba0be842bd4c192659c781e6fdce8eb9b2b1fff29a40d22f75da369d59f46f` |
| `vocab.entr.spm.gz` | 395,473 | `01e55973e65a34c5efbdce3968857d4e53998b4bef131c5125a19f8e44d8f87c` | 798,793 | `a220363d60391f7ce3df8ec9785424dbc00c24d5786d1a4308cf8ca3ed3385c2` |

Directory: `models/en-tr/spring-2024_LiFGeNrEQpKdNlziG2qP_A/exported/`.

The registry `uncompressedSize` and `uncompressedHash` for the model file match the raw pin above. Each download checks the gzip size, the gzip SHA-256, the raw size, and the raw SHA-256. URLs with a query string are rejected. `credentials` is `omit` and `cache` is `no-store`. A hash or size mismatch deletes the local cache and does not use those bytes.

## License

The model repository `mozilla/firefox-translations-models` publishes these weights under MPL-2.0. The Bergamot worker package is also MPL-2.0. `public/bergamot/NOTICE` names package 0.4.9, the license, the upstream GitHub repository, and the WASM version string. The npm package itself does not ship a LICENSE file. Attribution is that NOTICE plus `THIRD_PARTY_LICENSES.md`.

The worker is shipped unmodified. Extension code that calls it is a larger work and stays Apache-2.0. The 15.1 MB weights are not copied into the extension zip.

## Distribution

1. The user installs the extension. That package contains the Bergamot worker and the voice models. It does not contain the translation weights.
2. On **Modeli indir**, or on the first local translation after Start, the extension downloads the three pinned files from the Mozilla host.
3. Verified bytes are stored in IndexedDB `vesta_local_translation`, store `files`, on the extension origin. That database is separate from the TTS cache. Clearing TTS models does not delete it.
4. Later translation reads that cache. A stored model is marked ready without opening the WASM heap. The worker starts on the first actual translation and closes after 60 seconds idle. The verified bytes stay cached.
5. A failed disk write still translates from the verified memory copy and reports a storage error. It does not send the caption to Cloud Translation.

This is not zero-network translation. The model download uses the network once. YouTube captions also use the network. After the three files are cached, translation itself does not send caption text off the device.

No remote JavaScript is loaded. The service worker cannot construct `Worker`, which Brave 155 confirmed (`Worker is not defined`). The engine therefore runs in an offscreen document created with reason `WORKERS`. That document is not web-accessible and it is not a playback keepalive.

The shipped worker forces `workspace: 128` (128 MB) after the caller's config. This build does not edit the worker to lower it.

## Candidates that were not selected

- Chrome's built-in Translator can download a Turkish pack on desktop Chrome. It is not the default. Brave does not ship that pack reliably, the pack is not a pinned hashed file, and extension availability is not a release contract. It is not a silent extra path.
- `Xenova/opus-mt-en-tr` does not exist. `Xenova/opus-mt-tr-en` is Turkish to English and was rejected. `Helsinki-NLP/opus-mt-en-tr` was not found. The public ONNX export of the larger English-to-Turkish OPUS-MT model is about 2.3 GB in fp32 and about 1.0 GB in int8. That is too large for the default browser engine. Transformers.js was not added. A second model family was not downloaded.
- DeepL's auth terms forbid placing an API key in client-side or publicly distributed code. It is not an optional provider.
- The unofficial `translate.googleapis.com` client is not used and is not a fallback.

## Runtime contract

- One translation at a time. Cancel terminates the worker and rejects queued work. An in-flight WASM call stops only when the worker is terminated.
- Empty output is not spoken.
- Local failure stays local. The caption is not sent to Google Cloud unless the user has selected **Google Cloud — Kendi anahtarım** and saved a key.
- WebGPU is not required. `useNativeIntGemm` is false. CPU/WASM is the path that ran.
