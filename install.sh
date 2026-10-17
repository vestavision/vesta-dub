#!/bin/sh
# Prepare Vesta Dub 0.1.1 for Chrome or Brave.
# This script verifies a pinned release zip and extracts it into a user-owned
# directory. It does not install the extension into the browser, change browser
# policy, or request administrator rights.
set -eu

VERSION="0.1.1"
EXPECTED_ZIP_SHA256="4ecb385cd9ec853060641a1037a99a9ba1351b9ec733a4f98c01d5d8e5e0ac44"
# Git object ids of the withdrawn Piper files (SHA-1 of "blob <size>\\0" + bytes).
# These are not SHA-256 digests. SHA-256 of an extracted file cannot match them.
PIPER_GIT_BLOB="034599b1241214da842ec5f02a7265bb242efcac"
PIPER_CONFIG_GIT_BLOB="b495964d27195aae03726391b35a6ab1a513859f"
OFFICIAL_BASE="https://github.com/vestavision/vesta-dub/releases/download/v0.1.1"
ZIP_NAME="vesta-dub-0.1.1.zip"
SUM_NAME="vesta-dub-0.1.1.sha256"

browser="auto"
dry=0
workdir=""
staging=""

die() {
  printf 'error: %s\n' "$1" >&2
  exit "${2:-2}"
}

# Invoked by the EXIT trap below. ShellCheck does not treat that as a call.
# shellcheck disable=SC2329
cleanup() {
  if [ -n "$workdir" ] && [ -d "$workdir" ]; then
    rm -rf "$workdir"
  fi
  if [ -n "$staging" ] && [ -e "$staging" ]; then
    if [ -L "$staging" ]; then
      printf 'error: refusing to remove a symlinked staging directory\n' >&2
    else
      rm -rf "$staging"
    fi
  fi
}

trap cleanup EXIT

usage() {
  cat <<EOF
Usage: install.sh [--help] [--version] [--dry-run] [--browser brave|chrome]

Prepare the Vesta Dub ${VERSION} unpacked extension in a directory you own.
The script downloads ${ZIP_NAME} from the v${VERSION} GitHub release, checks
the pinned SHA-256, and extracts it. Chrome and Brave still require you to
turn on Developer Mode and choose Load unpacked. This script does not load
the extension into the browser and cannot do that step for you.

  --help            Show this help
  --version         Print ${VERSION}
  --dry-run         Print the plan and write nothing
  --browser brave   Look only for Brave
  --browser chrome  Look only for Chrome

Official release: ${OFFICIAL_BASE}
EOF
}

is_hex64() {
  printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$'
}

validate_base() {
  base=${base%/}
  if [ "$base" = "$OFFICIAL_BASE" ]; then
    return 0
  fi
  case "$base" in
    http://127.0.0.1:*|http://localhost:*) ;;
    *) die "refusing release URL" ;;
  esac
  case "$base" in
    *'?'*|*'#'*|*'@'*) die "refusing release URL" ;;
  esac
  port=${base##*:}
  case "$port" in
    ''|*[!0-9]*) die "refusing release URL" ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    die "refusing release URL"
  fi
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"
  fi
}

version_gt() {
  # True when $1 is a newer dotted version than $2.
  awk -v left="$1" -v right="$2" 'BEGIN {
    n = split(left, a, ".");
    m = split(right, b, ".");
    if (n != 3 || m != 3) exit 2;
    for (i = 1; i <= 3; i++) {
      if (a[i] !~ /^[0-9]+$/ || b[i] !~ /^[0-9]+$/) exit 2;
      if (a[i] + 0 > b[i] + 0) exit 0;
      if (a[i] + 0 < b[i] + 0) exit 1;
    }
    exit 1;
  }'
}

set_data_root() {
  if [ -n "${VESTA_DUB_HOME:-}" ]; then
    root=$VESTA_DUB_HOME
    return 0
  fi
  if [ -z "${HOME:-}" ]; then
    die "HOME is not set"
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    root="$HOME/Library/Application Support/Vesta Dub"
  else
    root="${XDG_DATA_HOME:-$HOME/.local/share}/vesta-dub"
  fi
}

find_browser() {
  want=$1
  if [ -n "${VESTA_DUB_FAKE_BROWSERS:-}" ]; then
    if [ "$want" = "brave" ] && [ -x "$VESTA_DUB_FAKE_BROWSERS/brave" ]; then
      printf '%s\n' "brave"
      return 0
    fi
    if [ "$want" = "chrome" ] && [ -x "$VESTA_DUB_FAKE_BROWSERS/google-chrome" ]; then
      printf '%s\n' "chrome"
      return 0
    fi
    return 1
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    if [ "$want" = "brave" ]; then
      if [ -d "/Applications/Brave Browser.app" ] || [ -d "$HOME/Applications/Brave Browser.app" ]; then
        printf '%s\n' "brave"
        return 0
      fi
    fi
    if [ "$want" = "chrome" ]; then
      if [ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ]; then
        printf '%s\n' "chrome"
        return 0
      fi
    fi
    return 1
  fi
  if [ "$want" = "brave" ]; then
    if command -v brave-browser >/dev/null 2>&1 || command -v brave >/dev/null 2>&1; then
      printf '%s\n' "brave"
      return 0
    fi
  fi
  if [ "$want" = "chrome" ]; then
    if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1; then
      printf '%s\n' "chrome"
      return 0
    fi
  fi
  return 1
}

select_browser() {
  choice=$1
  found=""
  if [ "$choice" = "auto" ] || [ "$choice" = "brave" ]; then
    if found=$(find_browser brave); then
      printf '%s\n' "$found"
      return 0
    fi
    if [ "$choice" = "brave" ]; then
      return 1
    fi
  fi
  if [ "$choice" = "auto" ] || [ "$choice" = "chrome" ]; then
    if found=$(find_browser chrome); then
      printf '%s\n' "$found"
      return 0
    fi
  fi
  return 1
}

extensions_url() {
  if [ "$1" = "brave" ]; then
    printf '%s\n' "brave://extensions"
  else
    printf '%s\n' "chrome://extensions"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --version)
      printf '%s\n' "$VERSION"
      exit 0
      ;;
    --dry-run)
      dry=1
      shift
      ;;
    --browser)
      [ $# -ge 2 ] || die "missing value for --browser"
      browser=$2
      shift 2
      ;;
    --browser=*)
      browser=${1#--browser=}
      shift
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

case "$browser" in
  auto|brave|chrome) ;;
  *) die "browser must be brave or chrome" ;;
esac

if [ -n "${VESTA_DUB_VERSION:-}" ] && [ "$VESTA_DUB_VERSION" != "$VERSION" ]; then
  die "this installer only prepares ${VERSION}"
fi

case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die "invalid installer version" ;;
esac

base=${VESTA_DUB_RELEASE_BASE:-$OFFICIAL_BASE}
validate_base
pin=$EXPECTED_ZIP_SHA256
if [ -n "${VESTA_DUB_EXPECTED_SHA256:-}" ]; then
  case "$base" in
    http://127.0.0.1:*|http://localhost:*) pin=$VESTA_DUB_EXPECTED_SHA256 ;;
    *) die "refusing to override the pinned checksum for a remote release" ;;
  esac
fi
is_hex64 "$pin" || die "pinned checksum is not a SHA-256 hex string"

forbidden_extra=""
if [ -n "${VESTA_DUB_FORBIDDEN_SHA256:-}" ]; then
  case "$base" in
    http://127.0.0.1:*|http://localhost:*) forbidden_extra=$VESTA_DUB_FORBIDDEN_SHA256 ;;
    *) die "refusing an extra forbidden hash for a remote release" ;;
  esac
  is_hex64 "$forbidden_extra" || die "extra forbidden hash is not a SHA-256 hex string"
fi

forbidden_git=""
if [ -n "${VESTA_DUB_FORBIDDEN_GIT_BLOB:-}" ]; then
  case "$base" in
    http://127.0.0.1:*|http://localhost:*) forbidden_git=$VESTA_DUB_FORBIDDEN_GIT_BLOB ;;
    *) die "refusing an extra forbidden git blob for a remote release" ;;
  esac
  printf '%s' "$forbidden_git" | grep -Eq '^[0-9a-f]{40}$' || die "extra forbidden git blob is not a SHA-1 hex string"
fi

set_data_root
case "$root" in
  /|"") die "refusing install directory" ;;
esac
dest="$root/extensions/$VERSION"
stamp="$root/extensions/${VERSION}.stamp"
current_file="$root/current-version"

if [ -L "$root" ] || [ -L "$root/extensions" ] || [ -L "$dest" ] || [ -L "$stamp" ]; then
  die "refusing a symlinked install path"
fi

selected=""
if selected=$(select_browser "$browser"); then
  :
else
  selected=""
fi
if [ "$browser" != "auto" ] && [ -z "$selected" ]; then
  die "requested browser was not found" 5
fi

if [ "$dry" -eq 1 ]; then
  printf 'status: dry-run\n'
  printf 'version: %s\n' "$VERSION"
  printf 'url: %s/%s\n' "$base" "$ZIP_NAME"
  printf 'directory: %s\n' "$dest"
  if [ -n "$selected" ]; then
    printf 'browser: %s\n' "$selected"
    printf 'extensions: %s\n' "$(extensions_url "$selected")"
  else
    printf 'browser: none\n'
  fi
  printf 'The extension is not downloaded or installed during a dry run.\n'
  staging=""
  exit 0
fi

if [ -f "$current_file" ]; then
  current=$(awk 'NR == 1 { print; exit }' "$current_file")
  case "$current" in
    [0-9]*.[0-9]*.[0-9]*)
      if version_gt "$current" "$VERSION"; then
        printf 'status: kept-newer\n'
        printf 'current: %s\n' "$current"
        printf 'requested: %s\n' "$VERSION"
        printf 'A newer prepared version is already recorded. This installer did not replace it.\n'
        staging=""
        exit 0
      fi
      ;;
    "") ;;
    *) die "current version file is invalid" ;;
  esac
fi

if [ -d "$dest" ] && [ -f "$stamp" ]; then
  recorded=$(awk 'NR == 2 { print; exit }' "$stamp")
  recorded_version=$(awk 'NR == 1 { print; exit }' "$stamp")
  if [ "$recorded_version" = "$VERSION" ] && [ "$recorded" = "$pin" ] && [ -f "$dest/manifest.json" ]; then
    printf 'status: prepared\n'
    printf 'version: %s\n' "$VERSION"
    printf 'directory: %s\n' "$dest"
    printf 'sha256: %s\n' "$pin"
    printf 'reused: yes\n'
    printf 'The verified directory is already present. No files were replaced.\n'
    if [ -n "$selected" ]; then
      printf 'browser: %s\n' "$selected"
      printf 'extensions: %s\n' "$(extensions_url "$selected")"
    else
      printf 'browser: none\n'
    fi
    printf 'This script did not load the extension into the browser.\n'
    staging=""
    exit 0
  fi
  die "an existing ${VERSION} directory does not match this release; move it aside before preparing it again" 3
fi

if [ -e "$dest" ]; then
  die "an existing ${VERSION} path is not a verified install directory; move it aside before preparing it again" 3
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required to inspect the archive"

mkdir -p "$root/extensions"
workdir=$(mktemp -d "${TMPDIR:-/tmp}/vesta-dub.XXXXXX")
archive="$workdir/$ZIP_NAME"
checksum="$workdir/$SUM_NAME"

case "$base" in
  https://*) curl_proto='=https' ;;
  *) curl_proto='=http' ;;
esac

if ! curl --proto "$curl_proto" --proto-redir "$curl_proto" -fsSL --retry 2 --retry-delay 1 --max-time 180 -o "$checksum" "$base/$SUM_NAME"; then
  die "could not download the checksum" 4
fi
if ! curl --proto "$curl_proto" --proto-redir "$curl_proto" -fsSL --retry 2 --retry-delay 1 --max-time 180 -o "$archive" "$base/$ZIP_NAME"; then
  die "could not download the release archive" 4
fi

sum_hash=$(awk 'NR == 1 { print $1; exit }' "$checksum")
is_hex64 "$sum_hash" || die "checksum file is malformed" 3
if [ "$sum_hash" != "$pin" ]; then
  die "checksum file does not match the pinned SHA-256" 3
fi
actual=$(hash_file "$archive")
if [ "$actual" != "$pin" ]; then
  die "archive SHA-256 does not match the pinned checksum" 3
fi

staging="${dest}.partial"
if [ -L "$staging" ]; then
  die "refusing to replace a symlinked staging path" 3
fi
if [ -d "$staging" ]; then
  rm -rf "$staging"
fi
mkdir -p "$staging"

VESTA_ZIP="$archive" \
VESTA_DEST="$staging" \
VESTA_PIPER_GIT_BLOB="$PIPER_GIT_BLOB" \
VESTA_PIPER_CONFIG_GIT_BLOB="$PIPER_CONFIG_GIT_BLOB" \
VESTA_FORBIDDEN_EXTRA="$forbidden_extra" \
VESTA_FORBIDDEN_GIT="$forbidden_git" \
python3 - <<'PY'
import hashlib
import os
import pathlib
import sys
import zipfile

archive = os.environ["VESTA_ZIP"]
dest = pathlib.Path(os.environ["VESTA_DEST"]).resolve()
forbidden_sha256 = set()
extra = os.environ.get("VESTA_FORBIDDEN_EXTRA", "")
if extra:
    forbidden_sha256.add(extra)
forbidden_git = {
    os.environ["VESTA_PIPER_GIT_BLOB"],
    os.environ["VESTA_PIPER_CONFIG_GIT_BLOB"],
}
extra_git = os.environ.get("VESTA_FORBIDDEN_GIT", "")
if extra_git:
    forbidden_git.add(extra_git)

# 0.1.1 declares 75 entries and 192,189,414 unpacked bytes (voice models
# plus several ONNX Runtime wasm builds). The cap stays above that release
# and still rejects a much larger archive.
max_files = 400
max_bytes = 210 * 1024 * 1024

def fail(message):
    sys.stderr.write("error: " + message + "\n")
    sys.exit(3)

try:
    zf = zipfile.ZipFile(archive)
except zipfile.BadZipFile:
    fail("archive is not a zip file")

infos = zf.infolist()
if len(infos) == 0 or len(infos) > max_files:
    fail("archive has an unexpected number of entries")

total = 0
names = []
for info in infos:
    name = info.filename.replace("\\", "/")
    if name.startswith("/") or (len(name) >= 2 and name[1] == ":"):
        fail("archive contains an absolute path")
    parts = [part for part in name.split("/") if part != ""]
    if any(part == ".." for part in parts):
        fail("archive contains a parent path")
    mode = (info.external_attr >> 16) & 0o170000
    if mode == 0o120000:
        fail("archive contains a symbolic link")
    lowered = "/".join(parts).lower()
    if "fahrettin" in lowered or "/piper/" in "/" + lowered or lowered.startswith("piper/"):
        fail("archive contains a withdrawn Piper path")
    if not info.is_dir():
        total += info.file_size
        if total > max_bytes:
            fail("archive is larger than the allowed unpacked size")
    names.append((info, name, parts))

if "manifest.json" not in [name for _, name, _ in names]:
    fail("archive is missing manifest.json")

written = 0
for info, name, parts in names:
    target = dest.joinpath(*parts).resolve() if parts else dest
    if target != dest and not str(target).startswith(str(dest) + os.sep):
        fail("archive path escapes the destination")
    if info.is_dir():
        target.mkdir(parents=True, exist_ok=True)
        continue
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink():
        fail("destination contains a symbolic link")
    chunks = []
    with zf.open(info, "r") as src:
        while True:
            chunk = src.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > max_bytes:
                fail("archive expanded beyond the allowed size")
            chunks.append(chunk)
    data = b"".join(chunks)
    with open(target, "wb") as out:
        out.write(data)
    digest = hashlib.sha256(data).hexdigest()
    blob = hashlib.sha1(("blob %d\0" % len(data)).encode("ascii") + data).hexdigest()
    if digest in forbidden_sha256 or blob in forbidden_git:
        os.remove(target)
        fail("archive contains a withdrawn Piper file")

manifest = dest / "manifest.json"
if not manifest.is_file() or manifest.is_symlink():
    fail("manifest.json is missing after extraction")
text = manifest.read_text(encoding="utf-8")
if '"manifest_version"' not in text or '"version"' not in text:
    fail("manifest.json is not a Chrome manifest")
if '"version": "0.1.1"' not in text and '"version":"0.1.1"' not in text:
    fail("manifest version is not 0.1.1")
PY

if [ ! -f "$staging/manifest.json" ]; then
  die "manifest.json was not extracted" 3
fi

mv "$staging" "$dest"
staging=""
printf '%s\n%s\n' "$VERSION" "$pin" > "$stamp"
if [ ! -f "$current_file" ]; then
  printf '%s\n' "$VERSION" > "$current_file"
else
  current=$(awk 'NR == 1 { print; exit }' "$current_file")
  if [ "$current" = "$VERSION" ] || [ -z "$current" ]; then
    printf '%s\n' "$VERSION" > "$current_file"
  elif version_gt "$VERSION" "$current"; then
    printf '%s\n' "$VERSION" > "$current_file"
  fi
fi

printf 'status: prepared\n'
printf 'version: %s\n' "$VERSION"
printf 'directory: %s\n' "$dest"
printf 'sha256: %s\n' "$pin"
printf 'reused: no\n'
if [ -n "$selected" ]; then
  printf 'browser: %s\n' "$selected"
  page=$(extensions_url "$selected")
  printf 'extensions: %s\n' "$page"
else
  printf 'browser: none\n'
  page="brave://extensions or chrome://extensions"
  printf 'No Brave or Chrome installation was found.\n'
fi
printf 'Verified manifest.json. No Piper asset was found.\n'
printf 'This script did not load the extension into the browser.\n'
printf 'Next: open %s, enable Developer Mode, choose Load unpacked, and select the directory above.\n' "$page"

if [ "${VESTA_DUB_OPEN_BROWSER:-}" = "1" ] && [ -n "$selected" ] && [ "$(uname -s)" = "Darwin" ] && [ -t 1 ]; then
  if [ "$selected" = "brave" ]; then
    open -a "Brave Browser" >/dev/null 2>&1 || true
  else
    open -a "Google Chrome" >/dev/null 2>&1 || true
  fi
fi
exit 0
