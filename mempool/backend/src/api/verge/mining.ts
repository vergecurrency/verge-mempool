import { VergeAlgorithm, isProofOfStake, vergeAlgorithm } from './chain-profile';

const algorithms: VergeAlgorithm[] = ['scrypt', 'x17', 'lyra2re', 'blake', 'groestl'];

export interface VergeMiningRpc {
  getBlockCount(): Promise<number>;
  getBlockHash(height: number): Promise<string>;
  getBlockHeader(hash: string, verbose: boolean): Promise<any>;
  getAllNetworkHashPs(lookup: number, height: number): Promise<Record<string, number>>;
}

export interface AlgorithmStatistics {
  algorithm: VergeAlgorithm;
  difficulty: number | null;
  lastBlockHeight: number | null;
  hashrate: number | null;
  blocksInSample: number;
}

/** Core supplies per-algorithm estimates; unlike-algorithm H/s values are never summed. @asyncUnsafe */
export async function getVergeMiningStatistics(client: VergeMiningRpc, lookback = 60) {
  if (!Number.isSafeInteger(lookback) || lookback < 1 || lookback > 300) { throw new Error('Invalid mining sample size'); }
  const height = await client.getBlockCount();
  const tip = await client.getBlockHash(height);
  const tipHeader = await client.getBlockHeader(tip, true);
  const tipIsPos = tipHeader.proof === 'pos' || isProofOfStake(tipHeader.version);
  const rates = tipIsPos ? {} : await client.getAllNetworkHashPs(120, height);
  const stats = Object.fromEntries(algorithms.map(algorithm => [algorithm, {
    algorithm, difficulty: null, lastBlockHeight: null,
    hashrate: null, blocksInSample: 0,
  }])) as Record<VergeAlgorithm, AlgorithmStatistics>;
  for (const algorithm of algorithms) {
    const rate = rates[algorithm === 'blake' ? 'blake2s' : algorithm];
    if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) { stats[algorithm].hashrate = rate; }
  }
  const lower = Math.max(0, height - lookback + 1);
  let posBlocks = 0;
  // Bounded batches avoid monopolizing Core's RPC worker queue.
  for (let start = height; start >= lower; start -= 4) {
    const heights = Array.from({ length: Math.min(4, start - lower + 1) }, (_, i) => start - i);
    const headers = await Promise.all(heights.map(blockHeight => client.getBlockHash(blockHeight).then(hash => client.getBlockHeader(hash, true))));
    for (const header of headers) {
      if (header.proof === 'pos' || isProofOfStake(header.version)) { posBlocks++; continue; }
      const stat = stats[vergeAlgorithm(header.version)];
      stat.blocksInSample++;
      if (stat.lastBlockHeight === null) {
        stat.lastBlockHeight = header.height;
        stat.difficulty = typeof header.difficulty === 'number' && Number.isFinite(header.difficulty) && header.difficulty >= 0 ? header.difficulty : null;
      }
    }
  }
  if (await client.getBlockHash(height) !== tip) { throw new Error('Verge chain reorganized during mining sample; retry'); }
  // Post-PoS mining estimates are not meaningful, even if a legacy RPC returns a number.
  if (tipIsPos) {
    for (const stat of Object.values(stats)) { stat.hashrate = null; }
  }
  return { height, hash: tip, fromHeight: lower, sampleBlocks: height - lower + 1,
    proof: tipIsPos ? 'pos' : 'pow', posBlocks,
    hashrateUnit: 'H/s', hashrateSource: 'getallnetworkhashps', algorithms: algorithms.map(a => stats[a]) };
}
