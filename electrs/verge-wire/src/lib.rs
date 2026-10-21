// Copyright (c) 2026 The Verge Currency Developers
// Distributed under the MIT software license; see ../../LICENSE.

//! Portable Verge wire types. These are separate from Bitcoin's transaction
//! codec: Verge serializes a timestamp and, for one version, a replay marker.
//! This crate does not validate scripts, signatures, fork choice or chain state.

pub mod address;
mod block;
pub mod network;
mod scrypt;
mod transaction;
pub use block::{Block, Header, HeaderFields, MerkleBlock};

pub use transaction::{Error, Transaction, MAX_SERIALIZED_BYTES, POS_REPLAY_MARKER, POS_VERSION};

/// Verge atomic units per XVG. Bitcoin Amount is used only as a u64 container;
/// its BTC formatting and Bitcoin money-range rules must not be used for XVG.
pub const COIN: u64 = 1_000_000;
pub const MAX_MONEY: u64 = 16_555_000_000 * COIN;

/// Core's CScript::IsUnspendable rule. A long output script is not a UTXO;
/// bond/unbond prefixes remain spendable and must retain their complete script.
pub fn is_unspendable(script: &bitcoin::Script) -> bool {
    script.as_bytes().first() == Some(&0x6a) || script.len() > 10_000
}
