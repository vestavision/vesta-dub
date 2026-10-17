# Installer design

`install.sh` prepares Vesta Dub 0.1.1 as an unpacked extension. It does not load the extension into Chrome or Brave, and it does not change browser policy.

The product stays the current local-first extension. The script does not download the Bergamot translation model. The extension does that on first use, with the pins already in the source.

## What the user runs

The README command downloads `install.sh` from the immutable release asset:

`https://github.com/vestavision/vesta-dub/releases/download/v0.1.1/install.sh`

It checks the SHA-256 printed in that same command, then runs the script. The hash is not fetched from the release. A review-before-execution path and a fully manual path are in the README.

That GitHub URL is the intended publication target. It is not live until the owner publishes the release. A test against a local fixture does not prove the public URL works.

## Flags

| Flag | Effect |
| --- | --- |
| `--help` | Prints usage and exits 0 |
| `--version` | Prints `0.1.1` and exits 0 |
| `--dry-run` | Prints the plan and writes nothing |
| `--browser brave` | Looks only for Brave |
| `--browser chrome` | Looks only for Chrome |

The default browser choice is automatic. Brave is preferred when both Brave and Chrome are present. An explicit browser that is missing exits 5 before any download.

## Steps

1. Reject a `VESTA_DUB_VERSION` value other than `0.1.1`. The value is compared as text. It is not evaluated.
2. Accept only the official release base, or an `http://127.0.0.1:PORT` / `http://localhost:PORT` base with a numeric port and no query, fragment, or userinfo. The loopback base exists so tests can serve a fixture. It is refused for any other host.
3. Choose the directory. macOS uses `$HOME/Library/Application Support/Vesta Dub`. Linux uses `${XDG_DATA_HOME:-$HOME/.local/share}/vesta-dub`. `VESTA_DUB_HOME` overrides both for tests. The root, `extensions/`, the destination, and the stamp file must not be symlinks.
4. If `current-version` is a newer three-part version, exit 0 with `status: kept-newer` and do not download.
5. If `extensions/0.1.1` and its stamp already match this version, the pinned checksum, and `manifest.json`, exit 0 with `reused: yes` and do not download.
6. If that directory exists but the stamp does not match, exit 3 and tell the user to move it aside. The script does not delete it.
7. Download `vesta-dub-0.1.1.sha256`, then `vesta-dub-0.1.1.zip`, over the one allowed protocol. Redirects stay on that protocol.
8. Require the checksum file's first field to be 64 hex characters and to equal the pin embedded in `install.sh`. Then hash the zip. Both must match before extraction.
9. Extract with Python's `zipfile` into `extensions/0.1.1.partial`. Reject absolute paths, `..`, backslashes, symlink entries, more than 400 entries, and more than 210 MiB declared or written. Reject names containing `fahrettin` or a `piper/` segment. Hash every file. Reject a SHA-256 listed in the loopback-only test hook, and reject a file whose Git blob id is the withdrawn Piper weight or its config. Require `manifest.json` at the archive root with version `0.1.1`.
10. Rename the staging directory into place only after those checks. Write `extensions/0.1.1.stamp` beside the extension directory, not inside it. Update `current-version` when it is missing, equal, or older.
11. Print `status: prepared` and the Load unpacked instructions. Success means the directory is verified. It does not mean the browser loaded the extension.

On macOS, when stdout is a terminal and `VESTA_DUB_OPEN_BROWSER=1`, the script may open Brave or Chrome with `open -a`. It does not open an extensions URL, click Developer Mode, or accept a dialog. Tests set `VESTA_DUB_OPEN_BROWSER=0`. The default is unset, so a non-interactive run does not open a browser.

## Directories and updates

Repeated runs of the same verified version reuse the directory. A newer recorded version is left in place. A modified 0.1.1 directory is not overwritten. The previous version stays until the new zip has been verified, because the new files land in `.partial` first. The EXIT trap removes the temp download and `.partial` unless the rename already succeeded. It will not `rm -rf` a symlinked staging path.

The script does not delete unrelated directories or browser profiles.

## What it will not do

Chrome and Brave do not offer a supported way for a shell script to install an unpacked extension without Developer Mode. This script does not write a browser profile, an enterprise policy, an external extension registry, or a preferences file. It does not run scripts from the zip. It does not use sudo. It does not require Node.js or npm. It does require `curl` and `python3`, which are used to download and inspect the archive.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Help, version, dry run, prepared, or a newer version kept |
| 2 | Usage, bad version, bad URL, or a symlinked destination |
| 3 | Checksum mismatch, corrupt or unsafe archive, Piper content, missing manifest, or a directory that does not match |
| 4 | Network failure or a short download |
| 5 | The requested browser was not found |

## Package name

`npm run package:release` still writes `release/vesta-dub-0.1.1-rc.zip` and copies those same bytes to `release/vesta-dub-0.1.1.zip`. The installer downloads the public name. Both files are gitignored and are uploaded later as release assets. They are not committed.
