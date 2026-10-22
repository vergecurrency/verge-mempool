use rocksdb;

use std::path::Path;
use std::sync::LazyLock;

use crate::config::Config;
use crate::util::{bincode_util, Bytes};

/// Each version will break any running instance with a DB that has a differing version.
/// It will also break if light mode is enabled or disabled.
// 1 = Original DB (since fork from Blockstream)
// 2 = Add tx position to TxHistory rows and place Spending before Funding
static DB_VERSION: u32 = 2;

// Shared by txstore, history and cache, rather than multiplied per database.
static WRITE_BUFFERS: LazyLock<rocksdb::WriteBufferManager> =
    LazyLock::new(|| rocksdb::WriteBufferManager::new_write_buffer_manager(128 << 20, true));
static BLOCK_CACHE: LazyLock<rocksdb::Cache> = LazyLock::new(|| {
    // Large unpartitioned SST indexes compete poorly in the default 64 small
    // shards. Keep the same shared budget, with four larger capacity pools.
    let mut options = rocksdb::LruCacheOptions::default();
    options.set_capacity(64 << 20);
    options.set_num_shard_bits(2);
    rocksdb::Cache::new_lru_cache_opts(&options)
});

#[derive(Debug, Eq, PartialEq)]
pub struct DBRow {
    pub key: Vec<u8>,
    pub value: Vec<u8>,
}

pub struct ScanIterator<'a> {
    prefix: Vec<u8>,
    iter: rocksdb::DBIterator<'a>,
    done: bool,
}

impl Iterator for ScanIterator<'_> {
    type Item = DBRow;

    fn next(&mut self) -> Option<DBRow> {
        if self.done {
            return None;
        }
        let (key, value) = self.iter.next().map(Result::ok)??;
        if !key.starts_with(&self.prefix) {
            self.done = true;
            return None;
        }
        Some(DBRow {
            key: key.to_vec(),
            value: value.to_vec(),
        })
    }
}

pub struct ReverseScanIterator<'a> {
    prefix: Vec<u8>,
    iter: rocksdb::DBRawIterator<'a>,
    done: bool,
}

impl Iterator for ReverseScanIterator<'_> {
    type Item = DBRow;

    fn next(&mut self) -> Option<DBRow> {
        if self.done || !self.iter.valid() {
            return None;
        }

        let key = self.iter.key().unwrap();
        if !key.starts_with(&self.prefix) {
            self.done = true;
            return None;
        }

        let row = DBRow {
            key: key.into(),
            value: self.iter.value().unwrap().into(),
        };

        self.iter.prev();

        Some(row)
    }
}

pub struct ReverseScanGroupIterator<'a> {
    iters: Vec<ReverseScanIterator<'a>>,
    next_rows: Vec<Option<DBRow>>,
    value_offset: usize,
    done: bool,
}

impl<'a> ReverseScanGroupIterator<'a> {
    pub fn new(
        mut iters: Vec<ReverseScanIterator<'a>>,
        value_offset: usize,
    ) -> ReverseScanGroupIterator<'a> {
        let mut next_rows: Vec<Option<DBRow>> = Vec::with_capacity(iters.len());
        for iter in &mut iters {
            let next = iter.next();
            next_rows.push(next);
        }
        let done = next_rows.iter().all(|row| row.is_none());
        ReverseScanGroupIterator {
            iters,
            next_rows,
            value_offset,
            done,
        }
    }
}

impl Iterator for ReverseScanGroupIterator<'_> {
    type Item = DBRow;

    fn next(&mut self) -> Option<DBRow> {
        if self.done {
            return None;
        }

        let best_index = self
            .next_rows
            .iter()
            .enumerate()
            .max_by(|(a_index, a_opt), (b_index, b_opt)| match (a_opt, b_opt) {
                (None, None) => a_index.cmp(b_index),

                (Some(_), None) => std::cmp::Ordering::Greater,

                (None, Some(_)) => std::cmp::Ordering::Less,

                (Some(a), Some(b)) => a.key[self.value_offset..].cmp(&(b.key[self.value_offset..])),
            })
            .map(|(index, _)| index)
            .unwrap_or(0);

        let best = self.next_rows[best_index].take();
        self.next_rows[best_index] = self.iters.get_mut(best_index)?.next();
        if self.next_rows.iter().all(|row| row.is_none()) {
            self.done = true;
        }

        best
    }
}

#[derive(Debug)]
pub struct DB {
    db: rocksdb::DB,
}

#[derive(Copy, Clone, Debug)]
pub enum DBFlush {
    Disable,
    Enable,
}

impl DB {
    pub fn open(path: &Path, config: &Config) -> DB {
        let db = DB {
            db: open_raw_db(path, OpenMode::ReadWrite),
        };
        db.verify_compatibility(config);
        db
    }

    pub fn full_compaction(&self) {
        // TODO: make sure this doesn't fail silently
        debug!("starting full compaction on {:?}", self.db);
        self.db.compact_range(None::<&[u8]>, None::<&[u8]>);
        debug!("finished full compaction on {:?}", self.db);
    }

    pub fn enable_auto_compaction(&self) {
        let opts = [("disable_auto_compactions", "false")];
        self.db.set_options(&opts).unwrap();
    }

    pub fn raw_iterator(&self) -> rocksdb::DBRawIterator<'_> {
        self.db.raw_iterator()
    }

    pub fn iter_scan(&self, prefix: &[u8]) -> ScanIterator<'_> {
        ScanIterator {
            prefix: prefix.to_vec(),
            iter: self.db.prefix_iterator(prefix),
            done: false,
        }
    }

    pub fn iter_scan_from(&self, prefix: &[u8], start_at: &[u8]) -> ScanIterator<'_> {
        let iter = self.db.iterator(rocksdb::IteratorMode::From(
            start_at,
            rocksdb::Direction::Forward,
        ));
        ScanIterator {
            prefix: prefix.to_vec(),
            iter,
            done: false,
        }
    }

    pub fn iter_scan_reverse(&self, prefix: &[u8], prefix_max: &[u8]) -> ReverseScanIterator<'_> {
        let mut iter = self.db.raw_iterator();
        iter.seek_for_prev(prefix_max);

        ReverseScanIterator {
            prefix: prefix.to_vec(),
            iter,
            done: false,
        }
    }

    pub fn iter_scan_group_reverse(
        &self,
        prefixes: impl Iterator<Item = (Vec<u8>, Vec<u8>)>,
        value_offset: usize,
    ) -> ReverseScanGroupIterator<'_> {
        let iters = prefixes
            .map(|(prefix, prefix_max)| {
                let mut iter = self.db.raw_iterator();
                iter.seek_for_prev(prefix_max);
                ReverseScanIterator {
                    prefix: prefix.to_vec(),
                    iter,
                    done: false,
                }
            })
            .collect();
        ReverseScanGroupIterator::new(iters, value_offset)
    }

    pub fn write(&self, mut rows: Vec<DBRow>, flush: DBFlush) {
        debug!(
            "writing {} rows to {:?}, flush={:?}",
            rows.len(),
            self.db,
            flush
        );
        rows.sort_unstable_by(|a, b| a.key.cmp(&b.key));
        let mut batch = rocksdb::WriteBatch::default();
        for row in rows {
            batch.put(&row.key, &row.value);
        }
        let do_flush = match flush {
            DBFlush::Enable => true,
            DBFlush::Disable => false,
        };
        let mut opts = rocksdb::WriteOptions::new();
        opts.set_sync(do_flush);
        opts.disable_wal(!do_flush);
        self.db.write_opt(batch, &opts).unwrap();
    }

    pub fn delete(&self, keys: Vec<Vec<u8>>) {
        debug!("deleting {} rows from {:?}", keys.len(), self.db);
        for key in keys {
            let _ = self.db.delete(key).inspect_err(|err| {
                warn!("Error while deleting DB row: {err}");
            });
        }
    }

    pub fn flush(&self) {
        self.db.flush().unwrap();
    }

    pub fn put(&self, key: &[u8], value: &[u8]) {
        self.db.put(key, value).unwrap();
    }

    pub fn put_sync(&self, key: &[u8], value: &[u8]) {
        let mut opts = rocksdb::WriteOptions::new();
        opts.set_sync(true);
        self.db.put_opt(key, value, &opts).unwrap();
    }

    pub fn get(&self, key: &[u8]) -> Option<Bytes> {
        self.db.get(key).unwrap().map(|v| v.to_vec())
    }

    pub fn contains(&self, key: &[u8]) -> bool {
        self.db.get_pinned(key).unwrap().is_some()
    }

    /// Coalesce SST metadata reads across a bounded set of keys. Empty values
    /// are present; an I/O error must never be interpreted as a missing marker.
    pub fn contains_many<K: AsRef<[u8]>>(&self, keys: &[K]) -> Result<Vec<bool>, rocksdb::Error> {
        let cf = self
            .db
            .cf_handle("default")
            .expect("missing default column family");
        self.db
            .batched_multi_get_cf(&cf, keys, false)
            .into_iter()
            .map(|result| result.map(|value| value.is_some()))
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn open_test(path: &Path) -> Self {
        Self {
            db: open_raw_db(path, OpenMode::ReadWrite),
        }
    }

    fn verify_compatibility(&self, config: &Config) {
        let mut compatibility_bytes = bincode_util::serialize_little(&DB_VERSION).unwrap();
        #[cfg(feature = "verge")]
        {
            compatibility_bytes.extend_from_slice(b"verge-wire-v1\0");
            compatibility_bytes.extend_from_slice(
                config
                    .network_type
                    .verge_network()
                    .parameters()
                    .genesis
                    .as_bytes(),
            );
            compatibility_bytes.push(u8::from(config.index_unspendables));
            compatibility_bytes.push(u8::from(config.address_search));
        }

        if config.light_mode {
            // append a byte to indicate light_mode is enabled.
            // we're not letting bincode serialize this so that the compatiblity bytes won't change
            // (and require a reindex) when light_mode is disabled. this should be chagned the next
            // time we bump DB_VERSION and require a re-index anyway.
            compatibility_bytes.push(1);
        }

        match self.get(b"V") {
            None => self.put(b"V", &compatibility_bytes),
            Some(ref x) if x != &compatibility_bytes => {
                panic!("Incompatible database found. Please reindex.")
            }
            Some(_) => (),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum OpenMode {
    ReadOnly,
    ReadWrite,
}

pub fn open_raw_db<T: rocksdb::ThreadMode>(
    path: &Path,
    read_mode: OpenMode,
) -> rocksdb::DBWithThreadMode<T> {
    debug!("opening DB at {:?}", path);
    open_with_options(path, read_mode, raw_options(&BLOCK_CACHE))
}

fn raw_options(cache: &rocksdb::Cache) -> rocksdb::Options {
    let mut db_opts = rocksdb::Options::default();
    db_opts.create_if_missing(true);
    db_opts.set_max_open_files(512);
    db_opts.set_compaction_style(rocksdb::DBCompactionStyle::Level);
    db_opts.set_compression_type(rocksdb::DBCompressionType::None);
    db_opts.set_target_file_size_base(1_073_741_824);
    db_opts.set_write_buffer_size(32 << 20);
    db_opts.set_max_write_buffer_number(2);
    db_opts.set_write_buffer_manager(&WRITE_BUFFERS);
    let mut block_opts = rocksdb::BlockBasedOptions::default();
    block_opts.set_block_cache(cache);
    block_opts.set_cache_index_and_filter_blocks(true);
    db_opts.set_block_based_table_factory(&block_opts);
    db_opts.set_disable_auto_compactions(true); // for initial bulk load

    // db_opts.set_advise_random_on_open(???);
    db_opts.set_compaction_readahead_size(1 << 20);
    db_opts.increase_parallelism(2);

    db_opts
}

fn open_with_options<T: rocksdb::ThreadMode>(
    path: &Path,
    read_mode: OpenMode,
    db_opts: rocksdb::Options,
) -> rocksdb::DBWithThreadMode<T> {
    // Open the same existing default keyspace with an explicit handle for the
    // optimized MultiGet API. Preserve its table/cache/write-buffer options.
    let cfs = [("default", db_opts.clone())];
    match read_mode {
        OpenMode::ReadOnly => rocksdb::DBWithThreadMode::<T>::open_cf_with_opts_for_read_only(
            &db_opts, path, cfs, false,
        )
        .expect("failed to open RocksDB (READ ONLY)"),
        OpenMode::ReadWrite => {
            rocksdb::DBWithThreadMode::<T>::open_cf_with_opts(&db_opts, path, cfs)
                .expect("failed to open RocksDB")
        }
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;

    #[test]
    fn partial_import_rows_and_empty_done_markers_survive_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let key = [b"D".as_slice(), &[42_u8; 32]].concat();
        let version = bincode_util::serialize_little(&DB_VERSION).unwrap();
        {
            let db = DB::open_test(directory.path());
            db.put_sync(b"V", &version);
            db.write(
                vec![
                    DBRow {
                        key: key.clone(),
                        value: vec![],
                    },
                    DBRow {
                        key: b"preserved".to_vec(),
                        value: b"history".to_vec(),
                    },
                ],
                DBFlush::Disable,
            );
            db.flush();
            assert!(db.contains(&key));
            assert!(!db.contains(b"t"));
        }
        let db = DB::open_test(directory.path());
        assert_eq!(db.get(b"V"), Some(version));
        assert_eq!(db.get(b"preserved"), Some(b"history".to_vec()));
        assert!(db.contains(&key));
        assert!(!db.contains(b"t"));
        db.delete(vec![key.clone()]);
        assert!(!db.contains(&key));
        assert_eq!(WRITE_BUFFERS.get_buffer_size(), 128 << 20);
    }

    #[test]
    fn batched_presence_preserves_order_duplicates_and_legacy_empty_markers() {
        let directory = tempfile::tempdir().unwrap();
        let present = [b"D".as_slice(), &[42_u8; 32]].concat();
        let missing = [b"D".as_slice(), &[43_u8; 32]].concat();
        // The pre-batch opener has no explicit column-family handles.
        {
            let db = rocksdb::DB::open(&raw_options(&BLOCK_CACHE), directory.path()).unwrap();
            db.put(&present, []).unwrap();
            db.put(b"other", b"retained").unwrap();
            db.flush().unwrap();
        }
        for mode in [OpenMode::ReadOnly, OpenMode::ReadWrite] {
            let db = DB {
                db: open_raw_db(directory.path(), mode),
            };
            assert_eq!(
                db.contains_many(&[missing.clone(), present.clone(), present.clone()])
                    .unwrap(),
                [false, true, true]
            );
            assert!(db.contains_many::<Vec<u8>>(&[]).unwrap().is_empty());
            assert_eq!(db.get(b"other"), Some(b"retained".to_vec()));
        }
    }

    /// Opt-in comparison on an isolated synthetic fixture or an explicitly
    /// marked, stopped database COPY. Never run this against a live database.
    #[test]
    #[ignore = "isolated marker lookup performance comparison"]
    fn marker_lookup_benchmark() {
        use bitcoin::hashes::{sha256, Hash};
        use std::time::Instant;

        fn key(number: u64) -> Vec<u8> {
            [
                b"D".as_slice(),
                sha256::Hash::hash(&number.to_le_bytes()).as_ref(),
            ]
            .concat()
        }

        let fixture = tempfile::tempdir().unwrap();
        let copy = std::env::var_os("ELECTRS_MARKER_BENCH_COPY");
        let (path, capacity, mut keys) = if let Some(copy) = copy {
            let path = std::path::PathBuf::from(copy);
            assert!(
                path.is_absolute() && path.join("CURRENT").is_file(),
                "select an existing absolute txstore COPY path"
            );
            assert!(
                path.parent().unwrap().join("BENCHMARK_COPY_ONLY").is_file(),
                "mark the stopped copy's parent with BENCHMARK_COPY_ONLY first"
            );
            let cache = rocksdb::Cache::new_lru_cache(64 << 20);
            let db: rocksdb::DB = open_with_options(&path, OpenMode::ReadOnly, raw_options(&cache));
            // Spread samples across the hash range, rather than taking only
            // the first lexicographic markers. This is bounded on a large DB.
            let mut iter = db.raw_iterator();
            let mut keys = Vec::new();
            for slot in 0..2_048_u16 {
                let mut target = [0_u8; 33];
                target[0] = b'D';
                target[1] = (slot >> 3) as u8;
                target[2] = ((slot & 7) << 5) as u8;
                iter.seek(target);
                if let (Some(key), Some(value)) = (iter.key(), iter.value()) {
                    if !key.starts_with(b"D") {
                        continue;
                    }
                    assert_eq!(key.len(), 33);
                    assert!(value.is_empty());
                    keys.push(key.to_vec());
                }
                iter.status().unwrap();
            }
            assert!(!keys.is_empty(), "copy has no persisted completion markers");
            (path, 64 << 20, keys)
        } else {
            // Scale the metadata/shard ratio without producing a multi-GB DB.
            // This is not a measurement of the production database or hardware.
            let path = fixture.path().join("fixture");
            let mut opts = raw_options(&BLOCK_CACHE);
            opts.set_level_zero_slowdown_writes_trigger(1_000);
            opts.set_level_zero_stop_writes_trigger(1_000);
            let mut table = rocksdb::BlockBasedOptions::default();
            table.set_block_size(128);
            table.set_cache_index_and_filter_blocks(true);
            table.set_block_cache(&BLOCK_CACHE);
            opts.set_block_based_table_factory(&table);
            let db: rocksdb::DB = open_with_options(&path, OpenMode::ReadWrite, opts);
            let mut keys = Vec::new();
            for file in 0..48_u64 {
                let mut batch = rocksdb::WriteBatch::default();
                for row in 0..4_000_u64 {
                    let marker = key(file * 4_000 + row);
                    batch.put(&marker, []);
                    let mut filler = marker.clone();
                    filler[0] = b'T';
                    batch.put(&filler, [17_u8; 48]);
                    if row % 96 == 0 {
                        keys.push(marker);
                    }
                }
                db.write(batch).unwrap();
                db.flush().unwrap();
            }
            eprintln!(
                "synthetic fixture: {}",
                db.property_value("rocksdb.aggregated-table-properties")
                    .unwrap()
                    .unwrap_or_default()
            );
            (path, 8 << 20, keys)
        };
        let count = keys.len();
        keys.extend((0..count).map(|i| key(u64::MAX - i as u64)));
        let mut seed = 123_u64;
        for i in (1..keys.len()).rev() {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            keys.swap(i, seed as usize % (i + 1));
        }
        let mut expected = None;
        let mut modes = vec![(6, false), (6, true), (2, false), (2, true)];
        for round in 1..=3 {
            for &(bits, batched) in &modes {
                let mut cache_opts = rocksdb::LruCacheOptions::default();
                cache_opts.set_capacity(capacity);
                cache_opts.set_num_shard_bits(bits);
                let cache = rocksdb::Cache::new_lru_cache_opts(&cache_opts);
                let mut opts = raw_options(&cache);
                opts.enable_statistics();
                let db = DB {
                    db: open_with_options(&path, OpenMode::ReadOnly, opts.clone()),
                };
                let before = Instant::now();
                let present: Vec<bool> = if batched {
                    keys.chunks(4_096)
                        .flat_map(|keys| db.contains_many(keys).unwrap())
                        .collect()
                } else {
                    keys.iter().map(|key| db.contains(key)).collect()
                };
                let elapsed = before.elapsed().as_secs_f64();
                if let Some(expected) = &expected {
                    assert_eq!(expected, &present);
                } else {
                    expected = Some(present);
                }
                eprintln!("marker_benchmark source={} round={} keys={} cache_bytes={} shards={} batched={} elapsed_s={:.6} keys_per_s={:.1} cache_usage_bytes={} cache_pinned_bytes={}",
                    if std::env::var_os("ELECTRS_MARKER_BENCH_COPY").is_some() { "stopped-copy" } else { "scaled-synthetic" },
                    round, keys.len(), capacity, 1 << bits, batched, elapsed, keys.len() as f64 / elapsed, cache.get_usage(), cache.get_pinned_usage());
                for line in opts.get_statistics().unwrap().lines().filter(|line| {
                    line.contains("rocksdb.block.cache.index.")
                        || line.contains("rocksdb.block.read.byte")
                }) {
                    eprintln!("{line}");
                }
            }
            modes.reverse();
        }
    }
}
