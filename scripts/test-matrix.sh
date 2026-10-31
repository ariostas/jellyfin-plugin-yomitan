#!/usr/bin/env bash
# Runs the Playwright suite against every server configuration, each on a fresh server, and always cleans
# up. Pass scenario names to run only those. JF_MATRIX_PORT sets the first port (default 18110). The plain server gets
# every browser, and the others Chromium: they differ in how the page reaches the browser, and not in what it does there.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# name: environment for scripts/dev.sh and the tests
declare -A scenarios=(
    [plain]=""
    [base-url]="JF_BASE_URL=/jf"
    [ft-outer]="JF_WITH_FT=1 JF_FT_ORDER=outer"
    [ft-inner]="JF_WITH_FT=1 JF_FT_ORDER=inner"
    [ft-inner-base-url]="JF_WITH_FT=1 JF_FT_ORDER=inner JF_BASE_URL=/jf"
)
order=(plain base-url ft-outer ft-inner ft-inner-base-url)
every_browser=(--project=chromium --project=firefox --project=webkit --project=android-chrome)
selected=("${@:-${order[@]}}")

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
        trap '"$root/scripts/dev.sh" reset' EXIT
        "$root/scripts/dev.sh" reset
        "$root/scripts/dev.sh" up
        cd "$root/tests"
        if [[ $scenario == plain ]]; then
            npx playwright test "${every_browser[@]}"
        else
            npx playwright test --project=chromium
        fi
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
