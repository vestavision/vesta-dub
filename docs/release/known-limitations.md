# Known limitations for 0.1.0

These are product limits. They are not a reason to hide a broken stop button, a stuck volume level, or a retry loop.

## Not in this version

- One synthetic voice for every speaker. The extension does not identify speakers.
- No conversation memory in the translator. Names and phrasing can come out awkward.
- No local speech recognition. A video without a usable caption track is not dubbed.
- Local translation needs one 15.1 MB download before the first English caption can be dubbed. After that cache is stored, caption text stays on the device. YouTube still needs the network. The extension is not fully offline.
- EMA Lightning is experimental. It is not the default, and its real-video acceptance gate is not closed.
- YouTube watch pages only. Shorts, embeds, live premiere edge cases, and other sites are out of scope.
- The local model is uneven on fragments, names in the middle of a rolling cue, and some word senses. `bus` was translated as the vehicle. That is recorded in `docs/release/local-translation-benchmark.md`. It is not a silent fallback to Cloud.
- Cloud Translation, only after the user selects it, can return HTTP 429, reject a key, or charge that user's Google Cloud project after the free monthly credit. Dubbing then stops instead of reading English. A local failure does not make this request.
- The translation key lasts for one browser session. The user enters it again after a restart.
- Background playback depends on the browser continuing the YouTube media element. Earlier notes recorded that the normal Brave profile can pause a hidden video. The extension does not force `video.play()`.
- Service-worker suspension can delay one translation. It does not restart a stopped session.
- Piper Fahrettin is removed from the product. The local Git history still contains the weight, so this clone must not be pushed as-is.

## Cosmetic or secondary

- The popup is Turkish. The repository docs for this release are English.
- Diagnostics are dense. They are behind a toggle.
- The extension package is large because it contains Antalia, EMA Lightning, ONNX Runtime wasm, and the Bergamot worker. The translation weights are a separate 15.1 MB download.

## Not cosmetic

Do not file these as polish:

- Dub audio that continues after Stop
- Original volume that stays ducked after a terminal failure
- English speech substituted for a failed translation
- A retry loop against HTTP 429
- A package that fetches executable code from the network
