// Copyright (c) 2026 The Verge Currency Developers
// Distributed under the GNU Affero General Public License; see COPYING.md.

export type VergeNetwork = 'mainnet' | 'testnet' | 'regtest';
export type VergeAlgorithm = 'scrypt' | 'x17' | 'lyra2rev2' | 'blake2s' | 'myriad-groestl';

export interface VergeChainProfile {
  chain: 'verge';
  network: VergeNetwork;
  rpcChain: string;
  genesis: string;
  rpcPort: number;
  magic: string;
  pubkeyHash: number;
  scriptHash: number;
  decimals: 6;
  unitsPerCoin: 1000000;
  targetBlockSeconds: 30;
  posActivationHeight: number;
}

const networks = {
  mainnet: {
    rpcChain: 'main', genesis: '00000fc63692467faeb20cdb3b53200dc601d75bdfa1001463304cc790d77278',
    rpcPort: 20102, magic: 'f7a77eff', pubkeyHash: 30, scriptHash: 33, posActivationHeight: 15000000,
  },
  testnet: {
    rpcChain: 'test', genesis: '000005e0bb94e3a30a565d1a14ad95a189d47ca45c5bbbe48ee7a32eab8cb980',
    rpcPort: 20104, magic: 'd6932f8a', pubkeyHash: 115, scriptHash: 198, posActivationHeight: 3000,
  },
  regtest: {
    rpcChain: 'regtest', genesis: '65b4e101cacf3e1e4f3a9237e3a74ffd1186e595d8b78fa8ea22c21ef5bf9347',
    rpcPort: 18334, magic: 'fabfb5da', pubkeyHash: 111, scriptHash: 196, posActivationHeight: 2147483647,
  },
};

export function vergeProfile(network: string): VergeChainProfile {
  if (!Object.prototype.hasOwnProperty.call(networks, network)) {
    throw new Error(`Unsupported Verge network: ${network}`);
  }
  return Object.freeze({
    chain: 'verge', network: network as VergeNetwork, decimals: 6,
    unitsPerCoin: 1000000, targetBlockSeconds: 30, ...networks[network as VergeNetwork],
  });
}

export function vergeAlgorithm(version: number): VergeAlgorithm {
  switch (version & 0x7800) {
    case 0x1800: return 'x17';
    case 0x5000: return 'lyra2rev2';
    case 0x2000: return 'blake2s';
    case 0x1000: return 'myriad-groestl';
    default: return 'scrypt';
  }
}

export function isProofOfStake(version: number): boolean {
  return (version & 0x8000) !== 0;
}
