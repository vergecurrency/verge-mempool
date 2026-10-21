import { VergeChainProfile } from './chain-profile';
import { decodeVergeBlock, decodeVergeHeader, decodeVergeTransaction } from './codec';

export interface VergeRpc {
  getNetworkInfo(): Promise<any>;
  getBlockchainInfo(): Promise<any>;
  getBlockCount(): Promise<number>;
  getBlockHash(height: number): Promise<string>;
  getBlock(hash: string, verbosity?: number): Promise<any>;
  getBlockHeader(hash: string, verbose?: boolean): Promise<any>;
  getRawTransaction(txid: string, verbose?: boolean, blockhash?: string): Promise<any>;
  getRawMemPool(verbose?: boolean): Promise<any>;
}

/** @asyncUnsafe */
export async function verifyVergeRpc(client: VergeRpc, profile: VergeChainProfile) {
  const network = await client.getNetworkInfo();
  const blockchain = await client.getBlockchainInfo();
  if (blockchain.chain !== profile.rpcChain || await client.getBlockHash(0) !== profile.genesis) {
    throw new Error(`Core chain/genesis does not match Verge ${profile.network}`);
  }
  if (blockchain.initialblockdownload !== false || blockchain.blocks !== blockchain.headers || blockchain.chaincurrentforservices === false) {
    throw new Error('Verge Core is not synchronized');
  }
  const height = await client.getBlockCount();
  const hash = await client.getBlockHash(height);
  const block = await client.getBlock(hash, 2);
  const header = decodeVergeHeader(await client.getBlockHeader(hash, false));
  if (block.hash !== hash || block.height !== height || header.id !== hash || header.merkle_root !== block.merkleroot) {
    throw new Error('Inconsistent Verge Core block/header response');
  }
  const rawBlock = decodeVergeBlock(await client.getBlock(hash, 0));
  if (rawBlock.id !== hash || rawBlock.tx_count !== block.tx.length ||
      rawBlock.tx.some((tx, i) => tx.txid !== block.tx[i].txid || tx.hex !== block.tx[i].hex)) {
    throw new Error('Inconsistent Verge Core raw block response');
  }
  const firstTx = block.tx?.[0];
  if (!firstTx?.hex || decodeVergeTransaction(firstTx.hex).txid !== firstTx.txid) {
    throw new Error('Invalid Verge Core transaction serialization');
  }
  // Explicit block hash permits historical reads without assuming txindex is enabled.
  if (height > 0) {
    const tx = await client.getRawTransaction(firstTx.txid, true, hash);
    if (tx.txid !== firstTx.txid || tx.hex !== firstTx.hex) { throw new Error('Inconsistent raw transaction response'); }
  }
  const mempool = await client.getRawMemPool(false);
  if (!Array.isArray(mempool) || mempool.some(txid => !/^[a-f0-9]{64}$/.test(txid))) {
    throw new Error('Invalid Verge Core mempool response');
  }
  if (await client.getBlockHash(height) !== hash) { throw new Error('Verge chain reorganized during connectivity check; retry'); }
  return {
    chain: 'verge', network: profile.network, genesis: profile.genesis, synchronized: true,
    height, hash, coreVersion: network.subversion, proof: header.proof,
    algorithm: header.algo, mempoolTransactions: mempool.length,
    unitsPerCoin: profile.unitsPerCoin, targetBlockSeconds: profile.targetBlockSeconds,
  };
}

/** Normalize fields whose meanings are established by Verge's RPC implementation. */
export function normalizeVergeMempoolEntry(entry: any): any {
  if (!entry || !Number.isSafeInteger(entry.vsize ?? entry.size) || (entry.vsize ?? entry.size) <= 0) {
    throw new Error('Invalid Verge mempool entry size');
  }
  const vsize = entry.vsize ?? entry.size;
  return { ...entry, vsize, weight: entry.weight ?? vsize * 4,
    fees: entry.fees ?? { base: entry.fee, modified: entry.modifiedfee ?? entry.fee },
    depends: entry.depends ?? [], spentby: entry.spentby ?? [] };
}

export function adaptVergeRpcClient<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, key) {
      const method = Reflect.get(target, key);
      if (typeof method !== 'function') { return method; }
      /** @asyncUnsafe: RPC rejection is propagated to the API caller. */
      const invoke = async (...args: any[]) => {
        // Bitcoin's numeric maxfeerate is not Verge's boolean allowhighfees.
        if ((key === 'testMempoolAccept' || key === 'sendRawTransaction') && args[1] !== undefined && typeof args[1] !== 'boolean') {
          throw new Error('Verge RPC expects allowhighfees as a boolean');
        }
        if (key === 'testMempoolAccept' && args[0]?.length !== 1) {
          throw new Error('Verge testmempoolaccept supports exactly one transaction');
        }
        const result = await method.apply(target, args);
        if (key === 'getMempoolEntry') { return normalizeVergeMempoolEntry(result); }
        if (key === 'getRawMemPool' && args[0] === true) {
          return Object.fromEntries(Object.entries(result).map(([id, entry]) => [id, normalizeVergeMempoolEntry(entry)]));
        }
        if (key === 'getMempoolInfo') {
          return { ...result, mempoolminfee: Number(result.mempoolminfee), minrelaytxfee: Number(result.minrelaytxfee) };
        }
        return result;
      };
      return invoke;
    },
  });
}
