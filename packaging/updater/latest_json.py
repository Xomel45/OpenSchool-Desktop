#!/usr/bin/env python3
"""Write latest.json, the manifest the app's updater reads (tauri-plugin-updater), from the signed release files.

    latest_json.py DIST_DIR VERSION TAG [REPO]  ->  DIST_DIR/latest.json

Every update file needs its `.sig` next to it (made by `cargo tauri build` with createUpdaterArtifacts and
TAURI_SIGNING_PRIVATE_KEY set). Files without a signature are left out; no signed file at all is an error.
"""
import datetime
import json
import pathlib
import re
import sys
import urllib.parse

# file name pattern -> the updater targets it serves ("{os}-{arch}" is what builds without a bundle mark ask for)
TARGETS = [
    (r'_amd64\.AppImage$', ['linux-x86_64-appimage', 'linux-x86_64']),
    (r'_x64-setup\.exe$', ['windows-x86_64-nsis', 'windows-x86_64']),
    (r'_x64_[A-Za-z-]+\.msi$', ['windows-x86_64-msi']),
    (r'_x86-setup\.exe$', ['windows-i686-nsis', 'windows-i686']),
]


def build(dist: pathlib.Path, version: str, tag: str, repo: str, now: str) -> dict:
    platforms = {}
    for f in sorted(dist.iterdir()):
        for pattern, targets in TARGETS:
            sig = f.with_name(f.name + '.sig')
            if re.search(pattern, f.name) and sig.is_file():
                url = f'https://github.com/{repo}/releases/download/{urllib.parse.quote(tag)}/{urllib.parse.quote(f.name)}'
                for t in targets:
                    platforms.setdefault(t, {'signature': sig.read_text().strip(), 'url': url})
    if not platforms:
        raise SystemExit('no signed update files in ' + str(dist))
    return {'version': version, 'notes': f'Что нового: https://github.com/{repo}/releases/tag/{tag}', 'pub_date': now, 'platforms': platforms}


if __name__ == '__main__':
    dist, version, tag = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    repo = sys.argv[4] if len(sys.argv) > 4 else 'Xomel45/OpenSchool-Desktop'
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    manifest = build(dist, version, tag, repo, now)
    (dist / 'latest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(', '.join(sorted(manifest['platforms'])))
