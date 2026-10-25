import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { coinToAtomic, coinToAtomicNumber, atomicToCoin, parseVergeRpcJson } from '../../api/verge/amounts';
import { vergeProfile, vergeAlgorithm } from '../../api/verge/chain-profile';
import { decodeVergeBlock, decodeVergeHeader, decodeVergeTransaction, decodeVergePowBlock, POS_TRANSACTION_VERSION, POS_REPLAY_MARKER } from '../../api/verge/codec';
import { verifyVergeRpc, adaptVergeRpcClient } from '../../api/verge/rpc';
import { scriptHashForElectrum, compareElectrumHistory, electrumCursorStart, assertElectrumGenesis } from '../../api/verge/electrum-utils';
import { getVergeMiningStatistics } from '../../api/verge/mining';
import { probeElectrum, verifyElectrumMerkle, connectElectrumProbe } from '../../api/verge/electrum-probe';
import { createServer } from 'node:net';
import { reconcileVergeBlockCache } from '../../api/verge/block-cache';
import { getVergeFeePolicy } from '../../api/verge/fee-policy';
import { getVergeBlockStats } from '../../api/verge/block-stats';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';

const fixtures = require('../../__fixtures__/verge/testnet-blocks.json');
const mainnet = require('../../__fixtures__/verge/mainnet-blocks.json');
const regtest = require('../../__fixtures__/verge/regtest-blocks.json');
const regtestSpends = require('../../__fixtures__/verge/regtest-spends.json');

const basicBlockStats = { avgtxsize: 200, ins: 1, outs: 3, swtxs: 0, swtotal_size: 0, swtotal_weight: 0, total_out: 4000000, utxo_increase: 2 };

test('Verge block statistics retry only the index-independent fields when Core requires txindex', async () => {
  const calls: unknown[][] = [];
  const extras = await getVergeBlockStats({ getBlockStats: async (...args: unknown[]) => {
    calls.push(args);
    if (args[1] === undefined) { throw Object.assign(new Error('One or more of the selected stats requires -txindex enabled'), { code: -8 }); }
    return basicBlockStats;
  } }, { id: 'a'.repeat(64) });
  assert.equal(extras.feeStatsAvailable, false);
  assert.equal(extras.totalFees, undefined);
  assert.equal(extras.medianFee, undefined);
  assert.equal(extras.feeRange, undefined);
  assert.equal(extras.avgTxSize, 200);
  assert.equal(extras.totalOutputAmt, 4000000);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1], ['avgtxsize', 'ins', 'outs', 'swtxs', 'swtotal_size', 'swtotal_weight', 'total_out', 'utxo_increase']);
});

test('Verge block statistics retain atomic units and Core fee bounds without invented percentiles', async () => {
  const extras = await getVergeBlockStats({ getBlockStats: async () => ({ ...basicBlockStats, totalfee: 200000, avgfee: 200000, avgfeerate: 1000, medianfeerate: 1000, minfeerate: 1000, maxfeerate: 1000 }) }, { id: 'a'.repeat(64) });
  assert.equal(extras.feeStatsAvailable, true);
  assert.equal(extras.totalFees, 200000);
  assert.equal(extras.avgFee, 200000);
  assert.equal(extras.medianFee, 1000);
  assert.deepEqual(extras.feeRange, [1000, 1000]);
});

test('Verge optional block statistics do not swallow RPC outages or unsafe amounts', async () => {
  for (const error of [new Error('Connection refused'), Object.assign(new Error('Invalid selected statistic'), { code: -8 })]) {
    await assert.rejects(getVergeBlockStats({ getBlockStats: async () => { throw error; } }, { id: 'a'.repeat(64) }), error);
  }
  await assert.rejects(getVergeBlockStats({ getBlockStats: async () => ({ ...basicBlockStats, total_out: '9007199254740993' }) }, { id: 'a'.repeat(64) }), /numeric API range/);
});

test('Verge stale blocks do not reuse canonical fee statistics', async () => {
  const extras = await getVergeBlockStats({ getBlockStats: async () => { throw new Error('Must not query stale block statistics'); } }, { id: 'a'.repeat(64), stale: true });
  assert.deepEqual(extras, { feeStatsAvailable: false });
});

test('XVG decimal amounts preserve individual base units above the JavaScript integer range', () => {
  assert.equal(coinToAtomic('16555000000.000000'), 16555000000000000n);
  assert.equal(coinToAtomic('9007199254.740993'), 9007199254740993n);
  assert.equal(coinToAtomic('1e-6'), 1n);
  assert.equal(coinToAtomic('-0.000001'), -1n);
  assert.equal(coinToAtomic('0.200000') / 1000n, 200n);
  assert.equal(atomicToCoin(9007199254740993n), '9007199254.740993');
  assert.throws(() => coinToAtomic('0.0000001'), /fractional base/);
  assert.throws(() => coinToAtomic('NaN'), /Invalid/);
  assert.throws(() => coinToAtomicNumber('9007199254.740993'), /numeric API range/);
});

test('RPC JSON preserves decimal money before decoding and does not rewrite quoted script text', () => {
  const raw = '{"result":{"value":9007199254.740993,"difficulty":1.25,"size":256,"sum":9007199254740993,"asm":"value: 3.14159 \\\"fee\\\": 42","fees":{"base":0.200000}},"id":1}';
  const parsed = parseVergeRpcJson(raw);
  assert.equal(parsed.result.value, '9007199254.740993');
  assert.equal(parsed.result.fees.base, '0.200000');
  assert.equal(parsed.result.difficulty, 1.25);
  assert.equal(parsed.result.sum, '9007199254740993');
  assert.equal(parsed.result.asm, JSON.parse(raw).result.asm);
  assert.equal(parsed.result.size, 256);
  assert.throws(() => parseVergeRpcJson('{"value":01}'));
});

test('Verge network and algorithm identifiers follow the Core source mapping', () => {
  assert.equal(vergeProfile('mainnet').pubkeyHash, 0x1e);
  assert.equal(vergeProfile('testnet').scriptHash, 0xc6);
  assert.throws(() => vergeProfile('signet'), /Unsupported/);
  assert.deepEqual([0x0800, 0x1800, 0x5000, 0x2000, 0x1000].map(vergeAlgorithm), ['scrypt', 'x17', 'lyra2rev2', 'blake2s', 'myriad-groestl']);
});

for (const fixture of fixtures.blocks) {
  test(`real testnet block ${fixture.block.height}: canonical ID, transactions, signature and full byte consumption`, () => {
    const decoded = decodeVergePowBlock(fixture.raw);
    const block = fixture.block;
    assert.equal(decoded.id, block.hash);
    assert.equal(decoded.size, block.size);
    assert.equal(decoded.weight, block.weight);
    assert.equal(decoded.signature, block.signature);
    assert.equal(decoded.tx_count, block.nTx);
    for (let i = 0; i < decoded.tx.length; i++) {
      assert.equal(decoded.tx[i].txid, block.tx[i].txid);
      assert.equal(decoded.tx[i].time, block.tx[i].time);
      assert.equal(decoded.tx[i].hex, block.tx[i].hex);
      assert.equal(decoded.tx[i].vout[0].value, coinToAtomic(String(block.tx[i].vout[0].value)));
    }
    assert.equal(decodeVergeHeader(fixture.header).id, block.hash);
    assert.equal(decodeVergeTransaction(block.tx[0].hex).txid, block.tx[0].txid);
    assert.throws(() => decodeVergePowBlock(fixture.raw + '00'), /Unexpected block data/);
    assert.throws(() => decodeVergePowBlock(fixture.raw.slice(0, -2)), /Truncated/);
  });
}

test('legacy transaction parser rejects incorrect CompactSize, bad hex and trailing bytes', () => {
  const hex = fixtures.blocks[0].block.tx[0].hex;
  assert.throws(() => decodeVergeTransaction(hex.slice(0, 16) + 'fd0100' + hex.slice(18)), /Noncanonical/);
  assert.throws(() => decodeVergeTransaction(hex + '00'), /Unexpected/);
  assert.throws(() => decodeVergeTransaction('0z'), /Invalid Verge hex/);
});

for (const fixture of mainnet.blocks) {
  test(`real mainnet ${fixture.algorithm}: Scrypt block ID matches an independent child header link`, () => {
    const decoded = decodeVergePowBlock(fixture.raw);
    const referencedId = Buffer.from(fixture.child_header, 'hex').subarray(4, 36).reverse().toString('hex');
    assert.equal(decoded.id, referencedId);
    assert.equal(decoded.id, fixture.hash);
    const preciseNames: Record<string, string> = { lyra2re: 'lyra2rev2', blake: 'blake2s', groestl: 'myriad-groestl' };
    const preciseName = preciseNames[fixture.algorithm] ?? fixture.algorithm;
    assert.equal(decoded.algo, preciseName);
    assert.equal(decoded.size * 2, fixture.raw.length);
    assert.ok(decoded.signature.length > 0);
  });
}

test('real mainnet ordinary spends retain input outpoints, scripts and transaction merkle commitments', () => {
  const block = decodeVergePowBlock(mainnet.multi_transaction_block.raw);
  assert.equal(block.tx_count, mainnet.multi_transaction_block.transactions);
  const spend = block.tx.find(tx => !tx.vin[0].is_coinbase)!;
  assert.ok(spend);
  assert.ok(spend.vin.every(input => input.txid !== '0'.repeat(64)));
  assert.ok(spend.vout.every(output => output.value >= 0n));
  assert.equal(decodeVergeTransaction(spend.hex).txid, spend.txid);
});

test('synthetic PoS replay transaction verifies marker position and includes marker/timestamp in txid', () => {
  const legacy = fixtures.blocks[0].block.tx[0].hex;
  const prefix = Buffer.alloc(12);
  prefix.writeInt32LE(POS_TRANSACTION_VERSION);
  prefix.writeUInt32LE(12345, 4);
  prefix.writeUInt32LE(POS_REPLAY_MARKER, 8);
  const hex = prefix.toString('hex') + legacy.slice(16);
  const parsed = decodeVergeTransaction(hex);
  const bytes = Buffer.from(hex, 'hex');
  const expected = createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest().reverse().toString('hex');
  assert.equal(parsed.txid, expected);
  assert.equal(parsed.time, 12345);
  assert.throws(() => decodeVergeTransaction(hex.slice(0, 16) + '01000000' + hex.slice(24)), /replay marker/);
});

test('PoS header parsing is version/length-aware, while PoW body decoder refuses an unsupported extension', () => {
  const header = Buffer.alloc(112);
  header.writeInt32LE(0x8002);
  assert.equal(decodeVergeHeader(header.toString('hex')).proof, 'pos');
  assert.throws(() => decodeVergeHeader(header.subarray(0, 80).toString('hex')), /Truncated/);
  assert.throws(() => decodeVergePowBlock(header.toString('hex')), /PoS block extension/);
  header.writeUInt32LE(1, 72);
  assert.throws(() => decodeVergeHeader(header.toString('hex')), /Nonzero PoS/);
});

for (const fixture of regtest.blocks) {
  test(`real regtest ${fixture.block.proof} block ${fixture.block.height}: complete body, merkle root and signed extension commitment`, () => {
    const decoded = decodeVergeBlock(fixture.raw);
    assert.equal(decoded.id, fixture.block.hash);
    assert.equal(decoded.size, fixture.block.size);
    assert.equal(decoded.weight, fixture.block.weight);
    assert.equal(decoded.signature, fixture.block.signature);
    assert.equal(decoded.tx_count, fixture.block.nTx);
    assert.deepEqual(decoded.tx.map(tx => tx.txid), fixture.block.tx.map((tx: { txid: string }) => tx.txid));
    if (decoded.proof === 'pos') {
      assert.equal(decoded.posExtension!.hash, decoded.posDataHash);
      assert.equal(decoded.posExtension!.stakeProof.slot, BigInt(Math.floor(decoded.timestamp / 30)));
      assert.equal(decoded.posExtension!.votes.length, fixture.block.height === 1500 ? 0 : 1);
      assert.ok(decoded.tx.every(tx => tx.version === POS_TRANSACTION_VERSION));
      // The signature itself is part of the header commitment, even though Core validates it cryptographically.
      const changed = Buffer.from(fixture.raw, 'hex');
      const extensionOffset = changed.length - decoded.posExtension!.hex.length / 2;
      changed[extensionOffset + 1 + 295 + 273 - 1] ^= 1;
      assert.throws(() => decodeVergeBlock(changed.toString('hex')), /commitment/);
      changed[extensionOffset] = 2;
      assert.throws(() => decodeVergeBlock(changed.toString('hex')), /object version/);
      const excessiveVotes = Buffer.from(fixture.raw, 'hex');
      const votesOffset = extensionOffset + 1 + 295 + 273;
      const modified = Buffer.concat([excessiveVotes.subarray(0, votesOffset), Buffer.from('fd0104', 'hex'), excessiveVotes.subarray(votesOffset + 1)]);
      assert.throws(() => decodeVergeBlock(modified.toString('hex')), /Too many/);
    }
    assert.throws(() => decodeVergeBlock(fixture.raw + '00'), /Unexpected block data/);
    assert.throws(() => decodeVergeBlock(fixture.raw.slice(0, -2)), /Truncated/);
  });
}

function mockRpc() {
  const fixture = fixtures.blocks[1];
  return {
    getNetworkInfo: async () => ({ subversion: '/verge:test/' }),
    getBlockchainInfo: async () => ({ chain: 'test', blocks: 1, headers: 1, initialblockdownload: false }),
    getBlockCount: async () => 1,
    getBlockHash: async (height: number) => fixtures.blocks[height === 0 ? 0 : 1].block.hash,
    getBlock: async (_hash: string, verbosity = 1) => verbosity === 0 ? fixture.raw : fixture.block,
    getBlockHeader: async () => fixture.header,
    getRawTransaction: async () => fixture.block.tx[0],
    getRawMemPool: async () => [],
  };
}

test('startup checks reject the wrong chain, stale node and inconsistent raw bytes', async () => {
  const rpc = mockRpc();
  assert.equal((await verifyVergeRpc(rpc, vergeProfile('testnet'))).height, 1);
  await assert.rejects(verifyVergeRpc(rpc, vergeProfile('mainnet')), /chain\/genesis/);
  await assert.rejects(verifyVergeRpc({ ...rpc, getBlockchainInfo: async () => ({ chain: 'test', initialblockdownload: true }) }, vergeProfile('testnet')), /not synchronized/);
  await assert.rejects(verifyVergeRpc({ ...rpc, getRawTransaction: async () => ({ txid: 'f'.repeat(64), hex: '00' }) }, vergeProfile('testnet')), /raw transaction/);
});

test('legacy mempool entry normalization preserves real fee data and never invents replacement policy', async () => {
  const adapted = adaptVergeRpcClient({
    getMempoolEntry: async () => ({ size: 250, fees: { base: '0.500000' } }),
    testMempoolAccept: async () => [], sendRawTransaction: async () => '',
  });
  const entry: any = await adapted.getMempoolEntry();
  assert.equal(entry.vsize, 250);
  assert.equal(entry.weight, 1000);
  assert.equal(entry.fees.base, '0.500000');
  assert.equal(entry['bip125-replaceable'], undefined);
  await assert.rejects((adapted.testMempoolAccept as any)(['aa'], 0.1), /allowhighfees/);
  await assert.rejects((adapted.testMempoolAccept as any)(['aa', 'bb']), /exactly one/);
});

test('Electrum script hashes use the exact raw script and reversed SHA256', () => {
  assert.equal(scriptHashForElectrum(''), '55b852781b9995a44c939b64e441ae2724b96f99c8f4fb9a141cfc9842c4b0e3');
  assert.throws(() => scriptHashForElectrum('0x12'), /Invalid script/);
  assert.doesNotThrow(() => assertElectrumGenesis({ genesis_hash: vergeProfile('testnet').genesis }, vergeProfile('testnet').genesis));
  assert.throws(() => assertElectrumGenesis({ genesis_hash: vergeProfile('mainnet').genesis }, vergeProfile('testnet').genesis), /genesis/);
});

test('Electrum unconfirmed parent heights and zero-fee transactions paginate without repeating cursor zero', () => {
  const history = [{ height: 10, tx_hash: 'b' }, { height: -1, tx_hash: 'd', fee: 0 }, { height: 0, tx_hash: 'c', fee: 0 }, { height: 11, tx_hash: 'a' }].sort(compareElectrumHistory);
  assert.deepEqual(history.map(h => h.tx_hash), ['c', 'd', 'a', 'b']);
  assert.equal(electrumCursorStart(history, 'c'), 1);
  assert.equal(electrumCursorStart(history, 'b'), 4);
  assert.throws(() => electrumCursorStart(history, 'missing'), /cursor/);
});

test('mining statistics use precise names while reading Core legacy rate keys', async () => {
  const versions = [0x1000, 0x2000, 0x5000, 0x1800, 0x0800];
  const rpc = {
    getBlockCount: async () => 4,
    getBlockHash: async (height: number) => String(height),
    getBlockHeader: async (hash: string) => ({ height: Number(hash), version: versions[Number(hash)], difficulty: 100 + Number(hash) }),
    getAllNetworkHashPs: async () => ({ scrypt: 1, x17: 2, lyra2re: 3, blake2s: 4, groestl: 5 }),
  };
  const result = await getVergeMiningStatistics(rpc, 5);
  assert.equal(result.algorithms.length, 5);
  assert.deepEqual(result.algorithms.map(a => a.algorithm), ['scrypt', 'x17', 'lyra2rev2', 'blake2s', 'myriad-groestl']);
  assert.equal(result.algorithms.find(a => a.algorithm === 'lyra2rev2')?.hashrate, 3);
  assert.equal(result.algorithms.find(a => a.algorithm === 'blake2s')?.hashrate, 4);
  assert.equal(result.algorithms.find(a => a.algorithm === 'myriad-groestl')?.hashrate, 5);
  assert.equal(result.algorithms.find(a => a.algorithm === 'myriad-groestl')?.difficulty, 100);
  assert.equal(result.algorithms.find(a => a.algorithm === 'scrypt')?.lastBlockHeight, 4);
  assert.equal('totalHashrate' in result, false);
  assert.equal((await getVergeMiningStatistics(rpc, 1)).algorithms.find(a => a.algorithm === 'x17')?.difficulty, null);
});

test('PoS mining sample does not request or fabricate active PoW hashrates', async () => {
  const rpc = {
    getBlockCount: async () => 1501,
    getBlockHash: async (height: number) => String(height),
    getBlockHeader: async () => ({ version: 0x8002, proof: 'pos', height: 1501 }),
    getAllNetworkHashPs: async () => { throw new Error('PoW RPC must not be called'); },
  };
  const result = await getVergeMiningStatistics(rpc, 1);
  assert.equal(result.proof, 'pos');
  assert.equal(result.posBlocks, 1);
  assert.ok(result.algorithms.every(algo => algo.hashrate === null && algo.difficulty === null));
  await assert.rejects(getVergeMiningStatistics(rpc, 301), /sample size/);
  let calls = 0;
  await assert.rejects(getVergeMiningStatistics({ ...rpc, getBlockHash: async () => String(calls++) }, 1), /reorganized/);
});

test('Electrum probe checks genesis, exact balances, raw XVG transactions and merkle proof against Core', async () => {
  const fixture = fixtures.blocks[1];
  const tx = fixture.block.tx[0];
  const value = coinToAtomic(String(tx.vout[0].value)).toString();
  const responses: Record<string, any> = {
    'server.version': ['ElectrumX-test', '1.4'],
    'server.features': { genesis_hash: vergeProfile('testnet').genesis, hash_function: 'sha256' },
    'blockchain.headers.subscribe': { height: 1, hex: fixture.header },
    'blockchain.block.header': fixture.header,
    'blockchain.scripthash.get_balance': { confirmed: value, unconfirmed: 0 },
    'blockchain.scripthash.get_history': [{ tx_hash: tx.txid, height: 1 }],
    'blockchain.scripthash.listunspent': [{ tx_hash: tx.txid, tx_pos: 0, height: 1, value }],
    'blockchain.transaction.get': tx.hex,
    'blockchain.transaction.get_merkle': { merkle: [], pos: 0, block_height: 1 },
  };
  const client = { request: async (method: string) => responses[method] };
  const result = await probeElectrum(client, vergeProfile('testnet'), tx.vout[0].scriptPubKey.hex, async () => fixture.block.hash);
  assert.equal(result.addressSample?.merkleVerified, true);
  assert.equal(result.addressSample?.confirmed, value);
  assert.equal(result.comparedWithCore, true);
  await assert.rejects(probeElectrum(client, vergeProfile('mainnet')), /genesis/);
  await assert.rejects(probeElectrum(client, vergeProfile('testnet'), undefined, async () => '0'.repeat(64)), /does not match Verge Core/);
  responses['blockchain.scripthash.get_balance'].unconfirmed = -1;
  await assert.rejects(probeElectrum(client, vergeProfile('testnet'), tx.vout[0].scriptPubKey.hex), /balance and unspent/);
  assert.throws(() => verifyElectrumMerkle(tx.txid, { merkle: [], pos: 1 }, fixture.block.merkleroot), /does not match/);
  assert.throws(() => verifyElectrumMerkle(tx.txid, { merkle: ['00'], pos: 0 }, fixture.block.merkleroot), /Invalid Electrum merkle branch/);
});

test('Electrum diagnostic transport handles fragmented replies, notifications and server errors', async () => {
  const server = createServer(socket => {
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        socket.write('{"method":"blockchain.headers.subscribe","params":[]}\n');
        const response = request.method === 'server.features' ? { id: request.id, error: { code: -1, message: 'test rejection' } } : { id: request.id, result: 'ok' };
        const wire = JSON.stringify(response) + '\n';
        socket.write(wire.slice(0, 4)); socket.write(wire.slice(4));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = await connectElectrumProbe('127.0.0.1', address.port, false, 1000);
  try {
    assert.equal(await client.request('server.version', []), 'ok');
    await assert.rejects(client.request('server.features', []), /test rejection/);
    await assert.rejects(client.request('blockchain.transaction.broadcast', ['00']), /read-only/);
  } finally {
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('recent-block reconciliation handles same-height replacement, rollback and forks beyond the cache', async () => {
  const cache = [10, 11, 12].map(height => ({ height, id: `old-${height}` }));
  const original = async (height: number) => `old-${height}`;
  const unchanged = await reconcileVergeBlockCache(cache, 13, original);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.blocks, cache);
  const rollback = await reconcileVergeBlockCache(cache, 11, original);
  assert.equal(rollback.changed, true);
  assert.deepEqual(rollback.blocks.map(b => b.height), [10, 11]);
  const replacement = await reconcileVergeBlockCache(cache, 12, async height => height === 12 ? 'replacement' : original(height));
  assert.deepEqual(replacement.blocks.map(b => b.height), [10, 11]);
  const deep = await reconcileVergeBlockCache(cache, 14, async height => `new-${height}`);
  assert.deepEqual(deep.blocks, []);
  assert.equal(deep.changed, true);
  await assert.rejects(reconcileVergeBlockCache(cache, 14, async () => { throw new Error('RPC unavailable'); }), /RPC unavailable/);
});

test('Verge policy fees round up by 999-byte chunks instead of a linear sat/vB estimate', () => {
  const info = { minrelaytxfee: '0.200000', mempoolminfee: '0.200000' };
  assert.equal(getVergeFeePolicy(info, 200).minimumRelayFeeAtomic, '100000');
  assert.equal(getVergeFeePolicy(info, 999).minimumRelayFeeAtomic, '100000');
  assert.equal(getVergeFeePolicy(info, 1000).minimumRelayFeeAtomic, '200000');
  assert.equal(getVergeFeePolicy(info, 1998).minimumRelayFeeAtomic, '200000');
  assert.equal(getVergeFeePolicy(info, 1999).minimumRelayFeeAtomic, '300000');
  assert.equal(getVergeFeePolicy(info).priorityEstimatesAvailable, false);
  assert.throws(() => getVergeFeePolicy(info, 0), /byte size/);
  assert.throws(() => getVergeFeePolicy({ ...info, mempoolminfee: '0.200001' }), /chunk policy/);
});

test('real PoS ordinary spend preserves replay version, transaction time, merkle branch and fee-only reward', () => {
  const fixture = regtestSpends.blocks[0];
  const block = decodeVergeBlock(fixture.raw);
  assert.equal(block.id, fixture.block.hash);
  assert.equal(block.tx_count, 2);
  assert.ok(block.tx.every(tx => tx.version === POS_TRANSACTION_VERSION));
  assert.equal(block.tx[1].vin[0].is_coinbase, false);
  assert.equal(block.tx[1].vin[0].sequence, 0xfffffffd);
  assert.equal(block.tx[1].time, fixture.block.tx[1].time);
  assert.equal(block.tx[0].vout.reduce((sum, output) => sum + output.value, 0n), 200000n);
  verifyElectrumMerkle(block.tx[1].txid, { merkle: [block.tx[0].txid], pos: 1 }, block.merkle_root);
});

test('Core RPC transport preserves monetary JSON, reloads rotated cookies and bounds request timeouts', async () => {
  const { JsonRPC } = require('../../rpc-api/jsonrpc');
  const directory = resolve(__dirname, '../../../.local');
  mkdirSync(directory, { recursive: true });
  const temporary = mkdtempSync(join(directory, 'rpc-test-'));
  assert.ok(resolve(temporary).startsWith(directory + sep));
  const cookie = join(temporary, '.cookie');
  writeFileSync(cookie, 'test:before');
  let expectedCredential = 'test:before';
  const server = createHttpServer((request, response) => {
    if (request.headers.authorization !== `Basic ${Buffer.from(expectedCredential).toString('base64')}`) {
      response.writeHead(401); response.end('{"error":{"code":-1,"message":"Unauthorized"}}'); return;
    }
    let body = '';
    request.on('data', chunk => body += chunk);
    request.on('end', () => {
      if (JSON.parse(body).method === 'timeout') { return; }
      response.end('{"result":{"value":9007199254.740993},"error":null,"id":1}');
    });
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new JsonRPC({ host: '127.0.0.1', port: address.port, cookie, parseResponse: parseVergeRpcJson, timeout: 250 });
  try {
    assert.equal((await client.call('getblock', [])).value, '9007199254.740993');
    expectedCredential = 'test:after'; writeFileSync(cookie, expectedCredential);
    await assert.rejects(client.call('getblock', []), /Unauthorized/);
    assert.equal((await client.call('getblock', [])).value, '9007199254.740993');
    await assert.rejects(client.call('timeout', []), /ETIMEDOUT|ESOCKETTIMEDOUT/);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(temporary, { recursive: true, force: true });
  }
});
