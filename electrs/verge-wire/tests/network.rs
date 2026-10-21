use std::collections::HashSet;
use verge_wire::network::{
    Algorithm, Network, SAME_ALGORITHM_SPACING_SECONDS, TARGET_SPACING_SECONDS,
};

#[test]
fn networks_have_independent_namespaces_genesis_and_wire_magic() {
    let parameters =
        [Network::Mainnet, Network::Testnet, Network::Regtest].map(Network::parameters);
    assert_eq!(
        parameters
            .iter()
            .map(|p| p.database_namespace)
            .collect::<HashSet<_>>()
            .len(),
        3
    );
    assert_eq!(
        parameters
            .iter()
            .map(|p| p.genesis)
            .collect::<HashSet<_>>()
            .len(),
        3
    );
    assert_eq!(
        parameters
            .iter()
            .map(|p| p.magic)
            .collect::<HashSet<_>>()
            .len(),
        3
    );
    assert_eq!(parameters[0].magic, [0xf7, 0xa7, 0x7e, 0xff]);
    assert_eq!(parameters[1].magic, [0xd6, 0x93, 0x2f, 0x8a]);
    assert_eq!(parameters[2].magic, [0xfa, 0xbf, 0xb5, 0xda]);
    assert_eq!(parameters.map(|p| p.rpc_port), [20102, 20104, 18334]);
    assert_eq!(parameters.map(|p| p.p2p_port), [21102, 21104, 31102]);
    assert_eq!(
        parameters.map(|p| (p.p2pkh_prefix, p.p2sh_prefix)),
        [(30, 33), (115, 198), (111, 196)]
    );
    assert_eq!(TARGET_SPACING_SECONDS, 30);
    assert_eq!(SAME_ALGORITHM_SPACING_SECONDS, 150);
}

#[test]
fn all_five_algorithms_and_pos_are_distinguished() {
    for (version, expected) in [
        (0x0804, Algorithm::Scrypt),
        (0x1804, Algorithm::X17),
        (0x5004, Algorithm::Lyra2Rev2),
        (0x2004, Algorithm::Blake2s),
        (0x1004, Algorithm::Groestl),
        (1, Algorithm::Scrypt),
    ] {
        assert_eq!(Algorithm::from_version(version), Some(expected));
    }
    for version in [0x8002, 0x8804, 0xd004] {
        assert_eq!(Algorithm::from_version(version), None);
    }
}
