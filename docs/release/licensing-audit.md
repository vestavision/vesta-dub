# Licensing audit for 0.1.0

This is an engineering record, not a legal opinion. The owner has to confirm they have the right to publish the repository and the bundled weights.

## Source code

Recommended license: Apache-2.0. `LICENSE` is the Apache License 2.0 text. `NOTICE` names the copyright line from local Git history: Sami Salih Ibrahimbas, 2026. There is no remote, so this history has not been published from this clone. Confirm the legal owner before the first public push. Do not assume a company assignment that is not in the repository.

Research notes under `docs/` and tools under `tools/` and `scripts/` are part of the same tree. Publishing the branch publishes them too.

## Antalia-2 Mini

Bundled files:

- `public/models/antalia/text.fp16.onnx`
- `public/models/antalia/cond.fp16.onnx`
- `public/models/antalia/flow.fp16.onnx`
- `public/models/antalia/vocoder.fp16.onnx`
- `public/models/antalia/frontend-data.json.gz`

Upstream model card: [cloud0day3/antalia-mini](https://huggingface.co/cloud0day3/antalia-mini). The card states that the code, text normaliser, and weights are Apache-2.0, and that the voice is synthetic, with no recordings of real speakers in training. A short `NOTICE` now sits next to the weights.

Antalia-1 is a different model and uses OpenRAIL-M. This extension does not bundle Antalia-1. Do not mix the two licenses.

Status: consistent with Apache-2.0 based on the upstream card. Keep the upstream LICENSE file with any public weight distribution. The owner should archive the card revision they shipped.

## EMA Lightning

Bundled under `public/models/ema-lightning/` with `LICENSE` (Apache-2.0), `NOTICE`, and `provenance.json`. The notice credits fr0stb1rd and records the source revision `174f29442e67d73ab15ab9e34412b64affd579cb` and the model revision `bc08ba02f1a0de2e3b8266a8f21700a1fc298ea5`.

Status: Apache-2.0 attribution is present. EMA remains an experimental voice. That is a product limit, not a license conflict.

## Bergamot and Firefox Translations

The default translator has two MPL-2.0 pieces.

- `@browsermt/bergamot-translator@0.4.9` supplies the worker JavaScript and WASM. `scripts/sync-bergamot.mjs` copies them into `public/bergamot/` and writes `NOTICE`. The worker is not modified. The published WASM version string is `v0.4.5+4917c11`. The npm tarball does not include a LICENSE file. Attribution is the generated NOTICE and the upstream repository `https://github.com/browsermt/bergamot-translator`.
- The English-to-Turkish weights are the Firefox Translations registry entry `en-tr`, architecture `tiny`, file prefix `spring-2024_LiFGeNrEQpKdNlziG2qP_A`, from `mozilla/firefox-translations-models`. The model repository license is MPL-2.0. The weights are not in the extension zip. They are downloaded from the pinned Mozilla host after SHA-256 checks. Pins are in `src/translation/LocalTranslationModel.ts`.

Extension code that calls the worker is a larger work under Apache-2.0. MPL obligations attach to the worker files and to the model weights, not to the whole extension.

Status: acceptable to ship with the NOTICE that is already in `public/bergamot/` and with the third-party table. The owner should keep the upstream LICENSE text with any public copy of the weights.

## Piper Fahrettin

The working tree no longer contains `public/models/piper/`. The production registry, popup, and release package do not include the voice. `src/tts/PiperProvider.ts` was removed. `PiperEngine.ts` and `TurkishPhonemizer.ts` remain so older research scripts still typecheck. Those scripts cannot run without the weight file, and they are not in the extension package.

Git history still contains the weight. It was introduced in commit `c155268a7da738809473fbb412b1245b7c4917ab` (2026-10-13, "chore: preserve supplied P5 workspace before P5.1 recovery") and is still reachable from `HEAD` `52ec0c518aaef7583695d6308d27662aea79c0dd` and from branches `main`, `p5.2-reliability-validation`, and `p5.5-extension-pause`.

| Item | Value |
| --- | --- |
| Path | `public/models/piper/tr_TR-fahrettin-medium.onnx` |
| Blob | `034599b1241214da842ec5f02a7265bb242efcac` |
| Size | 63,201,294 bytes |
| Config blob | `b495964d27195aae03726391b35a6ab1a513859f` (5,022 bytes) |

Checked against the upstream dataset on 2026-10-16:

- [rhasspy/piper-voices at v1.0.0](https://huggingface.co/rhasspy/piper-voices/tree/v1.0.0/tr/tr_TR/fahrettin/medium) still lists the file. The repository card on that tree shows `license: mit`. A repository badge is not a per-voice recording license.
- [rhasspy/piper-voices at main](https://huggingface.co/rhasspy/piper-voices/tree/main/tr/tr_TR) shows commit message "Remove fahrettin and fettah voices at request of contributors."

Older docs in this repository that say CC0, MIT, or CC-BY 4.0 disagree with each other. Those claims are withdrawn. They are historical research notes, not a license to publish the weight.

Status: **not cleared for redistribution.** The file is gone from the working tree. Publishing `git push` of this history would publish the blob. History was not rewritten.

## ONNX Runtime Web

`onnxruntime-web` 1.21 is MIT, copyright Microsoft. The package contains many wasm builds. The release zip keeps the copies at the extension root, which is what `src/tts/ortConfig.ts` configures, and drops the duplicate `wasm/` directory. MIT requires the copyright and permission notice to remain available. `THIRD_PARTY_LICENSES.md` records that. A full copy of the MIT text is in the installed package's own license file and should be retained if the wasm files are republished alone.

## Other dependencies

Preact, WXT, Tailwind, TypeScript, and Vitest are permissive (MIT or Apache-2.0). They are not model weights. Playwright and onnxruntime-node are development tools and are not part of the extension zip.

No third-party font is bundled. Icons in `public/icons/` are project assets. Their designer should confirm they are original before publication.

## History and local files

No secret pattern was found in the current source scan. Large blobs already in Git include the Piper weight, ONNX Runtime builds, Antalia weights, EMA weights, and files under `tests/artifacts/` and `tools/`. `tests/artifacts/` is now gitignored for new files. Files already committed remain in history. This preparation did not rewrite history.

Before a public push, the owner should decide whether historical research audio and caption-derived review files may be published. If not, publication needs a new repository or an explicit history rewrite. A rewrite was not performed.
