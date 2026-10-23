import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { importWithDependencies } from './module-harness';
import { coinToAtomicNumber } from '../../api/verge/amounts';
import { decodeVergeTransaction } from '../../api/verge/codec';
import { vergeProfile } from '../../api/verge/chain-profile';
import { assertElectrumTlsPeer } from '../../api/verge/electrum-tls';
import { createHash } from 'node:crypto';
import type { PeerCertificate } from 'node:tls';

const fixtures = require('../../__fixtures__/verge/testnet-blocks.json');
const posFixtures = require('../../__fixtures__/verge/regtest-spends.json');

function coreAdapter(client: any, verge = true) {
  const spending = new Map();
  const api = importWithDependencies(resolve(__dirname, '../../api/bitcoin/bitcoin-api.ts'), {
    '../blocks': { getBlocks: () => [], getCurrentBlockHeight: () => 9999 },
    '../mempool': { getMempool: () => ({}), isInSync: () => true, getSpendMap: () => spending },
    '../transaction-utils': { convertScriptSigAsm: (hex: string) => hex, addInnerScriptsToVin: () => {} },
    '../common': { Common: { getTransactionFlags: () => 0 } },
    '../../indexer': { isCoreIndexReady: () => null },
    '../verge/runtime': { isVerge: verge, rpcCoinToAtomic: verge ? coinToAtomicNumber : (value: number) => Math.round(value * 100000000) },
  }).default;
  return { api: new api(client), spending };
}

async function electrumAdapter(core: any, options: any = {}) {
  const { api: base } = coreAdapter(core);
  const cache = new Map();
  let client: any;
  let featureCalls = 0;
  const profile = vergeProfile('testnet');
  class ElectrumDouble {
    callbacks: any;
    conn = { _socket: options.tlsPeer };
    closed = false;
    constructor(_port: number, _host: string, _protocol: string, _options: unknown, callbacks: any) { this.callbacks = callbacks; client = this; }
    initElectrum() { queueMicrotask(() => this.callbacks.onConnect(this, ['unit-test', '1.4'])); return Promise.resolve(); }
    server_features() { featureCalls++; return options.features ? options.features() : Promise.resolve({ genesis_hash: profile.genesis }); }
    request() { return options.tip ? options.tip() : Promise.resolve({ height: 1, hex: fixtures.blocks[1].header }); }
    blockchainScripthash_getHistory(hash: string) { return options.history ? options.history(hash) : Promise.resolve([]); }
    blockchainScripthash_getBalance(hash: string) { return options.balance ? options.balance(hash) : Promise.resolve({ confirmed: 0, unconfirmed: 0 }); }
    blockchainScripthash_listunspent(hash: string) { return options.utxos ? options.utxos(hash) : Promise.resolve([]); }
    blockchainTransaction_get(txid: string) { return options.raw(txid); }
    blockchainTransaction_getMerkle(txid: string, height: number) { return options.merkle(txid, height); }
    close() { this.closed = true; this.callbacks.onClose(this); }
  }
  const apiClass = importWithDependencies(resolve(__dirname, '../../api/bitcoin/electrum-api.ts'), {
    '../../config': {
      ELECTRUM: { HOST: 'electrum.verge.test', PORT: 50002, TLS_ENABLED: options.tls ?? false, TLS_CERTIFICATE_FINGERPRINT: options.pin ?? '', MAX_BEHIND_TIP: options.maximumLag ?? 0 },
      ESPLORA: { REST_API_URL: options.restUrl ?? 'http://127.0.0.1:3001' },
    },
    'axios': { get: options.restStatus ?? (async () => { throw new Error('Unexpected indexed REST lookup'); }) },
    '@mempool/electrum-client': ElectrumDouble,
    './bitcoin-api': base.constructor,
    '../../logger': { info: () => {}, err: () => {}, debug: () => {} },
    '../verge/runtime': { isVerge: true, activeVergeProfile: profile },
    '../loading-indicators': { setProgress: () => {} },
    '../memory-cache': { get: (type: string, key: string) => cache.get(`${type}:${key}`), set: (type: string, key: string, value: any) => cache.set(`${type}:${key}`, value) },
  }).default;
  const api = new apiClass({ getBlockCount: async () => 1, getBlockHash: async () => fixtures.blocks[1].block.hash, ...core });
  await new Promise<void>(done => setImmediate(done));
  return { api, client, featureCalls: () => featureCalls };
}

test('Core adapter uses raw XVG amounts/time and confirming block height rather than the cached tip', async () => {
  const fixture = fixtures.blocks[1];
  const tx = { ...fixture.block.tx[0], confirmations: 1, blockhash: fixture.block.hash, blocktime: fixture.block.time };
  const { api } = coreAdapter({ getRawTransaction: async () => tx, getBlockHeader: async () => fixture.block });
  const result = await api.$getRawTransaction(tx.txid);
  assert.equal(result.status.block_height, fixture.block.height);
  assert.equal(result.status.confirmed, true);
  assert.equal(result.time, decodeVergeTransaction(tx.hex).time);
  assert.equal(result.vout[0].value, coinToAtomicNumber(tx.vout[0].value));
});

test('Core block transaction lists do not mark an orphaned block as confirmed', async () => {
  const fixture = fixtures.blocks[1];
  const block = { ...fixture.block, confirmations: -1 };
  const { api } = coreAdapter({ getBlock: async () => block });
  const transactions = await api.$getTxsForBlock(block.hash);
  assert.equal(transactions.length, block.tx.length);
  assert.deepEqual(transactions[0].status, { confirmed: false });
});

test('Core block ingestion can parse fully spent transactions without a historical prevout index', async () => {
  const block = { ...posFixtures.blocks[0].block, confirmations: 1 };
  let headerReads = 0;
  const { api } = coreAdapter({ getBlock: async () => block, getBlockHeader: async () => { headerReads++; return block; } });
  const transactions = await api.$getTxsForBlock(block.hash, false, false);
  assert.equal(transactions.length, block.tx.length);
  assert.equal(transactions[1].txid, block.tx[1].txid);
  assert.equal(transactions[1].vin[0].prevout, null);
  assert.equal(transactions[1].status.block_height, block.height);
  assert.equal(headerReads, 1, 'Recheck canonical status once per block, not once per transaction');
});

test('verified Verge prevout outputs remain usable after confirmation and cannot be mutated by a caller', async () => {
  const tx = fixtures.blocks[1].block.tx[0];
  let reads = 0;
  const { api } = coreAdapter({ getRawTransaction: async () => { reads++; if (reads > 1) { throw new Error('Historical lookup requires txindex'); } return tx; } });
  const first = await api.$getPrevoutTransaction(tx.txid);
  first.vout[0].value = 0;
  const second = await api.$getPrevoutTransaction(tx.txid);
  assert.equal(second.vout[0].value, coinToAtomicNumber(tx.vout[0].value));
  assert.equal(second.status, undefined);
  assert.equal(reads, 1);
});

test('Core block ingestion drops confirmations when the block becomes stale during conversion', async () => {
  const block = { ...posFixtures.blocks[0].block, confirmations: 1 };
  const { api } = coreAdapter({ getBlock: async () => block, getBlockHeader: async () => ({ ...block, confirmations: -1 }) });
  const transactions = await api.$getTxsForBlock(block.hash, false, false);
  assert.ok(transactions.every((tx: any) => tx.status.confirmed === false));
});

test('Core prevout retrieval rejects a valid transaction whose ID differs from the requested parent', async () => {
  const { api } = coreAdapter({ getRawTransaction: async () => fixtures.blocks[1].block.tx[0] });
  await assert.rejects(api.$getPrevoutTransaction('f'.repeat(64)), /previous transaction ID mismatch/);
});

test('Core adapter does not keep a confirmation if the confirming block became stale during lookup', async () => {
  const fixture = fixtures.blocks[1];
  const tx = { ...fixture.block.tx[0], confirmations: 1, blockhash: fixture.block.hash, blocktime: fixture.block.time };
  const { api } = coreAdapter({ getRawTransaction: async () => tx, getBlockHeader: async () => ({ ...fixture.block, confirmations: -1 }) });
  assert.deepEqual((await api.$getRawTransaction(tx.txid)).status, { confirmed: false });
});

test('Core adapter rejects RPC input metadata inconsistent with the timestamped raw transaction', async () => {
  const tx = structuredClone(posFixtures.blocks[0].block.tx[1]);
  tx.vin[0].vout++;
  const { api } = coreAdapter({ getRawTransaction: async () => tx });
  await assert.rejects(api.$getRawTransaction(tx.txid), /metadata disagree/);
});

test('Core outspend fallback reports a mempool spender without inventing confirmation', async () => {
  const fixture = fixtures.blocks[1];
  const tx = { ...fixture.block.tx[0], confirmations: 1, blockhash: fixture.block.hash, blocktime: fixture.block.time };
  const { api, spending } = coreAdapter({ getRawTransaction: async () => tx, getTxOut: async () => null, getMempoolEntry: async () => ({ size: 200 }) });
  spending.set(`${tx.txid}:0`, { txid: 'a'.repeat(64), vin: [{ txid: tx.txid, vout: 0 }] });
  assert.deepEqual(await api.$getOutspend(tx.txid, 0), { spent: true, txid: 'a'.repeat(64), vin: 0, status: { confirmed: false } });
});

test('Core outspend fallback checks output existence and does not classify OP_RETURN burns as spent', async () => {
  const fixture = posFixtures.blocks[0];
  const tx = fixture.block.tx[0];
  const index = tx.vout.findIndex((output: any) => output.scriptPubKey.hex.startsWith('6a'));
  assert.ok(index >= 0);
  const { api } = coreAdapter({ getRawTransaction: async () => tx, getTxOut: async () => null });
  assert.deepEqual(await api.$getOutspend(tx.txid, index), { spent: false });
  await assert.rejects(api.$getOutspend(tx.txid, tx.vout.length), /output index/);
});

test('Core coinbase lookup uses block data without requiring txindex', async () => {
  const fixture = fixtures.blocks[1];
  const { api } = coreAdapter({ getBlock: async () => fixture.block, getBlockHeader: async () => fixture.block });
  const transaction = await api.$getCoinbaseTx(fixture.block.hash);
  assert.equal(transaction.txid, fixture.block.tx[0].txid);
  assert.equal(transaction.status.block_height, fixture.block.height);
});

test('Core outspend fallback does not reuse a spender evicted from the node mempool', async () => {
  const tx = fixtures.blocks[1].block.tx[0];
  const { api, spending } = coreAdapter({ getRawTransaction: async () => tx, getTxOut: async () => null, getMempoolEntry: async () => { throw Object.assign(new Error('Not in mempool'), { code: -5 }); } });
  spending.set(`${tx.txid}:0`, { txid: 'a'.repeat(64), vin: [{ txid: tx.txid, vout: 0 }] });
  assert.deepEqual(await api.$getOutspend(tx.txid, 0), { spent: true });
});

test('the Bitcoin profile retains its upstream amount scale and does not use the Verge decoder', async () => {
  const tx = { hex: '00', txid: 'b'.repeat(64), version: 1, locktime: 0, size: 100, weight: 400, confirmations: 2, blockhash: 'c'.repeat(64), blocktime: 123,
    vin: [{ coinbase: '01', sequence: 0xffffffff }], vout: [{ value: 1, scriptPubKey: { hex: '', type: 'nonstandard' } }] };
  const { api } = coreAdapter({ getRawTransaction: async () => tx }, false);
  const transaction = await api.$getRawTransaction(tx.txid);
  assert.equal(transaction.vout[0].value, 100000000);
  assert.equal(transaction.time, undefined);
  assert.equal(transaction.status.block_height, 9998);
});

test('Electrum confirmed address history uses the Core block-hash hint without a local txindex', async () => {
  const fixture = fixtures.blocks[1];
  const transaction = { ...fixture.block.tx[0], confirmations: 1, blockhash: fixture.block.hash, blocktime: fixture.block.time };
  const calls: unknown[][] = [];
  const { api } = await electrumAdapter({
    getBlockHash: async () => fixture.block.hash,
    getBlockHeader: async () => fixture.block,
    getRawTransaction: async (...params: unknown[]) => {
      calls.push(params);
      if (params[2] !== fixture.block.hash) { throw Object.assign(new Error('Use -txindex'), { code: -5 }); }
      return transaction;
    },
  }, { history: async () => [{ tx_hash: transaction.txid, height: 1 }] });
  const transactions = await api.$getScriptHashTransactions('a'.repeat(64));
  assert.equal(transactions[0].txid, transaction.txid);
  assert.equal(transactions[0].status.block_height, 1);
  assert.deepEqual(calls[0], [transaction.txid, true, fixture.block.hash]);
  assert.equal(await api.$getTransactionHex(transaction.txid), transaction.hex);
});

test('Electrum direct historical transaction lookup uses the local index and a canonical Core block hint', async () => {
  const fixture = fixtures.blocks[1];
  const transaction = { ...fixture.block.tx[0], confirmations: 1, blockhash: fixture.block.hash, blocktime: fixture.block.time };
  const calls: unknown[][] = [];
  let statusQueries = 0;
  const { api } = await electrumAdapter({
    getBlockHash: async () => fixture.block.hash,
    getBlockHeader: async () => fixture.block,
    getRawTransaction: async (...params: unknown[]) => {
      calls.push(params);
      if (!params[2]) { throw Object.assign(new Error('Use -txindex'), { code: -5 }); }
      return transaction;
    },
  }, { restStatus: async (url: string, options: { timeout: number; proxy: boolean; maxRedirects: number }) => {
    statusQueries++;
    assert.equal(url, `http://127.0.0.1:3001/tx/${transaction.txid}/status`);
    assert.equal(options.timeout, 5000);
    assert.equal(options.proxy, false);
    assert.equal(options.maxRedirects, 0);
    return { data: { confirmed: true, block_height: 1, block_hash: fixture.block.hash } };
  } });
  const result = await api.$getRawTransaction(transaction.txid);
  assert.equal(result.txid, transaction.txid);
  assert.equal(result.status.block_height, 1);
  assert.equal(statusQueries, 1);
  assert.deepEqual(calls, [[transaction.txid, true], [transaction.txid, true, fixture.block.hash]]);
});

test('Electrum direct lookup refuses a stale index block and never uses its Core hint', async () => {
  const transaction = fixtures.blocks[1].block.tx[0];
  const calls: unknown[][] = [];
  const { api } = await electrumAdapter({
    getBlockHash: async () => fixtures.blocks[1].block.hash,
    getRawTransaction: async (...params: unknown[]) => {
      calls.push(params);
      throw Object.assign(new Error('Use -txindex'), { code: -5 });
    },
  }, { restStatus: async () => ({ data: { confirmed: true, block_height: 1, block_hash: 'f'.repeat(64) } }) });
  await assert.rejects(api.$getRawTransaction(transaction.txid), /diverges from Core/);
  assert.deepEqual(calls, [[transaction.txid, true]]);
});

test('Electrum direct lookup reports an unknown indexed transaction as absent', async () => {
  const txid = 'f'.repeat(64);
  const { api } = await electrumAdapter({
    getRawTransaction: async () => { throw Object.assign(new Error('Use -txindex'), { code: -5 }); },
  }, { restStatus: async () => { throw Object.assign(new Error('Not Found'), { response: { status: 404 } }); } });
  await assert.rejects(api.$getRawTransaction(txid), /No such mempool or blockchain transaction/);
  const absent = await electrumAdapter({
    getRawTransaction: async () => { throw Object.assign(new Error('Use -txindex'), { code: -5 }); },
  }, { restStatus: async () => ({ data: { confirmed: false } }) });
  await assert.rejects(absent.api.$getRawTransaction(txid), /No such mempool or blockchain transaction/);
});

test('Electrum direct lookup reconstructs the canonical genesis coinbase from Core block data', async () => {
  const genesis = fixtures.blocks[0].block;
  const txid = genesis.tx[0].txid;
  let hintedRawCalls = 0;
  const { api } = await electrumAdapter({
    getBlockHash: async (height: number) => { assert.equal(height, 0); return genesis.hash; },
    getBlock: async (hash: string) => { assert.equal(hash, genesis.hash); return genesis; },
    getBlockHeader: async () => genesis,
    getRawTransaction: async () => { hintedRawCalls++; throw Object.assign(new Error('Use -txindex'), { code: -5 }); },
  }, { restStatus: async () => ({ data: { confirmed: true, block_height: 0, block_hash: genesis.hash } }) });
  const result = await api.$getRawTransaction(txid);
  assert.equal(result.txid, txid);
  assert.equal(result.status.block_height, 0);
  assert.equal(result.status.block_hash, genesis.hash);
  assert.equal(hintedRawCalls, 1, 'Core genesis raw transaction is unavailable even with a block hint');
});

test('Electrum direct lookup preserves Core transport errors and requires a loopback index', async () => {
  const transaction = fixtures.blocks[1].block.tx[0];
  let statusQueries = 0;
  const { api } = await electrumAdapter({
    getRawTransaction: async () => { throw Object.assign(new Error('Core timeout'), { code: 'ETIMEDOUT' }); },
  }, { restStatus: async () => { statusQueries++; return { data: {} }; } });
  await assert.rejects(api.$getRawTransaction(transaction.txid), /Core timeout/);
  assert.equal(statusQueries, 0);
  const unsafe = await electrumAdapter({
    getRawTransaction: async () => { throw Object.assign(new Error('Use -txindex'), { code: -5 }); },
  }, { restUrl: 'https://remote.example:3001', restStatus: async () => { statusQueries++; return { data: {} }; } });
  await assert.rejects(unsafe.api.$getRawTransaction(transaction.txid), /local loopback/);
  assert.equal(statusQueries, 0);
});

test('Electrum prevout fallback verifies raw IDs and uses Core decoding without inventing confirmation or fees', async () => {
  const transaction = fixtures.blocks[1].block.tx[0];
  let decodes = 0;
  const { api } = await electrumAdapter({
    getRawTransaction: async () => { throw Object.assign(new Error('Use -txindex'), { code: -5 }); },
    decodeRawTransaction: async () => { decodes++; const { hex, ...metadata } = transaction; return metadata; },
  }, { raw: async () => transaction.hex });
  const previous = await api.$getPrevoutTransaction(transaction.txid);
  assert.equal(previous.vout[0].value, coinToAtomicNumber(transaction.vout[0].value));
  assert.equal(previous.status, undefined);
  assert.equal(previous.fee, undefined);
  assert.equal(decodes, 1);
  await assert.rejects(api.$getPrevoutTransaction('b'.repeat(64)), /previous transaction ID mismatch/);
  assert.equal(decodes, 1);
});

test('Electrum fallback does not mask Core transport errors', async () => {
  let rawCalls = 0;
  const { api } = await electrumAdapter({ getRawTransaction: async () => { throw Object.assign(new Error('Core timeout'), { code: 'ETIMEDOUT' }); } }, {
    raw: async () => { rawCalls++; return ''; },
  });
  await assert.rejects(api.$getPrevoutTransaction('a'.repeat(64)), /Core timeout/);
  assert.equal(rawCalls, 0);
});

test('Electrum TLS identity requires a trusted matching hostname or an explicit matching certificate pin', () => {
  const certificate = { raw: Buffer.from('public test certificate'), subjectaltname: 'DNS:electrum.verge.test' } as PeerCertificate;
  const socket = { authorized: true, getPeerCertificate: () => certificate };
  assert.doesNotThrow(() => assertElectrumTlsPeer(socket, 'electrum.verge.test'));
  assert.throws(() => assertElectrumTlsPeer(socket, 'different.verge.test'), /untrusted or does not match/);
  socket.authorized = false;
  assert.throws(() => assertElectrumTlsPeer(socket, 'electrum.verge.test'), /untrusted or does not match/);
  const pin = createHash('sha256').update(certificate.raw).digest('hex');
  assert.doesNotThrow(() => assertElectrumTlsPeer(socket, 'electrum.verge.test', pin));
  assert.doesNotThrow(() => assertElectrumTlsPeer(socket, 'electrum.verge.test', pin.match(/../g)!.join(':').toUpperCase()));
  assert.throws(() => assertElectrumTlsPeer(socket, 'electrum.verge.test', '0'.repeat(64)), /fingerprint mismatch/);
  assert.throws(() => assertElectrumTlsPeer(socket, 'electrum.verge.test', 'invalid'), /SHA256 fingerprint/);
});

test('Electrum TLS failure closes the connection before features or address queries', async () => {
  const { api, client, featureCalls } = await electrumAdapter({}, { tls: true });
  assert.equal(client.closed, true);
  assert.equal(featureCalls(), 0);
  await assert.rejects(api.$getScriptHash('a'.repeat(64)), /identity check/);
});

test('a failed identity check from an old Electrum connection does not close a verified reconnect', async () => {
  let rejectOld!: (error: Error) => void;
  let calls = 0;
  const { api, client } = await electrumAdapter({}, { features: () => ++calls === 1 ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve({ genesis_hash: vergeProfile('testnet').genesis }) });
  client.callbacks.onClose(client);
  client.callbacks.onConnect(client, ['unit-test', '1.4']);
  await new Promise<void>(done => setImmediate(done));
  rejectOld(new Error('Old connection lost'));
  await new Promise<void>(done => setImmediate(done));
  assert.equal(client.closed, false);
  assert.equal((await api.$getScriptHash('a'.repeat(64))).electrum, true);
});

test('an in-flight Electrum result is rejected after disconnection', async () => {
  let finish!: (value: any) => void;
  const { api, client } = await electrumAdapter({}, { history: () => new Promise(resolve => { finish = resolve; }) });
  const query = api.$getScriptHashTransactions('a'.repeat(64));
  await new Promise<void>(done => setImmediate(done));
  client.callbacks.onClose(client);
  finish([]);
  await assert.rejects(query, /connection changed/);
});

test('Electrum merkle proofs are checked against Core instead of returned unchecked', async () => {
  const fixture = fixtures.blocks[1];
  const tx = { ...fixture.block.tx[0], confirmations: 1, blockhash: fixture.block.hash, blocktime: fixture.block.time };
  let proof = { block_height: 1, merkle: [] as string[], pos: 0 };
  const { api } = await electrumAdapter({ getRawTransaction: async () => tx, getBlockHeader: async (_hash: string, verbose: boolean) => verbose ? fixture.block : fixture.header, getBlockHash: async () => fixture.block.hash }, {
    merkle: async () => proof,
  });
  assert.deepEqual(await api.$getTransactionMerkleProof(tx.txid), proof);
  proof = { ...proof, merkle: ['0'.repeat(64)] };
  await assert.rejects(api.$getTransactionMerkleProof(tx.txid), /does not match/);
});

test('Electrum tip checks coalesce and a lagging server can recover without restarting the connection', async () => {
  let height = 2;
  let tipCalls = 0;
  const { api, client } = await electrumAdapter({ getBlockCount: async () => height }, { tip: async () => { tipCalls++; return { height: 1, hex: fixtures.blocks[1].header }; } });
  await assert.rejects(api.$getScriptHash('a'.repeat(64)), /not synchronized/);
  assert.equal(client.closed, false);
  height = 1;
  await Promise.all([api.$getScriptHash('a'.repeat(64)), api.$getScriptHash('b'.repeat(64))]);
  assert.equal(tipCalls, 2);
  const diverged = await electrumAdapter({ getBlockHash: async () => '0'.repeat(64) });
  await assert.rejects(diverged.api.$getScriptHash('a'.repeat(64)), /diverges/);
});
