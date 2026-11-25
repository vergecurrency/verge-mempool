// Copyright (c) 2026 The Verge Currency Developers
// Distributed under the MIT software license; see ../../LICENSE.

use crate::transaction::{compact, vector, Borrowed, Reader};
use crate::{Error, Transaction, MAX_SERIALIZED_BYTES};
use bitcoin::consensus::{encode, Decodable, Encodable};
use bitcoin::{
    block::Version,
    hashes::{sha256, sha256d, Hash},
    BlockHash, CompactTarget, TxMerkleNode, Weight,
};
use std::{ops::Deref, sync::OnceLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderFields {
    pub version: Version,
    pub prev_blockhash: BlockHash,
    pub merkle_root: TxMerkleNode,
    pub time: u32,
    pub bits: CompactTarget,
    pub nonce: u32,
    pub pos_data_hash: Option<[u8; 32]>,
}

/// Immutable fields allow safely caching the expensive Scrypt block ID.
#[derive(Debug, Clone)]
pub struct Header {
    fields: HeaderFields,
    hash: OnceLock<BlockHash>,
}
impl PartialEq for Header {
    fn eq(&self, other: &Self) -> bool {
        self.fields == other.fields
    }
}
impl Eq for Header {}
impl Deref for Header {
    type Target = HeaderFields;
    fn deref(&self) -> &Self::Target {
        &self.fields
    }
}

impl Header {
    pub fn is_pos(&self) -> bool {
        self.version.to_consensus() & 0x8000 != 0
    }
    pub fn block_hash(&self) -> BlockHash {
        *self.hash.get_or_init(|| {
            let bytes = bitcoin::consensus::serialize(self);
            BlockHash::from_byte_array(if self.is_pos() {
                sha256d::Hash::hash(&bytes).to_byte_array()
            } else {
                crate::scrypt::hash(&bytes)
            })
        })
    }
    fn read<R: bitcoin::io::Read>(reader: &mut Reader<R>) -> Result<Self, Error> {
        let version = Version::from_consensus(i32::from_le_bytes(reader.array()?));
        let fields = HeaderFields {
            version,
            prev_blockhash: BlockHash::from_byte_array(reader.array()?),
            merkle_root: TxMerkleNode::from_byte_array(reader.array()?),
            time: reader.u32()?,
            bits: CompactTarget::from_consensus(reader.u32()?),
            nonce: reader.u32()?,
            pos_data_hash: if version.to_consensus() & 0x8000 != 0 {
                Some(reader.array()?)
            } else {
                None
            },
        };
        if fields.pos_data_hash.is_some() && (fields.bits.to_consensus() != 0 || fields.nonce != 0)
        {
            return Err(Error::InvalidBlock);
        }
        Ok(Self {
            fields,
            hash: OnceLock::new(),
        })
    }
}
impl Encodable for Header {
    fn consensus_encode<W: bitcoin::io::Write + ?Sized>(
        &self,
        w: &mut W,
    ) -> Result<usize, bitcoin::io::Error> {
        self.version.consensus_encode(w)?;
        self.prev_blockhash.consensus_encode(w)?;
        self.merkle_root.consensus_encode(w)?;
        self.time.consensus_encode(w)?;
        self.bits.consensus_encode(w)?;
        self.nonce.consensus_encode(w)?;
        if let Some(hash) = self.pos_data_hash {
            w.write_all(&hash)?;
            Ok(112)
        } else {
            Ok(80)
        }
    }
}
impl Decodable for Header {
    fn consensus_decode<R: bitcoin::io::Read + ?Sized>(r: &mut R) -> Result<Self, encode::Error> {
        Self::read(&mut Reader::new(Borrowed(r), 112))
            .map_err(|_| encode::Error::ParseFailed("invalid Verge header"))
    }
}

#[derive(Debug, Clone)]
pub struct Block {
    pub header: Header,
    pub txdata: Vec<Transaction>,
    pub signature: Vec<u8>,
    /// Canonical typed PoS extension, retained verbatim after structural checks.
    pub pos_extension: Option<Vec<u8>>,
}

fn tagged(tag: &[u8], bytes: &[u8]) -> [u8; 32] {
    let tag = sha256::Hash::hash(tag).to_byte_array();
    let mut data = Vec::with_capacity(64 + bytes.len());
    data.extend(tag);
    data.extend(tag);
    data.extend(bytes);
    sha256::Hash::hash(&data).to_byte_array()
}

fn authenticated_record<R: bitcoin::io::Read>(
    r: &mut Reader<R>,
    ext: &mut Vec<u8>,
    signatures: &mut Vec<(usize, usize)>,
    version: u8,
    legacy_size: usize,
) -> Result<(), Error> {
    let size = legacy_size + if version == 2 { 1312 + 2420 } else { 0 };
    let record = r.take(size)?;
    if record[0] != version {
        return Err(Error::InvalidBlock);
    }
    let offset = ext.len();
    signatures.push((offset + legacy_size - 64, offset + legacy_size));
    if version == 2 {
        signatures.push((offset + legacy_size + 1312, offset + size));
    }
    ext.extend(record);
    Ok(())
}

impl Block {
    pub fn block_hash(&self) -> BlockHash {
        self.header.block_hash()
    }
    pub fn total_size(&self) -> usize {
        bitcoin::consensus::serialize(self).len()
    }
    pub fn weight(&self) -> Weight {
        Weight::from_wu(self.total_size() as u64 * 4)
    }
    fn read<R: bitcoin::io::Read>(r: &mut Reader<R>) -> Result<Self, Error> {
        let header = Header::read(r)?;
        let count = r.compact()?;
        if count == 0 || count > r.remaining() / 64 {
            return Err(Error::InvalidBlock);
        }
        let mut txdata = Vec::with_capacity(count);
        for _ in 0..count {
            txdata.push(Transaction::read(r)?);
        }
        let signature = r.vector()?;
        let pos_extension = if header.is_pos() {
            if !signature.is_empty() {
                return Err(Error::InvalidBlock);
            }
            let version = r.take(1)?[0];
            if version != 1 && version != 2 {
                return Err(Error::InvalidBlock);
            }
            let mut ext = vec![version];
            let proof = r.take(295)?;
            if proof[0] != version
                || (version == 2
                    && (proof[117..150].iter().any(|b| *b != 0)
                        || proof[182..263].iter().any(|b| *b != 0)))
            {
                return Err(Error::InvalidBlock);
            }
            ext.extend(proof);
            let mut signatures = Vec::new();
            authenticated_record(r, &mut ext, &mut signatures, version, 273)?;
            let mut evidence_count = 0;
            for (kind, max) in [(0, if version == 2 { 192 } else { 1024 }), (1, 16), (2, 16)] {
                let count = r.compact()?;
                if count > max || (kind == 2 && count + evidence_count > 16) {
                    return Err(Error::InvalidBlock);
                }
                if kind == 1 {
                    evidence_count = count;
                }
                compact(&mut ext, count);
                for _ in 0..count {
                    if kind == 0 {
                        authenticated_record(r, &mut ext, &mut signatures, version, 229)?;
                    } else {
                        if r.take(1)?[0] != version {
                            return Err(Error::InvalidBlock);
                        }
                        ext.push(version);
                        let size = if kind == 1 { 273 } else { 229 };
                        authenticated_record(r, &mut ext, &mut signatures, version, size)?;
                        authenticated_record(r, &mut ext, &mut signatures, version, size)?;
                    }
                }
            }
            let proof = &ext[1..296];
            let auth_size = if version == 2 { 4005 } else { 273 };
            let auth = &ext[296..296 + auth_size];
            let mut candidate = bitcoin::consensus::serialize(&header);
            candidate[80..112].fill(0);
            // V1 normalizes only the producer signature; V2 normalizes every
            // classical/PQ signature, never the registered PQ public keys.
            let mut committed = ext.clone();
            let count = if version == 2 { signatures.len() } else { 1 };
            for (start, end) in signatures.into_iter().take(count) {
                committed[start..end].fill(0);
            }
            if Some(tagged(b"VergePoS/Data/v1", &committed)) != header.pos_data_hash
                || auth[5..37] != header.prev_blockhash.to_byte_array()
                || auth[37..69] != sha256d::Hash::hash(&candidate).to_byte_array()
                || auth[69..77] != proof[37..45]
                || auth[77..113] != proof[1..37]
                || auth[113..145] != tagged(b"VergePoS/StakeProof/v1", proof)
                || auth[145..177] != txdata[0].compute_txid().to_byte_array()
            {
                return Err(Error::InvalidBlock);
            }
            Some(ext)
        } else {
            None
        };
        if !txdata[0].is_coinbase() || txdata.iter().skip(1).any(Transaction::is_coinbase) {
            return Err(Error::InvalidBlock);
        }
        let root = bitcoin::merkle_tree::calculate_root(
            txdata.iter().map(|tx| tx.compute_txid().to_raw_hash()),
        );
        if root.map(TxMerkleNode::from_raw_hash) != Some(header.merkle_root) {
            return Err(Error::InvalidBlock);
        }
        Ok(Self {
            header,
            txdata,
            signature,
            pos_extension,
        })
    }
}
impl Decodable for Block {
    fn consensus_decode<R: bitcoin::io::Read + ?Sized>(r: &mut R) -> Result<Self, encode::Error> {
        Self::read(&mut Reader::new(Borrowed(r), MAX_SERIALIZED_BYTES))
            .map_err(|_| encode::Error::ParseFailed("invalid Verge block"))
    }
}
impl Encodable for Block {
    fn consensus_encode<W: bitcoin::io::Write + ?Sized>(
        &self,
        w: &mut W,
    ) -> Result<usize, bitcoin::io::Error> {
        let mut size = self.header.consensus_encode(w)?;
        size += bitcoin::VarInt(self.txdata.len() as u64).consensus_encode(w)?;
        for tx in &self.txdata {
            size += tx.consensus_encode(w)?;
        }
        let mut tail = Vec::new();
        vector(&mut tail, &self.signature);
        if let Some(ext) = &self.pos_extension {
            tail.extend(ext);
        }
        w.write_all(&tail)?;
        Ok(size + tail.len())
    }
}

pub struct MerkleBlock {
    pub header: Header,
    txn: bitcoin::merkle_tree::PartialMerkleTree,
}
impl MerkleBlock {
    pub fn from_header_txids_with_predicate<F: Fn(&bitcoin::Txid) -> bool>(
        header: &Header,
        txids: &[bitcoin::Txid],
        predicate: F,
    ) -> Self {
        let matches: Vec<bool> = txids.iter().map(predicate).collect();
        Self {
            header: header.clone(),
            txn: bitcoin::merkle_tree::PartialMerkleTree::from_txids(txids, &matches),
        }
    }
}
impl Encodable for MerkleBlock {
    fn consensus_encode<W: bitcoin::io::Write + ?Sized>(
        &self,
        w: &mut W,
    ) -> Result<usize, bitcoin::io::Error> {
        Ok(self.header.consensus_encode(w)? + self.txn.consensus_encode(w)?)
    }
}
