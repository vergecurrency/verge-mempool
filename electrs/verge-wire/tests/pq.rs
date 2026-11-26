use bitcoin::{
    consensus::{deserialize, serialize},
    hashes::{sha256, Hash},
    ScriptBuf,
};
use verge_wire::{address, network::Network, Block, Transaction};

fn fixtures() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/pq-blocks.json")).unwrap()
}
fn unhex(value: &str) -> Vec<u8> {
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap())
        .collect()
}
fn script(kind: u8, id: u8) -> ScriptBuf {
    let mut bytes = vec![kind, 32];
    bytes.extend([id; 32]);
    bytes.push(0xb3);
    ScriptBuf::from_bytes(bytes)
}

#[test]
fn core_pq_blocks_and_transactions_match_ids_and_roundtrip() {
    for fixture in fixtures()["blocks"].as_array().unwrap() {
        let raw = unhex(fixture["raw"].as_str().unwrap());
        let block: Block = deserialize(&raw).unwrap();
        assert_eq!(
            block.block_hash().to_string(),
            fixture["hash"].as_str().unwrap()
        );
        assert_eq!(serialize(&block), raw);
        assert_eq!(block.pos_extension.as_ref().unwrap()[0], 2);
        for (tx, reference) in block.txdata.iter().zip(fixture["tx"].as_array().unwrap()) {
            assert_eq!(
                tx.compute_txid().to_string(),
                reference["txid"].as_str().unwrap()
            );
            assert_eq!(serialize(tx), unhex(reference["hex"].as_str().unwrap()));
        }
    }
    for fixture in fixtures()["transactions"].as_array().unwrap() {
        let raw = unhex(fixture["hex"].as_str().unwrap());
        let tx: Transaction = deserialize(&raw).unwrap();
        assert_eq!(
            tx.compute_txid().to_string(),
            fixture["txid"].as_str().unwrap()
        );
        assert_eq!(serialize(&tx), raw);
    }
}

#[test]
fn native_pq_addresses_match_core_and_are_strictly_network_scoped() {
    for fixture in fixtures()["addresses"].as_array().unwrap() {
        let address = fixture["address"].as_str().unwrap();
        let script = ScriptBuf::from_bytes(unhex(fixture["script"].as_str().unwrap()));
        assert_eq!(address::encode(&script, Network::Regtest).unwrap(), address);
        assert_eq!(address::decode(address, Network::Regtest).unwrap(), script);
        assert_eq!(
            address::pq_type(&script).unwrap(),
            fixture["type"].as_str().unwrap()
        );
    }
    for network in [Network::Mainnet, Network::Testnet, Network::Regtest] {
        for kind in [0x53, 0x54] {
            let script = script(kind, 42);
            let encoded = address::encode(&script, network).unwrap();
            assert_eq!(address::decode(&encoded, network).unwrap(), script);
            assert_eq!(
                address::decode(&encoded.to_uppercase(), network).unwrap(),
                script
            );
            assert!(address::decode(&format!("X{}", &encoded[1..]), network).is_err());
            let mut changed = encoded.clone().into_bytes();
            let last = changed.len() - 1;
            changed[last] = if changed[last] == b'q' { b'p' } else { b'q' };
            assert!(address::decode(std::str::from_utf8(&changed).unwrap(), network).is_err());
            for other in [Network::Mainnet, Network::Testnet, Network::Regtest] {
                if network != other {
                    assert!(address::decode(&encoded, other).is_err());
                }
            }
            let hrp = encoded.split_once('1').unwrap().0;
            let hrp = bitcoin::bech32::Hrp::parse(hrp).unwrap();
            for payload in [vec![0; 32], vec![42; 31], vec![42; 33], vec![2; 33]] {
                let invalid =
                    bitcoin::bech32::encode::<bitcoin::bech32::Bech32m>(hrp, &payload).unwrap();
                assert!(address::decode(&invalid, network).is_err());
            }
            let wrong_checksum =
                bitcoin::bech32::encode::<bitcoin::bech32::Bech32>(hrp, &[42; 32]).unwrap();
            assert!(address::decode(&wrong_checksum, network).is_err());
        }
        assert!(address::encode(&script(0x53, 0), network).is_none());
        let native = script(0x53, 42);
        let mut bond = vec![0x4c, 100, b'V', b'P', b'B', 2];
        bond.resize(102, 42);
        bond.push(0x75);
        bond.extend(native.as_bytes());
        let bond = ScriptBuf::from_bytes(bond);
        assert_eq!(address::pq_type(&bond), Some("pq_bond"));
        assert_eq!(
            address::encode(&bond, network),
            address::encode(&native, network)
        );
        let mut unbond = vec![8, b'V', b'P', b'U', 2, 1, 2, 3, 4, 0x75];
        unbond.extend(native.as_bytes());
        let unbond = ScriptBuf::from_bytes(unbond);
        assert_eq!(address::pq_type(&unbond), Some("pq_unbond"));
        assert_eq!(
            address::encode(&unbond, network),
            address::encode(&native, network)
        );
    }
}

type HybridCase = (Vec<u8>, usize, Vec<(usize, usize)>, Vec<usize>);

// Structural fixtures only: Core, not the indexer, verifies votes/evidence.
fn hybrid_case(votes: u8, blocks: u8, evidence: u8) -> HybridCase {
    let raw = unhex(fixtures()["blocks"][0]["raw"].as_str().unwrap());
    let block: Block = deserialize(&raw).unwrap();
    let original = block.pos_extension.as_ref().unwrap();
    let offset = raw.len() - original.len();
    let mut ext = original[..296].to_vec();
    let mut signatures = Vec::new();
    let mut keys = Vec::new();
    let mut record = |ext: &mut Vec<u8>, size: usize, producer: bool| {
        let start = ext.len();
        let mut bytes = if producer {
            original[296..4301].to_vec()
        } else {
            vec![0x42; size + 3732]
        };
        bytes[0] = 2;
        signatures.push((start + size - 64, start + size));
        signatures.push((start + size + 1312, start + size + 3732));
        keys.push(start + size);
        ext.extend(bytes);
    };
    record(&mut ext, 273, true);
    ext.push(votes);
    for _ in 0..votes {
        record(&mut ext, 229, false);
    }
    ext.push(blocks);
    for _ in 0..blocks {
        ext.push(2);
        record(&mut ext, 273, false);
        record(&mut ext, 273, false);
    }
    ext.push(evidence);
    for _ in 0..evidence {
        ext.push(2);
        record(&mut ext, 229, false);
        record(&mut ext, 229, false);
    }
    let mut normalized = ext.clone();
    for &(start, end) in &signatures {
        normalized[start..end].fill(0);
    }
    let tag = sha256::Hash::hash(b"VergePoS/Data/v1").to_byte_array();
    let mut committed = tag.to_vec();
    committed.extend(tag);
    committed.extend(normalized);
    let mut result = raw[..offset].to_vec();
    result[80..112].copy_from_slice(&sha256::Hash::hash(&committed).to_byte_array());
    result.extend(ext);
    (result, offset, signatures, keys)
}

#[test]
fn hybrid_commitment_normalizes_all_signatures_but_commits_public_keys() {
    let (raw, offset, signatures, keys) = hybrid_case(1, 1, 1);
    let block: Block = deserialize(&raw).unwrap();
    for (start, end) in signatures {
        let mut changed = raw.clone();
        changed[offset + start] ^= 1;
        changed[offset + end - 1] ^= 1;
        let decoded: Block = deserialize(&changed).unwrap();
        assert_eq!(decoded.block_hash(), block.block_hash());
        assert_eq!(serialize(&decoded), changed);
    }
    for key in keys {
        let mut changed = raw.clone();
        changed[offset + key] ^= 1;
        assert!(deserialize::<Block>(&changed).is_err());
    }
}

#[test]
fn hybrid_bounds_versions_eligibility_and_truncation_are_checked() {
    assert!(deserialize::<Block>(&hybrid_case(192, 8, 8).0).is_ok());
    assert!(deserialize::<Block>(&hybrid_case(193, 0, 0).0).is_err());
    assert!(deserialize::<Block>(&hybrid_case(0, 8, 9).0).is_err());
    let (raw, offset, _, _) = hybrid_case(1, 1, 1);
    for position in [0, 1, 296, 4302, 4302 + 3961 + 1, 1 + 117, 1 + 182] {
        let mut changed = raw.clone();
        changed[offset + position] = 1;
        assert!(deserialize::<Block>(&changed).is_err());
    }
    for end in [
        112,
        offset,
        offset + 1,
        offset + 296,
        offset + 569,
        offset + 1585,
        offset + 4301,
        raw.len() - 1,
    ] {
        assert!(deserialize::<Block>(&raw[..end]).is_err());
    }
    let mut trailing = raw;
    trailing.push(0);
    assert!(deserialize::<Block>(&trailing).is_err());
}
