# Third-party licenses

Vesta Dub source code is Apache-2.0. The pieces below are not. Confirm each one before publication. The audit is `docs/release/licensing-audit.md`.

| Component | Role | License as published | Redistribution status |
| --- | --- | --- | --- |
| Antalia-2 Mini ONNX weights and frontend | Default Turkish voice | Apache-2.0, per the upstream model card | Include the upstream notice. Owner should keep a copy of the upstream LICENSE with the weights. |
| EMA Lightning Web ONNX assets | Experimental Turkish voice | Apache-2.0 | Bundled `LICENSE` and `NOTICE` travel with the files. |
| Piper `tr_TR-fahrettin-medium` | Removed from the product | Not established. Older project notes said CC0. That claim is withdrawn. Upstream removed the voice at a contributor's request. | Not shipped. The development clone's older Git history still has the blob. Do not publish that history. The public tree is a new Git root. |
| ONNX Runtime Web 1.21 | Local speech runtime | MIT, Microsoft | Bundled wasm and generated runtime files. |
| Bergamot Translator 0.4.9 | Local English-to-Turkish WASM worker | MPL-2.0 | Unmodified worker files in `public/bergamot/`, with `NOTICE`. WASM version string `v0.4.5+4917c11`. |
| Firefox Translations `en-tr` tiny, spring 2024 | Default translation weights | MPL-2.0, `mozilla/firefox-translations-models` | Not bundled. Downloaded once from the pinned Mozilla host after hash checks. |
| Preact | Popup UI | MIT | Development and runtime dependency. |
| WXT | Extension build | MIT | Build tool, not shipped as an app. |
| Tailwind CSS | Popup styles | MIT | Build tool. Compiled CSS is shipped. |
| onnxruntime-node, Playwright, TypeScript, Vitest, tsx | Tests and tooling | Their own licenses, MIT or Apache-2.0 | Not part of the extension package. |
| YouTube pages and captions | Runtime service | Third-party service, not licensed to this repository | Not bundled. Use is subject to YouTube's terms. |
| Google Cloud Translation API v2 | Optional English-to-Turkish caption translation when the user selects it and supplies a key | Google Cloud terms and pricing. Not a bundled library. | Never the default. The extension does not ship a key. Requests use the documented REST method. |

Do not treat a repository-level license badge as the license of every file inside that repository. Voice recordings, model weights, and code can differ.

Fonts and screenshots: the extension does not bundle a third-party font. Historical files under `tests/artifacts/` and `tools/` include generated audio and review pages. They are local research evidence and are gitignored or otherwise not part of the extension package. Do not add them to a public release without a separate rights review.
