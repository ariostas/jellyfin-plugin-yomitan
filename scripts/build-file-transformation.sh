#!/usr/bin/env bash
# Builds the File Transformation plugin against this project's Jellyfin version, for coexistence tests.
# It has no release for 12.4. Output is .dev/file-transformation/out. Set FT_SRC to use a local clone.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$root/scripts/lib/common.sh"

commit=2dd4279bc7aedd082de0639278f9142ead229a52
repository=https://github.com/IAmParadox27/jellyfin-plugin-file-transformation.git
work=$root/.dev/file-transformation
out=$work/out

[[ -f $out/meta.json ]] && exit 0

rm -rf "$work"
mkdir -p "$work"
git clone --quiet "${FT_SRC:-$repository}" "$work/src"
git -C "$work/src" -c advice.detachedHead=false checkout --quiet "$commit"

jellyfin_version=$(sed -n 's|.*<JellyfinVersion>\(.*\)</JellyfinVersion>.*|\1|p' \
    "$root/src/Jellyfin.Plugin.Yomitan/Jellyfin.Plugin.Yomitan.csproj")

dotnet_in_container publish .dev/file-transformation/src/src/Jellyfin.Plugin.FileTransformation \
    -c Release -o .dev/file-transformation/out --nologo -v quiet \
    "-p:JellyfinVersion=$jellyfin_version"

# The server provides everything except Newtonsoft.Json, and a second copy of its assemblies would break
# plugin loading, so keep only what the plugin itself needs.
find "$out" -mindepth 1 -maxdepth 1 ! -name 'Jellyfin.Plugin.FileTransformation.dll' \
    ! -name 'Newtonsoft.Json.dll' -exec rm -rf {} +

cat >"$out/meta.json" <<JSON
{
  "category": "General",
  "guid": "5e87cc92-571a-4d8d-8d98-d2d4147f9f90",
  "name": "File Transformation",
  "overview": "",
  "owner": "IAmParadox27",
  "targetAbi": "$jellyfin_version.0",
  "timestamp": "0001-01-01T00:00:00.0000000Z",
  "version": "3.0.0.0",
  "status": "Active",
  "autoUpdate": false,
  "assemblies": []
}
JSON
echo "Built $out"
