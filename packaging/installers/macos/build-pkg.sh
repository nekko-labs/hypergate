#!/bin/bash
# Build the macOS installer package.
#
# A .pkg rather than a .dmg: Hypergate is a tray agent *and* a CLI, so it needs
# to put a binary on PATH as well as an app in /Applications. A drag-to-install
# .dmg cannot do the former, and asking people to drag an app and then also run
# a shell command is worse than one double-click.
#
# Usage: build-pkg.sh <payload-dir> <version> <arch> <output.pkg>
set -euo pipefail

PAYLOAD="${1:?payload directory required}"
VERSION="${2:?version required}"
ARCH="${3:?arch required}"
OUTPUT="${4:?output path required}"

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
cp "$PAYLOAD/LICENSE" "$APP/Contents/Resources/LICENSE"
chmod 755 "$APP/Contents/MacOS/hypergate" "$APP/Contents/MacOS/hypergated"

# `web` sits beside hypergated because that is where the daemon looks: it
# resolves the UI relative to process.execPath when it is a compiled binary.

# An app bundle's executable takes no arguments, so a stub supplies `tray`.
cat > "$APP/Contents/MacOS/Hypergate" <<'STUB'
#!/bin/sh
exec "$(dirname "$0")/hypergate" tray
STUB
chmod 755 "$APP/Contents/MacOS/Hypergate"

# LSUIElement: a menu bar agent with no Dock icon, matching what the tray is.
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
  <key>CFBundleExecutable</key><string>Hypergate</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

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

productbuild \
  --distribution "$WORK/distribution.xml" \
  --package-path "$WORK/pkg" \
  --resources "$WORK/resources" \
  "$OUTPUT"

echo "Built $OUTPUT"
