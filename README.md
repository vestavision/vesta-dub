# Vesta Dub

Vesta Dub is an independent open-source browser extension by Vesta Vision. On a YouTube watch page that already has captions, it speaks a Turkish dub. Translation and voices run on your computer. It is not made by YouTube or Google, and it is not a live human dub.

Version 0.1.0 is a public beta of that product. The source in the clean repository is prepared for `https://github.com/vestavision/vesta-dub`. The release assets were not published by the session that prepared them, so the download URL below does not work until the owner publishes the `v0.1.0` release. A local test of the installer does not prove that URL is live.

## Install

Installing has four separate steps. Completing an earlier step does not complete a later one.

1. **Download.** Fetch the versioned installer, or fetch the zip yourself.
2. **Prepare.** The installer checks the zip and extracts it into a folder you own.
3. **Load.** You turn on Developer Mode and choose Load unpacked. A shell script cannot do this for you.
4. **Enable.** The extension is on only after the browser shows it as enabled. Turning it on is your action in the extensions page.

Chrome Web Store is the preferred install once a listing is approved. There is no store listing yet, and this project does not claim approval. An unpacked folder does not update itself the way a store listing does.

You do not need Node.js, npm, or an API key. You do need `curl` and `python3`. The script does not use sudo and does not change browser security settings.

The command below downloads `install.sh` from the `v0.1.0` release asset, not from `main`. The SHA-256 in the command is the pin. Check it against the `v0.1.0` tag before you trust it. The script then checks the zip against a second pin that is inside the script.

```bash
dir=$(mktemp -d) && cd "$dir" && curl -fsSL -o install.sh "https://github.com/vestavision/vesta-dub/releases/download/v0.1.0/install.sh" && expected=20eb20a8ce38847cf3ad7a209663577aa9c1558d8c9038aee7e3b8b14e2f5485 && actual=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum install.sh; else shasum -a 256 install.sh; fi | awk '{print $1}') && if [ "$actual" != "$expected" ]; then printf 'error: install.sh checksum mismatch\n' >&2; exit 1; fi && sh install.sh
```

Read the script before you run it:

```bash
dir=$(mktemp -d) && cd "$dir" && curl -fsSL -o install.sh "https://github.com/vestavision/vesta-dub/releases/download/v0.1.0/install.sh" && expected=20eb20a8ce38847cf3ad7a209663577aa9c1558d8c9038aee7e3b8b14e2f5485 && actual=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum install.sh; else shasum -a 256 install.sh; fi | awk '{print $1}') && if [ "$actual" != "$expected" ]; then printf 'error: install.sh checksum mismatch\n' >&2; exit 1; fi && ${EDITOR:-less} install.sh
```

Run `sh install.sh` only after that review. `status: prepared` means the folder is verified. It does not mean the browser loaded the extension. The script prints the folder and the extensions page. Turn on Developer Mode, choose Load unpacked, and select that folder. The folder contains `manifest.json`.

Useful flags: `--help`, `--version`, `--dry-run`, `--browser brave`, `--browser chrome`.

### Manual install

1. Download `vesta-dub-0.1.0.zip` and `vesta-dub-0.1.0.sha256` from the `v0.1.0` release.
2. Check the zip. The SHA-256 is `eb9b06430c475ee5dc8d9ec77b0135b56d155341c4157ac54dee6993139f237a`.
   `sha256sum -c vesta-dub-0.1.0.sha256` or `shasum -a 256 -c vesta-dub-0.1.0.sha256` from the directory that contains the zip.
3. Unzip it. The extracted folder must contain `manifest.json` at its top level.
4. Open `brave://extensions` or `chrome://extensions`.
5. Turn on Developer Mode.
6. Choose Load unpacked.
7. Select the extracted folder.

On macOS the installer uses `~/Library/Application Support/Vesta Dub/extensions/0.1.0`. On Linux it uses `${XDG_DATA_HOME:-~/.local/share}/vesta-dub/extensions/0.1.0`.

Details, including what the script refuses to do, are in `docs/release/installer-design.md` and `docs/release/installer-security.md`.

## How to use

Open a normal `https://www.youtube.com/watch?v=...` page that has captions. Open the Vesta Dub popup and press start. Press stop before you leave the video. Dubbing also stops when the watch page changes, or when translation or speech fails.

The default is manual. Two optional preferences can start later videos after you have started once: continue in that tab, or start on supported watch pages. Changing a preference does not start the video that is already open.

The default translation line in the popup is **Yerel çeviri — Varsayılan**. That path needs no API key. **Google Cloud — Kendi anahtarım** is optional and can cost money on the Google Cloud project.

## Features

- Native YouTube captions
- Free local English-to-Turkish translation
- Mozilla Bergamot running as WebAssembly in an offscreen document
- A translation model cached on the computer after the first download (about 15.1 MB)
- Antalia-2 Mini speech, and experimental EMA Lightning
- Filler-aware text preparation
- Dubbing that follows the video, including pause, resume, and seek
- Background playback when the browser itself keeps the video playing
- Manual activation by default, with optional automatic modes
- Optional Google Cloud Translation with your own key

## Limitations

- One synthetic voice for every speaker. The extension does not identify speakers.
- No local speech recognition. A video without usable captions cannot be dubbed.
- YouTube still needs the network. Local translation needs one model download, then keeps caption text on the device.
- EMA Lightning is experimental.
- Turkish phrasing can be awkward. Translation does not remember the wider conversation.
- Shorts, embeds, the feed, and other websites are not supported.
- If you select Cloud Translation, Google can reject the key, return HTTP 429, or bill the project after the free monthly credit.
- An unpacked install does not auto-update.
- The normal-browser YouTube listening pass for this build has not been completed. Unit tests do not replace that listen.

## Privacy

Speech is synthesized locally. The extension does not ask for the microphone and does not upload tab audio.

On the default local engine, caption text is not sent out for translation. The one-time model download fetches static files only. Caption text leaves the machine only if you select Google Cloud and save a key. The key stays in `chrome.storage.session` for that browser session. Preferences and cached model bytes stay in extension storage. There is no analytics service.

Permissions are `storage`, `tabs`, and `offscreen`, plus host access to YouTube, the optional Cloud Translation host, and the pinned Mozilla model host. Details are in `docs/release/privacy-and-permissions.md`.

## Development

Node.js 22 or newer.

```bash
npm ci
npm test
npm run compile
npm run build
```

Load `.output/chrome-mv3` while developing. `npm run package:release` writes `release/vesta-dub-0.1.0.zip` from that same output. The zip is gitignored. Reproduce it rather than committing it.

The development clone that still contains the withdrawn Piper weight in old Git objects is not this public tree. Do not push that clone.

## Contributing

Read `CONTRIBUTING.md`. Version 0.1 does not add diarization, a new voice, context translation, sentence reconstruction, local speech recognition, or a new model.

## Licenses

Source code is Apache-2.0 (`LICENSE`). Third-party terms are in `THIRD_PARTY_LICENSES.md` and `NOTICE`.

`NOTICE` records an individual copyright line taken from local Git history. That legal owner is not confirmed, and this README does not assign the copyright to a company. Security reports use `SECURITY.md`. A monitored security address has not been confirmed. Do not send secrets to an unconfirmed address.
