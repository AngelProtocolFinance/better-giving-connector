#!/usr/bin/env bash
# Shared paths for the verification scripts. Source this; do not execute it.

ACTIVE="/tmp/bgc-verify-active"

verify_root() {
	cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd
}

verify_tmux() {
	if [[ -f /exec-daemon/tmux.portal.conf ]]; then
		tmux -f /exec-daemon/tmux.portal.conf "$@"
	else
		tmux "$@"
	fi
}

verify_load() {
	if [[ ! -f "$ACTIVE" ]]; then
		echo "no active verification instance; run scripts/launch.sh from the repo root" >&2
		return 1
	fi
	# shellcheck disable=SC1090
	source "$(cat "$ACTIVE")"
}
