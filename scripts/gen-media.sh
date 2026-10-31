#!/usr/bin/env bash
# Generates the test media into .dev/media, unless it is already there. Uses the ffmpeg in the Jellyfin
# image, so every server sees files that image can read.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$root/scripts/lib/common.sh"

media=$root/.dev/media
[[ -d $media ]] && exit 0

# Built in a temporary directory so a failed or parallel run never leaves a half-made library behind.
work=$(mktemp -d "$root/.dev/media.XXXXXX")
trap 'rm -rf "$work"' EXIT

echo "Generating test media"
podman run --rm \
    --entrypoint /bin/sh \
    -v "$work:/out:Z" \
    -v "$root/tests/fixtures:/fixtures:ro,z" \
    "$jellyfin_image" -euc '
        ffmpeg="/usr/lib/jellyfin-ffmpeg/ffmpeg -hide_banner -loglevel error -y"
        source="-f lavfi -i testsrc=size=640x360:rate=24:duration=60 -f lavfi -i sine=frequency=440:duration=60"
        vp9="-c:v libvpx-vp9 -pix_fmt yuv420p -deadline realtime -cpu-used 8 -b:v 300k -c:a libopus -b:a 48k"

        # VP9 and Opus with a sidecar SRT: direct plays in Chromium.
        srt="/out/Movies/SrtSample (2026)"
        mkdir -p "$srt"
        $ffmpeg $source $vp9 "$srt/SrtSample (2026).webm"
        cp /fixtures/sample.ja.srt "$srt/SrtSample (2026).ja.srt"

        # Embedded ASS.
        ass="/out/Movies/AssSample (2026)"
        mkdir -p "$ass"
        $ffmpeg $source -i /fixtures/sample.ass -map 0:v -map 1:a -map 2:s $vp9 -c:s ass \
            -metadata:s:s:0 language=jpn "$ass/AssSample (2026).mkv"

        # HEVC with AC-3: forces a transcode in Chromium.
        transcode="/out/Movies/TranscodeSample (2026)"
        mkdir -p "$transcode"
        $ffmpeg $source -c:v libx265 -preset ultrafast -x265-params log-level=error -pix_fmt yuv420p \
            -c:a ac3 "$transcode/TranscodeSample (2026).mkv"
        cp /fixtures/sample.ja.srt "$transcode/TranscodeSample (2026).ja.srt"
    '

mv "$work" "$media" 2>/dev/null || true
trap - EXIT
rm -rf "$work"
chmod -R a+rX "$media"
