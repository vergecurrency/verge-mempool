// Exercises only a fresh, explicitly selected local Verge regtest node.
require('./register-typescript.cjs');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { JsonRPC } = require('../src/rpc-api/jsonrpc.ts');
const { decodeVergeBlock, decodeVergePowBlock, decodeVergeHeader, decodeVergeTransaction } = require('../src/api/verge/codec.ts');
const { parseVergeRpcJson, coinToAtomic, atomicToCoin } = require('../src/api/verge/amounts.ts');
const { normalizeVergeMempoolEntry } = require('../src/api/verge/rpc.ts');
const { reconcileVergeBlockCache } = require('../src/api/verge/block-cache.ts');
const argument = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
if (!argument('datadir')) { throw new Error('Select a fresh isolated regtest node with --datadir=PATH; it must be started separately'); }
const cookiePath = path.join(path.resolve(argument('datadir')), 'regtest', '.cookie');
const port = Number(argument('rpc-port') || '20334');
if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error('Invalid RPC port'); }
const client = new JsonRPC({ host: '127.0.0.1', port, cookie: cookiePath, timeout: 120000, parseResponse: parseVergeRpcJson });
const rpc = (method, params = []) => client.call(method, params);
const outputDirectory = path.resolve(__dirname, '../.local');
fs.mkdirSync(outputDirectory, { recursive: true });
async function mine(count, address) {
  while (count > 0) { const batch = Math.min(count, 100); await rpc('generatetoaddress', [batch, address]); count -= batch; console.log(`Mined to height ${await rpc('getblockcount')}`); }
}
async function capture(hash) {
  const block = await rpc('getblock', [hash, 2]);
  const raw = await rpc('getblock', [hash, 0]);
  const header = await rpc('getblockheader', [hash, false]);
  assert.equal(decodeVergeHeader(header).id, hash);
  assert.equal(decodeVergeBlock(raw).id, hash);
  for (const tx of block.tx) { assert.equal(decodeVergeTransaction(tx.hex).txid, tx.txid); }
  return { block, raw, header };
}
async function main() {
  assert.equal((await rpc('getblockchaininfo')).chain, 'regtest');
  assert.equal(await rpc('getblockhash', [0]), '65b4e101cacf3e1e4f3a9237e3a74ffd1186e595d8b78fa8ea22c21ef5bf9347');
  assert.equal(await rpc('getblockcount'), 0, 'Use a fresh isolated regtest database');
  const address = await rpc('getnewaddress');
  await mine(721, address);
  const bond = await rpc('createbond', [1000]);
  console.log('Bond admitted to isolated mempool');
  const bondTx = await rpc('getrawtransaction', [bond.txid, true]);
  assert.equal(decodeVergeTransaction(bondTx.hex).txid, bond.txid);
  const entry = normalizeVergeMempoolEntry(await rpc('getmempoolentry', [bond.txid]));
  assert.equal(entry.vsize, decodeVergeTransaction(bondTx.hex).size);
  assert.equal(entry.weight, entry.vsize * 4);
  const accept = await rpc('testmempoolaccept', [[bondTx.hex]]);
  assert.equal(accept[0].allowed, false); // Already in the mempool.
  await mine(1, address);
  const bondBlockHash = await rpc('getbestblockhash');
  const bondBlock = await capture(bondBlockHash);
  assert.equal(decodeVergePowBlock(bondBlock.raw).id, bondBlockHash);
  assert.equal((await rpc('getrawmempool')).length, 0);
  await rpc('invalidateblock', [bondBlockHash]);
  assert.equal(await rpc('getblockcount'), 721);
  assert.ok((await rpc('getrawmempool')).includes(bond.txid));
  await rpc('reconsiderblock', [bondBlockHash]);
  assert.equal(await rpc('getblockcount'), 722);
  assert.equal((await rpc('getrawmempool')).length, 0);
  console.log('PoW invalidate/reconsider restores mempool transaction correctly');
  await mine(777, address);
  assert.equal(await rpc('getblockcount'), 1499);
  const before = await rpc('getposinfo');
  assert.equal(before.next_block_proof, 'pos');
  const finalPowTime = (await rpc('getblockheader', [await rpc('getbestblockhash')])).time;
  const epochZeroTime = (Math.floor(finalPowTime / 30) + 1) * 30;
  await rpc('setmocktime', [epochZeroTime]);
  const firstPos = await rpc('generatestake');
  const posZero = await capture(firstPos);
  assert.equal(posZero.block.height, 1500);
  assert.ok(posZero.block.tx.every(tx => tx.version === 0x05475658));
  await rpc('setmocktime', [epochZeroTime + 120 * 30]);
  const nextPos = await rpc('generatestake');
  const posOne = await capture(nextPos);
  await rpc('invalidateblock', [nextPos]);
  assert.equal(await rpc('getbestblockhash'), firstPos);
  const cached = [{ id: firstPos, height: 1500 }, { id: nextPos, height: 1501 }];
  const reconciled = await reconcileVergeBlockCache(cached, await rpc('getblockcount'), height => rpc('getblockhash', [height]));
  assert.deepEqual(reconciled.blocks.map(block => block.id), [firstPos]);
  assert.equal(reconciled.changed, true);
  await rpc('reconsiderblock', [nextPos]);
  assert.equal(await rpc('getbestblockhash'), nextPos);
  assert.equal((await reconcileVergeBlockCache(cached, await rpc('getblockcount'), height => rpc('getblockhash', [height]))).changed, false);
  const spendAddress = await rpc('getnewaddress');
  const input = (await rpc('listunspent', [120])).find(output => coinToAtomic(output.amount) > 10000000000n && output.scriptPubKey.startsWith('76a914'));
  assert.ok(input, 'A mature ordinary regtest output is required');
  async function signedSpend(fee) {
    const raw = await rpc('createrawtransaction', [[{ txid: input.txid, vout: input.vout, sequence: 0xfffffffd }], { [spendAddress]: Number(atomicToCoin(coinToAtomic(input.amount) - fee)) }]);
    const signed = await rpc('signrawtransactionwithwallet', [raw]);
    assert.equal(signed.complete, true);
    assert.equal(decodeVergeTransaction(signed.hex).version, 0x05475658);
    return signed.hex;
  }
  const original = await signedSpend(200000n);
  const originalTxid = await rpc('sendrawtransaction', [original, true]);
  const replacement = await signedSpend(400000n);
  // This Core's CFeeRate(fee,size) fixes both comparison rates to 0.1 XVG/chunk.
  await assert.rejects(rpc('sendrawtransaction', [replacement, true]), /new feerate.*<= old feerate/);
  assert.deepEqual(await rpc('getrawmempool'), [originalTxid]);
  const previousTime = (await rpc('getblockheader', [nextPos])).time;
  await rpc('setmocktime', [previousTime + 120 * 30]);
  const spendBlockHash = await rpc('generatestake');
  const spendBlock = await capture(spendBlockHash);
  const parsed = decodeVergeBlock(spendBlock.raw);
  assert.ok(parsed.tx.some(tx => tx.txid === originalTxid));
  assert.equal(parsed.tx[0].vout.reduce((sum, output) => sum + output.value, 0n), 200000n);
  assert.equal((await rpc('getblockstats', [spendBlockHash])).totalfee, 200000);
  await rpc('invalidateblock', [spendBlockHash]);
  assert.ok((await rpc('getrawmempool')).includes(originalTxid));
  await rpc('reconsiderblock', [spendBlockHash]);
  assert.equal((await rpc('getrawmempool')).length, 0);
  const result = { network: 'regtest', source: 'Isolated Verge Core regression network; public synthetic chain data', bondBlock, posBlocks: [posZero, posOne, spendBlock], rejectedReplacement: replacement, checks: ['mempool admission', 'mempool entry normalization', 'already-known rejection', 'PoW rollback/reconsider', 'mempool resurrection', 'bond creation', 'PoS activation', 'PoS rollback/reconsider', 'backend recent-block cache reconciliation', 'higher-fee replacement rejected by fixed rate comparison', 'PoS ordinary spend', 'fee-only PoS reward', 'PoS spend resurrection'] };
  fs.writeFileSync(path.join(outputDirectory, 'regtest-results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ checks: result.checks, height: await rpc('getblockcount'), firstPos }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
