# Chrome Web Store submission draft

Nothing in this file was submitted. No developer account was created, no fee was paid, and no listing was published. Store review is a separate human decision. Chrome Web Store submission is **not authorized**. Piper is out of the package and out of this repository's Git history. The default translator is local. Cloud Translation is an optional bring-your-own-key path and has not been called with a real key.

Policies checked on 2026-10-16:

- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies)
- [User data and limited use](https://developer.chrome.com/docs/webstore/program-policies/policies), including the requirement to request the narrowest permissions and to limit user data to the disclosed single purpose
- [Quality guidelines FAQ](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq) on single purpose
- [Policy updates, 1 July 2026](https://developer.chrome.com/blog/cws-policy-updates-2026), with enforcement described as beginning 1 August 2026. Limited Use and disclosure rules are tighter: data must be necessary to the single purpose, and collection must be disclosed prominently.

Policy points that need a person, not another code change:

- Whether the owner's Google Cloud project, quota, and privacy-policy URL are ready before any user is asked to paste an API key.
- This repository does not contain the withdrawn Piper weight. Do not upload a package built from a tree that still has the file. The package script rejects the file.
- The privacy-policy URL must be a real public page before submission. This draft is not hosted.
- Screenshots must be taken from the real popup. This session did not capture them.

## Listing

Title: `Vesta Dub`

Short description (132 characters or fewer):

`Turkish speech for YouTube videos that already have captions. Translation runs in your browser. Voices do too.`

Full description:

```
Vesta Dub is an independent extension. It is not made by YouTube or Google.

On a YouTube watch page with captions, Vesta Dub can speak a Turkish dub. It reads the available caption track, translates English lines to Turkish, and plays speech from a model in your browser. You start it yourself. You can also choose to continue in the same tab, or to start on later watch pages.

Antalia is the default voice. EMA Lightning is experimental. Every speaker currently uses the one voice you selected.

English captions are translated on your device. The first use downloads about 15.1 MB of model data. After that, caption text stays on your device. YouTube still needs a network connection. An optional Google Cloud mode sends caption text to Google only after you select it and save your own API key. The key is not shared with the YouTube page. If translation fails, Vesta Dub stops and does not read the English line aloud. Videos without usable captions cannot be dubbed. A Turkish caption track does not need translation.

The original video volume is lowered during the dub and restored when you stop or when dubbing fails. Speech audio stays on your device. Vesta Dub does not use your microphone and does not collect browsing analytics.

This is not live human dubbing. Phrasing can be awkward, and the extension does not tell speakers apart.
```

## Feature summary

- Manual start and stop on YouTube watch pages
- English or Turkish captions, with English translated to Turkish
- Local Antalia voice by default
- Optional experimental EMA Lightning voice
- Pause, resume, and seek handling
- Original volume ducked and restored
- Optional tab-continuation and always-on preferences

Do not list Piper. Do not list speaker diarization, fully offline use, or local transcription. The model download and YouTube both use the network.

## Permission justifications

| Permission | Justification for the form |
| --- | --- |
| storage | Saves the start preference, the voice selected for a video, and the translation mode |
| tabs | Lets the popup address the YouTube tab the user is watching |
| offscreen | Runs the local translation worker. It does not capture the tab. |
| Host: youtube.com | Reads captions and plays audio on the watch page |
| Host: translation.googleapis.com | Sends caption text to Cloud Translation API v2 only after the user selects that mode and saves a key |
| Host: pinned Mozilla model prefix | Downloads the static English-to-Turkish model once. The request is not the caption text. |

`activeTab` was removed from the manifest during this preparation because the YouTube host permission already covers the content script.

## Privacy disclosures

Single purpose: speak a Turkish dub for a YouTube video the user opened, using that video's captions.

Data sent off device on the default path: the one-time translation-model download, which does not include caption text. Caption text is sent to Google Cloud Translation only if the user selects that mode, plus the user's API key in a request header. Not used for advertising. Not sold. The key is stored only in extension session storage.

Data kept locally: voice preference, activation mode, cached model bytes, optional diagnostic export.

Certification language, if the form asks about Google API data: "The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements." Cloud Translation API v2 is a documented Google API. The caption text sent to it is the user data to disclose. Do not submit until the privacy-policy URL is public.

## Privacy policy draft

Host this at a stable public URL before submission. Replace the contact line.

```
Vesta Dub privacy policy (draft)

Vesta Dub adds Turkish speech to YouTube watch pages you choose to dub.

English caption text is translated on your device after a one-time model download. That download does not include the caption. Caption text is sent to Google Cloud Translation only if you choose that option and provide an API key. The key is kept in the extension for the browser session and is not put in the page. The translated text is spoken on your device by a local model. Video and microphone audio are not uploaded. The extension does not ask for microphone permission.

The extension stores your activation choice and voice choice in the browser's extension storage. Model files shipped with the extension may be cached in the browser. Optional diagnostic files stay on your machine unless you choose to share them.

Vesta Dub does not sell personal information and does not use caption text for advertising. You can stop dubbing at any time and you can remove the extension, which removes its stored preferences.

Contact: security@vestavision.io
```

## Screenshot checklist

Capture on a real watch page after a successful start. Do not mock the translation.

1. Popup before start, on a YouTube watch page, manual mode visible.
2. Popup while Antalia is speaking, with the status and the stop control.
3. Voice list showing Antalia as default and EMA as experimental.
4. Translation-unavailable state, if you can reproduce HTTP 429 without fabricating the banner.
5. A frame that shows the original YouTube page is still YouTube, so the listing does not imply a new video host.

Use 1280x800 or the current store's required size. Check the dashboard. Include the 128 icon from `public/icons/icon-128.png`.

## Icon and visual checklist

- 16, 32, 48, and 128 PNG icons are in `public/icons/` and in the manifest.
- Confirm the artwork is original and readable at 16 pixels.
- No YouTube logo, play-button mark, or Google mark in the icon.
- No screenshot of a logged-in account name or a private recommendation shelf.

## Support contact

Support and security contact: security@vestavision.io. Use that address in a future store form. This draft does not submit the listing.

## Remote code and local execution

The packaged extension does not download JavaScript. Bergamot and ONNX Runtime Web are files inside the zip. The offscreen document runs the Bergamot worker with `wasm-unsafe-eval` so the local translator can execute WASM. That worker is the unmodified file from `@browsermt/bergamot-translator` 0.4.9. It is not fetched at runtime.

Remote bytes on the default path are the pinned Firefox Translations English-to-Turkish model. The extension downloads those static files once from the Mozilla storage host already named in the manifest, checks their SHA-256, and caches them. The download is not caption text and it is not executable JavaScript. Voice models are already in the zip. The installer does not download the translation model ahead of time.

Google Cloud Translation is a separate optional path. It sends caption text only after the user selects that mode and saves a key. There is no silent fallback to Cloud, and Cloud without a key does not fall back to local.

## Compliance checklist

- [ ] Single purpose is only YouTube caption dubbing to Turkish
- [ ] Description does not promise fully offline use, human dubbing, or speaker identification
- [ ] Privacy policy URL is live and matches the build
- [ ] Permission list matches the manifest
- [ ] The published repository does not contain the Piper ONNX blob. The current local history still does.
- [ ] Cloud Translation key handling and the privacy policy match the packaged build
- [ ] No remote JavaScript
- [ ] Screenshots are from the packaged build
- [ ] Human listening checklist is complete
- [ ] Owner has submitted the listing themselves

A checked box in this file is not a store approval.
