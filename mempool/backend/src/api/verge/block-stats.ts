// Copyright (c) 2026 The Verge Currency Developers
// Distributed under the GNU Affero General Public License; see COPYING.md.

import { safeAtomicNumber } from './amounts';

const WITHOUT_PREVOUTS = ['avgtxsize', 'ins', 'outs', 'swtxs', 'swtotal_size', 'swtotal_weight', 'total_out', 'utxo_increase'];

export interface VergeBlockStatistics {
  feeStatsAvailable: boolean;
  avgTxSize?: number;
  totalInputs?: number;
  totalOutputs?: number;
  totalOutputAmt?: number;
  utxoSetChange?: number;
  segwitTotalTxs?: number;
  segwitTotalSize?: number;
  segwitTotalWeight?: number;
  totalFees?: number;
  avgFee?: number;
  avgFeeRate?: number;
  medianFee?: number;
  feeRange?: number[];
}

/** Core's historical fee statistics require txindex; basic block reads do not. @asyncUnsafe */
export async function getVergeBlockStats(client: { getBlockStats(hash: string, stats?: string[]): Promise<Record<string, number | string>> }, block: { id: string; stale?: boolean }): Promise<VergeBlockStatistics> {
  if (block.stale) { return { feeStatsAvailable: false }; }
  let stats: Record<string, number | string>;
  let feesAvailable = true;
  try {
    stats = await client.getBlockStats(block.id);
  } catch (error) {
    if ((error as { code?: number }).code !== -8 || !(error instanceof Error) || !error.message.includes('requires -txindex enabled')) { throw error; }
    stats = await client.getBlockStats(block.id, WITHOUT_PREVOUTS);
    feesAvailable = false;
  }
  const integer = (key: string): number => {
    const value = stats[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) { throw new Error(`Invalid Verge block statistic: ${key}`); }
    return value;
  };
  const result: VergeBlockStatistics = {
    feeStatsAvailable: feesAvailable,
    avgTxSize: integer('avgtxsize'),
    totalInputs: integer('ins'),
    totalOutputs: integer('outs'),
    totalOutputAmt: safeAtomicNumber(BigInt(stats.total_out)),
    utxoSetChange: integer('utxo_increase'),
    segwitTotalTxs: integer('swtxs'),
    segwitTotalSize: integer('swtotal_size'),
    segwitTotalWeight: integer('swtotal_weight'),
  };
  if (feesAvailable) {
    result.totalFees = safeAtomicNumber(BigInt(stats.totalfee));
    result.avgFee = safeAtomicNumber(BigInt(stats.avgfee));
    result.avgFeeRate = integer('avgfeerate');
    result.medianFee = integer('medianfeerate');
    // Verge Core supplies bounds and a median, not Bitcoin's percentiles.
    result.feeRange = [integer('minfeerate'), integer('maxfeerate')];
  }
  return result;
}
