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
static BLOCK_CACHE: LazyLock<rocksdb::Cache> =
    LazyLock::new(|| rocksdb::Cache::new_lru_cache(64 << 20));

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
    block_opts.set_block_cache(&BLOCK_CACHE);
    block_opts.set_cache_index_and_filter_blocks(true);
    db_opts.set_block_based_table_factory(&block_opts);
    db_opts.set_disable_auto_compactions(true); // for initial bulk load

    // db_opts.set_advise_random_on_open(???);
    db_opts.set_compaction_readahead_size(1 << 20);
    db_opts.increase_parallelism(2);

    match read_mode {
        OpenMode::ReadOnly => {
            rocksdb::DBWithThreadMode::<T>::open_for_read_only(&db_opts, path, false)
                .expect("failed to open RocksDB (READ ONLY)")
        }
        OpenMode::ReadWrite => {
            rocksdb::DBWithThreadMode::<T>::open(&db_opts, path).expect("failed to open RocksDB")
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
}
