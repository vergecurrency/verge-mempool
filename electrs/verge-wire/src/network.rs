// Copyright (c) 2026 The Verge Currency Developers
// Distributed under the MIT software license; see ../../LICENSE.

//! Values checked against Verge Core chainparams.cpp and chainparamsbase.cpp.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Network {
    Mainnet,
    Testnet,
    Regtest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Parameters {
    pub genesis: &'static str,
    /// Wire order, as stored before a block in blk*.dat.
    pub magic: [u8; 4],
    pub rpc_port: u16,
    pub p2p_port: u16,
    pub p2pkh_prefix: u8,
    pub p2sh_prefix: u8,
    /// Active index namespaces; never shared with Bitcoin or another network.
    pub database_namespace: &'static str,
}

impl Network {
    pub const fn parameters(self) -> Parameters {
        match self {
            Self::Mainnet => Parameters {
                genesis: "00000fc63692467faeb20cdb3b53200dc601d75bdfa1001463304cc790d77278",
                magic: [0xf7, 0xa7, 0x7e, 0xff],
                rpc_port: 20102,
                p2p_port: 21102,
                p2pkh_prefix: 30,
                p2sh_prefix: 33,
                database_namespace: "verge-mainnet-v1",
            },
            Self::Testnet => Parameters {
                genesis: "000005e0bb94e3a30a565d1a14ad95a189d47ca45c5bbbe48ee7a32eab8cb980",
                magic: [0xd6, 0x93, 0x2f, 0x8a],
                rpc_port: 20104,
                p2p_port: 21104,
                p2pkh_prefix: 115,
                p2sh_prefix: 198,
                database_namespace: "verge-testnet-v1",
            },
            Self::Regtest => Parameters {
                genesis: "65b4e101cacf3e1e4f3a9237e3a74ffd1186e595d8b78fa8ea22c21ef5bf9347",
                magic: [0xfa, 0xbf, 0xb5, 0xda],
                rpc_port: 18334,
                p2p_port: 31102,
                p2pkh_prefix: 111,
                p2sh_prefix: 196,
                database_namespace: "verge-regtest-v1",
            },
        }
    }
}

pub const TARGET_SPACING_SECONDS: u32 = 30;
pub const SAME_ALGORITHM_SPACING_SECONDS: u32 = 150;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    Scrypt,
    X17,
    Lyra2Rev2,
    Blake2s,
    Groestl,
}

impl Algorithm {
    /// PoS has no mining algorithm. Historical unmatched masks default to
    /// Scrypt, matching Core's GetAlgo; this does not compute a block ID.
    pub fn from_version(version: i32) -> Option<Self> {
        if version & 0x8000 != 0 {
            return None;
        }
        Some(match version & 0x7800 {
            0x1800 => Self::X17,
            0x5000 => Self::Lyra2Rev2,
            0x2000 => Self::Blake2s,
            0x1000 => Self::Groestl,
            _ => Self::Scrypt,
        })
    }
}
