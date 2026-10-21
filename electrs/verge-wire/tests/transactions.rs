use bitcoin::hashes::Hash;
use bitcoin::{absolute, Amount, OutPoint, ScriptBuf, Sequence, TxIn, TxOut, Witness};
use serde_json::Value;
use verge_wire::{
    is_unspendable, Error, Transaction, COIN, MAX_MONEY, MAX_SERIALIZED_BYTES, POS_VERSION,
};

fn unhex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    (0..value.len())
        .step_by(2)
        .map(|offset| u8::from_str_radix(&value[offset..offset + 2], 16).unwrap())
        .collect()
}

fn fixtures() -> Vec<Value> {
    serde_json::from_str::<Value>(include_str!("fixtures/transactions.json")).unwrap()
        ["transactions"]
        .as_array()
        .unwrap()
        .clone()
}

fn ordinary() -> Transaction {
    Transaction {
        version: 1,
        time: 1_700_000_000,
        input: vec![TxIn {
            previous_output: OutPoint {
                txid: Hash::all_zeros(),
                vout: 7,
            },
            script_sig: ScriptBuf::from_bytes(vec![0x51]),
            sequence: Sequence(0xffff_fffd),
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::from_sat(200_000),
            script_pubkey: ScriptBuf::from_bytes(vec![0x51]),
        }],
        lock_time: absolute::LockTime::from_consensus(123),
    }
}

#[test]
fn core_fixtures_match_txid_bytes_timestamp_inputs_and_exact_outputs() {
    let cases = fixtures();
    assert_eq!(cases.len(), 10);
    for fixture in cases {
        let name = fixture["name"].as_str().unwrap();
        let raw = unhex(fixture["hex"].as_str().unwrap());
        let tx = Transaction::decode(&raw).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(tx.encode().unwrap(), raw, "{name}");
        assert_eq!(tx.serialized_size().unwrap(), raw.len(), "{name}");
        assert_eq!(
            tx.txid().unwrap().to_string(),
            fixture["txid"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(
            i64::from(tx.version),
            fixture["version"].as_i64().unwrap(),
            "{name}"
        );
        assert_eq!(
            u64::from(tx.time),
            fixture["time"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(
            u64::from(tx.lock_time.to_consensus_u32()),
            fixture["locktime"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(
            tx.is_coinbase(),
            fixture["coinbase"].as_bool().unwrap(),
            "{name}"
        );
        let expected_inputs = fixture["vin"].as_array().unwrap();
        assert_eq!(tx.input.len(), expected_inputs.len(), "{name}");
        for (input, expected) in tx.input.iter().zip(expected_inputs) {
            assert_eq!(
                input.previous_output.txid.to_string(),
                expected["txid"].as_str().unwrap(),
                "{name}"
            );
            assert_eq!(
                u64::from(input.previous_output.vout),
                expected["vout"].as_u64().unwrap(),
                "{name}"
            );
            assert_eq!(
                input.script_sig.as_bytes(),
                unhex(expected["script"].as_str().unwrap()),
                "{name}"
            );
            assert_eq!(
                u64::from(input.sequence.0),
                expected["sequence"].as_u64().unwrap(),
                "{name}"
            );
            assert!(input.witness.is_empty(), "{name}");
        }
        let expected_outputs = fixture["vout"].as_array().unwrap();
        assert_eq!(tx.output.len(), expected_outputs.len(), "{name}");
        for (output, expected) in tx.output.iter().zip(expected_outputs) {
            assert_eq!(
                output.value.to_sat().to_string(),
                expected["atoms"].as_str().unwrap(),
                "{name}"
            );
            assert_eq!(
                output.script_pubkey.as_bytes(),
                unhex(expected["script"].as_str().unwrap()),
                "{name}"
            );
        }
    }
}

#[test]
fn every_truncated_core_transaction_is_rejected() {
    for fixture in fixtures() {
        let raw = unhex(fixture["hex"].as_str().unwrap());
        for end in 0..raw.len() {
            assert!(
                Transaction::decode(&raw[..end]).is_err(),
                "{} accepted {end} bytes",
                fixture["name"]
            );
        }
    }
}

#[test]
fn prefix_decoder_consumes_one_transaction_but_strict_decoder_rejects_suffix() {
    let first = ordinary().encode().unwrap();
    let mut joined = first.clone();
    joined.extend_from_slice(&first);
    let (tx, consumed) = Transaction::decode_prefix(&joined).unwrap();
    assert_eq!(tx, ordinary());
    assert_eq!(consumed, first.len());
    assert_eq!(Transaction::decode(&joined), Err(Error::TrailingBytes));
}

#[test]
fn replay_marker_and_timestamp_are_part_of_transaction_identity() {
    let legacy = ordinary();
    let legacy_id = legacy.txid().unwrap();
    let mut replay = legacy.clone();
    replay.version = POS_VERSION;
    assert_eq!(
        replay.serialized_size().unwrap(),
        legacy.serialized_size().unwrap() + 4
    );
    assert_ne!(replay.txid().unwrap(), legacy_id);
    let mut raw = replay.encode().unwrap();
    let replay_id = replay.txid().unwrap();
    assert_eq!(Transaction::decode(&raw).unwrap(), replay);
    raw[8] ^= 1;
    assert_eq!(Transaction::decode(&raw), Err(Error::InvalidReplayMarker));
    replay.time += 1;
    assert_ne!(replay.txid().unwrap(), replay_id);
    let mut changed_legacy = legacy;
    changed_legacy.time += 1;
    assert_ne!(changed_legacy.txid().unwrap(), legacy_id);
}

#[test]
fn compact_size_noncanonical_and_large_counts_are_rejected_before_allocation() {
    let raw = ordinary().encode().unwrap();
    for count in [
        vec![0xfd, 1, 0],
        vec![0xfe, 1, 0, 0, 0],
        vec![0xff, 1, 0, 0, 0, 0, 0, 0, 0],
    ] {
        let mut malformed = raw[..8].to_vec();
        malformed.extend_from_slice(&count);
        malformed.extend_from_slice(&raw[9..]);
        assert_eq!(
            Transaction::decode(&malformed),
            Err(Error::NoncanonicalCompactSize)
        );
    }
    let mut oversized = raw[..8].to_vec();
    oversized.extend_from_slice(&[0xff; 9]);
    assert_eq!(Transaction::decode(&oversized), Err(Error::SizeLimit));
    let mut impossible = raw.clone();
    impossible[8] = 252;
    assert_eq!(Transaction::decode(&impossible), Err(Error::Truncated));
    let mut zero = raw;
    zero[8] = 0;
    assert_eq!(Transaction::decode(&zero), Err(Error::EmptyInputs));
}

#[test]
fn canonical_compact_size_boundaries_roundtrip_for_scripts_and_counts() {
    for size in [0, 1, 252, 253, 65_535, 65_536] {
        let mut tx = ordinary();
        tx.input[0].script_sig = ScriptBuf::from_bytes(vec![0x51; size]);
        tx.output[0].script_pubkey = ScriptBuf::from_bytes(vec![0x51; size]);
        let raw = tx.encode().unwrap();
        assert_eq!(tx.serialized_size().unwrap(), raw.len());
        assert_eq!(Transaction::decode(&raw).unwrap(), tx);
    }
    let mut tx = ordinary();
    tx.input = vec![tx.input[0].clone(); 253];
    tx.output = vec![tx.output[0].clone(); 253];
    assert_eq!(Transaction::decode(&tx.encode().unwrap()).unwrap(), tx);
}

#[test]
fn exact_values_above_javascript_range_and_verge_limits_roundtrip() {
    assert_eq!(COIN, 1_000_000);
    let mut tx = ordinary();
    tx.output[0].value = Amount::from_sat(MAX_MONEY);
    let decoded_amount = Transaction::decode(&tx.encode().unwrap()).unwrap().output[0]
        .value
        .to_sat();
    assert_eq!(decoded_amount, MAX_MONEY);
    assert!(decoded_amount > (1_u64 << 53));
    tx.output.push(TxOut {
        value: Amount::from_sat(1),
        script_pubkey: ScriptBuf::new(),
    });
    assert_eq!(tx.encode(), Err(Error::InvalidAmount));
    tx.output.pop();
    tx.output[0].value = Amount::from_sat(MAX_MONEY + 1);
    assert_eq!(tx.encode(), Err(Error::InvalidAmount));
    tx.output[0].value = Amount::from_sat(u64::MAX);
    assert_eq!(tx.encode(), Err(Error::InvalidAmount));
}

#[test]
fn negative_values_and_oversized_sums_are_rejected_on_decode() {
    let mut tx = ordinary();
    tx.input[0].script_sig = ScriptBuf::new();
    let mut raw = tx.encode().unwrap();
    // version/time + input count + the 41-byte input + output count.
    let value_start = 8 + 1 + 41 + 1;
    raw[value_start..value_start + 8].fill(0xff);
    assert_eq!(Transaction::decode(&raw), Err(Error::InvalidAmount));
    tx.output[0].value = Amount::from_sat(MAX_MONEY);
    raw = tx.encode().unwrap();
    raw[value_start - 1] = 2;
    let last = raw.len() - 4;
    raw.splice(last..last, [1, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(Transaction::decode(&raw), Err(Error::InvalidAmount));
}

#[test]
fn witness_and_empty_vectors_are_rejected_instead_of_silently_discarded() {
    let mut tx = ordinary();
    tx.input[0].witness.push([1, 2, 3]);
    let bitcoin_transaction = bitcoin::Transaction {
        version: bitcoin::transaction::Version(tx.version),
        lock_time: tx.lock_time,
        input: tx.input.clone(),
        output: tx.output.clone(),
    };
    let mut witness_wire = bitcoin::consensus::serialize(&bitcoin_transaction);
    // A timestamp does not make Bitcoin's witness-marker encoding valid XVG.
    witness_wire.splice(4..4, tx.time.to_le_bytes());
    assert_eq!(Transaction::decode(&witness_wire), Err(Error::EmptyInputs));
    assert_eq!(tx.encode(), Err(Error::UnsupportedWitness));
    assert_eq!(tx.txid(), Err(Error::UnsupportedWitness));
    tx.input.clear();
    assert_eq!(tx.encode(), Err(Error::EmptyInputs));
    tx = ordinary();
    tx.output.clear();
    assert_eq!(tx.encode(), Err(Error::EmptyOutputs));
}

#[test]
fn decoder_and_encoder_enforce_resource_bounds() {
    assert_eq!(
        Transaction::decode(&vec![0; MAX_SERIALIZED_BYTES + 1]),
        Err(Error::SizeLimit)
    );
    let mut tx = ordinary();
    tx.output[0].script_pubkey = ScriptBuf::from_bytes(vec![0x51; MAX_SERIALIZED_BYTES]);
    assert_eq!(tx.encode(), Err(Error::SizeLimit));
}

#[test]
fn scripts_preserve_verge_bonds_burns_and_unspendable_rules() {
    assert!(is_unspendable(&ScriptBuf::from_bytes(vec![0x6a, 0x51])));
    assert!(is_unspendable(&ScriptBuf::from_bytes(vec![0x51; 10_001])));
    assert!(!is_unspendable(&ScriptBuf::from_bytes(vec![0x51; 10_000])));
    assert!(!is_unspendable(&ScriptBuf::new()));
    let tx = fixtures()
        .into_iter()
        .find(|tx| tx["name"] == "regtest-blocks-722-1")
        .unwrap();
    let parsed = Transaction::decode(&unhex(tx["hex"].as_str().unwrap())).unwrap();
    let bond = parsed
        .output
        .iter()
        .find(|output| {
            output
                .script_pubkey
                .as_bytes()
                .windows(4)
                .any(|window| window == b"VPB\x01")
        })
        .unwrap();
    assert!(!is_unspendable(&bond.script_pubkey));
    assert_eq!(bond.value.to_sat(), 1000 * COIN);
}
