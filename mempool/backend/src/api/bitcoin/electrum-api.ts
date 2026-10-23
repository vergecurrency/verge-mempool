import config from '../../config';
import Client from '@mempool/electrum-client';
import { AbstractBitcoinApi } from './bitcoin-api-abstract-factory';
import { IEsploraApi } from './esplora-api.interface';
import { IElectrumApi } from './electrum-api.interface';
import BitcoinApi from './bitcoin-api';
import logger from '../../logger';
import { scriptHashForElectrum, compareElectrumHistory, electrumCursorStart, assertElectrumGenesis } from '../verge/electrum-utils';
import { activeVergeProfile, isVerge } from '../verge/runtime';
import { safeAtomicNumber } from '../verge/amounts';
import loadingIndicators from '../loading-indicators';
import memoryCache from '../memory-cache';
import { assertElectrumTlsPeer } from '../verge/electrum-tls';
import { IBitcoinApi } from './bitcoin-api.interface';
import { decodeVergeTransaction, decodeVergeHeader } from '../verge/codec';
import { verifyElectrumMerkle } from '../verge/electrum-probe';
import axios from 'axios';

class BitcoindElectrsApi extends BitcoinApi implements AbstractBitcoinApi {
  private electrumClient: any;
  private chainVerified = !isVerge;
  private connectionGeneration = 0;
  private knownTransactionHeights = new Map<string, number>();
  private tipCheck?: Promise<void>;
  private tipVerifiedUntil = 0;
  private tipHash = '';

  constructor(bitcoinClient: any) {
    super(bitcoinClient);

    const electrumConfig = { client: 'mempool-v2', version: '1.4' };
    const electrumPersistencePolicy = { retryPeriod: 1000, maxRetry: Number.MAX_SAFE_INTEGER, callback: null };

    const electrumCallbacks = {
      onConnect: (client, versionInfo) => {
        logger.info(`Connected to Electrum Server at ${config.ELECTRUM.HOST}:${config.ELECTRUM.PORT} (${JSON.stringify(versionInfo)})`);
        if (activeVergeProfile) {
          this.chainVerified = false;
          const generation = ++this.connectionGeneration;
          /** @asyncUnsafe */
          const verifyIdentity = async () => {
            if (config.ELECTRUM.TLS_ENABLED) {
              assertElectrumTlsPeer(client.conn?._socket, config.ELECTRUM.HOST, config.ELECTRUM.TLS_CERTIFICATE_FINGERPRINT);
            } else if (config.ELECTRUM.TLS_CERTIFICATE_FINGERPRINT) { throw new Error('An Electrum certificate fingerprint requires TLS'); }
            const features = await client.server_features();
            assertElectrumGenesis(features, activeVergeProfile!.genesis);
            if (generation === this.connectionGeneration) { this.chainVerified = true; }
          };
          verifyIdentity().catch(error => {
            if (generation !== this.connectionGeneration) { return; }
            this.chainVerified = false;
            logger.err(`Verge Electrum identity check failed: ${error.message}`); client.close();
          });
        }
      },
      onClose: (client) => {
        this.chainVerified = !isVerge; this.connectionGeneration++; this.knownTransactionHeights.clear();
        this.tipCheck = undefined; this.tipVerifiedUntil = 0; this.tipHash = '';
        logger.info(`Disconnected from Electrum Server at ${config.ELECTRUM.HOST}:${config.ELECTRUM.PORT}`);
      },
      onError: (err) => { logger.err(`Electrum error: ${JSON.stringify(err)}`); },
      onLog: (str) => { logger.debug(str); },
    };

    this.electrumClient = new Client(
      config.ELECTRUM.PORT,
      config.ELECTRUM.HOST,
      config.ELECTRUM.TLS_ENABLED ? 'tls' : 'tcp',
      null,
      electrumCallbacks
    );

    this.electrumClient.initElectrum(electrumConfig, electrumPersistencePolicy)
      .then(() => { })
      .catch((err) => {
        logger.err(`Error connecting to Electrum Server at ${config.ELECTRUM.HOST}:${config.ELECTRUM.PORT}`);
      });
  }

  /** @asyncUnsafe */
  async $getAddress(address: string): Promise<IEsploraApi.Address> {
    const addressInfo = await this.bitcoindClient.validateAddress(address);
    if (!addressInfo || !addressInfo.isvalid) {
      throw new Error(isVerge ? 'Invalid Verge address' : 'Invalid Bitcoin address');
    }

    try {
      const balance = await this.$getScriptHashBalance(addressInfo.scriptPubKey);
      const history = await this.$getScriptHashHistory(addressInfo.scriptPubKey);

      const unconfirmed = history.filter((h) => h.height <= 0).length;

      return {
        'address': addressInfo.address,
        'chain_stats': {
          'funded_txo_count': 0,
          'funded_txo_sum': balance.confirmed ? balance.confirmed : 0,
          'spent_txo_count': 0,
          'spent_txo_sum': balance.confirmed < 0 ? balance.confirmed : 0,
          'tx_count': history.length - unconfirmed,
        },
        'mempool_stats': {
          'funded_txo_count': 0,
          'funded_txo_sum': balance.unconfirmed > 0 ? balance.unconfirmed : 0,
          'spent_txo_count': 0,
          'spent_txo_sum': balance.unconfirmed < 0 ? -balance.unconfirmed : 0,
          'tx_count': unconfirmed,
        },
        'electrum': true,
      };
    } catch (e: any) {
      throw new Error(typeof e === 'string' ? e : e && e.message || e);
    }
  }

  /** @asyncUnsafe */
  async $getAddressTransactions(address: string, lastSeenTxId: string): Promise<IEsploraApi.Transaction[]> {
    const addressInfo = await this.bitcoindClient.validateAddress(address);
    if (!addressInfo || !addressInfo.isvalid) {
      throw new Error(isVerge ? 'Invalid Verge address' : 'Invalid Bitcoin address');
    }

    try {
      loadingIndicators.setProgress('address-' + address, 0);

      const transactions: IEsploraApi.Transaction[] = [];
      const history = await this.$getScriptHashHistory(addressInfo.scriptPubKey);
      history.sort(compareElectrumHistory);
      const startingIndex = electrumCursorStart(history, lastSeenTxId);
      const endIndex = Math.min(startingIndex + 10, history.length);

      for (let i = startingIndex; i < endIndex; i++) {
        this.rememberHistoryHeight(history[i]);
        const tx = await this.$getRawTransaction(history[i].tx_hash, false, true);
        transactions.push(tx);
        loadingIndicators.setProgress('address-' + address, (i + 1) / endIndex * 100);
      }

      return transactions;
    } catch (e: any) {
      loadingIndicators.setProgress('address-' + address, 100);
      throw new Error(typeof e === 'string' ? e : e && e.message || e);
    }
  }

  async $getScriptHash(scripthash: string): Promise<IEsploraApi.ScriptHash> {
    this.assertChainVerified();
    try {
      const balance: IElectrumApi.ScriptHashBalance = await this.$verifiedElectrumRequest(() => this.electrumClient.blockchainScripthash_getBalance(scripthash));
      safeAtomicNumber(balance.confirmed);
      safeAtomicNumber(balance.unconfirmed);
      const history = await this.$getElectrumHistory(scripthash);

      const unconfirmed = history ? history.filter((h) => h.height <= 0).length : 0;

      return {
        'scripthash': scripthash,
        'chain_stats': {
          'funded_txo_count': 0,
          'funded_txo_sum': balance.confirmed ? balance.confirmed : 0,
          'spent_txo_count': 0,
          'spent_txo_sum': balance.confirmed < 0 ? balance.confirmed : 0,
          'tx_count': (history?.length || 0) - unconfirmed,
        },
        'mempool_stats': {
          'funded_txo_count': 0,
          'funded_txo_sum': balance.unconfirmed > 0 ? balance.unconfirmed : 0,
          'spent_txo_count': 0,
          'spent_txo_sum': balance.unconfirmed < 0 ? -balance.unconfirmed : 0,
          'tx_count': unconfirmed,
        },
        'electrum': true,
      };
    } catch (e: any) {
      throw new Error(typeof e === 'string' ? e : e && e.message || e);
    }
  }

  /** @asyncUnsafe */
  async $getAddressUtxos(address: string): Promise<IEsploraApi.UTXO[]> {
    const addressInfo = await this.bitcoindClient.validateAddress(address);
    if (!addressInfo || !addressInfo.isvalid) {
      throw new Error(isVerge ? 'Invalid Verge address' : 'Invalid Bitcoin address');
    }
    const scripthash = this.encodeScriptHash(addressInfo.scriptPubKey);
    return this.$getScriptHashUtxos(scripthash);
  }

  async $getScriptHashTransactions(scripthash: string, lastSeenTxId?: string): Promise<IEsploraApi.Transaction[]> {
    this.assertChainVerified();
    try {
      loadingIndicators.setProgress('address-' + scripthash, 0);

      const transactions: IEsploraApi.Transaction[] = [];
      const history = await this.$getElectrumHistory(scripthash);
      if (!history) {
        throw new Error('failed to get scripthash history');
      }
      history.sort(compareElectrumHistory);
      const startingIndex = electrumCursorStart(history, lastSeenTxId);
      const endIndex = Math.min(startingIndex + 10, history.length);

      for (let i = startingIndex; i < endIndex; i++) {
        this.rememberHistoryHeight(history[i]);
        const tx = await this.$getRawTransaction(history[i].tx_hash, false, true);
        transactions.push(tx);
        loadingIndicators.setProgress('address-' + scripthash, (i + 1) / endIndex * 100);
      }

      return transactions;
    } catch (e: any) {
      loadingIndicators.setProgress('address-' + scripthash, 100);
      throw new Error(typeof e === 'string' ? e : e && e.message || e);
    }
  }

  /** @asyncUnsafe */
  async $getScriptHashUtxos(scripthash: string): Promise<IEsploraApi.UTXO[]> {
    const utxos = await this.$getScriptHashUnspent(scripthash);
    const result: IEsploraApi.UTXO[] = [];
    for(const utxo of utxos) {
      safeAtomicNumber(utxo.value);
      if(utxo.height<=0) {
        //Unconfirmed
        result.push({
          txid: utxo.tx_hash,
          vout: utxo.tx_pos,
          status: {
            confirmed: false
          },
          value: utxo.value
        });
      } else {
        //Confirmed
        const blockHash = await this.$getBlockHash(utxo.height);
        const block = await this.$getBlock(blockHash);
        result.push({
          txid: utxo.tx_hash,
          vout: utxo.tx_pos,
          status: {
            confirmed: true,
            block_height: utxo.height,
            block_hash: blockHash,
            block_time: block.timestamp
          },
          value: utxo.value
        });
      }
    }
    return result;
  }

  private $getScriptHashUnspent(scriptHash: string): Promise<IElectrumApi.ScriptHashUtxos[]> {
    return this.$verifiedElectrumRequest(() => this.electrumClient.blockchainScripthash_listunspent(scriptHash));
  }

  /** @asyncUnsafe */
  async $getTransactionMerkleProof(txId: string): Promise<IEsploraApi.MerkleProof> {
    this.assertChainVerified();
    const tx = await this.$getRawTransaction(txId);
    if (isVerge && !tx.status.confirmed) { throw new Error('Merkle proof is unavailable for an unconfirmed Verge transaction'); }
    const proof: IEsploraApi.MerkleProof = await this.$verifiedElectrumRequest(() => this.electrumClient.blockchainTransaction_getMerkle(txId, tx.status.block_height));
    if (isVerge) {
      const header = decodeVergeHeader(await this.bitcoindClient.getBlockHeader(tx.status.block_hash, false));
      if (proof.block_height !== tx.status.block_height || header.id !== tx.status.block_hash ||
          await this.bitcoindClient.getBlockHash(tx.status.block_height) !== header.id) { throw new Error('Verge merkle proof block changed; refresh the transaction'); }
      verifyElectrumMerkle(txId, proof, header.merkle_root);
    }
    return proof;
  }

  private $getScriptHashBalance(scriptHash: string): Promise<IElectrumApi.ScriptHashBalance> {
    return this.$verifiedElectrumRequest<IElectrumApi.ScriptHashBalance>(() => this.electrumClient.blockchainScripthash_getBalance(this.encodeScriptHash(scriptHash))).then(balance => {
      safeAtomicNumber(balance.confirmed);
      safeAtomicNumber(balance.unconfirmed);
      return balance;
    });
  }

  private $getScriptHashHistory(scriptHash: string): Promise<IElectrumApi.ScriptHashHistory[]> {
    return this.$getElectrumHistory(this.encodeScriptHash(scriptHash));
  }

  /** @asyncUnsafe */
  private async $getElectrumHistory(scripthash: string): Promise<IElectrumApi.ScriptHashHistory[]> {
    this.assertChainVerified();
    await this.$assertVergeElectrumTip();
    const key = isVerge ? `verge:${activeVergeProfile!.network}:${this.connectionGeneration}:${this.tipHash}:${scripthash}` : scripthash;
    const fromCache = memoryCache.get<IElectrumApi.ScriptHashHistory[]>('Scripthash_getHistory', key);
    if (fromCache) { return fromCache; }
    const history: IElectrumApi.ScriptHashHistory[] = await this.$verifiedElectrumRequest(() => this.electrumClient.blockchainScripthash_getHistory(scripthash));
    if (isVerge && (!Array.isArray(history) || history.some(entry => !/^[a-f\d]{64}$/i.test(entry.tx_hash) || !Number.isSafeInteger(entry.height) || entry.height < -1))) {
      throw new Error('Invalid Verge Electrum history');
    }
    memoryCache.set('Scripthash_getHistory', key, history, 2);
    return history;
  }

  private rememberHistoryHeight(entry: IElectrumApi.ScriptHashHistory): void {
    if (!isVerge) { return; }
    this.knownTransactionHeights.delete(entry.tx_hash);
    this.knownTransactionHeights.set(entry.tx_hash, entry.height);
    if (this.knownTransactionHeights.size > 2000) { this.knownTransactionHeights.delete(this.knownTransactionHeights.keys().next().value!); }
  }

  /** @asyncUnsafe */
  protected async $getCoreTransaction(txid: string, forPrevout = false): Promise<IBitcoinApi.Transaction> {
    const height = isVerge ? this.knownTransactionHeights.get(txid) : undefined;
    if (height === undefined || height <= 0) {
      try { return await super.$getCoreTransaction(txid); }
      catch (error) {
        if (!isVerge || forPrevout || (error as { code?: number }).code !== -5) { throw error; }
        return this.$getVergeIndexedTransaction(txid);
      }
    }
    this.assertChainVerified();
    const blockhash = await this.bitcoindClient.getBlockHash(height);
    const transaction = await this.bitcoindClient.getRawTransaction(txid, true, blockhash);
    if (transaction.in_active_chain === false) { throw new Error('Verge address history reorganized; refresh the history'); }
    return transaction;
  }

  /** Resolve a direct historical tx lookup without requiring Core txindex. @asyncUnsafe */
  private async $getVergeIndexedTransaction(txid: string): Promise<IBitcoinApi.Transaction> {
    this.assertChainVerified();
    if (!/^[a-f\d]{64}$/i.test(txid)) { throw new Error('Invalid Verge transaction ID'); }
    const rest = new URL(config.ESPLORA.REST_API_URL);
    if (rest.protocol !== 'http:' || rest.hostname !== '127.0.0.1' || !rest.port || rest.username || rest.password) {
      throw new Error('Verge indexed REST API must use a local loopback HTTP listener');
    }
    const statusUrl = new URL(`/tx/${txid}/status`, rest);
    let status;
    try {
      ({ data: status } = await axios.get(statusUrl.href, { timeout: 5000, proxy: false, maxRedirects: 0 }));
    } catch (error) {
      if ((error as { response?: { status?: number } }).response?.status === 404) {
        throw new Error('No such mempool or blockchain transaction');
      }
      throw error;
    }
    if (status?.confirmed === false) { throw new Error('No such mempool or blockchain transaction'); }
    if (status?.confirmed !== true || !Number.isSafeInteger(status.block_height) || status.block_height < 0 ||
        typeof status.block_hash !== 'string' || !/^[a-f\d]{64}$/i.test(status.block_hash)) {
      throw new Error('Verge indexed transaction has no valid canonical block location');
    }
    const blockhash = await this.bitcoindClient.getBlockHash(status.block_height);
    if (blockhash !== status.block_hash) { throw new Error('Verge indexed transaction block diverges from Core'); }
    if (status.block_height === 0) {
      const genesis = await this.bitcoindClient.getBlock(blockhash, 2);
      if (genesis.hash !== blockhash || genesis.tx[0]?.txid !== txid) {
        throw new Error('Verge genesis transaction disagrees with Core');
      }
      return { ...genesis.tx[0], confirmations: genesis.confirmations, blockhash, blocktime: genesis.time };
    }
    const transaction = await this.bitcoindClient.getRawTransaction(txid, true, blockhash);
    if (transaction.txid !== txid || transaction.in_active_chain === false ||
        await this.bitcoindClient.getBlockHash(status.block_height) !== blockhash) {
      throw new Error('Verge indexed transaction block changed; refresh the transaction');
    }
    return transaction;
  }

  /** @asyncUnsafe */
  protected async $getPrevoutTransaction(txid: string): Promise<Pick<IEsploraApi.Transaction, 'vout'>> {
    try { return await super.$getPrevoutTransaction(txid); }
    catch (error) {
      if (!isVerge || (error as { code?: number }).code !== -5) { throw error; }
      const hex: string = await this.$verifiedElectrumRequest(() => this.electrumClient.blockchainTransaction_get(txid, false));
      if (decodeVergeTransaction(hex).txid !== txid) { throw new Error('Verge Electrum previous transaction ID mismatch'); }
      const metadata: IBitcoinApi.Transaction = { ...await this.bitcoindClient.decodeRawTransaction(hex), hex };
      if (metadata.txid !== txid) { throw new Error('Verge Electrum previous transaction ID mismatch'); }
      const decoded = this.$decodeVergeRpcTransaction(metadata);
      return { vout: this.$convertTransactionOutputs(metadata, decoded) };
    }
  }

  private encodeScriptHash(scriptPubKey: string): string {
    return scriptHashForElectrum(scriptPubKey);
  }

  private assertChainVerified(): void {
    if (!this.chainVerified) { throw new Error('Verge Electrum connection has not passed its network identity check'); }
  }

  /** @asyncUnsafe */
  private async $verifiedElectrumRequest<T>(request: () => Promise<T>): Promise<T> {
    this.assertChainVerified();
    const generation = this.connectionGeneration;
    await this.$assertVergeElectrumTip();
    const result = await request();
    if (isVerge && (generation !== this.connectionGeneration || !this.chainVerified)) {
      throw new Error('Verge Electrum connection changed during the request; retry');
    }
    return result;
  }

  /** @asyncUnsafe */
  private async $assertVergeElectrumTip(): Promise<void> {
    if (!isVerge || Date.now() < this.tipVerifiedUntil) { return; }
    if (this.tipCheck) { return this.tipCheck; }
    const generation = this.connectionGeneration;
    const check = this.$validateVergeElectrumTip(generation);
    this.tipCheck = check;
    try { await check; } finally { if (this.tipCheck === check) { this.tipCheck = undefined; } }
  }

  /** @asyncUnsafe */
  private async $validateVergeElectrumTip(generation: number): Promise<void> {
    const maximumLag = config.ELECTRUM.MAX_BEHIND_TIP;
    if (!Number.isSafeInteger(maximumLag) || maximumLag < 0) { throw new Error('ELECTRUM.MAX_BEHIND_TIP must be a nonnegative integer'); }
    const tip = await this.electrumClient.request('blockchain.headers.subscribe', []);
    if (!Number.isSafeInteger(tip?.height) || tip.height < 0 || typeof tip.hex !== 'string') { throw new Error('Invalid Verge Electrum tip'); }
    const header = decodeVergeHeader(tip.hex);
    const height = await this.bitcoindClient.getBlockCount();
    if (tip.height > height || height - tip.height > maximumLag) { throw new Error('Verge Electrum index is not synchronized with Core'); }
    if (await this.bitcoindClient.getBlockHash(tip.height) !== header.id) { throw new Error('Verge Electrum tip diverges from Core'); }
    if (generation !== this.connectionGeneration || !this.chainVerified) { throw new Error('Verge Electrum connection changed during tip validation'); }
    this.tipHash = header.id;
    this.tipVerifiedUntil = Date.now() + 1000;
  }

}

export default BitcoindElectrsApi;
