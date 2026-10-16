# Installer acceptance

The table below was measured on 2026-10-16 against a local fixture. Those rows stay as the fixture record.

Later the same day, the published release was downloaded with no GitHub token. `install.sh`, `vesta-dub-0.1.0.zip`, and `vesta-dub-0.1.0.sha256` matched the pins in `docs/release/v0.1.0-publication.md`. The downloaded `install.sh` was run with a temporary data directory and `VESTA_DUB_OPEN_BROWSER=0`. It printed `status: prepared`, left `manifest.json` at version 0.1.0, and found no Piper asset. It did not load the extension into a browser.

## Commands

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Exit 0. `npm run compile` is `wxt prepare && tsc --noEmit` so a fresh checkout can generate `.wxt/` first. |
| `npm test` | 46 files, 326 tests passed. |
| `shellcheck -s sh install.sh` | ShellCheck 0.11.0, exit 0. |
| `npm run package:release` | Exit 0 on the development tree and on the clean tree. Both zips match. SHA-256 `eb9b06430c475ee5dc8d9ec77b0135b56d155341c4157ac54dee6993139f237a`. Size `81,269,936` bytes. 67 files. Voice-model bytes `53,465,942`. Unpacked tree matched the zip. |
| Earlier package | `47cad93ce2f745b0427c7bf06fd277cd80d7a83254747fda46081f8ffc82e43c` (`81,270,454` bytes) was built before Tailwind's scan was limited to `entrypoints/` and `src/`. It is not the file the installer pins. |
| Public zip copy | `release/vesta-dub-0.1.0.zip` is byte-identical to `release/vesta-dub-0.1.0-rc.zip` (`cmp`). The checksum file names `vesta-dub-0.1.0.zip`. |
| `install.sh` SHA-256 | `20eb20a8ce38847cf3ad7a209663577aa9c1558d8c9038aee7e3b8b14e2f5485` |
| Piper Git ids | `git cat-file` of `034599b1241214da842ec5f02a7265bb242efcac` is 63,201,294 bytes and hashes as that same Git blob id. `b495964d27195aae03726391b35a6ab1a513859f` is 5,022 bytes and matches the same way. The weight was not written into the release zip. |

The package script was run again after the installer landed. The zip hash did not change.

## Installer cases

`tests/installer.test.ts` passed 11 tests. Homes, browsers, and HTTP servers were temporary. No browser profile was opened. `VESTA_DUB_OPEN_BROWSER=0`.

| Case | Result |
| --- | --- |
| Help and `--version` | Exit 0. Help says the script does not load the extension. Version is `0.1.0`. |
| Rejected version string `0.2.0;rm -rf /` | Exit 2. The string was not executed. |
| Release URL outside the official host and loopback | Exit 2. |
| Loopback URL with a query | Exit 2. |
| Checksum override without a loopback base | Exit 2. |
| Dry run | Exit 0. Writes nothing. Says the extension is not downloaded or installed. |
| `--browser brave` and `--browser chrome` with fake binaries | The matching `brave://extensions` or `chrome://extensions` line is printed. |
| Explicit Brave when only a fake Chrome binary exists | Exit 5. Output does not say prepared. |
| Fresh fixture, then the same version again | First run `status: prepared`, `reused: no`. Second run `reused: yes` and the HTTP hit count stays the same. |
| Recorded current version `0.2.0` | Exit 0, `status: kept-newer`. The `0.1.0` directory is not created. The closed port is not contacted. |
| Linux `uname` and an empty `XDG_DATA_HOME` | Files land in `$HOME/.local/share/vesta-dub/extensions/0.1.0`. Browser line is `none`. |
| Darwin `uname` | Files land in `$HOME/Library/Application Support/Vesta Dub/extensions/0.1.0`. |
| Checksum file that does not match the pin | Exit 3. Destination absent. |
| Non-zip bytes whose published checksum matches the test pin | Exit 3, `not a zip`. |
| Download closed after 20 bytes | Exit 4. Destination and `.partial` absent. |
| `http://127.0.0.1:1` | Exit 4, `could not download`. |
| Zip without `manifest.json` | Exit 3. |
| Zip entry `../escaped.txt` | Exit 3, `parent path`. The file is not written beside `extensions/`. |
| Zip symlink entry | Exit 3, `symbolic link`. |
| Path `models/piper/tr_TR-fahrettin-medium.onnx` | Exit 3. Destination and `.partial` absent. |
| Innocent filename whose SHA-256 is the loopback forbidden hash | Exit 3, `withdrawn Piper file`. |
| Innocent filename whose Git blob id is the loopback forbidden id | Exit 3, `withdrawn Piper file`. `.partial` absent. |
| Existing directory with a different stamp | Exit 3, `move it aside`, before any HTTP request. |
| Destination is a symlink | Exit 2 on dry run. The link target remains. |
| Real `vesta-dub-0.1.0-rc.zip` through a local HTTP fixture, using the embedded pin | Exit 0, `status: prepared`. Manifest version `0.1.0`, manifest v3. No `models/piper` directory and no fahrettin or piper filename. |

`SIGKILL` during extraction was not sent. A failure the process can catch removes `.partial`. A kill that skips the EXIT trap can leave that partial directory.

## Clean tree

The clean repository's own `npm test` and `npm run compile` are recorded in `docs/release/v0.1.0-publication.md` after that tree is exported. This file's 326 count includes development tests that read private artifacts. Those tests are not part of the public tree, so the public count is smaller.
