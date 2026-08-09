#!/bin/bash
# Build the macOS drag-to-Applications disk image.
#
# Usage: build-dmg.sh <payload-dir> <version> <output.dmg> <icon.icns>
set -euo pipefail

PAYLOAD="${1:?payload directory required}"
VERSION="${2:?version required}"
OUTPUT="${3:?output path required}"
ICON="${4:?icns path required}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DAEMON_ENTITLEMENTS="$SCRIPT_DIR/hypergate-daemon.entitlements.plist"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

STAGING="$WORK/staging"
ROOT="$STAGING"
APP="$ROOT/Hypergate.app"
mkdir -p "$STAGING" "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Both binaries and the UI live inside the bundle, so the whole product is one
# self-contained thing the user can move or delete.
cp "$PAYLOAD/hypergate" "$APP/Contents/MacOS/hypergate"
cp "$PAYLOAD/hypergated" "$APP/Contents/MacOS/hypergated"
cp -R "$PAYLOAD/web" "$APP/Contents/MacOS/web"
cp "$ICON" "$APP/Contents/Resources/hypergate.icns"
cp "$PAYLOAD/LICENSE" "$APP/Contents/Resources/LICENSE"
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

cat > "$APP/Contents/Resources/uninstall.sh" <<'UNINSTALL'
#!/bin/sh
set -eu
APP="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
BIN="$APP/Contents/MacOS/hypergate"
if [ -x "$BIN" ]; then
  "$BIN" stop || true
  "$BIN" autostart off || true
  "$BIN" shortcut uninstall || true
fi
rm -rf "$APP"
UNINSTALL
chmod 755 "$APP/Contents/Resources/uninstall.sh"

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
  # The Rust shell does not JIT, so keep its hardened-runtime signature tight.
  codesign --force --options runtime --timestamp \
    --sign "$MACOS_SIGN_IDENTITY" "$APP/Contents/MacOS/hypergate"
  # Node/V8 needs these entitlements to reserve and populate its JIT code range.
  codesign --force --options runtime --timestamp \
    --entitlements "$DAEMON_ENTITLEMENTS" \
    --sign "$MACOS_SIGN_IDENTITY" "$APP/Contents/MacOS/hypergated"
  codesign --force --options runtime --timestamp \
    --sign "$MACOS_SIGN_IDENTITY" "$APP"
  mv "$WORK/web" "$APP/Contents/MacOS/web"
  assert_bundle_integrity
fi

ln -s /Applications "$STAGING/Applications"

# The image is read-only after creation. The app itself is signed above; a DMG
# is not an installer package and therefore uses the application identity too.
hdiutil create -volname Hypergate -srcfolder "$STAGING" -format UDZO -ov "$WORK/unsigned.dmg"
if [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$MACOS_SIGN_IDENTITY" "$WORK/unsigned.dmg"
fi
mv "$WORK/unsigned.dmg" "$OUTPUT"

echo "Built $OUTPUT"
