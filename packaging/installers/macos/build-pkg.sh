#!/bin/bash
# Build the macOS installer package.
#
# A .pkg rather than a .dmg: Hypergate is a tray agent *and* a CLI, so it needs
# to put a binary on PATH as well as an app in /Applications. A drag-to-install
# .dmg cannot do the former, and asking people to drag an app and then also run
# a shell command is worse than one double-click.
#
# Usage: build-pkg.sh <payload-dir> <version> <arch> <output.pkg> <icon.icns>
set -euo pipefail

PAYLOAD="${1:?payload directory required}"
VERSION="${2:?version required}"
ARCH="${3:?arch required}"
OUTPUT="${4:?output path required}"
ICON="${5:?icns path required}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ROOT="$WORK/root"
APP="$ROOT/Applications/Hypergate.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$ROOT/usr/local/bin"

# Both binaries and the UI live inside the bundle, so the whole product is one
# self-contained thing the user can move or delete.
cp "$PAYLOAD/hypergate" "$APP/Contents/MacOS/hypergate"
cp "$PAYLOAD/hypergated" "$APP/Contents/MacOS/hypergated"
cp -R "$PAYLOAD/web" "$APP/Contents/MacOS/web"
cp "$ICON" "$APP/Contents/Resources/hypergate.icns"
cp "$PAYLOAD/LICENSE" "$APP/Contents/Resources/LICENSE"
cat > "$APP/Contents/Resources/uninstall.sh" <<'UNINSTALL'
#!/bin/sh
set -eu

run_user() {
  if [ "$(id -u)" -eq 0 ]; then
    if [ -z "${SUDO_USER:-}" ]; then
      echo "Run this script as the logged-in user (or via sudo from that user)." >&2
      exit 1
    fi
    sudo -u "$SUDO_USER" -H "$@"
  else
    "$@"
  fi
}

# User-scoped first: the shell owns the real LaunchAgent implementation and
# must run as the logged-in user, not root's sudo home.
if [ -x /Applications/Hypergate.app/Contents/MacOS/hypergate ]; then
  run_user /Applications/Hypergate.app/Contents/MacOS/hypergate autostart off >/dev/null 2>&1 || true
fi
run_user osascript -e 'tell application "Hypergate" to quit' >/dev/null 2>&1 || true
run_user pkill -TERM -f '/Applications/Hypergate.app/Contents/MacOS/hypergated' >/dev/null 2>&1 || true
sleep 1
run_user pkill -KILL -f '/Applications/Hypergate.app/Contents/MacOS/hypergated' >/dev/null 2>&1 || true

if [ "$(id -u)" -eq 0 ]; then
  rm -f /usr/local/bin/hypergate /usr/local/bin/hypergated
  rm -rf /Applications/Hypergate.app
  pkgutil --forget app.hypergate.tray >/dev/null 2>&1 || true
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Run this script as an administrator (sudo is required for /Applications and /usr/local/bin)." >&2
    exit 1
  fi
  sudo rm -f /usr/local/bin/hypergate /usr/local/bin/hypergated
  sudo rm -rf /Applications/Hypergate.app
  sudo pkgutil --forget app.hypergate.tray >/dev/null 2>&1 || true
fi

echo "Hypergate removed. ~/.hypergate was left intact."
UNINSTALL
chmod 755 "$APP/Contents/Resources/uninstall.sh"
chmod 755 "$APP/Contents/MacOS/hypergate" "$APP/Contents/MacOS/hypergated"

# `web` sits beside hypergated because that is where the daemon looks: it
# resolves the UI relative to process.execPath when it is a compiled binary.

# An app bundle's executable takes no arguments, so a stub supplies `app`.
# Its name must not be a case variant of `hypergate`: macOS filesystems are
# commonly case-insensitive, and a case-only name would truncate the real CLI.
# opening it from Launchpad/Finder means "show me the app", so the manager
# window opens. The login item runs `tray` (headless) instead.
cat > "$APP/Contents/MacOS/HypergateApp" <<'STUB'
#!/bin/sh
exec "$(dirname "$0")/hypergate" app
STUB
chmod 755 "$APP/Contents/MacOS/HypergateApp"

# LSUIElement: a menu bar agent with no Dock icon, matching what the tray is.
# CFBundleExecutable uses the case-distinct stub name so it cannot collide with
# the lowercase `hypergate` CLI on a case-insensitive macOS filesystem.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Hypergate</string>
  <key>CFBundleDisplayName</key><string>Hypergate</string>
  <key>CFBundleIdentifier</key><string>app.hypergate.tray</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>HypergateApp</string>
  <key>CFBundleIconFile</key><string>hypergate.icns</string>
  <key>CFBundleIconName</key><string>hypergate</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

is_macho() {
  local magic
  magic="$(od -An -tx1 -N4 "$1" | tr -d ' \n')"
  case "$magic" in
    feedface|cefaedfe|feedfacf|cffaedfe|cafebabe|bebafeca|cafebabf|bfbafeca)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

assert_bundle_integrity() {
  local executable magic collisions
  executable="$(sed -n 's:.*<key>CFBundleExecutable</key><string>\([^<]*\)</string>.*:\1:p' \
    "$APP/Contents/Info.plist")"
  if [ -z "$executable" ] || [ ! -x "$APP/Contents/MacOS/$executable" ]; then
    echo "macOS bundle validation failed: CFBundleExecutable '$executable' is missing or not executable" >&2
    return 1
  fi
  for binary in hypergate hypergated; do
    if [ ! -f "$APP/Contents/MacOS/$binary" ] || ! is_macho "$APP/Contents/MacOS/$binary"; then
      magic="$(od -An -tx1 -N4 "$APP/Contents/MacOS/$binary" 2>/dev/null | tr -d ' \n' || true)"
      echo "macOS bundle validation failed: Contents/MacOS/$binary is not Mach-O (magic: ${magic:-missing})" >&2
      return 1
    fi
  done
  collisions="$(
    find "$APP" -mindepth 1 -print |
      sed "s#^$APP/##" |
      tr '[:upper:]' '[:lower:]' |
      sort |
      uniq -d
  )"
  if [ -n "$collisions" ]; then
    echo "macOS bundle validation failed: case-insensitive path collision(s): $collisions" >&2
    return 1
  fi
}

assert_bundle_integrity

# Code signing, when the workflow provides an identity. The two Mach-O binaries
# arrive already signed (the workflow signs them with hardened runtime before
# packaging); here the assembled bundle gets its seal, after Info.plist is
# written, because the plist is part of what codesign seals. Unset means a
# local unsigned build, unchanged.
#
# The web directory contains static assets (PNGs, etc.) that codesign rejects as
# unsigned code objects. Move it out before signing the bundle, then restore it.
if [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
  mv "$APP/Contents/MacOS/web" "$WORK/web"
  codesign --force --options runtime --timestamp \
    --sign "$MACOS_SIGN_IDENTITY" "$APP/Contents/MacOS/hypergate"
  codesign --force --options runtime --timestamp \
    --sign "$MACOS_SIGN_IDENTITY" "$APP/Contents/MacOS/hypergated"
  codesign --force --options runtime --timestamp \
    --sign "$MACOS_SIGN_IDENTITY" "$APP"
  mv "$WORK/web" "$APP/Contents/MacOS/web"
  assert_bundle_integrity
fi

# The CLI on PATH. A relative symlink, so it keeps working if the bundle is
# reinstalled and does not encode the build machine's layout.
ln -s "/Applications/Hypergate.app/Contents/MacOS/hypergate" "$ROOT/usr/local/bin/hypergate"
ln -s "/Applications/Hypergate.app/Contents/MacOS/hypergated" "$ROOT/usr/local/bin/hypergated"

mkdir -p "$WORK/pkg" "$WORK/resources"
cp "$PAYLOAD/LICENSE" "$WORK/resources/LICENSE.txt"

# Component package. --install-location / because the payload carries its own
# absolute layout (/Applications and /usr/local/bin).
pkgbuild \
  --root "$ROOT" \
  --identifier app.hypergate.tray \
  --version "$VERSION" \
  --install-location / \
  "$WORK/pkg/hypergate-component.pkg"

cat > "$WORK/distribution.xml" <<DIST
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Hypergate ${VERSION}</title>
  <license file="LICENSE.txt"/>
  <options customize="never" require-scripts="false" hostArchitectures="${ARCH}"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <choices-outline>
    <line choice="default"/>
  </choices-outline>
  <choice id="default" title="Hypergate">
    <pkg-ref id="app.hypergate.tray"/>
  </choice>
  <pkg-ref id="app.hypergate.tray" version="${VERSION}">hypergate-component.pkg</pkg-ref>
</installer-gui-script>
DIST

# Build unsigned, then productsign into place when an installer identity is
# set. Distribution signing is a separate certificate (Developer ID Installer)
# from app signing (Developer ID Application), hence the second variable.
if [ -n "${MACOS_INSTALLER_IDENTITY:-}" ]; then
  productbuild \
    --distribution "$WORK/distribution.xml" \
    --package-path "$WORK/pkg" \
    --resources "$WORK/resources" \
    "$WORK/unsigned.pkg"
  productsign --sign "$MACOS_INSTALLER_IDENTITY" "$WORK/unsigned.pkg" "$OUTPUT"
else
  productbuild \
    --distribution "$WORK/distribution.xml" \
    --package-path "$WORK/pkg" \
    --resources "$WORK/resources" \
    "$OUTPUT"
fi

echo "Built $OUTPUT"
