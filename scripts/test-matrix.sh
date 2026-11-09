#!/usr/bin/env bash
# Runs the Playwright suite against every server configuration, each on a fresh server, and always cleans up. Pass
# scenario names to run only those. With none, it runs plain, base-url, ft-outer, ft-inner and ft-inner-base-url.
#
#   plain              every spec, in every browser of JF_MATRIX_BROWSERS
#   base-url           with BaseUrl /jf, the specs whose requests are built from it, in Chromium
#   ft-outer           with File Transformation outside our middleware, the specs that read index.html, in Chromium
#   ft-inner           the same with File Transformation inside it
#   ft-inner-base-url  the same with BaseUrl /jf as well
#   smoke              the specs tagged @smoke, in Chromium: what CI runs on main and pull requests
#   compat             the smoke set and every playback spec, in Chromium: what proves a server version
#   catalogue          installs the plugin from a repository through the dashboard, on a server without it, and
#                      upgrades it if given two zips. See tests/e2e/catalogue.spec.mjs
#   real               the specs that take real dictionaries, in Chromium, with those scripts/real-dicts.sh downloads
#
# A failed scenario keeps its server's log in tests/test-results/<server name>/server/.
#
# Environment:
#   JF_MATRIX_PORT      the first port (default 18110)
#   JF_MATRIX_BROWSERS  the Playwright projects of plain (default chromium firefox webkit android-chrome)
#   JF_IMAGE            the server image, as for scripts/dev.sh
#   YOMITAN_CATALOGUE_ZIPS  for catalogue, the zips to install, oldest first (default the one scripts/package.sh makes)
#   YOMITAN_REAL_DICTS  for real, a directory of the dictionaries (default the one scripts/real-dicts.sh fills)
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# name: environment for scripts/dev.sh and the tests
declare -A scenarios=(
    [plain]=""
    [base-url]="JF_BASE_URL=/jf"
    [ft-outer]="JF_WITH_FT=1 JF_FT_ORDER=outer"
    [ft-inner]="JF_WITH_FT=1 JF_FT_ORDER=inner"
    [ft-inner-base-url]="JF_WITH_FT=1 JF_FT_ORDER=inner JF_BASE_URL=/jf"
    [smoke]=""
    [compat]=""
    [catalogue]="JF_INSTALL=0"
    [real]=""
)
order=(plain base-url ft-outer ft-inner ft-inner-base-url)
read -r -a browsers <<<"${JF_MATRIX_BROWSERS:-chromium firefox webkit android-chrome}"
selected=("${@:-${order[@]}}")

# A BaseUrl changes every URL the client builds, through ApiClient.getUrl() or from the loader's own address, and where
# the server injects the loader. These specs make each of those requests in a browser: the loader and the engine
# (smoke, injection, playback), Stream.js and the queries (playback), the media API (popup), the settings page and the
# settings (user-page), and the dashboard page with its upload (admin-page). The rest call the API with the prefix,
# which is Jellyfin's routing, or do what they do the same under any address.
base_url_specs=(smoke injection playback popup user-page admin-page)

# File Transformation only rewrites index.html, so the specs that read it, through the server and in a browser.
ft_specs=(smoke injection file-transformation)

# The specs that take YOMITAN_REAL_DICTS. They skip what needs it when it is not set, so real always sets it.
real_specs=(parity-real segmentation-real popup-real dictionary-choice admin-page)

# Runs Playwright for one scenario, in tests/. It runs as the condition of an if, where set -e does nothing.
playwright_for() {
    case $1 in
        plain) npx playwright test "${browsers[@]/#/--project=}" ;;
        base-url) npx playwright test --project=chromium "${base_url_specs[@]/%/.spec.mjs}" ;;
        ft-*) npx playwright test --project=chromium "${ft_specs[@]/%/.spec.mjs}" ;;
        smoke) npx playwright test --project=chromium --grep @smoke ;;
        compat)
            local status=0
            npx playwright test --project=chromium --grep @smoke || status=1
            npx playwright test --project=chromium playback.spec.mjs || status=1
            return $status
            ;;
        catalogue)
            YOMITAN_CATALOGUE_ZIPS=${YOMITAN_CATALOGUE_ZIPS:-$("$root/scripts/package.sh" | head -n 1)} \
                npx playwright test --project=chromium catalogue.spec.mjs
            ;;
        real)
            local dicts
            dicts=${YOMITAN_REAL_DICTS:-$("$root/scripts/real-dicts.sh")} || return 1
            YOMITAN_REAL_DICTS=$dicts npx playwright test --project=chromium "${real_specs[@]/%/.spec.mjs}"
            ;;
    esac
}

# Keeps a failed scenario's server log beside its Playwright results, which CI uploads, before the reset deletes it: a
# server that dies in the middle of a run says why only there. Jellyfin writes its log and each FFmpeg's to config/log,
# and the container's own output adds what the process printed on the way down. Run in the scenario's environment.
save_server_log() {
    local results=$root/tests/test-results/$JF_NAME
    mkdir -p "$results/server"
    podman inspect --format \
        'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}} finished={{.State.FinishedAt}}' \
        "$JF_NAME" >"$results/server/state.txt" 2>&1 || true
    podman logs --timestamps "$JF_NAME" >"$results/server/console.log" 2>&1 || true
    cp -r "$root/.dev/$JF_NAME/config/log/." "$results/server/" 2>/dev/null || true
}

port=${JF_MATRIX_PORT:-18110}
failed=()

[[ -d $root/tests/node_modules ]] || npm ci --silent --prefix "$root/tests"
"$root/scripts/build.sh"

for scenario in "${selected[@]}"; do
    [[ -v "scenarios[$scenario]" ]] || { echo "Unknown scenario: $scenario"; exit 2; }
    echo "=== $scenario"
    name=jf-yomitan-matrix-$scenario

    # shellcheck disable=SC2086 # the scenario is a list of assignments
    if ! (
        export JF_NAME=$name JF_PORT=$port ${scenarios[$scenario]}
        trap '(($? == 0)) || save_server_log; "$root/scripts/dev.sh" reset' EXIT
        "$root/scripts/dev.sh" reset &&
            "$root/scripts/dev.sh" up &&
            cd "$root/tests" &&
            playwright_for "$scenario"
    ); then
        failed+=("$scenario")
    fi
    port=$((port + 1))
done

if ((${#failed[@]})); then
    echo "FAILED: ${failed[*]}"
    exit 1
fi
echo "All scenarios passed: ${selected[*]}"
