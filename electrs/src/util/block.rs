use bitcoin::hashes::Hash;

use crate::chain::{BlockHash, BlockHeader};
use crate::errors::*;
use crate::new_index::BlockEntry;

use std::collections::HashMap;
use std::fmt;
use std::slice;
use std::sync::Arc;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime as DateTime;

const MTP_SPAN: usize = 11;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BlockId {
    pub height: usize,
    pub hash: BlockHash,
    pub time: u32,
}

impl From<&HeaderEntry> for BlockId {
    fn from(header: &HeaderEntry) -> Self {
        BlockId {
            height: header.height(),
            hash: *header.hash(),
            time: header.header().time,
        }
    }
}

#[derive(Eq, PartialEq)]
struct HeaderEntryData {
    height: usize,
    hash: BlockHash,
    header: BlockHeader,
}

#[derive(Eq, PartialEq, Clone)]
pub struct HeaderEntry(Arc<HeaderEntryData>);

impl HeaderEntry {
    pub fn new(height: usize, header: BlockHeader) -> Self {
        Self(Arc::new(HeaderEntryData {
            height,
            hash: header.block_hash(),
            header,
        }))
    }

    pub fn hash(&self) -> &BlockHash {
        &self.0.hash
    }

    pub fn header(&self) -> &BlockHeader {
        &self.0.header
    }

    pub fn height(&self) -> usize {
        self.0.height
    }
}

impl fmt::Debug for HeaderEntry {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        let last_block_time = DateTime::from_unix_timestamp(self.header().time as i64).unwrap();
        write!(
            f,
            "hash={} height={} @ {}",
            self.hash(),
            self.height(),
            last_block_time.format(&Rfc3339).unwrap(),
        )
    }
}

pub struct HeaderList {
    headers: Vec<HeaderEntry>,
    heights: HashMap<BlockHash, usize>,
    tip: BlockHash,
}

impl HeaderList {
    pub fn empty() -> HeaderList {
        HeaderList {
            headers: vec![],
            heights: HashMap::new(),
            tip: BlockHash::all_zeros(),
        }
    }

    pub fn new<F>(mut lookup: F, tip_hash: BlockHash) -> HeaderList
    where
        F: FnMut(&BlockHash) -> Option<BlockHeader>,
    {
        let mut blockhash = tip_hash;
        let mut headers_chain: Vec<HeaderEntry> = vec![];
        let null_hash = BlockHash::all_zeros();

        while blockhash != null_hash {
            let header = lookup(&blockhash).unwrap_or_else(|| {
                panic!(
                    "missing persisted header: {:?}, pointed from: {:?}",
                    blockhash,
                    headers_chain.last().map(|h| h.hash())
                )
            });
            let entry = HeaderEntry::new(0, header);
            assert_eq!(*entry.hash(), blockhash);
            blockhash = entry.header().prev_blockhash;
            headers_chain.push(entry);
        }
        headers_chain.reverse();

        let mut heights = HashMap::with_capacity(headers_chain.len());
        for (height, entry) in headers_chain.iter_mut().enumerate() {
            Arc::get_mut(&mut entry.0).unwrap().height = height;
            heights.insert(*entry.hash(), height);
        }
        HeaderList {
            headers: headers_chain,
            heights,
            tip: tip_hash,
        }
    }

    pub fn order(&self, new_headers: Vec<BlockHeader>) -> Vec<HeaderEntry> {
        let prev_blockhash = match new_headers.first() {
            Some(h) => h.prev_blockhash,
            None => return vec![],
        };
        let null_hash = BlockHash::all_zeros();
        let new_height: usize = if prev_blockhash == null_hash {
            0
        } else {
            self.header_by_blockhash(&prev_blockhash)
                .unwrap_or_else(|| panic!("{} is not part of the blockchain", prev_blockhash))
                .height()
                + 1
        };
        let mut previous = prev_blockhash;
        new_headers
            .into_iter()
            .enumerate()
            .map(|(offset, header)| {
                assert_eq!(header.prev_blockhash, previous);
                let entry = HeaderEntry::new(new_height + offset, header);
                previous = *entry.hash();
                entry
            })
            .collect()
    }

    /// Returns any rolled back blocks in order from old tip first and first block in the fork is last
    /// It also returns the blockhash of the post-rollback tip.
    pub fn apply(
        &mut self,
        new_headers: Vec<HeaderEntry>,
    ) -> (Vec<HeaderEntry>, Option<BlockHash>) {
        // new_headers[i] -> new_headers[i - 1] (i.e. new_headers.last() is the tip)
        for i in 1..new_headers.len() {
            assert_eq!(new_headers[i - 1].height() + 1, new_headers[i].height());
            assert_eq!(
                *new_headers[i - 1].hash(),
                new_headers[i].header().prev_blockhash
            );
        }
        let new_height = match new_headers.first() {
            Some(entry) => {
                let height = entry.height();
                let expected_prev_blockhash = if height > 0 {
                    *self.headers[height - 1].hash()
                } else {
                    BlockHash::all_zeros()
                };
                assert_eq!(entry.header().prev_blockhash, expected_prev_blockhash);
                height
            }
            None => return (vec![], None),
        };
        debug!(
            "applying {} new headers from height {}",
            new_headers.len(),
            new_height
        );
        let mut removed = self.headers.split_off(new_height); // keep [0..new_height) entries
        for entry in &removed {
            self.heights.remove(entry.hash());
        }
        self.headers.reserve(new_headers.len());
        self.heights.reserve(new_headers.len());

        // If we reorged, we should return the last blockhash before adding the new chain's blockheaders.
        let reorged_tip = if !removed.is_empty() {
            self.headers.last().map(|be| be.hash()).cloned()
        } else {
            None
        };

        for new_header in new_headers {
            let height = new_header.height();
            assert_eq!(height, self.headers.len());
            self.tip = *new_header.hash();
            self.headers.push(new_header);
            self.heights.insert(self.tip, height);
        }
        removed.reverse();
        (removed, reorged_tip)
    }

    pub fn header_by_blockhash(&self, blockhash: &BlockHash) -> Option<&HeaderEntry> {
        let height = self.heights.get(blockhash)?;
        let header = self.headers.get(*height)?;
        if *blockhash == *header.hash() {
            Some(header)
        } else {
            None
        }
    }

    /// Roll back to a known ancestor when Core's new tip has no new headers.
    /// Return removed entries in the same reverse order as apply().
    pub fn rollback_to(&mut self, blockhash: &BlockHash) -> Vec<HeaderEntry> {
        let height = self
            .header_by_blockhash(blockhash)
            .expect("rollback tip must be indexed")
            .height();
        let mut removed = self.headers.split_off(height + 1);
        self.tip = *blockhash;
        for header in &removed {
            self.heights.remove(header.hash());
        }
        removed.reverse();
        removed
    }

    pub fn header_by_height(&self, height: usize) -> Option<&HeaderEntry> {
        self.headers.get(height).inspect(|entry| {
            assert_eq!(entry.height(), height);
        })
    }

    pub fn equals(&self, other: &HeaderList) -> bool {
        self.headers.last() == other.headers.last()
    }

    pub fn tip(&self) -> &BlockHash {
        assert_eq!(
            self.tip,
            self.headers
                .last()
                .map(|h| *h.hash())
                .unwrap_or(BlockHash::all_zeros())
        );
        &self.tip
    }

    pub fn len(&self) -> usize {
        self.headers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.headers.is_empty()
    }

    pub fn iter(&self) -> slice::Iter<'_, HeaderEntry> {
        self.headers.iter()
    }

    /// Get the Median Time Past
    pub fn get_mtp(&self, height: usize) -> u32 {
        // Use the timestamp as the mtp of the genesis block.
        // Matches bitcoind's behaviour: bitcoin-cli getblock `bitcoin-cli getblockhash 0` | jq '.time == .mediantime'
        if height == 0 {
            self.headers.first().unwrap().header().time
        } else if height > self.len() - 1 {
            0
        } else {
            let mut timestamps = (height.saturating_sub(MTP_SPAN - 1)..=height)
                .map(|p_height| self.headers.get(p_height).unwrap().header().time)
                .collect::<Vec<_>>();
            timestamps.sort_unstable();
            timestamps[timestamps.len() / 2]
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct BlockStatus {
    pub in_best_chain: bool,
    pub height: Option<usize>,
    pub next_best: Option<BlockHash>,
}

impl BlockStatus {
    pub fn confirmed(height: usize, next_best: Option<BlockHash>) -> BlockStatus {
        BlockStatus {
            in_best_chain: true,
            height: Some(height),
            next_best,
        }
    }

    pub fn orphaned() -> BlockStatus {
        BlockStatus {
            in_best_chain: false,
            height: None,
            next_best: None,
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct BlockMeta {
    #[serde(alias = "nTx")]
    pub tx_count: u32,
    pub size: u32,
    pub weight: u32,
}

pub struct BlockHeaderMeta {
    pub header_entry: HeaderEntry,
    pub meta: BlockMeta,
    pub mtp: u32,
}

#[cfg(all(test, not(feature = "liquid")))]
mod rollback_tests {
    use super::*;
    use bitcoin::consensus::deserialize;

    fn child(parent: BlockHash, nonce: u32) -> BlockHeader {
        let mut bytes = [0_u8; 80];
        bytes[..4].copy_from_slice(&1_i32.to_le_bytes());
        bytes[4..36].copy_from_slice(&parent.to_byte_array());
        bytes[76..80].copy_from_slice(&nonce.to_le_bytes());
        deserialize(&bytes).unwrap()
    }

    #[test]
    fn ancestor_only_rollback_removes_orphans_and_accepts_same_height_fork() {
        let genesis = child(BlockHash::all_zeros(), 0);
        let first = child(genesis.block_hash(), 1);
        let second = child(first.block_hash(), 2);
        let third = child(second.block_hash(), 3);
        let mut list = HeaderList::empty();
        list.apply(list.order(vec![
            genesis.clone(),
            first.clone(),
            second.clone(),
            third.clone(),
        ]));
        let removed = list.rollback_to(&first.block_hash());
        assert_eq!(
            removed
                .iter()
                .map(|entry| *entry.hash())
                .collect::<Vec<_>>(),
            vec![third.block_hash(), second.block_hash()]
        );
        assert_eq!(*list.tip(), first.block_hash());
        assert_eq!(list.len(), 2);
        assert!(list.header_by_blockhash(&second.block_hash()).is_none());
        let replacement = child(first.block_hash(), 4);
        let (removed, _) = list.apply(list.order(vec![replacement.clone()]));
        assert!(removed.is_empty());
        assert_eq!(*list.tip(), replacement.block_hash());
        assert_eq!(
            list.header_by_height(2).unwrap().hash(),
            &replacement.block_hash()
        );
        assert!(list.rollback_to(&replacement.block_hash()).is_empty());
    }

    #[test]
    fn clones_share_headers_and_reload_only_walks_the_indexed_chain() {
        let genesis = child(BlockHash::all_zeros(), 10);
        let next = child(genesis.block_hash(), 11);
        let tip = next.block_hash();
        let mut stored = HashMap::from([(genesis.block_hash(), genesis), (tip, next)]);
        let mut reads = 0;
        let list = HeaderList::new(
            |hash| {
                reads += 1;
                stored.remove(hash)
            },
            tip,
        );
        assert_eq!(reads, 2);
        let entry = list.header_by_height(1).unwrap();
        let cloned = entry.clone();
        assert!(std::ptr::eq(entry.header(), cloned.header()));
        assert_eq!(
            std::mem::size_of::<HeaderEntry>(),
            std::mem::size_of::<usize>()
        );
        assert_eq!(*list.tip(), tip);
    }
}

impl From<&BlockEntry> for BlockMeta {
    fn from(b: &BlockEntry) -> BlockMeta {
        #[cfg(not(feature = "liquid"))]
        let weight = b.block.weight().to_wu() as u32;
        #[cfg(feature = "liquid")]
        let weight = b.block.weight() as u32;
        BlockMeta {
            tx_count: b.block.txdata.len() as u32,
            weight,
            size: b.size,
        }
    }
}

impl BlockMeta {
    pub fn parse_getblock(val: ::serde_json::Value) -> Result<BlockMeta> {
        Ok(BlockMeta {
            tx_count: val
                .get("nTx")
                .chain_err(|| "missing nTx")?
                .as_f64()
                .chain_err(|| "nTx not a number")? as u32,
            size: val
                .get("size")
                .chain_err(|| "missing size")?
                .as_f64()
                .chain_err(|| "size not a number")? as u32,
            weight: val
                .get("weight")
                .chain_err(|| "missing weight")?
                .as_f64()
                .chain_err(|| "weight not a number")? as u32,
        })
    }
}
