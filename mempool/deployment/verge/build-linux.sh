#!/usr/bin/env bash
set -euo pipefail

# Build in a fresh directory outside both source trees. Existing checkouts,
# running services, Core and databases are never modified by this builder.
mempool_source="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "Usage: bash build-linux.sh ELECTRS_SOURCE FRONTEND_CONFIG NEW_OUTPUT_DIRECTORY [--check-only]" >&2
  exit 2
fi
indexer_source="$(realpath "$1")"
frontend_profile="$(realpath "$2")"
build_root="$(realpath -m "$3")"
mode="${4:-build}"
[[ "$mode" == build || "$mode" == --check-only ]] || { echo 'Unknown build option' >&2; exit 2; }
[[ "$(uname -s)" == Linux ]] || { echo 'Run this builder on Linux; Windows artifacts are not deployable.' >&2; exit 1; }
[[ -f "$indexer_source/verge-wire/Cargo.toml" && -f "$frontend_profile" ]] || { echo 'Missing Verge indexer source or frontend profile' >&2; exit 1; }
case "$build_root/" in "$mempool_source/"*|"$indexer_source/"*) echo 'Output must be outside both source trees' >&2; exit 1;; esac
[[ ! -e "$build_root" ]] || { echo 'Output already exists; choose a new directory' >&2; exit 1; }
for tool in node npm cargo rustup clang cmake make cc c++ pkg-config tar sha256sum git find xargs ldd; do
  command -v "$tool" >/dev/null || { echo "Missing build dependency: $tool" >&2; exit 1; }
done
if LC_ALL=C grep -q $'\r' "$mempool_source/deployment/verge/source-excludes.txt"; then
  echo 'Source exclusion rules must use LF line endings; no source was copied.' >&2
  exit 1
fi
node "$mempool_source/deployment/verge/validate-profile.cjs" "$frontend_profile"
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(process.platform!=="linux"||process.arch!=="x64"||!process.report.getReport().header.glibcVersionRuntime||!((major===22&&minor>=12)||major>=24)){throw Error("Use Linux x86_64/glibc and Node 22.12+ (22.x) or Node 24+.")}'
node --version
npm --version
indexer_pin="$(tr -d '\r\n' < "$indexer_source/rust-toolchain")"
gbt_pin="$(tr -d '\r\n' < "$mempool_source/rust/gbt/rust-toolchain")"
echo "Unchanged Rust pins: indexer=$indexer_pin native-addon=$gbt_pin"
[[ "$mode" != --check-only ]] || { echo 'Build prerequisites/profile passed. No files were changed.'; exit 0; }

mkdir -p "$build_root/work/mempool" "$build_root/work/electrs" "$build_root/release" "$build_root/logs"
exec > >(tee "$build_root/logs/build.log") 2>&1
export CARGO_BUILD_JOBS="${VERGE_BUILD_JOBS:-4}"
export NG_BUILD_MAX_WORKERS="$CARGO_BUILD_JOBS"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
export CYPRESS_INSTALL_BINARY=0 NG_CLI_ANALYTICS=false

# The same exclusion rules are also used for the published source archive.
excluded=(--exclude-from="$mempool_source/deployment/verge/source-excludes.txt"
  --exclude=./backend/mempool-config.json --exclude='./backend/cache*'
  --exclude=./frontend/mempool-frontend-config.json --exclude=./frontend/src/index.html
  --exclude=./frontend/theme-manifest.json --exclude=./frontend/src/resources/config.js
  --exclude=./frontend/src/resources/config.template.js --exclude=./frontend/src/resources/customize.js
  --exclude=./rust/gbt/index.js --exclude=./rust/gbt/index.d.ts)
tar -C "$mempool_source" "${excluded[@]}" -cf - . | tar -C "$build_root/work/mempool" -xf -
tar -C "$indexer_source" "${excluded[@]}" -cf - . | tar -C "$build_root/work/electrs" -xf -
work="$build_root/work"
release="$build_root/release"
cp "$frontend_profile" "$work/mempool/frontend/mempool-frontend-config.json"
# These are upstream baselines, including when both trees are ordinary folders
# in one repository. The actual modified source is identified by its archive hash.
export MEMPOOL_UPSTREAM_REVISION="$(node -e 'const p=require(process.argv[1]);if(!/^[a-f0-9]{40}$/.test(p.mempool.revision))process.exit(1);console.log(p.mempool.revision)' "$work/mempool/deployment/verge/upstream-revisions.json")"
export ELECTRS_UPSTREAM_REVISION="$(node -e 'const p=require(process.argv[1]);if(!/^[a-f0-9]{40}$/.test(p.electrs.revision))process.exit(1);console.log(p.electrs.revision)' "$work/mempool/deployment/verge/upstream-revisions.json")"

rustup toolchain install "$indexer_pin" --profile minimal --component rustfmt --component clippy
rustup toolchain install "$gbt_pin" --profile minimal
(
  cd "$work/electrs"
  cargo +"$indexer_pin" fmt
  cargo +"$indexer_pin" fmt --manifest-path verge-wire/Cargo.toml
)
(
  cd "$work"
  sha256sum mempool/backend/package-lock.json mempool/frontend/package-lock.json mempool/rust/gbt/Cargo.lock electrs/Cargo.lock electrs/verge-wire/Cargo.lock > "$build_root/locks.before"
  # Include the actual public frontend profile in corresponding source.
  # The generated config, build artifacts and private runtime configuration are omitted.
  tar --exclude-from="$mempool_source/deployment/verge/source-excludes.txt" -czf "$release/sources.tar.gz" mempool electrs
)
export VERGE_SOURCE_SHA256="$(sha256sum "$release/sources.tar.gz" | cut -d ' ' -f 1)"
export MEMPOOL_COMMIT_HASH="${VERGE_SOURCE_SHA256:0:12}"
export DOCKER_COMMIT_HASH="$MEMPOOL_COMMIT_HASH"

echo 'Building the locked Linux native addon'
(
  cd "$work/mempool/rust/gbt"
  cargo +"$gbt_pin" build --release --locked --target-dir "$build_root/targets/gbt"
  mkdir -p "$work/mempool/backend/rust-gbt"
  cp package.json "$work/mempool/backend/rust-gbt/"
  cp "$work/mempool/deployment/verge/native-addon.cjs" "$work/mempool/backend/rust-gbt/index.js"
  cp "$work/mempool/deployment/verge/native-addon.d.ts" "$work/mempool/backend/rust-gbt/index.d.ts"
  cp "$build_root/targets/gbt/release/libgbt.so" "$work/mempool/backend/rust-gbt/gbt.linux-x64-gnu.node"
)
echo 'Building and checking the backend'
(
  cd "$work/mempool/backend"
  npm ci --ignore-scripts --no-audit --no-fund
  npm run build
  npm run typecheck:verge
  npm run test:verge
)
echo 'Building and checking the optimized frontend'
(
  cd "$work/mempool/frontend"
  bash meta/scripts/check-install-scripts.sh
  npm ci --no-audit --no-fund
  npm run test:verge
  npm run build:verge:production
)
echo 'Checking and building the Verge indexer'
(
  cd "$work/electrs"
  export CARGO_TARGET_DIR="$build_root/targets/electrs"
  INCLUDE_TESTS=1 bash scripts/checks.sh
  cargo +"$indexer_pin" build --release --locked --features verge --bin electrs
)

mkdir -p "$release/backend" "$release/frontend" "$release/bin" "$release/licenses" "$release/inventory"
cp -a "$work/mempool/backend/dist" "$release/backend/"
cp "$work/mempool/backend/package.json" "$work/mempool/backend/package-lock.json" "$release/backend/"
cp -a "$work/mempool/backend/rust-gbt" "$release/backend/"
(
  cd "$release/backend"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  node -e 'if(typeof require("rust-gbt").GbtGenerator!=="function")process.exit(1);process.exit(0)'
  npm ls --all --omit=dev --json > "$release/inventory/backend-npm.json"
)
cp -a "$work/mempool/frontend/dist/mempool/browser/." "$release/frontend/"
cp "$build_root/targets/electrs/release/electrs" "$release/bin/"
cp "$work/mempool/COPYING.md" "$release/licenses/mempool-COPYING.md"
cp "$work/electrs/LICENSE" "$release/licenses/electrs-LICENSE"
cp "$work/electrs/verge-wire/NOTICE" "$release/licenses/verge-wire-NOTICE"
cp -a "$work/mempool/deployment/verge" "$release/deployment"
(
  cd "$work/electrs"
  cargo +"$indexer_pin" metadata --locked --features verge --format-version 1 > "$release/inventory/electrs-cargo.json"
  cd "$work/mempool/rust/gbt"
  cargo +"$gbt_pin" metadata --locked --format-version 1 > "$release/inventory/gbt-cargo.json"
)
(
  cd "$work"
  sha256sum -c "$build_root/locks.before"
)
node "$mempool_source/deployment/verge/write-manifest.cjs" "$release" "$frontend_profile"
ldd "$release/bin/electrs" > "$release/inventory/indexer-libraries.txt"
ldd "$release/backend/rust-gbt/gbt.linux-x64-gnu.node" > "$release/inventory/addon-libraries.txt"
if grep -q 'not found' "$release/inventory/indexer-libraries.txt" "$release/inventory/addon-libraries.txt"; then
  echo 'A Linux runtime library is missing; inspect the inventory before deployment.' >&2
  exit 1
fi
(
  cd "$release"
  find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS
)
tar -C "$build_root" -czf "$build_root/verge-explorer-linux-x64.tar.gz" release
echo "Linux build and checks passed: $build_root/verge-explorer-linux-x64.tar.gz"
echo 'This builds release artifacts; it does not install services, change Core, copy a database or publish the site.'
