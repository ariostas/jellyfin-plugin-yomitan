# shellcheck shell=bash disable=SC2034,SC2154
# Shared by the scripts in scripts/. Expects $root to be the repository root.

# Pinned by digest, because the compiler and runtime versions go into the DLL's embedded PDB: another SDK makes another
# zip from the same commit, and a release that is run again must make the zip it already published. 10.0.403 made 0.1.0.
sdk_image=${JF_SDK_IMAGE:-mcr.microsoft.com/dotnet/sdk:10.0.403@sha256:de4fe90a98845d75910b9769662465c84de1a934665c431279d1382b2bddc02b}

# Runs dotnet in the SDK image with the repository as the working directory. These volumes use :z, not
# :Z, because parallel builds share them.
dotnet_in_container() {
    mkdir -p "$root/.dev/nuget"
    podman run --rm \
        -v "$root:/repo:z" \
        -v "$root/.dev/nuget:/root/.nuget/packages:z" \
        -w /repo \
        -e DOTNET_CLI_TELEMETRY_OPTOUT=1 \
        -e DOTNET_NOLOGO=1 \
        "$sdk_image" dotnet "$@"
}

# The server the tests run on, pinned so that a new release shows up in the scheduled CI first, and not as a failure on
# a push. Keep it on a full tag, which never moves. JF_IMAGE=oldest is the oldest supported, which is JellyfinVersion in
# the csproj, and the one image of that version that the release and the weekly run test on.
oldest_jellyfin_image=docker.io/jellyfin/jellyfin:12.0.20260908-012347
jellyfin_image=${JF_IMAGE:-docker.io/jellyfin/jellyfin:12.4.20261026-211555}
if [[ $jellyfin_image == oldest ]]; then
    jellyfin_image=$oldest_jellyfin_image
    # Its major and minor version are JellyfinVersion's, so that a change to one fails until the other follows.
    jellyfin_version=$(sed -n 's|.*<JellyfinVersion>\(.*\)</JellyfinVersion>.*|\1|p' \
        "$root/src/Jellyfin.Plugin.Yomitan/Jellyfin.Plugin.Yomitan.csproj")
    if [[ ${jellyfin_image##*:} != "${jellyfin_version%.*}".* ]]; then
        echo "The oldest image, $jellyfin_image, is not JellyfinVersion $jellyfin_version" >&2
        exit 1
    fi
fi
