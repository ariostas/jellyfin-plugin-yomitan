#!/usr/bin/env bash
# Runs the C# unit tests inside the .NET SDK container.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$root/scripts/lib/common.sh"

dotnet_in_container test tests/unit --nologo "$@"
