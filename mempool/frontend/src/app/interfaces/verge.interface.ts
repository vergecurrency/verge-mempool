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
    algorithm: 'scrypt' | 'x17' | 'lyra2re' | 'blake' | 'groestl';
    difficulty: number | null;
    lastBlockHeight: number | null;
    hashrate: number | null;
    blocksInSample: number;
  }[];
}
