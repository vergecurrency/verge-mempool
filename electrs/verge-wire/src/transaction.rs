// Copyright (c) 2026 The Verge Currency Developers
// Distributed under the MIT software license; see ../../LICENSE.

use bitcoin::hashes::{sha256d, Hash};
use bitcoin::{absolute, Amount, OutPoint, ScriptBuf, Sequence, TxIn, TxOut, Txid, Witness};
use std::fmt;

use crate::MAX_MONEY;

pub const POS_VERSION: i32 = 0x0547_5658;
pub const POS_REPLAY_MARKER: u32 = 0x4756_5800;
/// Decoder allocation bound, not a claim about consensus block capacity.
pub const MAX_SERIALIZED_BYTES: usize = 4_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Truncated,
    NoncanonicalCompactSize,
    SizeLimit,
    EmptyInputs,
    EmptyOutputs,
    InvalidReplayMarker,
    InvalidAmount,
    UnsupportedWitness,
    TrailingBytes,
    InvalidBlock,
    InvalidAddress,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Truncated => "truncated Verge transaction",
            Self::NoncanonicalCompactSize => "noncanonical CompactSize",
            Self::SizeLimit => "Verge decoder size limit exceeded",
            Self::EmptyInputs => "transaction has no inputs",
            Self::EmptyOutputs => "transaction has no outputs",
            Self::InvalidReplayMarker => "invalid Verge PoS replay marker",
            Self::InvalidAmount => "output value or total outside Verge money range",
            Self::UnsupportedWitness => "Verge transactions cannot serialize witness data",
            Self::TrailingBytes => "unexpected bytes after Verge transaction",
            Self::InvalidBlock => "invalid Verge block structure or commitment",
            Self::InvalidAddress => "invalid address or address on another Verge network",
        })
    }
}

impl std::error::Error for Error {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transaction {
    pub version: i32,
    pub time: u32,
    pub input: Vec<TxIn>,
    pub output: Vec<TxOut>,
    pub lock_time: absolute::LockTime,
}

impl Transaction {
    /// Decode one complete transaction, rejecting appended or witness data.
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        let (transaction, consumed) = Self::decode_prefix(bytes)?;
        if consumed != bytes.len() {
            return Err(Error::TrailingBytes);
        }
        Ok(transaction)
    }

    /// Decode a transaction prefix for a future block decoder. All lengths are
    /// checked against available bytes before allocation. No Bitcoin transaction
    /// decoder or witness-marker interpretation is used.
    pub fn decode_prefix(bytes: &[u8]) -> Result<(Self, usize), Error> {
        if bytes.len() > MAX_SERIALIZED_BYTES {
            return Err(Error::SizeLimit);
        }
        let mut reader = Reader::new(bitcoin::io::Cursor::new(bytes), bytes.len());
        let transaction = Self::read(&mut reader)?;
        Ok((transaction, reader.offset))
    }

    pub(crate) fn read<R: bitcoin::io::Read>(reader: &mut Reader<R>) -> Result<Self, Error> {
        let version = i32::from_le_bytes(reader.array()?);
        let time = u32::from_le_bytes(reader.array()?);
        if version == POS_VERSION && reader.u32()? != POS_REPLAY_MARKER {
            return Err(Error::InvalidReplayMarker);
        }
        let input_count = reader.compact()?;
        if input_count == 0 {
            return Err(Error::EmptyInputs);
        }
        if input_count > reader.remaining() / 41 {
            return Err(Error::Truncated);
        }
        let mut input = Vec::with_capacity(input_count);
        for _ in 0..input_count {
            let txid = Txid::from_byte_array(reader.array()?);
            let vout = reader.u32()?;
            let script_sig = ScriptBuf::from_bytes(reader.vector()?);
            let sequence = Sequence(reader.u32()?);
            input.push(TxIn {
                previous_output: OutPoint { txid, vout },
                script_sig,
                sequence,
                witness: Witness::new(),
            });
        }
        let output_count = reader.compact()?;
        if output_count == 0 {
            return Err(Error::EmptyOutputs);
        }
        if output_count > reader.remaining() / 9 {
            return Err(Error::Truncated);
        }
        let mut output = Vec::with_capacity(output_count);
        let mut total = 0_u64;
        for _ in 0..output_count {
            let value = u64::from_le_bytes(reader.array()?);
            total = checked_total(total, value)?;
            let script_pubkey = ScriptBuf::from_bytes(reader.vector()?);
            output.push(TxOut {
                value: Amount::from_sat(value),
                script_pubkey,
            });
        }
        let lock_time = absolute::LockTime::from_consensus(reader.u32()?);
        Ok(Self {
            version,
            time,
            input,
            output,
            lock_time,
        })
    }

    /// Encode the canonical timestamped, non-witness Verge representation.
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        let size = self.serialized_size()?;
        let mut bytes = Vec::with_capacity(size);
        bytes.extend_from_slice(&self.version.to_le_bytes());
        bytes.extend_from_slice(&self.time.to_le_bytes());
        if self.version == POS_VERSION {
            bytes.extend_from_slice(&POS_REPLAY_MARKER.to_le_bytes());
        }
        compact(&mut bytes, self.input.len());
        for input in &self.input {
            bytes.extend_from_slice(&input.previous_output.txid.to_byte_array());
            bytes.extend_from_slice(&input.previous_output.vout.to_le_bytes());
            vector(&mut bytes, input.script_sig.as_bytes());
            bytes.extend_from_slice(&input.sequence.0.to_le_bytes());
        }
        compact(&mut bytes, self.output.len());
        for output in &self.output {
            bytes.extend_from_slice(&output.value.to_sat().to_le_bytes());
            vector(&mut bytes, output.script_pubkey.as_bytes());
        }
        bytes.extend_from_slice(&self.lock_time.to_consensus_u32().to_le_bytes());
        Ok(bytes)
    }

    /// Includes the timestamp and the version-dependent replay marker.
    pub fn txid(&self) -> Result<Txid, Error> {
        Ok(Txid::from_raw_hash(sha256d::Hash::hash(&self.encode()?)))
    }

    pub fn is_coinbase(&self) -> bool {
        self.input.len() == 1 && self.input[0].previous_output.is_null()
    }

    pub fn serialized_size(&self) -> Result<usize, Error> {
        if self.input.is_empty() {
            return Err(Error::EmptyInputs);
        }
        if self.output.is_empty() {
            return Err(Error::EmptyOutputs);
        }
        let mut size = 12 + usize::from(self.version == POS_VERSION) * 4;
        add_size(&mut size, compact_size(self.input.len()))?;
        add_size(&mut size, compact_size(self.output.len()))?;
        for input in &self.input {
            if !input.witness.is_empty() {
                return Err(Error::UnsupportedWitness);
            }
            add_size(&mut size, 40 + compact_size(input.script_sig.len()))?;
            add_size(&mut size, input.script_sig.len())?;
        }
        let mut total = 0;
        for output in &self.output {
            total = checked_total(total, output.value.to_sat())?;
            add_size(&mut size, 8 + compact_size(output.script_pubkey.len()))?;
            add_size(&mut size, output.script_pubkey.len())?;
        }
        Ok(size)
    }
}

fn checked_total(total: u64, value: u64) -> Result<u64, Error> {
    if value > MAX_MONEY {
        return Err(Error::InvalidAmount);
    }
    total
        .checked_add(value)
        .filter(|sum| *sum <= MAX_MONEY)
        .ok_or(Error::InvalidAmount)
}

fn add_size(size: &mut usize, increment: usize) -> Result<(), Error> {
    *size = size
        .checked_add(increment)
        .filter(|sum| *sum <= MAX_SERIALIZED_BYTES)
        .ok_or(Error::SizeLimit)?;
    Ok(())
}

fn compact_size(value: usize) -> usize {
    match value as u64 {
        0..=0xfc => 1,
        0xfd..=0xffff => 3,
        0x1_0000..=0xffff_ffff => 5,
        _ => 9,
    }
}

pub(crate) fn compact(bytes: &mut Vec<u8>, value: usize) {
    match value as u64 {
        0..=0xfc => bytes.push(value as u8),
        0xfd..=0xffff => {
            bytes.push(0xfd);
            bytes.extend_from_slice(&(value as u16).to_le_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            bytes.push(0xfe);
            bytes.extend_from_slice(&(value as u32).to_le_bytes());
        }
        _ => {
            bytes.push(0xff);
            bytes.extend_from_slice(&(value as u64).to_le_bytes());
        }
    }
}

pub(crate) fn vector(bytes: &mut Vec<u8>, value: &[u8]) {
    compact(bytes, value.len());
    bytes.extend_from_slice(value);
}

pub(crate) struct Reader<R> {
    source: R,
    pub(crate) offset: usize,
    limit: usize,
}

pub(crate) struct Borrowed<'a, R: ?Sized>(pub &'a mut R);
impl<R: bitcoin::io::Read + ?Sized> bitcoin::io::Read for Borrowed<'_, R> {
    fn read(&mut self, bytes: &mut [u8]) -> Result<usize, bitcoin::io::Error> {
        self.0.read(bytes)
    }
}

impl<R: bitcoin::io::Read> Reader<R> {
    pub(crate) fn new(source: R, limit: usize) -> Self {
        Self {
            source,
            offset: 0,
            limit,
        }
    }

    pub(crate) fn remaining(&self) -> usize {
        self.limit - self.offset
    }

    pub(crate) fn take(&mut self, length: usize) -> Result<Vec<u8>, Error> {
        let end = self.offset.checked_add(length).ok_or(Error::SizeLimit)?;
        if end > self.limit {
            return Err(Error::Truncated);
        }
        let mut bytes = vec![0; length];
        self.source
            .read_exact(&mut bytes)
            .map_err(|_| Error::Truncated)?;
        self.offset = end;
        Ok(bytes)
    }

    pub(crate) fn array<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        if N > self.remaining() {
            return Err(Error::Truncated);
        }
        let mut bytes = [0; N];
        self.source
            .read_exact(&mut bytes)
            .map_err(|_| Error::Truncated)?;
        self.offset += N;
        Ok(bytes)
    }

    pub(crate) fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    pub(crate) fn compact(&mut self) -> Result<usize, Error> {
        let tag = self.take(1)?[0];
        let value = match tag {
            0xfd => u64::from(u16::from_le_bytes(self.array()?)),
            0xfe => u64::from(self.u32()?),
            0xff => u64::from_le_bytes(self.array()?),
            _ => u64::from(tag),
        };
        if (tag == 0xfd && value < 0xfd)
            || (tag == 0xfe && value <= 0xffff)
            || (tag == 0xff && value <= 0xffff_ffff)
        {
            return Err(Error::NoncanonicalCompactSize);
        }
        if value > MAX_SERIALIZED_BYTES as u64 {
            return Err(Error::SizeLimit);
        }
        Ok(value as usize)
    }

    pub(crate) fn vector(&mut self) -> Result<Vec<u8>, Error> {
        let length = self.compact()?;
        self.take(length)
    }
}

impl Transaction {
    pub fn compute_txid(&self) -> Txid {
        self.txid().expect("validated Verge transaction")
    }
    pub fn total_size(&self) -> usize {
        self.serialized_size().expect("validated Verge transaction")
    }
    pub fn base_size(&self) -> usize {
        self.total_size()
    }
    pub fn vsize(&self) -> usize {
        self.total_size()
    }
    pub fn weight(&self) -> bitcoin::Weight {
        bitcoin::Weight::from_wu(self.total_size() as u64 * 4)
    }
}

impl bitcoin::consensus::Encodable for Transaction {
    fn consensus_encode<W: bitcoin::io::Write + ?Sized>(
        &self,
        writer: &mut W,
    ) -> Result<usize, bitcoin::io::Error> {
        let bytes = self
            .encode()
            .map_err(|_| bitcoin::io::Error::from(bitcoin::io::ErrorKind::InvalidData))?;
        writer.write_all(&bytes)?;
        Ok(bytes.len())
    }
}

impl bitcoin::consensus::Decodable for Transaction {
    fn consensus_decode<R: bitcoin::io::Read + ?Sized>(
        reader: &mut R,
    ) -> Result<Self, bitcoin::consensus::encode::Error> {
        Self::read(&mut Reader::new(Borrowed(reader), MAX_SERIALIZED_BYTES)).map_err(|_| {
            bitcoin::consensus::encode::Error::ParseFailed("invalid Verge transaction")
        })
    }
}
