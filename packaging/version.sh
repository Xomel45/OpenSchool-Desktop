#!/usr/bin/env bash
# The app's version lives in one place: src-tauri/Cargo.toml. Tauri (tauri.conf.json has no version), the binary
# (CARGO_PKG_VERSION) and Nix (package.nix reads Cargo.toml) take it from there by themselves. The Arch files cannot read it, so
# this script writes it into them.
#   packaging/version.sh            print the version
#   packaging/version.sh --sync     write it into packaging/arch/PKGBUILD and .SRCINFO (pkgrel back to 1 when the version changes)
#   packaging/version.sh --check [TAG]  fail if the Arch files (or the tag, given as vX.Y.Z) say another version
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
version=$(sed -n '/^\[package\]/,/^\[/{s/^version = "\(.*\)"/\1/p}' "$root/src-tauri/Cargo.toml" | head -1)
[[ -n $version ]] || { echo "no version in src-tauri/Cargo.toml" >&2; exit 1; }
pkgbuild="$root/packaging/arch/PKGBUILD"
srcinfo="$root/packaging/arch/.SRCINFO"
arch_version() { sed -n 's/^pkgver=//p' "$pkgbuild"; }

case "${1:-}" in
  "") echo "$version" ;;
  --sync)
    if [[ $(arch_version) != "$version" ]]; then
      sed -i "s/^pkgver=.*/pkgver=$version/; s/^pkgrel=.*/pkgrel=1/" "$pkgbuild"
      sed -i "s/^\tpkgver = .*/\tpkgver = $version/; s/^\tpkgrel = .*/\tpkgrel = 1/; s/#tag=v[^\t ]*/#tag=v$version/" "$srcinfo"
    fi
    echo "$version" ;;
  --check)
    bad=0
    tag=${2:-}
    if [[ -n $tag && ${tag#v} != "$version" ]]; then echo "tag $tag != Cargo.toml $version" >&2; bad=1; fi
    if [[ $(arch_version) != "$version" ]]; then echo "PKGBUILD $(arch_version) != Cargo.toml $version (run packaging/version.sh --sync)" >&2; bad=1; fi
    if ! grep -q "^	pkgver = $version\$" "$srcinfo" || ! grep -q "#tag=v$version" "$srcinfo"; then
      echo ".SRCINFO is not at $version (run packaging/version.sh --sync)" >&2; bad=1
    fi
    [[ $bad == 0 ]] && echo "$version"
    exit $bad ;;
  *) echo "usage: $0 [--sync | --check [TAG]]" >&2; exit 2 ;;
esac
