// Copyright (c) 2026 The Verge Currency Developers
// Distributed under the MIT software license; see ../../LICENSE.
use crate::{network::Network, Error};
use bitcoin::{
    hashes::{hash160, Hash},
    PubkeyHash, Script, ScriptBuf, ScriptHash,
};

pub fn encode(script: &Script, network: Network) -> Option<String> {
    let params = network.parameters();
    let bytes = script.as_bytes();
    let (prefix, hash) = if script.is_p2pkh() {
        (params.p2pkh_prefix, &bytes[3..23])
    } else if script.is_p2sh() {
        (params.p2sh_prefix, &bytes[2..22])
    } else {
        return None;
    };
    let mut payload = vec![prefix];
    payload.extend(hash);
    Some(bitcoin::base58::encode_check(&payload))
}

pub fn decode(address: &str, network: Network) -> Result<ScriptBuf, Error> {
    let bytes = bitcoin::base58::decode_check(address).map_err(|_| Error::InvalidAddress)?;
    if bytes.len() != 21 {
        return Err(Error::InvalidAddress);
    }
    let hash = hash160::Hash::from_slice(&bytes[1..]).map_err(|_| Error::InvalidAddress)?;
    let params = network.parameters();
    if bytes[0] == params.p2pkh_prefix {
        Ok(ScriptBuf::new_p2pkh(&PubkeyHash::from_raw_hash(hash)))
    } else if bytes[0] == params.p2sh_prefix {
        Ok(ScriptBuf::new_p2sh(&ScriptHash::from_raw_hash(hash)))
    } else {
        Err(Error::InvalidAddress)
    }
}
