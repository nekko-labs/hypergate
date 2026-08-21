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
DEVICE=""
cleanup() {
  if [ -n "$DEVICE" ]; then
    hdiutil detach "$DEVICE" -force >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

STAGING="$WORK/staging"
ROOT="$STAGING"
APP="$ROOT/Hypergate.app"
mkdir -p "$STAGING" "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Both binaries and the UI live inside the bundle, so the whole product is one
# self-contained thing the user can move or delete.
cp "$PAYLOAD/hypergate" "$APP/Contents/MacOS/hypergate"
cp "$PAYLOAD/hypergated" "$APP/Contents/MacOS/hypergated"
cp -R "$PAYLOAD/web" "$APP/Contents/Resources/web"
ln -s ../Resources/web "$APP/Contents/MacOS/web"
cp "$ICON" "$APP/Contents/Resources/hypergate.icns"
cp "$PAYLOAD/LICENSE" "$APP/Contents/Resources/LICENSE"
chmod 755 "$APP/Contents/MacOS/hypergate" "$APP/Contents/MacOS/hypergated"

# `web` lives in Resources, with a relative link beside hypergated so the
# daemon's installed-layout lookup resolves to the sealed resource.

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

ln -s /Applications "$STAGING/Applications"

cat > "$WORK/background.swift" <<'SWIFT'
import AppKit

let size = NSSize(width: 660, height: 400)
let image = NSImage(size: size)
image.lockFocus()

let rect = NSRect(origin: .zero, size: size)
NSGradient(colors: [
  NSColor(calibratedRed: 0.025, green: 0.035, blue: 0.090, alpha: 1),
  NSColor(calibratedRed: 0.055, green: 0.055, blue: 0.160, alpha: 1),
  NSColor(calibratedRed: 0.025, green: 0.100, blue: 0.155, alpha: 1),
])!.draw(in: rect, angle: -18)

func glow(_ frame: NSRect, _ color: NSColor) {
  NSGradient(starting: color, ending: color.withAlphaComponent(0))!
    .draw(in: frame, relativeCenterPosition: .zero)
}

glow(NSRect(x: 45, y: 45, width: 270, height: 270), NSColor(calibratedRed: 0.38, green: 0.24, blue: 1, alpha: 0.32))
glow(NSRect(x: 355, y: 35, width: 270, height: 270), NSColor(calibratedRed: 0.05, green: 0.78, blue: 1, alpha: 0.22))

let stars: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
  (35, 335, 2, 0.55), (82, 306, 1, 0.45), (128, 350, 1.5, 0.72),
  (220, 318, 1, 0.55), (278, 345, 2, 0.58), (355, 320, 1, 0.52),
  (420, 352, 1.5, 0.62), (516, 324, 1, 0.48), (603, 350, 2, 0.58),
  (628, 288, 1, 0.48), (45, 96, 1.5, 0.52), (110, 54, 1, 0.45),
  (246, 78, 2, 0.42), (337, 45, 1, 0.5), (445, 72, 1.5, 0.48),
  (566, 52, 1, 0.45), (622, 105, 2, 0.46),
]
for (x, y, radius, alpha) in stars {
  NSColor.white.withAlphaComponent(alpha).setFill()
  NSBezierPath(ovalIn: NSRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)).fill()
}

for (diameter, alpha, width) in [(190.0, 0.11, 2.0), (160.0, 0.18, 2.5), (132.0, 0.32, 3.0)] {
  let ring = NSBezierPath(ovalIn: NSRect(x: 175 - diameter / 2, y: 170 - diameter / 2, width: diameter, height: diameter))
  ring.lineWidth = width
  NSColor(calibratedRed: 0.48, green: 0.58, blue: 1, alpha: alpha).setStroke()
  ring.stroke()
}

func arrowPath(_ shift: CGFloat) -> NSBezierPath {
  let path = NSBezierPath()
  path.move(to: NSPoint(x: 267, y: 177 + shift))
  path.curve(to: NSPoint(x: 399, y: 178 + shift), controlPoint1: NSPoint(x: 304, y: 207 + shift), controlPoint2: NSPoint(x: 357, y: 148 + shift))
  path.lineCapStyle = .round
  path.lineJoinStyle = .round
  return path
}

let shadow = arrowPath(-2)
shadow.lineWidth = 12
NSColor.black.withAlphaComponent(0.32).setStroke()
shadow.stroke()

for (shift, alpha, width) in [(-1.5, 0.30, 7.5), (1.0, 0.95, 4.5)] {
  let path = arrowPath(shift)
  path.lineWidth = width
  NSColor(calibratedRed: 0.20, green: 0.88, blue: 1, alpha: alpha).setStroke()
  path.stroke()
}

let arrowHead = NSBezierPath()
arrowHead.move(to: NSPoint(x: 374, y: 204))
arrowHead.line(to: NSPoint(x: 401, y: 178))
arrowHead.line(to: NSPoint(x: 370, y: 160))
arrowHead.lineCapStyle = .round
arrowHead.lineJoinStyle = .round
arrowHead.lineWidth = 5
NSColor(calibratedRed: 0.20, green: 0.88, blue: 1, alpha: 0.95).setStroke()
arrowHead.stroke()

let style = NSMutableParagraphStyle()
style.alignment = .center
let text = "Drag it over into the Applications folder" as NSString
text.draw(in: NSRect(x: 35, y: 332, width: 590, height: 34), withAttributes: [
  .font: NSFont.systemFont(ofSize: 22, weight: .semibold),
  .foregroundColor: NSColor.white.withAlphaComponent(0.96),
  .paragraphStyle: style,
])

let accent = NSBezierPath()
accent.move(to: NSPoint(x: 249, y: 319))
accent.curve(to: NSPoint(x: 411, y: 319), controlPoint1: NSPoint(x: 295, y: 312), controlPoint2: NSPoint(x: 365, y: 326))
accent.lineCapStyle = .round
accent.lineWidth = 2
NSColor(calibratedRed: 0.34, green: 0.72, blue: 1, alpha: 0.35).setStroke()
accent.stroke()

for frame in [NSRect(x: 110, y: 80, width: 130, height: 30), NSRect(x: 420, y: 80, width: 130, height: 30)] {
  NSColor(calibratedRed: 0.88, green: 0.94, blue: 1, alpha: 0.82).setFill()
  NSBezierPath(roundedRect: frame, xRadius: 15, yRadius: 15).fill()
}

image.unlockFocus()
guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
  fatalError("could not render the DMG background")
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
SWIFT

swift "$WORK/background.swift" "$APP/Contents/Resources/dmg-background.png"

# Code signing, when the workflow provides an identity. The two Mach-O binaries
# arrive already signed (the workflow signs them with hardened runtime before
# packaging); here the assembled bundle gets its seal, after every resource and
# Info.plist are in place. Unset means a local unsigned build, unchanged.
if [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
  # The Rust shell does not JIT, so keep its hardened-runtime signature tight.
  codesign --force --options runtime --timestamp \
    --sign "$MACOS_SIGN_IDENTITY" "$APP/Contents/MacOS/hypergate"
  # Node/V8 needs these entitlements to reserve and populate its JIT code range.
  codesign --force --options runtime --timestamp \
    --entitlements "$DAEMON_ENTITLEMENTS" \
    --sign "$MACOS_SIGN_IDENTITY" "$APP/Contents/MacOS/hypergated"
  codesign --force --options runtime --timestamp \
    --sign "$MACOS_SIGN_IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=4 "$APP"
fi

auto_layout_dmg="$WORK/layout.dmg"
VOLNAME="Hypergate $VERSION"
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGING" -format UDRW -ov "$auto_layout_dmg"
ATTACH_OUTPUT="$(hdiutil attach -readwrite -noverify -noautoopen "$auto_layout_dmg")"
DEVICE="$(printf '%s\n' "$ATTACH_OUTPUT" | awk '/^\/dev\// { print $1; exit }')"
MOUNT="$(printf '%s\n' "$ATTACH_OUTPUT" | awk -F '\t' 'NF >= 3 && $3 != "" { print $3; exit }')"
if [ -z "$DEVICE" ] || [ -z "$MOUNT" ] || [ ! -d "$MOUNT" ]; then
  echo "macOS disk image layout failed: no mounted device or volume" >&2
  exit 1
fi

osascript - "$VOLNAME" <<'APPLESCRIPT'
on run argv
  set volumeName to item 1 of argv
  tell application "Finder"
    set dmgDisk to disk volumeName
    tell dmgDisk
      open
      delay 1
      set dmgWindow to container window
      set current view of dmgWindow to icon view
      set bounds of dmgWindow to {100, 100, 760, 522}
      set toolbar visible of dmgWindow to false
      set statusbar visible of dmgWindow to false
      set pathbar visible of dmgWindow to false
      set sidebar width of dmgWindow to 0
      set viewOptions to icon view options of dmgWindow
      set arrangement of viewOptions to not arranged
      set icon size of viewOptions to 112
      set background picture of viewOptions to file "Hypergate.app:Contents:Resources:dmg-background.png"
      set position of item "Hypergate.app" of dmgWindow to {175, 230}
      set position of item "Applications" of dmgWindow to {485, 230}
      update without registering applications
      delay 2
      close dmgWindow
    end tell
  end tell
  delay 1
end run
APPLESCRIPT

rm -rf "$MOUNT/.fseventsd"
sync
# Finder's diskimages-help can still hold the volume for a few seconds after the
# window closes, and a plain detach then fails with "Resource busy". Wait it out
# rather than forcing immediately: a forced detach can drop the layout Finder has
# not flushed yet, which is the whole point of this mount.
detach_attempt=1
until hdiutil detach "$DEVICE" >/dev/null 2>&1; do
  if [ "$detach_attempt" -ge 10 ]; then
    echo "macOS disk image layout: volume still busy after 10 attempts, forcing detach" >&2
    hdiutil detach "$DEVICE" -force
    break
  fi
  detach_attempt=$((detach_attempt + 1))
  sleep 3
done
DEVICE=""
hdiutil convert "$auto_layout_dmg" -format UDZO -imagekey zlib-level=9 -o "$WORK/final.dmg"

# The image is read-only after creation. The app itself is signed above; a DMG
# is not an installer package and therefore uses the application identity too.
if [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$MACOS_SIGN_IDENTITY" "$WORK/final.dmg"
fi
mv "$WORK/final.dmg" "$OUTPUT"

echo "Built $OUTPUT"
