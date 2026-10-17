# Known limitations for 0.1.1

These are product limits. They are not a reason to hide a broken stop button, a stuck volume level, or a retry loop. The 0.1.0 notes stay in the files named `v0.1.0`.

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
- Hidden-tab playback can restart the YouTube playhead. On 2026-10-17, one isolated Brave 155 run of the caption-activation path hid `https://www.youtube.com/watch?v=zjkBMFhNj_g` after the video had reached about 43 seconds. The playhead then restarted near 0. The same media element kept playing while the tab stayed hidden, and Turkish speech continued on that restarted timeline, then thinned after a few minutes. Five continuous minutes of hidden dubbing without a position reset did not pass. That run was not repeated on the 0.1.1 package. The normal Brave profile was not part of that run. The extension does not call `video.play()` to hold a hidden tab open. Foreground dubbing is the supported path.
- A fresh watch page can fail to receive a usable caption body. Two isolated 0.1.1 loads stayed on the preloaded-caption error and did not speak. A third load of the same video did speak. Stop still returns the session to idle.
- Caption activation can move the YouTube volume slider to 1 before dubbing lowers it. Stop restores the ducked level to that reset value, so the video is not left quiet. A lower slider position from before the reset may not come back.
- Service-worker suspension can delay one translation. It does not restart a stopped session.
- Piper Fahrettin is not in this product and is not in this repository. Do not add the weight.

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
