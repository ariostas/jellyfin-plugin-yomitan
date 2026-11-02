#!/usr/bin/env bash
# Zips out/plugin, as scripts/build.sh left it, into out/release/yomitan_<version>.zip, the file a plugin repository
# points at, and prints its MD5, which is the checksum the server checks. The same commit gives the same zip.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
plugin=$root/out/plugin
expected=(Jellyfin.Plugin.Yomitan.dll LICENSE THIRD-PARTY-NOTICES.md meta.json)

# Exactly what the server needs, and nothing a build left behind.
actual=$(cd "$plugin" && find . -mindepth 1 -printf '%P\n' | LC_ALL=C sort)
if [[ $actual != "$(printf '%s\n' "${expected[@]}")" ]]; then
    echo "out/plugin should hold exactly ${expected[*]}, and holds:" >&2
    echo "$actual" >&2
    exit 1
fi

version=$(node -p "require('$plugin/meta.json').version")
zip=$root/out/release/yomitan_$version.zip
mkdir -p "$root/out/release"
rm -f "$zip"

# A zip stores each file's time, so they take the commit's.
stamp=$(git -C "$root" log -1 --format=%ct)
work=$(mktemp -d "$root/out/release/.package.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp "${expected[@]/#/$plugin/}" "$work/"
chmod 644 "$work"/*
touch --date="@$stamp" "$work"/*
(cd "$work" && TZ=UTC zip --quiet -X "$zip" "${expected[@]}")

echo "$zip"
md5sum "$zip" | cut -d' ' -f1
