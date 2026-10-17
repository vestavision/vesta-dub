# Security

## Reporting

Report a vulnerability privately to security@vestavision.io.

Do not open a public issue that includes an exploit, a session cookie, a signed YouTube URL, or an API key. Give the project a reasonable chance to investigate before you publish the details.

There is no bug-bounty program. This document does not promise a response time.

## What to include

Describe the version, the commit, and the smallest steps that show the problem. Say what an attacker can do. Do not include microphone audio, tab audio, or a full caption transcript unless the maintainer asks for it.

## Supported use

The security boundary for 0.1.1 is the unpacked extension prepared from the versioned release zip, which is the same tree built by `npm run package:release`. `install.sh` only downloads and checks that zip. It does not change browser policy. Research scripts under `scripts/`, `tools/`, and `tests/` are not a supported production surface.

## Known boundaries

The extension reads YouTube caption responses from the page. A script running in the YouTube page can also dispatch caption-shaped events. Caption text is untrusted. The popup renders it as text, not as HTML.

Caption text is translated in the browser by default and is not sent to a translation service. It is sent to `translation.googleapis.com` only when the translation mode is exactly Cloud and a Cloud Translation API key is present in extension session storage. A stored key does not select Cloud by itself. That text leaves the browser only on that path. The key is not hardcoded, not logged, and not sent to the page. Speech synthesis, model weights, and audio stay on the device.

The extension does not request microphone or tab-capture permission. Do not add a path that uploads microphone or tab audio.
