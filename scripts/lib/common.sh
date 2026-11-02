# shellcheck shell=bash disable=SC2034,SC2154
# Shared by the scripts in scripts/. Expects $root to be the repository root.

sdk_image=${JF_SDK_IMAGE:-mcr.microsoft.com/dotnet/sdk:10.0}

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
# a push. Keep it on a full tag, which never moves. The oldest supported is in the csproj, as JellyfinVersion.
jellyfin_image=${JF_IMAGE:-docker.io/jellyfin/jellyfin:12.4.20261026-211555}
