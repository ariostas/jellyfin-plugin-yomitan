#!/usr/bin/env bash
# Runs a disposable Jellyfin with the built plugin installed.
#
#   scripts/dev.sh up      (re)start the server with out/plugin, building it if missing
#   scripts/dev.sh down    stop and remove the container, keeping its state
#   scripts/dev.sh logs    follow the server log
#   scripts/dev.sh reset   remove the container and its state
#
# Environment:
#   JF_NAME          container name, also the state directory under .dev/ (default jf-yomitan)
#   JF_PORT          port on 127.0.0.1 (default 18096)
#   JF_BASE_URL      server BaseUrl, for example /jf (default none)
#   JF_WITH_FT       1 installs File Transformation (default 0)
#   JF_FT_ORDER      where File Transformation's middleware sits relative to ours: outer (default, what
#                    the real plugin names give) or inner. The server orders plugins by manifest name.
#   JF_IMAGE         server image
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$root/scripts/lib/common.sh"

name=${JF_NAME:-jf-yomitan}
port=${JF_PORT:-18096}
base_url=${JF_BASE_URL:-}
state=$root/.dev/$name
plugins=$state/config/plugins

set_base_url() {
    local file=$state/config/config/network.xml
    if [[ -f $file ]]; then
        sed -i -E "s|<BaseUrl( ?/>\|>.*</BaseUrl>)|<BaseUrl>$base_url</BaseUrl>|" "$file"
    else
        mkdir -p "$(dirname "$file")"
        printf '<?xml version="1.0" encoding="utf-8"?>\n<NetworkConfiguration>\n  <BaseUrl>%s</BaseUrl>\n</NetworkConfiguration>\n' \
            "$base_url" >"$file"
    fi
}

install_plugins() {
    local version
    version=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$root/out/plugin/meta.json")

    mkdir -p "$plugins"
    find "$plugins" -mindepth 1 -maxdepth 1 -type d ! -name configurations -exec rm -rf {} +
    cp -r "$root/out/plugin" "$plugins/Yomitan_$version"

    if [[ ${JF_WITH_FT:-0} == 1 ]]; then
        "$root/scripts/build-file-transformation.sh"
        cp -r "$root/.dev/file-transformation/out" "$plugins/FileTransformation_3.0.0.0"
        if [[ ${JF_FT_ORDER:-outer} == inner ]]; then
            sed -i 's/"name": "File Transformation"/"name": "Zz File Transformation"/' \
                "$plugins/FileTransformation_3.0.0.0/meta.json"
        fi
    fi
}

up() {
    [[ -f $root/out/plugin/meta.json ]] || "$root/scripts/build.sh"
    "$root/scripts/gen-media.sh"

    podman rm --force --ignore "$name" >/dev/null
    mkdir -p "$state/config" "$state/cache"
    set_base_url
    install_plugins

    podman run --detach --name "$name" \
        --publish "127.0.0.1:$port:8096" \
        --volume "$state/config:/config:Z" \
        --volume "$state/cache:/cache:Z" \
        --volume "$root/.dev/media:/media:ro,z" \
        "$jellyfin_image" >/dev/null

    node "$root/scripts/lib/provision.mjs" "http://127.0.0.1:$port$base_url"
    echo "Jellyfin is at http://127.0.0.1:$port$base_url/web/ (spike / spike)"
}

down() {
    podman rm --force --ignore "$name" >/dev/null
}

reset() {
    down
    if [[ -e $state ]]; then
        podman unshare rm -rf "$state"
    fi
}

case ${1:-} in
    up | down | reset) "$1" ;;
    logs) podman logs --follow "$name" ;;
    *)
        sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
        exit 2
        ;;
esac
