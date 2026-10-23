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
./target/release/electrs -vv --network testnet \
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

The tested Mempool connection uses `MEMPOOL.CHAIN=verge`, `MEMPOOL.BACKEND=electrum`, with `ELECTRUM` pointing here and `CORE_RPC` on the same chain. Set `ESPLORA.REST_API_URL` to this indexer's loopback REST listener as well. For a direct historical transaction request without Core txindex, the backend obtains its block location from REST and verifies the canonical block hash against Core before requesting the raw transaction with a block hint. The adapter checks genesis/tip against Core. Its balance response retains upstream Electrum net-balance semantics; full funded/spent totals are available from this indexer's REST address API. The Mempool Esplora adapter requires separate qualification.

Linux retains Unix sockets, SIGUSR1 notification and process metrics. Windows supports TCP development listeners and omits Linux `/proc` metrics/Unix sockets. A Windows test does not qualify Linux deployment.

## Controlled acceptance

### Following synchronization

Use `-vv` for INFO progress (included in the deployment service template). With
systemd, follow the actual installed unit using `journalctl -fu verge-indexer`.
Existing units need their logging flag updated separately; installing new source
does not change an installed unit automatically. Keep the node's actual daemon
directory and cookie permissions when adapting the template.

Each phase emits a start, a heartbeat every five seconds while it is active,
and a finish or interruption record. Progress is phase-local:

| Phase | Meaning of processed / total |
| --- | --- |
| `open_databases` | Opened transaction, history and cache databases / 3 |
| `load_persisted_headers` | Headers loaded from the published tip's ancestry / unknown |
| `download_headers` | Heights retrieved / captured target height plus genesis |
| `verify_header_ancestry` | Suffix headers retrieved during ancestry repair / unknown |
| `validate_header_links` | Header links checked / captured chain length |
| `fetch_new_headers` | New headers retrieved on subsequent updates / unknown |
| `scan_transaction_markers` | Transaction completion keys checked / candidate headers |
| `index_transactions` | Missing blocks stored / missing transaction blocks |
| `compact_transactions` | Transaction compaction; total and percentage unknown |
| `scan_history_markers` | History completion keys checked / candidate headers |
| `index_address_history` | Blocks whose address/spend history was written / missing history blocks |
| `compact_history`, `compact_cache` | Compaction; total and percentage unknown |
| `flush_index` | Final initial-import flush; total and percentage unknown |

Records also include `rate_per_s`, `elapsed_s`, `idle_s`, `last_height`, and the
transaction count for block-writing passes. Marker scans report `reused` and
`missing_blocks`: missing means absent among the markers checked so far. Scan
`remaining` counts unchecked markers, not blocks left to download. An empty
persisted marker is complete. A blocked call keeps the count unchanged while
elapsed/idle time increases. ETA is a rough average for that phase only; it is
unknown before measurable progress, for phases without totals, and after 15
seconds without progress. It is never a predicted time for the whole explorer.
Compaction can be expensive even while its processed count is zero.

The loopback monitoring endpoint is available before query servers start:

```sh
curl -fsS http://127.0.0.1:14224/metrics
```

`index_sync_processed`, `index_sync_total`, `index_sync_reused` and
`index_sync_active` have a bounded `phase` label for marker, block-writing,
compaction and flush phases. Unknown totals are -1; active is 1 during a phase
and 0 after finish/interruption. Counters are gauges reset per phase run, not
ever-increasing lifetime totals. Header/open phases are reported in logs.
`tip_height` still represents only the committed indexed tip. None of these
progress counters publishes an incomplete address index as synchronized.

After both index passes and flushing, startup compares the committed hash with
Core again and catches up before starting REST/Electrum query servers. The log
announces that transition explicitly. Core can advance again afterwards; normal
live polling and the backend's readiness checks still apply. This transition
does not establish that public Apache/TLS/backend deployment is healthy.

### Measuring a slow completion-marker scan

Marker probes use RocksDB's optimized batched MultiGet in groups of at most
4,096, preserving header order and propagating read errors. The shared block
cache retains its 64 MiB budget with four shards, so large unpartitioned SST
index blocks have larger capacity pools. This is a runtime cache setting, not
an SST format change. It requires neither deleting the index nor migrating
completion keys. The shared write-buffer budget remains 128 MiB.

An opt-in benchmark compares individual versus batched probes and 64 versus
four cache shards. It asserts identical ordered presence results in all modes,
uses fresh caches, and runs three rounds with alternating mode order. To run
the small synthetic fixture on Linux:

```sh
cargo fmt
cargo test --locked --release --lib --features verge marker_lookup_benchmark \
  -- --ignored --nocapture
```

The synthetic fixture deliberately scales table blocks and cache size to
exercise metadata fragmentation: 48 overlapping files, 128-byte table blocks,
and an 8 MiB cache explicitly set to 64 or four shards. It is not the default
cache configuration at that size and is not a mainnet throughput prediction.

For production qualification, prepare the candidate binary and tests first.
Arrange a maintenance window, stop only the indexer cleanly and confirm its
process has exited. Copy the entire index to a separate destination on a
filesystem with enough space. Never copy active RocksDB files individually or
place the benchmark marker in the live index. Keep an untouched stopped backup
for rollback. In the **copy only**, mark the parent of `txstore`:

```sh
# Replace this example with the verified absolute path to the STOPPED COPY.
touch /srv/benchmark-copy/verge-mainnet-v1/newindex/BENCHMARK_COPY_ONLY
ELECTRS_MARKER_BENCH_COPY=/srv/benchmark-copy/verge-mainnet-v1/newindex/txstore \
  cargo test --locked --release --lib --features verge marker_lookup_benchmark \
  -- --ignored --nocapture
```

The benchmark opens the selected copy read-only, samples up to 2,048 persisted
markers across the hash range and adds equally many random probes. It compares
all modes at the production 64 MiB cache budget and prints elapsed time,
keys/second, cache usage and index-block hit/miss statistics. The marker file
is an operator guard, not automatic proof that the path is a safe copy.
Do not flush the host OS page cache on a production server. This measures a
sampled startup lookup workload; separately measure sustained concurrent query
latency and total RSS/swap during indexing and live operation.

Keep the same network, full database path and index options when replacing the
binary. Retain the old executable and stopped backup, and preserve all marker,
header and history records. Compare progress, RSS/swap, scan rate and new block
RPC activity before claiming that the mainnet bottleneck is resolved. Avoid
repeated diagnostic restarts: a historical import without a published tip must
retrieve headers again on each startup.

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
