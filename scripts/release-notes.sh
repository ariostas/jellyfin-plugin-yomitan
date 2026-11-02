#!/usr/bin/env bash
# Prints the changelog of a release tag: the subjects of the feat, fix and perf commits since the tag before it, as a
# Markdown list. The release on GitHub and the plugin manifest both use it.
set -euo pipefail

tag=${1:?usage: scripts/release-notes.sh <tag>}
previous=$(git describe --tags --abbrev=0 --match 'v*' "$tag^" 2>/dev/null || true)
if [[ -z $previous ]]; then
    echo "- First release."
    exit 0
fi

git log --no-merges --format='- %s' "$previous..$tag" | grep -E '^- (feat|fix|perf)(\([^)]*\))?!?: ' ||
    echo "- No changes to what the plugin does."
