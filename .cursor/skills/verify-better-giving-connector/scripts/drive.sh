#!/usr/bin/env bash
# Drive one feature against the instance launch.sh started.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib.sh"
ROOT="$(verify_root)"
verify_load

exec env NODE_EXTRA_CA_CERTS="$CA_CERT" \
	pnpm --dir "$ROOT" exec tsx "$HERE/drive.ts" "$@"
