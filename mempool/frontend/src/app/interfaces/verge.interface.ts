export interface VergeMiningStatistics {
  height: number;
  hash: string;
  fromHeight: number;
  sampleBlocks: number;
  proof: 'pow' | 'pos';
  posBlocks: number;
  hashrateUnit: 'H/s';
  hashrateSource: string;
  algorithms: {
    algorithm: 'scrypt' | 'x17' | 'lyra2rev2' | 'blake2s' | 'myriad-groestl';
    difficulty: number | null;
    lastBlockHeight: number | null;
    hashrate: number | null;
    blocksInSample: number;
  }[];
}

export interface VergePeer {
  address: string;
  direction: 'Inbound' | 'Outbound';
  lastSeen: number | null;
  version: string;
  smsgSupport: boolean;
  connected: boolean;
}

export interface VergePeersSnapshot {
  count: number;
  privateLocalCount: number;
  knownCount: number;
  updatedAt: string;
  peers: VergePeer[];
}
