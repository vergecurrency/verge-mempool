/** Observed paid atomic-XVG/byte quantiles, without padding unused capacity
 * with Bitcoin's zero-fee conceptual block space or applying a mining model. */
export function observedVergeFeeStatistics(transactions: { weight: number; fee: number }[]) {
  if (!transactions.length) { return { medianFee: 0, feeRange: [0, 0, 0, 0, 0, 0, 0] }; }
  const sorted = transactions.map(tx => {
    if (!Number.isSafeInteger(tx.fee) || tx.fee < 0 || !Number.isSafeInteger(tx.weight) || tx.weight <= 0) {
      throw new Error('Invalid Verge fee statistics input');
    }
    return { weight: tx.weight, rate: tx.fee / (tx.weight / 4) };
  }).sort((a, b) => a.rate - b.rate);
  const totalWeight = sorted.reduce((total, tx) => total + tx.weight, 0);
  const feeRange = [0, 10, 25, 50, 75, 90, 100].map(percentile => {
    const target = totalWeight * percentile / 100;
    let weight = 0;
    for (const tx of sorted) { weight += tx.weight; if (weight >= target) { return tx.rate; } }
    return sorted[sorted.length - 1].rate;
  });
  return { medianFee: feeRange[3], feeRange };
}
