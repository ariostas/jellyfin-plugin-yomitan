#!/usr/bin/env bash
# Runs the server that scripts/segmentation/score.mjs looks words up on, with the pinned JMdict, JMnedict and KANJIDIC
# from scripts/real-dicts.sh, and Jitendex too if YOMITAN_JITENDEX names its zip. The first `up` imports them, which
# takes a few minutes. After that the state is kept, and `up` only restarts the server.
#
#   scripts/segmentation/server.sh up      start it, and import whatever dictionary is missing
#   scripts/segmentation/server.sh reset   remove it and its state
#
# Environment:
#   JF_NAME            container name (default jf-segmentation)
#   JF_PORT            port on 127.0.0.1 (default 18790)
#   YOMITAN_REAL_DICTS where the pinned dictionaries are, or go (default .dev/real-dicts)
#   YOMITAN_JITENDEX   a jitendex-yomitan.zip, optional. Jitendex is not pinned, so the scorer reports its title
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export JF_NAME=${JF_NAME:-jf-segmentation}
export JF_PORT=${JF_PORT:-18790}

case ${1:-} in
    up)
        directory=$("$root/scripts/real-dicts.sh" "${YOMITAN_REAL_DICTS:-}")
        zips=("$directory/JMdict_english.zip" "$directory/JMnedict.zip" "$directory/KANJIDIC_english.zip")
        if [[ -n ${YOMITAN_JITENDEX:-} ]]; then
            zips+=("$YOMITAN_JITENDEX")
        fi

        "$root/scripts/dev.sh" up
        node "$root/scripts/segmentation/install-dicts.mjs" "http://127.0.0.1:$JF_PORT" "${zips[@]}"
        ;;
    reset) "$root/scripts/dev.sh" reset ;;
    *)
        sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
        exit 2
        ;;
esac
