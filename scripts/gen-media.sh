#!/usr/bin/env bash
# Generates the test media into .dev/media, unless it is already there. Uses the ffmpeg in the Jellyfin
# image, so every server sees files that image can read.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$root/scripts/lib/common.sh"

media=$root/.dev/media
stamp=$(cat "$root/scripts/gen-media.sh" "$root/tests/lib/pgs.mjs" "$root"/tests/fixtures/*.ass "$root"/tests/fixtures/*.srt | sha256sum | cut -d' ' -f1)
[[ -f $media/.stamp && $(cat "$media/.stamp") == "$stamp" ]] && exit 0

# Built in a temporary directory so a failed or parallel run never leaves a half-made library behind.
work=$(mktemp -d "$root/.dev/media.XXXXXX")
trap 'rm -rf "$work"' EXIT

echo "Generating test media"
node --input-type=module -e "
    import {writeFileSync} from 'node:fs';
    import {makePgs} from '$root/tests/lib/pgs.mjs';
    writeFileSync('$work/sample.sup', makePgs(2, 50));
"
podman run --rm \
    --entrypoint /bin/sh \
    -v "$work:/out:Z" \
    -v "$root/tests/fixtures:/fixtures:ro,z" \
    -v "$work:/work:z" \
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
        cp /fixtures/sync.ja.srt "$transcode/TranscodeSample (2026).ja.srt"
        cp /fixtures/sync.en.srt "$transcode/TranscodeSample (2026).en.srt"

        # Many cues on a fixed grid, and every kind of track the client has to tell apart.
        tracks="/out/Movies/TracksSample (2026)"
        mkdir -p "$tracks"
        $ffmpeg $source $vp9 "$tracks/TracksSample (2026).webm"
        cp /fixtures/sync.ja.srt "$tracks/TracksSample (2026).ja.srt"
        cp /fixtures/sync.en.srt "$tracks/TracksSample (2026).en.srt"
        cp /fixtures/untagged-japanese.srt "$tracks/TracksSample (2026).unlabelled.srt"
        cp /fixtures/untagged-chinese.srt "$tracks/TracksSample (2026).hanzi.srt"

        # Everything a fansub release does in one ASS file.
        typeset="/out/Movies/TypesetSample (2026)"
        mkdir -p "$typeset"
        $ffmpeg $source -i /fixtures/typeset.ass -map 0:v -map 1:a -map 2:s $vp9 -c:s ass \
            -metadata:s:s:0 language=jpn "$typeset/TypesetSample (2026).mkv"

        # An image subtitle stream, tagged Japanese so only its format can rule it out.
        image="/out/Movies/ImageSample (2026)"
        mkdir -p "$image"
        $ffmpeg $source -i /work/sample.sup -map 0:v -map 1:a -map 2:s $vp9 -c:s copy \
            -metadata:s:s:0 language=jpn "$image/ImageSample (2026).mkv"

        # Two episodes, for going from one to the next.
        show="/out/Shows/Sample Show/Season 01"
        mkdir -p "$show"
        for episode in 1 2; do
            name="Sample Show S01E0$episode"
            ffmpeg_source="-f lavfi -i testsrc=size=640x360:rate=24:duration=30 -f lavfi -i sine=frequency=440:duration=30"
            $ffmpeg $ffmpeg_source $vp9 "$show/$name.webm"
            cp "/fixtures/episode$episode.ja.srt" "$show/$name.ja.srt"
        done
    '

rm "$work/sample.sup"
echo "$stamp" >"$work/.stamp"
chmod -R a+rX "$work"

# Running servers keep the old directory open and are unaffected. A parallel run may have won the race.
rm -rf "$media"
mv "$work" "$media" 2>/dev/null || true
trap - EXIT
rm -rf "$work"
