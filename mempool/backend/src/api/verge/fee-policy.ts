import { coinToAtomic, CoinAmount } from './amounts';

/** The inspected Core GetFee uses ceil(bytes / 999), and GetFeePerK calls GetFee(1000). */
export function getVergeFeePolicy(info: { minrelaytxfee: CoinAmount; mempoolminfee: CoinAmount }, transactionBytes?: number) {
  const relayPerK = coinToAtomic(info.minrelaytxfee);
  const poolPerK = coinToAtomic(info.mempoolminfee);
  if (relayPerK < 0n || poolPerK < relayPerK || relayPerK % 2n || poolPerK % 2n) {
    throw new Error('Verge fee RPC does not match the supported chunk policy');
  }
  if (transactionBytes !== undefined && (!Number.isSafeInteger(transactionBytes) || transactionBytes < 1 || transactionBytes > 1000000)) {
    throw new Error('Invalid Verge transaction byte size');
  }
  const chunks = transactionBytes === undefined ? undefined : BigInt(Math.ceil(transactionBytes / 999));
  return {
    model: 'verge-999-byte-chunks', currency: 'XVG', decimals: 6, bytesPerChunk: 999,
    minimumRelayPerChunkAtomic: (relayPerK / 2n).toString(), minimumMempoolPerChunkAtomic: (poolPerK / 2n).toString(),
    priorityEstimatesAvailable: false,
    ...(chunks === undefined ? {} : { transactionBytes, minimumRelayFeeAtomic: (relayPerK / 2n * chunks).toString(), minimumMempoolFeeAtomic: (poolPerK / 2n * chunks).toString() }),
  };
}
