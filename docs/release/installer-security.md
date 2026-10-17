# Installer security

The installer has two checks, and neither one is a signature.

## Integrity model

1. The person copies a command from the v0.1.1 README or release notes. That command contains the SHA-256 of `install.sh`. The script is downloaded from `releases/download/v0.1.1/install.sh`, not from `main`. The command compares the file with the hash that was copied. A checksum downloaded from the same URL is not the pin.
2. `install.sh` contains the SHA-256 of `vesta-dub-0.1.1.zip`. It also downloads `vesta-dub-0.1.1.sha256`. The file's first field must equal the embedded pin, and the zip bytes must equal that same pin. The downloaded checksum cannot authorize a different zip.

Trust comes from the hash the person copied from the v0.1.1 tag or release text. Verify that text against the tag before relying on it. The v0.1.0 release used the same two-pin model. Its hashes stay in `docs/release/v0.1.0-publication.md` and are not reused.

## Limits

- This is corruption detection plus a pin. It is not Sigstore, minisign, or GPG. A maintainer who can replace GitHub release assets can publish a new zip. The embedded pin catches that only when `install.sh` itself still matches the hash the person copied. If that person instead copies a later command from a changed README, the pin moves with the README.
- GitHub release assets are not immutable once a maintainer edits the release. The git tag object is the record to compare.
- Protocol-locked redirects stop an `https` download from following an `http` redirect. They do not by themselves prove which host sent the bytes. The pin does.
- The loopback overrides `VESTA_DUB_RELEASE_BASE`, `VESTA_DUB_EXPECTED_SHA256`, `VESTA_DUB_FORBIDDEN_SHA256`, and `VESTA_DUB_FORBIDDEN_GIT_BLOB` exist for tests. The script rejects them unless the base is `http://127.0.0.1:PORT` or `http://localhost:PORT`.
- `python3` inspects the zip. The script does not execute anything from the archive.
- A crash that cannot run the EXIT trap, such as `SIGKILL`, can leave `extensions/0.1.1.partial` or a temp directory. Those paths are not the live extension directory. Run the script again after removing a partial directory you recognize.
- The unpacked directory does not update itself. Chrome Web Store would. This install method does not.
- The script cannot tell that the person finished Load unpacked. `status: prepared` is only the directory check.

## Archive checks

The extractor rejects absolute paths, parent segments, backslashes, zip symlink entries, a destination that is already a symlink, more than 400 entries, and more than 210 MiB. The 0.1.0 archive declared 75 entries and 192,176,618 unpacked bytes. The 0.1.1 archive size is recorded in `docs/release/v0.1.1-release-notes.md`. The cap stays above both releases.

Piper is rejected three ways:

- A path containing `fahrettin` or a `piper/` segment.
- SHA-256, used by the test hook so a fixture can stand in for a forbidden file without the real weight.
- Git blob id. `034599b1241214da842ec5f02a7265bb242efcac` is the Git object id of `public/models/piper/tr_TR-fahrettin-medium.onnx` (63,201,294 bytes). `b495964d27195aae03726391b35a6ab1a513859f` is the config object (5,022 bytes). Those ids are SHA-1 of `blob <size>\0` plus the bytes. They are not SHA-256, so comparing them to a SHA-256 digest would never match. The extractor computes the Git blob id from the extracted bytes. On the development clone, `git cat-file` of both objects produced those same ids. The real weight is not in the release zip and is not copied into the public tree.

A matching forbidden file is deleted before the extractor exits. The staging directory is then removed by the EXIT trap. The live `extensions/0.1.1` directory is created only after the checks.

## Browser and privacy

The script does not write Chrome or Brave preferences, policies, or extension registries. It does not click through install dialogs. It does not collect a name, an account, or a caption. It does not read or log a Cloud Translation key. It does not request sudo.

Opening the browser application, when that optional macOS path runs, is not installation. The person still turns on Developer Mode and chooses Load unpacked.

## Tests that cover this model

`tests/installer.test.ts` uses a temporary home and a local HTTP fixture. It does not read or write a real browser profile. The cases are listed in `docs/release/installer-acceptance.md`.
