# Verge indexer

Build the Verge server explicitly. The default build retains upstream Bitcoin behavior. Verge, Liquid and Bitcoin Electrum peer discovery are separate builds; incompatible combinations fail at compile time. Verge keeps the upstream RocksDB transaction/history/cache stores and REST/Electrum query architecture.

## Build on Linux

On Ubuntu/Debian, install native compiler dependencies and the Rust version in the unchanged `rust-toolchain` file:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config clang libclang-dev cmake git curl
# Install Rustup from the official Rust distribution, then from this repository:
rustup toolchain install 1.87 --profile minimal --component rustfmt --component clippy
cargo fmt
cargo fmt --manifest-path verge-wire/Cargo.toml
INCLUDE_TESTS=1 bash scripts/checks.sh
cargo build --release --locked --features verge --bin electrs
```

Cargo builds pinned Rust dependencies and native RocksDB from source; no Windows libraries or artifacts are copied to Linux. Keep `Cargo.lock`, `verge-wire/Cargo.lock` and the toolchain pin. Initial builds need access to the locked Cargo registry and Git dependencies. Deploy the Linux binary with the repository MIT license and `verge-wire/NOTICE`. Fresh Linux build and production performance qualification remain release gates.

## Run

Use a synchronized, unpruned Verge node. `txindex=0` is supported. Cookie authentication is preferred; do not publish credentials. The daemon directory is the base directory, before the network's `testnet3` or `regtest` suffix.

```sh
./target/release/electrs --network testnet \
  --daemon-dir /srv/verge \
  --daemon-rpc-addr 127.0.0.1:20104 \
  --db-dir /srv/verge-index \
  --jsonrpc-import \
  --http-addr 127.0.0.1:3001 \
  --electrum-rpc-addr 127.0.0.1:60001 \
  --monitoring-addr 127.0.0.1:14224 \
  --main-loop-delay 500
```

`mainnet`, `testnet` and `regtest` select Verge genesis, wire magic, RPC defaults and address prefixes. Defaults use `~/.VERGE`; pass the actual base directory explicitly, particularly on Windows. Persistent stores are separate `verge-mainnet-v1`, `verge-testnet-v1` and `verge-regtest-v1` subdirectories. A fingerprint also checks genesis, wire version, light mode, address search and unspendable-output indexing. Incompatible settings require a new database. Keep development and production databases separate.

For local block-file import, omit `--jsonrpc-import` and provide read access to the node's `blocks` directory. Subsequent updates use RPC. Raw block reconstruction retains signatures and PoS extensions. Genesis transactions remain queryable while their outputs are excluded from address balances and UTXOs.

REST and Electrum expose integer atomic XVG amounts. Clients must parse integers without rounding. REST blocks include `proof_type`, `algorithm` (null for PoS), and Core-compatible difficulty. Transactions include `time`; size/weight include timestamp/replay serialization. Bitcoin SegWit, Taproot, anchor interpretation, package relay and confirmation-target fee estimates are disabled. Fee histograms describe observed paid fees rather than Verge's relay policy.

The tested Mempool connection uses `MEMPOOL.CHAIN=verge`, `MEMPOOL.BACKEND=electrum`, with `ELECTRUM` pointing here and `CORE_RPC` on the same chain. The adapter checks genesis/tip against Core. Its balance response retains upstream Electrum net-balance semantics; full funded/spent totals are available from this indexer's REST address API. The Mempool Esplora adapter requires separate qualification.

Linux retains Unix sockets, SIGUSR1 notification and process metrics. Windows supports TCP development listeners and omits Linux `/proc` metrics/Unix sockets. A Windows test does not qualify Linux deployment.

## Controlled acceptance

### Resuming a historical import

The reorg-safe, lower-memory importer keeps the existing database version,
network fingerprint, header encoding and block-completion keys. Stop the old
indexer cleanly, retain its entire database directory, and replace only the
indexer binary built with the same locked dependencies and `--features verge`.
Restart with the existing flags and directory; do not delete or recreate the
database. A database backup made while the service is stopped remains advisable.

An interrupted initial import reuses persisted completion markers, including
empty marker values. Transaction and history passes still complete and flush
before publishing the synchronized tip. If no complete import tip has yet been
published, startup still downloads the header chain again; it does not discard
the already persisted block/transaction/history records or mark an incomplete
history as synchronized.

Initial header requests use groups of at most 1,000 heights and unique RPC IDs.
Replies are associated by ID, and raw header IDs are checked against their
requested hashes. If active-chain height lookups cross a reorganization, only
the affected suffix is reconstructed by parent hashes. The captured tip remains
the exact required final hash; all link and hash assertions remain enabled.
If a height becomes unavailable, verified hash ancestry provides a fallback.
The regular next update handles any further change to Core's active chain.

Header entries share immutable storage instead of cloning full headers into
each import list. Completed block sets stay in RocksDB rather than duplicated
in memory, and restart loads only the persisted tip's ancestry rather than
building a map of all stored headers. The three RocksDB stores share a 128 MiB
write-buffer budget and a 64 MiB block cache, with 32 MiB individual write
buffers and bounded open-table counts. These budgets are not a cap on total
process RSS: chain metadata, allocations, native DB bookkeeping and queued
blocks also consume memory. Monitor mainnet peak memory and throughput on the
deployment host; more swap is not a substitute for that qualification.

Regression coverage includes the public mainnet sibling blocks at height
9,550,376, a reorg during a height batch, unavailable heights, invalid hash
responses, shuffled/duplicate/missing RPC IDs, interruption, shared header
storage, and reopening partial database records without a synchronized tip.

### Isolated regression chain

Use a fresh, separately started, disposable regtest node with no peers, loopback RPC and `txindex=0`:

```sh
node scripts/test-verge-index.cjs \
  --datadir=/tmp/verge-index-regtest \
  --binary=./target/release/electrs --rpc-port=20340
```

Node.js 18+ is required; no npm packages are needed for the index-only test. It refuses a non-regtest/nonempty chain before mutations, imports native block files, verifies history/balances/UTXOs/spends/proofs/subscriptions, restarts the indexer, and tests rollback/resurrection/restoration/replacement. Evidence stays in the test directory. The script owns its indexer; the caller owns Core.

Add `--pos` only with the fresh Core override `-posactivationheight=1500` to test bonds, PoS activation, replay-protected spends, full block reconstruction and PoS reorgs. Optionally add `--backend-dir=/path/to/mempool/backend` with its dependencies and compilation complete to test the real Core + Rust Electrum + Mempool HTTP path. Defaults: RPC 20340, HTTP 30340, Electrum 50340, metrics 42340, optional backend 8934. Indexer ports have corresponding script arguments.

Add `--live` with `--backend-dir` to qualify the actual backend WebSocket feed: parent-child transaction arrival, tracked addresses, visualization deltas, confirmation, reconnect snapshots, lower-height rollback/resurrection/restoration, burst catch-up and real Core eviction. The eviction case spends a coinbase at maturity and rolls back one block so Core removes the now-premature transaction. Each measured event has a five-second visibility budget; the controlled backend polls at 100 ms. Timings and results are saved in the test directory and are not a production performance claim. These tests mutate only the explicitly selected disposable regtest.

Full-chain throughput, sustained query load, broad recovery testing, monitoring and clean Linux deployment remain production qualification work. A short regression chain does not establish mainnet-scale performance.
