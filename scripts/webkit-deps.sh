#!/usr/bin/env bash
# Puts the libraries Playwright's WebKit needs next to it, for a machine where `playwright install-deps` is not an option
# because it needs root. The wrapper around WebKit replaces LD_LIBRARY_PATH, so they have to go in its own directory.
set -euo pipefail

packages=(libevent-2.1-7t64 libavif16 libmanette-0.2-0 libgav1-2 libyuv0 libbacktrace0 libhidapi-hidraw0 libhidapi-libusb0)

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
for browser in "$HOME"/.cache/ms-playwright/webkit-*/minibrowser-wpe; do
    work=$(mktemp -d "$root/.dev/webkit-deps.XXXXXX")
    trap 'rm -rf "$work"' EXIT
    (cd "$work" && apt-get download "${packages[@]}" >/dev/null && for package in *.deb; do dpkg -x "$package" unpacked; done)
    cp --update=none "$work"/unpacked/usr/lib/x86_64-linux-gnu/*.so* "$browser/sys/lib/"
done
