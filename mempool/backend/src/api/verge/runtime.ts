import config from '../../config';
import { coinToAtomicNumber, CoinAmount } from './amounts';
import { vergeProfile } from './chain-profile';

export const isVerge = config.MEMPOOL.CHAIN === 'verge';
export const activeVergeProfile = isVerge ? vergeProfile(config.MEMPOOL.NETWORK) : undefined;
export const coinDecimals = isVerge ? 6 : 8;
export const unitsPerCoin = isVerge ? 1000000 : 100000000;

export function rpcCoinToAtomic(value: CoinAmount): number {
  return isVerge ? coinToAtomicNumber(value) : Math.round(Number(value) * unitsPerCoin);
}
