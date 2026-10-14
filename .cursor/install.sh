#!/usr/bin/env bash
# Install the Node version in .nvmrc and the pnpm pin in packageManager (corepack),
# then install dependencies. Sets no environment values: tests need none, and
# production secrets must not be written here.
set -euo pipefail

cd "$(dirname "$0")/.."

spec=$(tr -d '[:space:]' < .nvmrc)
spec=${spec#v}
if [ -z "$spec" ]; then
	echo "install: .nvmrc is empty" >&2
	exit 1
fi

case "$(uname -m)" in
	x86_64) arch=x64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*)
		echo "install: unsupported architecture $(uname -m)" >&2
		exit 1
		;;
esac

if [[ "$spec" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	base="https://nodejs.org/dist/v${spec}"
elif [[ "$spec" =~ ^[0-9]+$ ]]; then
	# Same resolution as actions/setup-node with node-version-file: latest of that major.
	base="https://nodejs.org/dist/latest-v${spec}.x"
else
	echo "install: .nvmrc must be a major (24) or an exact version (24.11.1); got ${spec}" >&2
	exit 1
fi

sums=$(curl -fsSL "${base}/SHASUMS256.txt")
tarball=$(printf '%s\n' "$sums" | awk -v arch="$arch" 'index($2, "-linux-" arch ".tar.xz") && $2 ~ /^node-v/ { print $2; exit }')
hash=$(printf '%s\n' "$sums" | awk -v f="$tarball" '$2 == f { print $1; exit }')
if [ -z "${tarball}" ] || [ -z "${hash}" ]; then
	echo "install: no linux-${arch} node tarball for .nvmrc ${spec}" >&2
	exit 1
fi
version=${tarball#node-v}
version=${version%%-linux-*}
case "$version" in
	"${spec}" | "${spec}".*) ;;
	*)
		echo "install: resolved node ${version} does not match .nvmrc ${spec}" >&2
		exit 1
		;;
esac
url="https://nodejs.org/dist/v${version}/${tarball}"

as_root() {
	if [ "$(id -u)" -eq 0 ]; then
		"$@"
	else
		sudo "$@"
	fi
}

current=$(/usr/local/bin/node --version 2>/dev/null || true)
if [ "$current" != "v${version}" ]; then
	tmp=$(mktemp)
	curl -fsSL "$url" -o "$tmp"
	echo "${hash}  ${tmp}" | sha256sum -c -
	as_root tar -xJf "$tmp" -C /usr/local --strip-components=1
	rm -f "$tmp"
fi

export PATH="/usr/local/bin:${PATH}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
as_root env PATH="/usr/local/bin:${PATH}" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 /usr/local/bin/corepack enable

pm=$(sed -n 's/.*"packageManager": *"\([^"]*\)".*/\1/p' package.json)
case "$pm" in
	pnpm@*) ;;
	*)
		echo "install: packageManager must be pnpm@<version>, got ${pm:-empty}" >&2
		exit 1
		;;
esac
corepack prepare "$pm" --activate
got=$(pnpm --version)
want=${pm#pnpm@}
want=${want%%+*}
if [ "$got" != "$want" ]; then
	echo "install: pnpm ${got} does not match packageManager ${pm}" >&2
	exit 1
fi

# This image sources nvm from ~/.bashrc, which would otherwise stay on Node 22
# ahead of /usr/local/bin. Install the same version and make it the default.
nvm_sh="${NVM_DIR:-${HOME}/.nvm}/nvm.sh"
if [ -s "$nvm_sh" ]; then
	# shellcheck disable=SC1090
	. "$nvm_sh"
	nvm install "$version"
	nvm alias default "$version"
	nvm use "$version"
	corepack enable
	corepack prepare "$pm" --activate
fi

as_root tee /etc/profile.d/better-giving-connector.sh >/dev/null <<EOF
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export PATH="/usr/local/bin:\${PATH}"
EOF

hash -r
case "$(node --version)" in
	"v${version}") ;;
	*)
		echo "install: node $(node --version) is on PATH; .nvmrc resolved to v${version}" >&2
		exit 1
		;;
esac
echo "node $(node --version) ($(command -v node))"
echo "pnpm $(pnpm --version) ($(command -v pnpm))"
pnpm install --frozen-lockfile
