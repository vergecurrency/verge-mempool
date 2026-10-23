import { AbstractBitcoinApi, HealthCheckHost } from './bitcoin-api-abstract-factory';
import { IBitcoinApi, SubmitPackageResult, TestMempoolAcceptResult } from './bitcoin-api.interface';
import { IEsploraApi } from './esplora-api.interface';
import blocks from '../blocks';
import mempool from '../mempool';
import { TransactionExtended } from '../../mempool.interfaces';
import transactionUtils from '../transaction-utils';
import { Common } from '../common';
import indexer from '../../indexer';
import { isVerge, rpcCoinToAtomic } from '../verge/runtime';
import { decodeVergeTransaction } from '../verge/codec';
import { safeAtomicNumber } from '../verge/amounts';

class BitcoinApi implements AbstractBitcoinApi {
  private rawMempoolCache: IBitcoinApi.RawMempool | null = null;
  // Immutable output data stays valid across confirmations and reorganizations.
  // Bound the serialized cache to 16 MiB; this is not a historical transaction index.
  private vergePrevoutCache = new Map<string, { vout: IEsploraApi.Vout[]; bytes: number }>();
  private vergePrevoutCacheBytes = 0;
  protected bitcoindClient: any;

  constructor(bitcoinClient: any) {
    this.bitcoindClient = bitcoinClient;
  }

  static convertBlock(block: IBitcoinApi.Block): IEsploraApi.Block {
    return {
      id: block.hash,
      height: block.height,
      version: block.version,
      timestamp: block.time,
      bits: parseInt(block.bits, 16),
      nonce: block.nonce,
      difficulty: block.difficulty,
      merkle_root: block.merkleroot,
      tx_count: block.nTx,
      size: block.size,
      weight: block.weight,
      previousblockhash: block.previousblockhash,
      mediantime: block.mediantime,
      stale: block.confirmations === -1,
      ...(isVerge ? { algo: block.algo, proof: block.proof, pow_hash: block.pow_hash, signature: block.signature } : {}),
    };
  }


  $getRawTransaction(txId: string, skipConversion = false, addPrevout = false, lazyPrevouts = false): Promise<IEsploraApi.Transaction> {
    // If the transaction is in the mempool we already converted and fetched the fee. Only prevouts are missing
    const txInMempool = mempool.getMempool()[txId];
    if (txInMempool && addPrevout) {
      return this.$addPrevouts(txInMempool);
    }

    return this.$getCoreTransaction(txId)
      .then((transaction: IBitcoinApi.Transaction) => {
        if (skipConversion) {
          transaction.vout.forEach((vout) => {
            vout.value = rpcCoinToAtomic(vout.value);
          });
          // The legacy skipConversion API returns Core-shaped data with atomic outputs.
          return transaction as unknown as IEsploraApi.Transaction;
        }
        return this.$convertTransaction(transaction, addPrevout, lazyPrevouts);
      })
      .catch((e: Error) => {
        if (e.message.startsWith('The genesis block coinbase')) {
          return this.$returnCoinbaseTransaction();
        }
        throw e;
      });
  }

  async $getRawTransactions(txids: string[]): Promise<IEsploraApi.Transaction[]> {
    const txs: IEsploraApi.Transaction[] = [];
    for (const txid of txids) {
      try {
        const tx = await this.$getRawTransaction(txid, false, true);
        txs.push(tx);
      } catch (err) {
        // skip failures
      }
    }
    return txs;
  }

  $getMempoolTransactions(txids: string[]): Promise<IEsploraApi.Transaction[]> {
    throw new Error('Method getMempoolTransactions not supported by the Bitcoin RPC API.');
  }

  $getAllMempoolTransactions(lastTxid?: string, max_txs?: number): Promise<IEsploraApi.Transaction[]> {
    throw new Error('Method getAllMempoolTransactions not supported by the Bitcoin RPC API.');

  }

  async $getTransactionHex(txId: string): Promise<string> {
    const txInMempool = mempool.getMempool()[txId];
    if (txInMempool && txInMempool.hex) {
      return txInMempool.hex;
    }

    return this.$getCoreTransaction(txId)
      .then((transaction: IBitcoinApi.Transaction) => {
        return transaction.hex;
      });
  }

  $getTransactionMerkleProof(txId: string): Promise<IEsploraApi.MerkleProof> {
    throw new Error('Method getTransactionMerkleProof not supported by the Bitcoin RPC API.');
  }

  $getBlockHeightTip(): Promise<number> {
    return this.bitcoindClient.getBlockCount();
  }

  $getBlockHashTip(): Promise<string> {
    return this.bitcoindClient.getBestBlockHash();
  }

  $getTxIdsForBlock(hash: string, fallbackToCore = false): Promise<string[]> {
    return this.bitcoindClient.getBlock(hash, 1)
      .then((rpcBlock: IBitcoinApi.Block) => rpcBlock.tx);
  }

  /** @asyncUnsafe */
  async $getTxsForBlock(hash: string, fallbackToCore = false, addPrevouts = true): Promise<IEsploraApi.Transaction[]> {
    const verboseBlock: IBitcoinApi.VerboseBlock = await this.bitcoindClient.getBlock(hash, 2);
    const transactions: IEsploraApi.Transaction[] = [];
    for (const tx of verboseBlock.tx) {
      const transaction = isVerge ? { ...tx, confirmations: verboseBlock.confirmations, blockhash: hash, blocktime: verboseBlock.time } : tx;
      const converted = await this.$convertTransaction(transaction, addPrevouts, false, verboseBlock.confirmations === -1, isVerge ? verboseBlock : undefined);
      converted.status = isVerge && verboseBlock.confirmations <= 0 ? { confirmed: false } : {
        confirmed: true,
        block_height: verboseBlock.height,
        block_hash: hash,
        block_time: verboseBlock.time,
      };
      transactions.push(converted);
    }
    if (isVerge && verboseBlock.confirmations > 0) {
      const current = await this.bitcoindClient.getBlockHeader(hash, true);
      if (current.confirmations <= 0) {
        for (const transaction of transactions) { transaction.status = { confirmed: false }; }
      }
    }
    return transactions;
  }

  $getRawBlock(hash: string): Promise<Buffer> {
    return this.bitcoindClient.getBlock(hash, 0)
      .then((raw: string) => Buffer.from(raw, 'hex'));
  }

  $getBlockHash(height: number): Promise<string> {
    return this.bitcoindClient.getBlockHash(height);
  }

  $getBlockHeader(hash: string): Promise<string> {
    return this.bitcoindClient.getBlockHeader(hash, false);
  }

  async $getBlock(hash: string): Promise<IEsploraApi.Block> {
    const foundBlock = blocks.getBlocks().find((block) => block.id === hash);
    if (foundBlock) {
      return foundBlock;
    }

    return this.bitcoindClient.getBlock(hash)
      .then((block: IBitcoinApi.Block) => BitcoinApi.convertBlock(block));
  }

  $getAddress(address: string): Promise<IEsploraApi.Address> {
    throw new Error('Method getAddress not supported by the Bitcoin RPC API.');
  }

  $getAddressTransactions(address: string, lastSeenTxId: string): Promise<IEsploraApi.Transaction[]> {
    throw new Error('Method getAddressTransactions not supported by the Bitcoin RPC API.');
  }

  $getAddressUtxos(address: string): Promise<IEsploraApi.UTXO[]> {
    throw new Error('Method getAddressUtxos not supported by the Bitcoin RPC API.');
  }

  $getScriptHash(scripthash: string): Promise<IEsploraApi.ScriptHash> {
    throw new Error('Method getScriptHash not supported by the Bitcoin RPC API.');
  }

  $getScriptHashTransactions(scripthash: string, lastSeenTxId: string): Promise<IEsploraApi.Transaction[]> {
    throw new Error('Method getScriptHashTransactions not supported by the Bitcoin RPC API.');
  }

  $getScriptHashUtxos(scripthash: string): Promise<IEsploraApi.UTXO[]> {
    throw new Error('Method getScriptHashUtxos not supported by the Bitcoin RPC API.');
  }

  $getRawMempool(): Promise<IEsploraApi.Transaction['txid'][]> {
    return this.bitcoindClient.getRawMemPool();
  }

  $getAddressPrefix(prefix: string): string[] {
    const found: { [address: string]: string } = {};
    const mp = mempool.getMempool();
    for (const tx in mp) {
      for (const vout of mp[tx].vout) {
        if (vout.scriptpubkey_address?.indexOf(prefix) === 0) {
          found[vout.scriptpubkey_address] = '';
          if (Object.keys(found).length >= 10) {
            return Object.keys(found);
          }
        }
      }
      for (const vin of mp[tx].vin) {
        if (vin.prevout?.scriptpubkey_address?.indexOf(prefix) === 0) {
          found[vin.prevout?.scriptpubkey_address] = '';
          if (Object.keys(found).length >= 10) {
            return Object.keys(found);
          }
        }
      }
    }
    return Object.keys(found);
  }

  $sendRawTransaction(rawTransaction: string): Promise<string> {
    return this.bitcoindClient.sendRawTransaction(rawTransaction);
  }

  async $testMempoolAccept(rawTransactions: string[], maxfeerate?: number): Promise<TestMempoolAcceptResult[]> {
    if (isVerge && maxfeerate !== undefined) { throw new Error('Verge testmempoolaccept does not support maxfeerate'); }
    if (rawTransactions.length) {
      return this.bitcoindClient.testMempoolAccept(rawTransactions, maxfeerate ?? undefined);
    } else {
      return [];
    }
  }

  $submitPackage(rawTransactions: string[], maxfeerate?: number, maxburnamount?: number): Promise<SubmitPackageResult> {
    if (isVerge) { return Promise.reject(new Error('Package submission is not supported by Verge Core')); }
    return this.bitcoindClient.submitPackage(rawTransactions, maxfeerate ?? undefined, maxburnamount ?? undefined);
  }

  /** @asyncUnsafe */
  async $getOutspend(txId: string, vout: number): Promise<IEsploraApi.Outspend> {
    if (isVerge) { return (await this.$getVergeOutspends(txId, vout))[0]; }
    const txOut = await this.bitcoindClient.getTxOut(txId, vout, false);
    return {
      spent: txOut === null,
      status: {
        confirmed: true,
      }
    };
  }

  /** @asyncUnsafe */
  async $getOutspends(txId: string): Promise<IEsploraApi.Outspend[]> {
    if (isVerge) { return this.$getVergeOutspends(txId); }
    const tx = await this.$getRawTransaction(txId, true, false);
    if (indexer.isCoreIndexReady('txospenderindex')) {
      const outputs = tx.vout.map((_, vout) => ({ txid: txId, vout }));
      if (!outputs.length) {
        return [];
      }

      try {
        const spendingPrevouts: IBitcoinApi.TxSpendingPrevout[] = await this.bitcoindClient.getTxSpendingPrevout(outputs, { mempool_only: false });
        return spendingPrevouts.map((spendingPrevout): IEsploraApi.Outspend => {
          if (!spendingPrevout.spendingtxid) {
            return { spent: false };
          }

          return {
            spent: true,
            txid: spendingPrevout.spendingtxid,
            status: spendingPrevout.blockhash ? { confirmed: true, block_hash: spendingPrevout.blockhash } : { confirmed: false },
          };
        });
      } catch (e) {
        const rpcError = e as { code?: number; message?: string };
        // If txospenderindex is not available, fall back to gettxout for each output
        if (rpcError.code !== -1 || !rpcError.message?.includes('txospenderindex is unavailable')) {
          throw e;
        }
      }
    }

    const outSpends: IEsploraApi.Outspend[] = [];
    for (let i = 0; i < tx.vout.length; i++) {
      if (tx.status && tx.status.block_height === 0) {
        outSpends.push({
          spent: false
        });
      } else {
        const txOut = await this.bitcoindClient.getTxOut(txId, i);
        outSpends.push({
          spent: txOut === null,
        });
      }
    }
    return outSpends;
  }

  /** @asyncUnsafe */
  async $getBatchedOutspends(txId: string[]): Promise<IEsploraApi.Outspend[][]> {
    const outspends: IEsploraApi.Outspend[][] = [];
    for (const tx of txId) {
      const outspend = await this.$getOutspends(tx);
      outspends.push(outspend);
    }
    return outspends;
  }

  async $getBatchedOutspendsInternal(txId: string[]): Promise<IEsploraApi.Outspend[][]> {
    return this.$getBatchedOutspends(txId);
  }

  /** @asyncUnsafe */
  async $getOutSpendsByOutpoint(outpoints: { txid: string, vout: number }[]): Promise<IEsploraApi.Outspend[]> {
    const outspends: IEsploraApi.Outspend[] = [];
    for (const outpoint of outpoints) {
      const outspend = await this.$getOutspend(outpoint.txid, outpoint.vout);
      outspends.push(outspend);
    }
    return outspends;
  }

  /** @asyncUnsafe */
  async $getCoinbaseTx(blockhash: string): Promise<IEsploraApi.Transaction> {
    if (isVerge) {
      const block: IBitcoinApi.Block = await this.bitcoindClient.getBlock(blockhash, 2);
      return this.$convertTransaction({ ...block.tx[0], confirmations: block.confirmations, blockhash, blocktime: block.time }, false);
    }
    const txids = await this.$getTxIdsForBlock(blockhash);
    return this.$getRawTransaction(txids[0]);
  }

  async $getAddressTransactionSummary(address: string): Promise<IEsploraApi.AddressTxSummary[]> {
    throw new Error('Method getAddressTransactionSummary not supported by the Bitcoin RPC API.');
  }

  $getEstimatedHashrate(blockHeight: number): Promise<number> {
    // 120 is the default block span in Core
    return this.bitcoindClient.getNetworkHashPs(120, blockHeight);
  }

  /** @asyncUnsafe */
  protected async $convertTransaction(transaction: IBitcoinApi.Transaction, addPrevout: boolean, lazyPrevouts = false, allowMissingPrevouts = false, blockContext?: Pick<IBitcoinApi.Block, 'height' | 'confirmations'>): Promise<IEsploraApi.Transaction> {
    const decoded = this.$decodeVergeRpcTransaction(transaction);
    let esploraTransaction: IEsploraApi.Transaction = {
      txid: transaction.txid,
      version: transaction.version,
      locktime: transaction.locktime,
      size: decoded?.size ?? transaction.size,
      weight: decoded?.weight ?? transaction.weight,
      fee: 0,
      vin: [],
      vout: [],
      status: { confirmed: false },
      ...(isVerge ? { time: decoded!.time } : {}),
    };

    esploraTransaction.vout = this.$convertTransactionOutputs(transaction, decoded);

    esploraTransaction.vin = transaction.vin.map((vin) => {
      return {
        is_coinbase: !!vin.coinbase,
        prevout: null,
        scriptsig: vin.scriptSig && vin.scriptSig.hex || vin.coinbase || '',
        scriptsig_asm: vin.scriptSig ? transactionUtils.convertScriptSigAsm(vin.scriptSig.hex) : (vin.coinbase ? transactionUtils.convertScriptSigAsm(vin.coinbase) : ''),
        sequence: vin.sequence,
        txid: vin.txid || '',
        vout: vin.vout || 0,
        witness: vin.txinwitness || [],
        inner_redeemscript_asm: '',
        inner_witnessscript_asm: '',
      };
    });

    if (transaction.confirmations > 0 && transaction.in_active_chain !== false) {
      const confirmingBlock = isVerge ? blockContext ?? await this.bitcoindClient.getBlockHeader(transaction.blockhash, true) : undefined;
      esploraTransaction.status = isVerge && confirmingBlock.confirmations <= 0 ? { confirmed: false } : {
        confirmed: true,
        block_height: confirmingBlock ? confirmingBlock.height : blocks.getCurrentBlockHeight() - transaction.confirmations + 1,
        block_hash: transaction.blockhash,
        block_time: transaction.blocktime,
      };
    }

    if (esploraTransaction.vin[0].is_coinbase) {
      return esploraTransaction;
    }

    if (addPrevout) {
      try {
        esploraTransaction = await this.$calculateFeeFromInputs(esploraTransaction, false, lazyPrevouts);
      } catch (e) {
        if (!allowMissingPrevouts) {
          throw e;
        }
      }
    } else if (!transaction.confirmations) {
      esploraTransaction = await this.$appendMempoolFeeData(esploraTransaction);
    }

    return esploraTransaction;
  }

  /** Override the retrieval mechanism without duplicating amount/confirmation conversion. */
  protected $getCoreTransaction(txid: string, _forPrevout = false): Promise<IBitcoinApi.Transaction> {
    return this.bitcoindClient.getRawTransaction(txid, true);
  }

  protected $decodeVergeRpcTransaction(transaction: IBitcoinApi.Transaction): ReturnType<typeof decodeVergeTransaction> | undefined {
    if (!isVerge) { return undefined; }
    const decoded = decodeVergeTransaction(transaction.hex);
    if (decoded.txid !== transaction.txid) { throw new Error('Verge raw transaction ID mismatch'); }
    if (decoded.version !== transaction.version || decoded.locktime !== transaction.locktime ||
        decoded.vout.length !== transaction.vout.length || decoded.vin.length !== transaction.vin.length ||
        decoded.vout.some((output, index) => output.scriptpubkey !== transaction.vout[index].scriptPubKey.hex) ||
        decoded.vin.some((input, index) => {
          const metadata = transaction.vin[index];
          return input.sequence !== metadata.sequence || (input.is_coinbase ? input.scriptsig !== metadata.coinbase :
            input.txid !== metadata.txid || input.vout !== metadata.vout || input.scriptsig !== metadata.scriptSig?.hex);
        })) {
      throw new Error('Verge raw transaction and RPC metadata disagree');
    }
    return decoded;
  }

  protected $convertTransactionOutputs(transaction: IBitcoinApi.Transaction, decoded?: ReturnType<typeof decodeVergeTransaction>): IEsploraApi.Vout[] {
    return transaction.vout.map((output, index) => ({
      value: decoded ? safeAtomicNumber(decoded.vout[index].value) : rpcCoinToAtomic(output.value),
      scriptpubkey: output.scriptPubKey.hex,
      scriptpubkey_address: output.scriptPubKey.address || output.scriptPubKey.addresses?.[0] || '',
      scriptpubkey_asm: output.scriptPubKey.asm ? transactionUtils.convertScriptSigAsm(output.scriptPubKey.hex) : '',
      scriptpubkey_type: this.translateScriptPubKeyType(output.scriptPubKey.type),
    }));
  }

  /** @asyncUnsafe */
  protected async $getPrevoutTransaction(txid: string): Promise<Pick<IEsploraApi.Transaction, 'vout'>> {
    if (!isVerge) { return this.$getRawTransaction(txid, false, false); }
    const cached = this.vergePrevoutCache.get(txid);
    if (cached) {
      this.vergePrevoutCache.delete(txid);
      this.vergePrevoutCache.set(txid, cached);
      return { vout: cached.vout.map(output => ({ ...output })) };
    }
    const transaction = await this.$getCoreTransaction(txid, true);
    if (transaction.txid !== txid) { throw new Error('Verge previous transaction ID mismatch'); }
    const vout = this.$convertTransactionOutputs(transaction, this.$decodeVergeRpcTransaction(transaction));
    const bytes = Buffer.byteLength(JSON.stringify(vout));
    const limit = 16 * 1024 * 1024;
    if (bytes <= limit) {
      const previous = this.vergePrevoutCache.get(txid);
      if (previous) {
        this.vergePrevoutCacheBytes -= previous.bytes;
        this.vergePrevoutCache.delete(txid);
      }
      while (this.vergePrevoutCacheBytes + bytes > limit && this.vergePrevoutCache.size) {
        const oldest = this.vergePrevoutCache.entries().next();
        if (oldest.done) { break; }
        this.vergePrevoutCacheBytes -= oldest.value[1].bytes;
        this.vergePrevoutCache.delete(oldest.value[0]);
      }
      this.vergePrevoutCache.set(txid, { vout: vout.map(output => ({ ...output })), bytes });
      this.vergePrevoutCacheBytes += bytes;
    }
    return { vout };
  }

  /** Core can establish UTXO state, but cannot supply a confirmed spender ID without an index. @asyncUnsafe */
  private async $getVergeOutspends(txid: string, onlyOutput?: number): Promise<IEsploraApi.Outspend[]> {
    let transaction: IBitcoinApi.Transaction;
    let genesis = false;
    try { transaction = await this.$getCoreTransaction(txid); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('The genesis block coinbase')) { throw error; }
      const hash = await this.bitcoindClient.getBlockHash(0);
      transaction = (await this.bitcoindClient.getBlock(hash, 2)).tx[0];
      if (transaction.txid !== txid) { throw new Error('Verge genesis transaction mismatch'); }
      genesis = true;
    }
    const decoded = this.$decodeVergeRpcTransaction(transaction)!;
    if (onlyOutput !== undefined && (!Number.isSafeInteger(onlyOutput) || onlyOutput < 0 || onlyOutput >= decoded.vout.length)) {
      throw new Error('Invalid transaction output index');
    }
    if (transaction.confirmations < 0 || transaction.in_active_chain === false) {
      throw new Error('Outspend state is unavailable for a noncanonical Verge transaction');
    }
    const outputs = onlyOutput === undefined ? decoded.vout.map((_, index) => index) : [onlyOutput];
    const result: IEsploraApi.Outspend[] = [];
    for (const index of outputs) {
      const script = decoded.vout[index].scriptpubkey;
      if (genesis || script.startsWith('6a') || script.length > 20000) { result.push({ spent: false }); continue; }
      if (await this.bitcoindClient.getTxOut(txid, index, true) !== null) { result.push({ spent: false }); continue; }
      const spender = mempool.getSpendMap().get(`${txid}:${index}`);
      if (spender) {
        const vin = spender.vin.findIndex(input => input.txid === txid && input.vout === index);
        try {
          // Recheck the node: the cached spender may already have been mined or evicted.
          if (vin >= 0) {
            await this.bitcoindClient.getMempoolEntry(spender.txid);
            result.push({ spent: true, txid: spender.txid, vin, status: { confirmed: false } }); continue;
          }
        } catch (error) { if ((error as { code?: number }).code !== -5) { throw error; } }
      }
      result.push({ spent: true });
    }
    return result;
  }

  private translateScriptPubKeyType(outputType: string): string {
    const map = {
      'pubkey': 'p2pk',
      'pubkeyhash': 'p2pkh',
      'scripthash': 'p2sh',
      'witness_v0_keyhash': 'v0_p2wpkh',
      'witness_v0_scripthash': 'v0_p2wsh',
      'witness_v1_taproot': 'v1_p2tr',
      'nonstandard': 'nonstandard',
      'multisig': 'multisig',
      'anchor': 'anchor',
      'nulldata': 'op_return'
    };

    if (map[outputType]) {
      return map[outputType];
    } else {
      return 'unknown';
    }
  }

  /** @asyncUnsafe */
  private async $appendMempoolFeeData(transaction: IEsploraApi.Transaction): Promise<IEsploraApi.Transaction> {
    if (transaction.fee) {
      return transaction;
    }
    let mempoolEntry: IBitcoinApi.MempoolEntry;
    if (!mempool.isInSync() && !this.rawMempoolCache) {
      this.rawMempoolCache = await this.$getRawMempoolVerbose();
    }
    if (this.rawMempoolCache && this.rawMempoolCache[transaction.txid]) {
      mempoolEntry = this.rawMempoolCache[transaction.txid];
    } else {
      mempoolEntry = await this.$getMempoolEntry(transaction.txid);
    }
    transaction.fee = rpcCoinToAtomic(mempoolEntry.fees.base);
    return transaction;
  }

  /** @asyncUnsafe */
  protected async $addPrevouts(transaction: TransactionExtended): Promise<TransactionExtended> {
    let addedPrevouts = false;
    for (const vin of transaction.vin) {
      if (vin.prevout) {
        continue;
      }
      const innerTx = await this.$getPrevoutTransaction(vin.txid);
      vin.prevout = innerTx.vout[vin.vout];
      transactionUtils.addInnerScriptsToVin(vin);
      addedPrevouts = true;
    }
    if (addedPrevouts) {
      // re-calculate transaction flags now that we have full prevout data
      transaction.flags = undefined; // clear existing flags to force full classification
      transaction.flags = Common.getTransactionFlags(transaction, transaction.status?.block_height ?? blocks.getCurrentBlockHeight());
    }
    return transaction;
  }

  protected $returnCoinbaseTransaction(): Promise<IEsploraApi.Transaction> {
    return this.bitcoindClient.getBlockHash(0).then((hash: string) =>
      this.bitcoindClient.getBlock(hash, 2)
        .then((block: IBitcoinApi.Block) => {
          return this.$convertTransaction(Object.assign(block.tx[0], {
            confirmations: blocks.getCurrentBlockHeight() + 1,
            blockhash: hash,
            blocktime: block.time }), false);
        })
    );
  }

  private $getMempoolEntry(txid: string): Promise<IBitcoinApi.MempoolEntry> {
    return this.bitcoindClient.getMempoolEntry(txid);
  }

  private $getRawMempoolVerbose(): Promise<IBitcoinApi.RawMempool> {
    return this.bitcoindClient.getRawMemPool(true);
  }


  /** @asyncUnsafe */
  private async $calculateFeeFromInputs(transaction: IEsploraApi.Transaction, addPrevout: boolean, lazyPrevouts: boolean): Promise<IEsploraApi.Transaction> {
    if (transaction.vin[0].is_coinbase) {
      transaction.fee = 0;
      return transaction;
    }
    let totalIn = 0n;

    for (let i = 0; i < transaction.vin.length; i++) {
      if (lazyPrevouts && i > 12) {
        transaction.vin[i].lazy = true;
        continue;
      }
      const innerTx = await this.$getPrevoutTransaction(transaction.vin[i].txid);
      transaction.vin[i].prevout = innerTx.vout[transaction.vin[i].vout];
      transactionUtils.addInnerScriptsToVin(transaction.vin[i]);
      totalIn += BigInt(innerTx.vout[transaction.vin[i].vout].value);
    }
    if (lazyPrevouts && transaction.vin.length > 12) {
      transaction.fee = -1;
    } else {
      const totalOut = transaction.vout.reduce((p, output) => p + BigInt(output.value), 0n);
      transaction.fee = safeAtomicNumber(totalIn - totalOut);
    }
    return transaction;
  }

  public startHealthChecks(): void {};

  public getHealthStatus() {
    return [];
  }
}

export default BitcoinApi;
