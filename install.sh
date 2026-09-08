#!/bin/sh
# Dim0 desktop installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/vcmf/dim0/main/install.sh | sh
#
# Downloads the newest release for your OS from GitHub. The macOS app is signed with
# a Developer ID and notarized, so it launches with no prompt from any download path
# (this terminal one and a browser .dmg alike). The quarantine strip below is now
# belt-and-suspenders rather than the thing that makes it work.
set -eu

REPO="vcmf/dim0"
API="https://api.github.com/repos/$REPO/releases/latest"

say() { printf '  %s\n' "$1"; }
die() { printf '\nDim0 install failed: %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"

printf '\nInstalling Dim0...\n'
json="$(curl -fsSL "$API")" || die "could not reach GitHub"
tag="$(printf '%s' "$json" | grep -oE '"tag_name": *"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
[ -n "${tag:-}" ] && say "latest release: $tag"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    [ "$arch" = "arm64" ] || die "only Apple Silicon (arm64) is built right now; yours is $arch"
    url="$(printf '%s' "$json" | grep -oE 'https://[^"]+-mac\.zip' | head -1)"
    [ -n "$url" ] || die "no macOS build found in $tag"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    say "downloading $(basename "$url")"
    curl -fsSL "$url" -o "$tmp/dim0.zip" || die "download failed"
    /usr/bin/ditto -x -k "$tmp/dim0.zip" "$tmp" || die "could not unzip"
    [ -d "$tmp/Dim0.app" ] || die "archive did not contain Dim0.app"
    dest="/Applications"
    [ -w "$dest" ] || dest="$HOME/Applications"
    mkdir -p "$dest"
    rm -rf "$dest/Dim0.app"
    mv "$tmp/Dim0.app" "$dest/Dim0.app"
    # Belt-and-suspenders: strip quarantine in case the file ever carried it.
    xattr -dr com.apple.quarantine "$dest/Dim0.app" 2>/dev/null || true
    say "installed to $dest/Dim0.app"
    printf '\nDone. Launch it from Spotlight, or: open "%s/Dim0.app"\n\n' "$dest"
    ;;
  Linux)
    url="$(printf '%s' "$json" | grep -oE 'https://[^"]+\.AppImage' | head -1)"
    [ -n "$url" ] || die "no Linux build found in $tag"
    dest="${DIM0_BIN:-$HOME/.local/bin}"
    mkdir -p "$dest"
    say "downloading $(basename "$url")"
    curl -fsSL "$url" -o "$dest/dim0" || die "download failed"
    chmod +x "$dest/dim0"
    say "installed to $dest/dim0"
    case ":$PATH:" in
      *":$dest:"*) : ;;
      *) printf '\nNote: %s is not on your PATH. Add it, or run %s/dim0 directly.\n' "$dest" "$dest" ;;
    esac
    printf '\nDone. Run: dim0\n\n'
    ;;
  *)
    die "unsupported OS: $os (this installer covers macOS and Linux; Windows uses install.ps1)"
    ;;
esac
