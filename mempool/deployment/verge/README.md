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

For a public Verge testnet explorer, copy `frontend-testnet.example.json` to a
build profile and replace `testnet-explorer.example.invalid` with its intended
HTTPS origin. The profile links back to the mainnet explorer; set
`VERGE_TESTNET_WEBSITE_URL` in the next mainnet frontend build to show a
matching Testnet link there. These links switch between separate hosts, so a
testnet request cannot accidentally reach the mainnet API. The example profile
is deliberately rejected until its public URL is replaced.

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
If an Electrum history response exceeds its configured limit, Verge backend
address/script summaries and ten-transaction pages use the local Rust REST
index. The backend still verifies each returned transaction through Core and
rejects summary amounts outside its exact numeric API range.
All application/indexer listeners stay on loopback. SQL, Lightning, pricing,
Bitcoin mining statistics, native GBT
selection and unqualified transaction tools remain disabled. The backend's
`HTTP_HOST` is explicit; upstream's default listener behavior is preserved for
other configurations.

The Verge backend polls Core's `getpeerinfo` once at startup and every two
minutes thereafter. `/api/v1/peers` serves the last saved snapshot without
calling Core for each visitor. Public peer addresses remain in the list after
disconnecting, with their last message time and last advertised version/SMSG
service bit. Only current connections contribute to the connected counts;
private/local peer names are never saved or returned. The backend stores this
history atomically under the service account's
`~/.local/state/verge-mempool/peers-NETWORK.json` by default, or at the absolute
path in `VERGE_PEERS_STORE_PATH`. Keep this file in the persistent backend state
directory and include it in backups. If it is unreadable, polling stops rather
than replacing the history; repair it before restarting the backend.

Review/copy the service units, update `/usr/bin/node` if necessary, run
`systemd-analyze verify` on the actual server and start the indexer/backend.
Service restarts retry transient Core/index synchronization failures; they do
not bypass chain/genesis/readiness checks. The Rust database lives separately
from the release directory. Mainnet, testnet and regtest have distinct database
namespaces and fingerprints.

## Run a separate testnet explorer

The PQ trial uses testnet message magic `524c7f07` and activates PoS at height
3000. This explorer decodes both classical (v1) and hybrid ML-DSA (v2) PoS
extensions, including the v2 signature-normalized block commitment. Verge Core
remains the cryptographic and consensus validator; the indexer checks the wire
format, transaction IDs, merkle root and extension commitment.

Native single-key and multisig PQ addresses use Bech32m with `xvgpq1` (mainnet),
`xvgtpq1` (testnet), or `xvgrpq1` (regtest). These are not SegWit addresses.
Legacy addresses, PoW blocks and classical PoS blocks remain supported. This
does not enable PQ consensus on mainnet or change its activation height.

Deploy against an upgraded, unpruned Core with its matching OpenSSL PQ backend.
For this reset trial, create a fresh **testnet-only** explorer index and Core
chain directory; old trial data shares the genesis but is not the new chain.
Do not delete or reuse mainnet data. No database schema migration is introduced
by this decoder/address update. Paid SMSG funding remains an ordinary indexed
transaction; private message contents are not exposed by the explorer.

The application, indexer and frontend already recognize the existing Verge
testnet. The committed profile uses genesis
`000005e0bb94e3a30a565d1a14ad95a189d47ca45c5bbbe48ee7a32eab8cb980`,
Core RPC chain `test`, RPC port 20104 and the `testnet3` data subdirectory.
Confirm these against the actual Core node before building. If the forthcoming
testnet has a different genesis or network parameters, update the backend
`verge/chain-profile.ts`, Rust `verge-wire/src/network.rs`, fixtures and gateway
checks together; do not start this profile against a different chain.

Use a separate host for the public testnet deployment when possible. The
current mainnet host has limited free memory and swap already in use. The
testnet example paths and ports are distinct even if both explorers eventually
share a machine:

| Component | Testnet example |
| --- | --- |
| Release pointer | `/opt/verge-explorer-testnet/current` |
| Persistent index and backend | `/var/lib/verge-explorer-testnet/index`, `/var/lib/verge-explorer-testnet/backend` |
| Core data and cookie | `/var/lib/verge/testnet3`, `/var/lib/verge/testnet3/.cookie` |
| Core RPC, indexer REST, Electrum, backend | `20104`, `3011`, `60011`, `9009` |
| Local gateway | `127.0.0.1:8081` |

Build with `frontend-testnet.example.json` after editing its public URL, and
install that release under `/opt/verge-explorer-testnet/releases/BUILD_ID`.
Point only the testnet `current` symlink at it. Copy
`backend-testnet.example.json` to `/etc/verge-explorer-testnet/backend.json`,
`verge-testnet-indexer.service`, `verge-testnet-backend.service` and
`verge-testnet-site-health.service` to the systemd unit directory, and
`nginx-testnet.conf` into Nginx's `http` context. The health service checks
both local APIs every three seconds. New page loads show the bundled temporary
maintenance page whenever either API is unavailable or their tips disagree.
Create the `verge-explorer` account and testnet state directories first; grant
read access only to the testnet Core cookie and write access only to the
testnet explorer state. Adjust `/usr/bin/node`, Core paths and gateway choice
to the host. Check unit files with `systemd-analyze verify` and the gateway
with `nginx -t` before starting either service.

Start the testnet indexer after the unpruned testnet Core node has synchronized,
then start the testnet backend and health service. Check the local gateway
before configuring its public TLS virtual host:

```sh
node /opt/verge-explorer-testnet/current/deployment/check-live.cjs \
  --url=http://127.0.0.1:8081/ --network=testnet
```

This check rejects wrong genesis, backend/Core/indexer disagreement, lag and
WebSocket failures. The testnet backend also verifies Core's chain and genesis
at startup. Keep the mainnet services, release pointer and index untouched.

The Nginx example binds only `127.0.0.1:8080` for staging. It serves the actual
frontend, splits `/api/v1` to Mempool and `/api` to Rust, supports WebSocket
upgrades, returns real 404s for missing static files, and withholds internal
backend routes and public transaction submission. Run `nginx -t` before use.
Configure the actual TLS virtual host/domain only after staging passes. Point
`SOURCE_CODE_URL` to the public repository and publish the matching
`sources.tar.gz` as a separate corresponding-source download; retain the upstream AGPL,
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
