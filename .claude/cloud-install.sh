#!/bin/bash
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"

# the pnpm the setup script installed, pinned by `packageManager`
ver=$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\).*/\1/p' package.json)
[ -n "$ver" ] || { echo "cloud-install: no pnpm pin in packageManager" >&2; exit 1; }
pnpm_home="${PNPM_HOME:-$HOME/.local/share/pnpm}"

# the installer's wrapper locates its binary from its own path, so the directory
# holding it goes on PATH whole: a link to the wrapper or to a path inside
# PNPM_HOME breaks, and the layout under it differs between pnpm releases.
pnpm_bin=""
for dir in "$pnpm_home/bin" "$pnpm_home"; do
  [ -x "$dir/pnpm" ] && { pnpm_bin="$dir"; break; }
done
[ -n "$pnpm_bin" ] || { echo "cloud-install: no pnpm under $pnpm_home" >&2; exit 1; }
got=$("$pnpm_bin/pnpm" --version)
[ "$got" = "$ver" ] || { echo "cloud-install: pnpm $got installed, packageManager pins $ver" >&2; exit 1; }

# the setup script installs the repo's node (`.nvmrc`) into /usr/local, but the
# image's /opt/node22/bin comes first on PATH and would run every command on 22.
bin="$HOME/.kru-bin"
mkdir -p "$bin"
node_bin=/usr/local/bin/node
if [ -x "$node_bin" ] && "$node_bin" --version | grep -q "^v$(cat .nvmrc)\."; then
  ln -sf "$node_bin" "$bin/node"
fi
export PATH="$pnpm_bin:$bin:$PATH"
# later shells source CLAUDE_ENV_FILE. without this line they find the image's
# pnpm, which self-switches to `packageManager` with lifecycle scripts off.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$pnpm_bin:$bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

pnpm install --frozen-lockfile
