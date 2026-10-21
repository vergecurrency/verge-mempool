use bitcoin::consensus::{deserialize, serialize, Decodable};
use verge_wire::{Block, Header, Transaction};

fn unhex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|v| u8::from_str_radix(std::str::from_utf8(v).unwrap(), 16).unwrap())
        .collect()
}
fn fixtures() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/blocks.json")).unwrap()
}

#[test]
fn core_blocks_roundtrip_and_match_independent_ids_all_algorithms_and_pos() {
    for value in fixtures()["blocks"].as_array().unwrap() {
        let bytes = unhex(value["raw"].as_str().unwrap());
        let block: Block = deserialize(&bytes).unwrap();
        assert_eq!(
            block.block_hash().to_string(),
            value["hash"].as_str().unwrap()
        );
        assert_eq!(serialize(&block), bytes);
        let header_bytes = unhex(value["header"].as_str().unwrap());
        let header: Header = deserialize(&header_bytes).unwrap();
        assert_eq!(header, block.header);
        assert_eq!(header.block_hash(), block.block_hash());
        assert_eq!(header_bytes.len(), if header.is_pos() { 112 } else { 80 });
        assert_eq!(block.weight().to_wu(), bytes.len() as u64 * 4);
        for tx in block.txdata {
            let bytes = serialize(&tx);
            assert_eq!(deserialize::<Transaction>(&bytes).unwrap(), tx);
        }
    }
}

#[test]
fn every_truncated_block_and_trailing_data_are_rejected() {
    for value in fixtures()["blocks"].as_array().unwrap() {
        let bytes = unhex(value["raw"].as_str().unwrap());
        for end in 0..bytes.len() {
            assert!(
                deserialize::<Block>(&bytes[..end]).is_err(),
                "accepted truncation {end}"
            );
        }
        let mut trailing = bytes;
        trailing.push(0);
        assert!(deserialize::<Block>(&trailing).is_err());
    }
}

#[test]
fn merkle_and_pos_commitment_corruption_are_rejected() {
    for value in fixtures()["blocks"].as_array().unwrap() {
        let original = unhex(value["raw"].as_str().unwrap());
        let mut corrupt = original.clone();
        corrupt[36] ^= 1;
        assert!(deserialize::<Block>(&corrupt).is_err());
        let block: Block = deserialize(&original).unwrap();
        if block.header.is_pos() {
            let mut corrupt = original.clone();
            corrupt[80] ^= 1;
            assert!(deserialize::<Block>(&corrupt).is_err());
            let mut corrupt = original;
            let end = corrupt.len();
            corrupt[end - 4] ^= 1;
            assert!(deserialize::<Block>(&corrupt).is_err());
        }
    }
}

#[test]
fn streaming_transaction_decoder_leaves_next_transaction_unread() {
    let value = &fixtures()["blocks"][1];
    let block: Block = deserialize(&unhex(value["raw"].as_str().unwrap())).unwrap();
    let tx = &block.txdata[0];
    let bytes = serialize(tx);
    let mut joined = bytes.clone();
    joined.extend(&bytes);
    let mut cursor = bitcoin::io::Cursor::new(joined);
    assert_eq!(Transaction::consensus_decode(&mut cursor).unwrap(), *tx);
    assert_eq!(cursor.position(), bytes.len() as u64);
    assert_eq!(Transaction::consensus_decode(&mut cursor).unwrap(), *tx);
}

#[test]
fn address_encoding_checks_network_type_length_and_checksum() {
    use bitcoin::{hashes::Hash, PubkeyHash, ScriptBuf, ScriptHash};
    use verge_wire::{address, network::Network};
    for network in [Network::Mainnet, Network::Testnet, Network::Regtest] {
        for script in [
            ScriptBuf::new_p2pkh(&PubkeyHash::from_byte_array([42; 20])),
            ScriptBuf::new_p2sh(&ScriptHash::from_byte_array([42; 20])),
        ] {
            let encoded = address::encode(&script, network).unwrap();
            assert_eq!(address::decode(&encoded, network).unwrap(), script);
            for other in [Network::Mainnet, Network::Testnet, Network::Regtest] {
                if other != network {
                    assert!(address::decode(&encoded, other).is_err());
                }
            }
            let mut bad = encoded;
            bad.push('1');
            assert!(address::decode(&bad, network).is_err());
        }
    }
    assert!(address::decode("", Network::Mainnet).is_err());
    assert!(address::encode(&ScriptBuf::new(), Network::Mainnet).is_none());
}
