// Copyright (c) 2026 The Verge Currency Developers
// Distributed under the MIT software license; see ../../LICENSE.
use crate::{network::Network, Error};
use bitcoin::{
    bech32::{self, primitives::decode::CheckedHrpstring, Bech32m, Hrp},
    hashes::{hash160, Hash},
    PubkeyHash, Script, ScriptBuf, ScriptHash,
};

fn pq_hrp(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "xvgpq",
        Network::Testnet => "xvgtpq",
        Network::Regtest => "xvgrpq",
    }
}

fn pq_suffix(script: &Script) -> Option<(u8, &[u8])> {
    let bytes = script.as_bytes();
    let tail = match bytes.len() {
        35 => bytes,
        138 if bytes[..6] == [0x4c, 100, b'V', b'P', b'B', 2] && bytes[102] == 0x75 => {
            &bytes[103..]
        }
        45 if bytes[..5] == [8, b'V', b'P', b'U', 2] && bytes[9] == 0x75 => &bytes[10..],
        _ => return None,
    };
    if tail.len() != 35
        || tail[1] != 32
        || tail[34] != 0xb3
        || (tail[0] != 0x53 && tail[0] != 0x54)
        || tail[2..34].iter().all(|b| *b == 0)
        || (bytes.len() != 35 && tail[0] != 0x53)
    {
        return None;
    }
    Some((tail[0], &tail[2..34]))
}

pub fn pq_type(script: &Script) -> Option<&'static str> {
    pq_suffix(script).map(|(kind, _)| match script.len() {
        138 => "pq_bond",
        45 => "pq_unbond",
        _ if kind == 0x54 => "pq_multisig",
        _ => "pq_keyhash",
    })
}

pub fn encode(script: &Script, network: Network) -> Option<String> {
    if let Some((kind, hash)) = pq_suffix(script) {
        let mut payload = Vec::new();
        if kind == 0x54 {
            payload.push(1);
        }
        payload.extend(hash);
        return bech32::encode::<Bech32m>(Hrp::parse(pq_hrp(network)).ok()?, &payload).ok();
    }
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
    if address.len() > 90 {
        return Err(Error::InvalidAddress);
    }
    if address
        .to_ascii_lowercase()
        .starts_with(&format!("{}1", pq_hrp(network)))
    {
        let checked =
            CheckedHrpstring::new::<Bech32m>(address).map_err(|_| Error::InvalidAddress)?;
        let bytes: Vec<u8> = checked.byte_iter().collect();
        let multisig = bytes.len() == 33 && bytes[0] == 1;
        if bytes.len() != 32 && !multisig {
            return Err(Error::InvalidAddress);
        }
        let hash = &bytes[usize::from(multisig)..];
        if hash.iter().all(|b| *b == 0)
            || checked.hrp() != Hrp::parse(pq_hrp(network)).unwrap()
            || bech32::encode::<Bech32m>(checked.hrp(), &bytes)
                .map_err(|_| Error::InvalidAddress)?
                != address.to_ascii_lowercase()
        {
            return Err(Error::InvalidAddress);
        }
        let mut script = vec![if multisig { 0x54 } else { 0x53 }, 32];
        script.extend(hash);
        script.push(0xb3);
        return Ok(ScriptBuf::from_bytes(script));
    }
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
