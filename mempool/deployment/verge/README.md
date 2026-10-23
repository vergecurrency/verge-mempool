# Verge Linux deployment

The builder preserves Mempool's Angular/TypeScript/REST/WebSocket split and the
ported electrs stores. It builds Linux-native dependencies with the existing npm
and Cargo locks. It does not modify Core, start services, migrate a database or
publish the site.

This deployment path is prepared for qualification. A Windows frontend build or
a shell syntax check does not demonstrate a complete Linux release build.

## Build

Use Linux x86_64 with glibc, Node 22.12+ on the 22.x line or Node 24+, npm and
Rustup. Install the compiler prerequisites on Ubuntu/Debian:

```sh
sudo apt-get update
sudo apt-get install build-essential pkg-config clang libclang-dev cmake git curl ca-certificates libssl-dev
```

Keep the `mempool` and ported `electrs` sources together. For mainnet, copy
`frontend-mainnet.example.json` to a separate profile and set the real public
HTTPS origin and corresponding-source URL. The example `.invalid` names are
deliberately rejected. For a local Linux qualification run, use the existing
`frontend/mempool-frontend-config.verge.sample.json` testnet profile instead.

```sh
bash deployment/verge/build-linux.sh ../electrs /path/frontend.json /var/tmp/verge-build-001 --check-only
bash deployment/verge/build-linux.sh ../electrs /path/frontend.json /var/tmp/verge-build-001
```

The output directory must be new and outside both source trees. The builder
copies sources there, installs the unchanged Rust 1.87 and 1.84 pins, compiles
the native addon directly from locked Cargo dependencies, tests/builds the
backend, builds the optimized frontend, and runs the complete Rust checks with
tests before producing the Verge indexer. Original checkouts and running local
services are untouched. `VERGE_BUILD_JOBS` defaults to four.

Both source trees may be ordinary `mempool/` and `electrs/` directories in one
repository. Upstream baseline revisions are recorded in `upstream-revisions.json`;
the release source archive hash identifies the actual modified code. The Linux
addon loader and API declaration are maintained source files in this directory,
so the builder does not depend on generated Windows NAPI bindings.

The release contains Linux binaries, production backend dependencies, hashed
frontend bundles, licenses, dependency inventories, an exact source snapshot,
`BUILD.json` and `SHA256SUMS`. It excludes `.local`, private runtime configs,
Git metadata and the local investigation reports. The source archive hash also
identifies the frontend/backend build. Dependencies are locked; bit-identical
binary reproduction across different hosts/toolchains is not claimed.

## Stage before public launch

Build on the deployment distribution or verify runtime library compatibility;
check the recorded `ldd` output and the checksums after transfer. Keep the
release root-owned under `/opt/verge-explorer/releases/BUILD_ID`; point
`/opt/verge-explorer/current` at the selected release. Do not mix binaries from
different releases or networks.

Create a `verge-explorer` service account and its persistent index/backend
directories under `/var/lib/verge-explorer`. The example units assume Core's
base data directory is `/var/lib/verge`, RPC is on loopback 20102 and the
unpruned node is synchronized on **Verge mainnet**. Give the service only the
required read access to the existing RPC cookie. Adapt paths to the actual
node; no Core configuration or wallet changes are performed by these files.

Copy the backend example to `/etc/verge-explorer/backend.json` and select the
same chain and Rust Electrum service. Keep `ESPLORA.REST_API_URL` pointed at the
local Rust REST listener even with `MEMPOOL.BACKEND=electrum`: direct historical
transaction pages use its block location, then ask Core for the transaction
with that canonical block hash. This supports an unpruned Core with `txindex=0`.
All application/indexer listeners stay on loopback. SQL, Lightning, pricing,
Bitcoin mining statistics, native GBT
selection and unqualified transaction tools remain disabled. The backend's
`HTTP_HOST` is explicit; upstream's default listener behavior is preserved for
other configurations.

Review/copy the service units, update `/usr/bin/node` if necessary, run
`systemd-analyze verify` on the actual server and start the indexer/backend.
Service restarts retry transient Core/index synchronization failures; they do
not bypass chain/genesis/readiness checks. The Rust database lives separately
from the release directory. Mainnet, testnet and regtest have distinct database
namespaces and fingerprints.

The Nginx example binds only `127.0.0.1:8080` for staging. It serves the actual
frontend, splits `/api/v1` to Mempool and `/api` to Rust, supports WebSocket
upgrades, returns real 404s for missing static files, and withholds internal
backend routes and public transaction submission. Run `nginx -t` before use.
Configure the actual TLS virtual host/domain only after staging passes. Publish
the matching `sources.tar.gz` at `SOURCE_CODE_URL`; retain the upstream AGPL,
MIT, BSD and asset notices. Dependency inventories assist the final license
review; they are not an automatic license-clearance report.

The included read-only gateway check needs Node 22.12+ and no cookie or wallet
access. Run it after staging starts, then against the intended public TLS URL:

```sh
node deployment/check-live.cjs --url=http://127.0.0.1:8080/ --network=mainnet
```

It checks the exact network/genesis/coin scale, Core-backed and indexed canonical
hash agreement, index lag (two blocks by default), WebSocket initialization and
pong. It fails on an identity mismatch or disagreement and emits JSON suitable
for an external monitor. Also monitor Core's independent peer/sync health, time
since the last block, service restarts, disk space and memory. A gateway that
agrees with a stalled Core is not proof that the node is current with peers.

## Release acceptance still required

Run read-only chain/genesis/block/transaction/address checks against the actual
mainnet node and index. Verify full-chain catch-up, representative history from
all consensus eras, safe full-range/cumulative amount handling, large-history
pagination, response latency and live lag under the expected load. The current
numeric browser/API paths reject unsafe monetary numbers; a complete lossless
mainnet amount contract remains a release gate. Mainnet-scale performance has
not been inferred from the short testnet/regtest acceptance runs.

Exercise startup order, automatic restart, monitoring, controlled regtest
reorganizations and a backup/restore rehearsal. Stop index writers before
copying the complete network index, including txstore/history/cache. A Windows
testnet index cannot seed mainnet; a cross-OS copy needs an actual Linux reopen
and query comparison. Core itself must be synchronized separately. No database
or wallet is bundled in this release.
