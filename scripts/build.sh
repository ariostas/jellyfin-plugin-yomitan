#!/usr/bin/env bash
# Builds the client, then the plugin inside the .NET SDK container, into out/plugin.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$root/scripts/lib/common.sh"

cd "$root/client"
[[ node_modules/.package-lock.json -nt package-lock.json ]] || npm ci --silent
npm run --silent build

rm -rf "$root/out/plugin"
dotnet_in_container publish src/Jellyfin.Plugin.Yomitan -c Release -o out/plugin --nologo -v quiet
echo "Built $root/out/plugin"
