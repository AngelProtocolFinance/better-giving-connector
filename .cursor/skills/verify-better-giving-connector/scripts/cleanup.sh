#!/usr/bin/env bash
# Stop the instance this verification run started. Evidence under verify-evidence/ stays.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib.sh"

if [[ ! -f "$ACTIVE" ]]; then
	echo "no active verification instance"
	exit 0
fi
verify_load
evidence="$EVIDENCE"

if [[ -n "${CONNECTOR_SESSION:-}" ]] && verify_tmux has-session -t "=$CONNECTOR_SESSION" 2>/dev/null; then
	verify_tmux kill-session -t "$CONNECTOR_SESSION"
fi
if [[ -n "${FAKE_SESSION:-}" ]] && verify_tmux has-session -t "=$FAKE_SESSION" 2>/dev/null; then
	verify_tmux kill-session -t "$FAKE_SESSION"
fi

if [[ -f "$RUN_DIR/connector.pid" ]]; then
	pid="$(cat "$RUN_DIR/connector.pid")"
	cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
	case "$cmd" in
		*src/dev.ts*|*tsx*) kill "$pid" 2>/dev/null || true ;;
	esac
fi
if [[ -f "$RUN_DIR/fake.pid" ]]; then
	pid="$(cat "$RUN_DIR/fake.pid")"
	if sudo -n kill -0 "$pid" 2>/dev/null; then
		sudo -n kill "$pid" 2>/dev/null || true
	fi
fi

if [[ "${HOSTS_ADDED:-0}" == "1" ]]; then
	sudo -n sed -i "/# bgc-verify-${RUN_ID}\$/d" /etc/hosts
fi

rm -rf "$RUN_DIR"
rm -f "$ACTIVE"
echo "cleaned up; evidence remains at ${evidence}"
