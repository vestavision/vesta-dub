# Browser acceptance for 0.1.0

Categories are separate. A pass in A does not prove C or D.

## A. Unit and integration tests

Command: `npm test` (`vitest run`).

Result on the current tree: 45 files, 315 tests, all passed. `npx tsc --noEmit` passed before the release zip was built. That includes activation policy, playback notices, volume restoration, scheduler recovery, translation rate limits, the Cloud Translation client, local translation routing, Piper migration, voice switching, and the guards that reject a foreign translate sender and a missing model download.

These tests use fakes for audio, captions, and Cloud translation. One local-translation test runs the real Bergamot worker in Node. They do not open YouTube. They do not call Cloud Translation.

## B. Controlled browser tests

`scripts/p9.2-browser-inference.mjs` loaded the unpacked extension in a temporary Brave profile and translated English to Turkish in the offscreen worker. That result is in `docs/release/local-translation-browser-acceptance.md`. It is not YouTube playback.

Earlier P5.4 evidence used a temporary profile and received HTTP 429 from the old unofficial endpoint. That run was not repeated.

The collaborative browser available here cannot install an unpacked Manifest V3 extension. It was not used as a dubbing test.

## C. Genuine YouTube caption playback

Not run. No Antalia listening pass, no EMA listening pass, and no five-minute background dub were performed here. Do not read older research notes as a new acceptance of this candidate.

## D. Human acceptance in the normal profile

Not run. The normal Brave profile was not opened. macOS privacy controls previously blocked automated access to that profile, and this session did not ask for them.

## Normal Brave listening procedure

Not run. Do this in the normal Brave profile you already use, with developer mode enabled. Load the unpacked directory `.output/chrome-mv3` produced by `npm run package:release`. Use a watch page that has English captions and that you have the right to play. Leave translation on **Yerel çeviri — Varsayılan**. Do not paste a Cloud key for this pass. Do not treat a unit test, the extension-page translation, or a mocked player as this pass.

1. Install succeeds. On a YouTube watch page the popup opens. Before Start, the original audio is unchanged. The translation section shows local as the default and does not ask for an API key. The 15.1 MB size is visible before download.
2. Press **Modeli indir**, or press Start and let the first cue download the model. Progress reaches ready. English is not spoken while the model is missing. A download failure restores or leaves the original volume and does not send the caption to Google.
3. Start with Antalia. The first Turkish line is the local translation of an English caption. The original volume drops. Stop and start again on the same profile. The model is not downloaded a second time.
4. Pause the video. Dub speech stops. Resume. Dub speech follows the new position and does not play the line that was in flight at pause.
5. Seek backward and forward. The old line does not continue.
6. Stop. Dub speech ends, and the original volume returns.
7. Reload the tab. With manual activation, dubbing stays off until you start again.
8. Open a second watch video in another tab. Starting one does not start the other.
9. Switch the primary voice to EMA Lightning and repeat start, pause, seek, and stop once. Odd pronunciation is an experimental note. It does not make EMA the default.
10. If a previous install had Piper selected, the primary slot is Antalia and the second slot is EMA after the page loads. Piper is not in the voice list.
11. Turn captions off, or pick a video with no captions. The popup says captions are missing. It does not invent speech.
12. If you can reproduce HTTP 429 on the optional Cloud setting without changing the client, the popup says translation is waiting, English is not spoken, and volume returns. There is no automatic resume. Do not select Cloud unless you accept a possible charge.
13. Leave the browser for five minutes during a successful Antalia dub. Record whether the YouTube video itself kept playing. If Brave paused the video, that is the known background limit. The extension should not keep speaking over a paused video.
14. Optional, and only with your own Cloud key: select **Google Cloud — Kendi anahtarım**, confirm the warning that caption text is sent out, save the key, and start once. Then return to Local and confirm the key field disappears. A local error after that return must not call Google.

Write the result next to each step. A failure of steps 2, 3, 4, 5, or 6 is a release blocker.
