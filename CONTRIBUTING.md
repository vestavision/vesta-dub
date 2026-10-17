# Contributing

Vesta Dub is a browser extension that dubs supported YouTube videos into Turkish from available captions and local speech models. Version 0.1 is a frozen product, not a research branch.

## Scope

Changes should make the existing product more reliable, safer, clearer, or easier to build. Do not add:

- speaker diarization or a second automatic voice
- context-aware translation experiments
- experimental sentence reconstruction
- local speech recognition
- new model families, training jobs, or translation providers
- new websites or monetization
- telemetry or analytics

Piper Fahrettin stays unavailable for public redistribution until its rights are resolved. Do not document it as CC0.

## Setup

Node.js 22 or newer.

```bash
npm ci
npm test
npm run compile
npm run build
```

Load `.output/chrome-mv3` as an unpacked extension. `npm run package:release` builds that directory and writes `release/vesta-dub-0.1.1-rc.zip` plus a byte-identical `release/vesta-dub-0.1.1.zip`. End users prepare that public zip with `install.sh`. They do not need Node.js. The script does not load the extension into the browser.

## Tests

`npm test` is the required check. Browser tests that open YouTube are optional and are not a substitute for listening to a real video in a normal browser profile. Do not commit `tests/artifacts/`.

## Pull requests

Explain the user-visible behavior, the risk, and how you tested it. Keep the diff small. Do not commit secrets, browser profiles, caption dumps, or model weights downloaded from a new source.

## Reports

Security reports go through `SECURITY.md`, not a public issue with exploit detail.
