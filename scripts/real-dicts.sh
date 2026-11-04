#!/usr/bin/env bash
# Downloads the real dictionaries that YOMITAN_REAL_DICTS points the tests at, JMdict, JMnedict and KANJIDIC for
# Yomitan, into a directory (default .dev/real-dicts), and checks each against its SHA-256. JMdict for Yomitan is
# rebuilt every day, so these come from one dated release, and a failure means the code changed and not the dictionary.
# They are from the Electronic Dictionaries Research Group, under CC BY-SA 4.0, and are downloaded, never committed.
#
# To move to a newer release, change the date and the checksums together, after the real specs pass on it.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
directory=${1:-$root/.dev/real-dicts}
release=https://github.com/yomidevs/jmdict-yomitan/releases/download/2026-11-03

declare -A sha256=(
    [JMdict_english.zip]=233979bfe02dd7ae277b76a71727fc885a5cc4ba52dec3b5f635b7a9e8fea788
    [JMnedict.zip]=f85ff406a395a2e923922814ff633199f5aa3631cba84fa7e1ee53749fa3e658
    [KANJIDIC_english.zip]=c3f40325acebbf7f82e00b3665938db8e6b342078898993919b647e257f4c787
)

# Only the directory goes to stdout, since scripts/test-matrix.sh reads it from there.
mkdir -p "$directory"
for file in "${!sha256[@]}"; do
    if ! echo "${sha256[$file]}  $directory/$file" | sha256sum --check --status &>/dev/null; then
        echo "Downloading $file" >&2
        curl --fail --silent --show-error --location --output "$directory/$file.part" "$release/$file"
        echo "${sha256[$file]}  $directory/$file.part" | sha256sum --check --quiet >&2
        mv "$directory/$file.part" "$directory/$file"
    fi
done
echo "$directory"
