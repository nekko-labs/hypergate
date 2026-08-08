#!/bin/bash
# Build the Linux packages: .deb, .rpm and a plain tarball.
#
# One staged tree serves all three. Everything lands under /usr/lib/hypergate
# with symlinks into /usr/bin, which is not decoration: the shell finds the
# daemon as a sibling of itself, and the daemon finds the web UI beside its own
# executable. Splitting them across /usr/bin and /usr/lib would break both
# lookups, and `current_exe()` resolves the symlink so the sibling search still
# starts in the right directory.
#
# Usage: build-linux.sh <payload-dir> <version> <arch: amd64|arm64> <output-dir>
set -euo pipefail

PAYLOAD="${1:?payload directory required}"
VERSION="${2:?version required}"
DEB_ARCH="${3:?arch required}"
OUTDIR="${4:?output directory required}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "$DEB_ARCH" in
  amd64) RPM_ARCH=x86_64 ;;
  arm64) RPM_ARCH=aarch64 ;;
  *) echo "unknown arch $DEB_ARCH" >&2; exit 1 ;;
esac

ROOT="$WORK/root"
LIBDIR="$ROOT/usr/lib/hypergate"
mkdir -p "$LIBDIR" "$ROOT/usr/bin" "$ROOT/usr/share/applications" \
  "$ROOT/usr/share/icons/hicolor/scalable/apps" "$ROOT/usr/share/doc/hypergate"

install -m 755 "$PAYLOAD/hypergate" "$LIBDIR/hypergate"
install -m 755 "$PAYLOAD/hypergated" "$LIBDIR/hypergated"
cp -R "$PAYLOAD/web" "$LIBDIR/web"
install -m 644 "$PAYLOAD/LICENSE" "$ROOT/usr/share/doc/hypergate/LICENSE"
install -m 644 "$PAYLOAD/README.md" "$ROOT/usr/share/doc/hypergate/README.md"

ln -s ../lib/hypergate/hypergate "$ROOT/usr/bin/hypergate"
ln -s ../lib/hypergate/hypergated "$ROOT/usr/bin/hypergated"

# The icon comes out of the binary rather than a checked-in asset, the same
# source the tray and the Windows shortcut use.
"$PAYLOAD/hypergate" icon "$ROOT/usr/share/icons/hicolor/scalable/apps/hypergate.svg" >/dev/null

cat > "$ROOT/usr/share/applications/hypergate.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Hypergate
Comment=Local-first runtime and gateway for MCP servers
Exec=/usr/lib/hypergate/hypergate app
Icon=hypergate
Terminal=false
Categories=Development;Utility;
Keywords=MCP;AI;agent;gateway;
DESKTOP

mkdir -p "$OUTDIR"

# ── tarball ──────────────────────────────────────────────────────────────────
# For distributions we do not package for, and for anyone who would rather not
# install anything system-wide.
TARBALL="$OUTDIR/hypergate-${VERSION}-linux-${DEB_ARCH}.tar.gz"
tar -czf "$TARBALL" -C "$PAYLOAD" .
echo "Built $TARBALL"

# ── .deb ─────────────────────────────────────────────────────────────────────
DEBROOT="$WORK/deb"
cp -a "$ROOT" "$DEBROOT"
mkdir -p "$DEBROOT/DEBIAN"

# GTK and WebKitGTK are hard dependencies, not optional ones: the tray links GTK
# and the manager window links webkit2gtk at load time, and it is the same binary
# as the CLI, so `hypergate status` would fail to start without them. Both ship
# with every mainstream desktop; headless boxes should run the daemon alone.
cat > "$DEBROOT/DEBIAN/control" <<CONTROL
Package: hypergate
Version: ${VERSION}
Section: devel
Priority: optional
Architecture: ${DEB_ARCH}
Maintainer: Nekko Labs <philip@nekkolabs.com>
Depends: libc6, libgtk-3-0, libxdo3, libayatana-appindicator3-1 | libappindicator3-1, libwebkit2gtk-4.1-0
Homepage: https://hypergate.app
Description: Local-first runtime and gateway for MCP servers
 Run MCP servers securely, supervise them, and expose one gateway endpoint any
 agent harness can use. Includes the daemon, the tray agent, the command-line
 interface and the browser-based manager UI. No account, no cloud, and no
 outbound calls the user did not ask for.
CONTROL

cat > "$DEBROOT/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
command -v update-desktop-database >/dev/null 2>&1 &&
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 &&
  gtk-update-icon-cache -q -f /usr/share/icons/hicolor >/dev/null 2>&1 || true
exit 0
POSTINST
cat > "$DEBROOT/DEBIAN/postrm" <<'POSTRM'
#!/bin/sh
command -v update-desktop-database >/dev/null 2>&1 &&
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 &&
  gtk-update-icon-cache -q -f /usr/share/icons/hicolor >/dev/null 2>&1 || true
exit 0
POSTRM
chmod 755 "$DEBROOT/DEBIAN/postinst" "$DEBROOT/DEBIAN/postrm"

DEB="$OUTDIR/hypergate_${VERSION}_${DEB_ARCH}.deb"
# -Zxz, not the modern default of zstd: a zstd-compressed .deb needs dpkg 1.21+,
# so it fails to install on Ubuntu 20.04 and Debian 11. xz is understood
# everywhere and costs nothing here.
dpkg-deb -Zxz --root-owner-group --build "$DEBROOT" "$DEB" >/dev/null
echo "Built $DEB"

# ── .rpm ─────────────────────────────────────────────────────────────────────
if ! command -v rpmbuild >/dev/null 2>&1; then
  echo "note: rpmbuild not installed, skipping the .rpm"
  exit 0
fi

RPMTOP="$WORK/rpm"
mkdir -p "$RPMTOP"/{BUILD,RPMS,SOURCES,SPECS,BUILDROOT}
cat > "$RPMTOP/SPECS/hypergate.spec" <<SPEC
Name:           hypergate
Version:        ${VERSION}
Release:        1
Summary:        Local-first runtime and gateway for MCP servers
License:        MIT
URL:            https://hypergate.app
BuildArch:      ${RPM_ARCH}
Requires:       gtk3, xdotool, libappindicator-gtk3, webkit2gtk4.1
# The payload is already built; this spec only stages it.
%global _build_id_links none
%global __os_install_post %{nil}

%description
Run MCP servers securely, supervise them, and expose one gateway endpoint any
agent harness can use. Includes the daemon, the tray agent, the command-line
interface and the browser-based manager UI.

%install
cp -a ${ROOT}/. %{buildroot}/

%files
/usr/lib/hypergate
/usr/bin/hypergate
/usr/bin/hypergated
/usr/share/applications/hypergate.desktop
/usr/share/icons/hicolor/scalable/apps/hypergate.svg
%doc /usr/share/doc/hypergate/README.md
%license /usr/share/doc/hypergate/LICENSE

%post
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database /usr/share/applications >/dev/null 2>&1 || :; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -f /usr/share/icons/hicolor >/dev/null 2>&1 || :; fi

%postun
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database /usr/share/applications >/dev/null 2>&1 || :; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -f /usr/share/icons/hicolor >/dev/null 2>&1 || :; fi
SPEC

rpmbuild --define "_topdir $RPMTOP" -bb "$RPMTOP/SPECS/hypergate.spec" >/dev/null
find "$RPMTOP/RPMS" -name '*.rpm' -exec cp {} "$OUTDIR/" \;
echo "Built $(find "$OUTDIR" -name '*.rpm' -printf '%f\n' | head -1)"
