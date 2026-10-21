// Mutations are restricted to an explicitly selected, initially empty regtest node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const WebSocket = require('ws');
const { JsonRPC } = require('../dist/rpc-api/jsonrpc');
const { parseVergeRpcJson, coinToAtomic, atomicToCoin } = require('../dist/api/verge/amounts');
const { decodeVergeBlock } = require('../dist/api/verge/codec');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!option('datadir')) { throw new Error('Select a fresh, separately started regtest node with --datadir=PATH'); }
const datadir = path.resolve(option('datadir'));
const port = Number(option('rpc-port') || 20340);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
const wire = new JsonRPC({ host: '127.0.0.1', port, cookie: path.join(datadir, 'regtest', '.cookie'), timeout: 30000, parseResponse: parseVergeRpcJson });
const rpc = (method, params = []) => wire.call(method, params);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const checks = [];
const frames = [];
let backend;
let socket;
let directory;
let base;

async function until(label, predicate) {
  const deadline = Date.now() + 15000;
  do {
    if (backend?.exitCode !== null && backend?.exitCode !== undefined) { throw new Error(`Backend exited ${backend.exitCode}: ${label}`); }
    if (await predicate()) { return; }
    await pause(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

async function get(route, format = 'json') {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, route);
  return format === 'text' ? response.text() : response.json();
}

function passed(name) { checks.push(name); console.log(`PASS ${name}`); }

async function spend(txid, vout, amount, address) {
  const raw = await rpc('createrawtransaction', [[{ txid, vout }], { [address]: Number(atomicToCoin(amount - 200000n)) }]);
  const signed = await rpc('signrawtransactionwithwallet', [raw]);
  assert.equal(signed.complete, true);
  return rpc('sendrawtransaction', [signed.hex, true]);
}

async function main() {
  assert.equal((await rpc('getblockchaininfo')).chain, 'regtest');
  assert.equal(await rpc('getblockhash', [0]), '65b4e101cacf3e1e4f3a9237e3a74ffd1186e595d8b78fa8ea22c21ef5bf9347');
  assert.equal(await rpc('getblockcount'), 0, 'Refusing to mutate an existing chain; use a fresh regtest directory');
  const address = await rpc('getnewaddress');
  const recipient = await rpc('getnewaddress');
  await rpc('generatetoaddress', [100, address]);
  await rpc('generatetoaddress', [30, address]);
  const original = (await rpc('getblock', [await rpc('getblockhash', [1]), 2])).tx[0];
  const output = original.vout.findIndex(out => coinToAtomic(out.value) > 1000000n);
  assert.ok(output >= 0);
  const amount = coinToAtomic(original.vout[output].value);
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const httpPort = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  directory = fs.mkdtempSync(path.join(path.resolve(__dirname, '../.local/'), 'live-regtest-'));
  const configuration = {
    MEMPOOL: { CHAIN: 'verge', NETWORK: 'regtest', BACKEND: 'none', HTTP_PORT: httpPort, POLL_RATE_MS: 100, CACHE_ENABLED: false, CACHE_DIR: path.join(directory, 'cache'), INDEXING_BLOCKS_AMOUNT: 0, RUST_GBT: false, AUDIT: false, CLUSTER_MEMPOOL: false },
    CORE_RPC: { HOST: '127.0.0.1', PORT: port, COOKIE: true, COOKIE_PATH: path.join(datadir, 'regtest', '.cookie') },
    DATABASE: { ENABLED: false }, FIAT_PRICE: { ENABLED: false }, LIGHTNING: { ENABLED: false }, STRATUM: { ENABLED: false }, STATISTICS: { ENABLED: false }, SYSLOG: { ENABLED: false }, WALLETS: { ENABLED: false }, MEMPOOL_SERVICES: { ACCELERATIONS: false },
  };
  const configurationPath = path.join(directory, 'config.json');
  fs.writeFileSync(configurationPath, JSON.stringify(configuration, null, 2));
  const stdout = fs.openSync(path.join(directory, 'stdout.log'), 'w');
  const stderr = fs.openSync(path.join(directory, 'stderr.log'), 'w');
  backend = spawn(process.execPath, ['dist/index.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, MEMPOOL_CONFIG_FILE: configurationPath }, windowsHide: true, stdio: ['ignore', stdout, stderr] });
  fs.closeSync(stdout); fs.closeSync(stderr);
  fs.writeFileSync(path.join(directory, 'process.json'), JSON.stringify({ pid: backend.pid, httpPort }));
  base = `http://127.0.0.1:${httpPort}/api/v1/`;
  await until('backend startup', async () => { try { return Number(await get('blocks/tip/height', 'text')) === 130; } catch { return false; } });
  socket = new WebSocket(`ws://127.0.0.1:${httpPort}/api/v1/ws`);
  socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
  await once(socket, 'open');
  socket.send(JSON.stringify({ action: 'want', data: ['blocks', 'stats', 'mempool-blocks'] }));
  socket.send(JSON.stringify({ action: 'init' }));
  socket.send(JSON.stringify({ 'track-mempool-txids': true }));
  await until('WebSocket initialization', () => frames.some(frame => frame.chain?.network === 'regtest'));
  passed('real backend starts on the isolated Core chain');

  const txid = await spend(original.txid, output, amount, recipient);
  await until('mempool arrival', () => frames.some(frame => frame['mempool-txids']?.added.includes(txid)));
  const mempool = await get('mempool');
  assert.equal(mempool.count, 1); assert.equal(mempool.total_fee, 200000);
  const unconfirmed = await get(`tx/${txid}`);
  assert.equal(unconfirmed.fee, 200000); assert.equal(unconfirmed.status.confirmed, false);
  const projected = await get('fees/mempool-blocks');
  assert.ok(projected.some(block => block.nTx >= 1));
  passed('transaction arrival, exact mempool fee and visualization data');

  const firstHash = (await rpc('generatetoaddress', [1, address]))[0];
  await until('mined transaction notification', () => frames.some(frame => frame.block?.id === firstHash && frame['mempool-txids']?.mined.includes(txid)));
  await until('confirmed HTTP status', async () => (await get(`tx/${txid}`)).status.block_hash === firstHash && (await get('mempool')).count === 0);
  const confirmed = await get(`block/${firstHash}`);
  assert.equal(confirmed.extras.feeStatsAvailable, false);
  assert.equal(confirmed.extras.totalFees, undefined);
  passed('new block and confirmation without txindex-dependent fee statistics');

  const rollbackStart = frames.length;
  await rpc('invalidateblock', [firstHash]);
  await until('lower tip', async () => Number(await get('blocks/tip/height', 'text')) === 130);
  await until('resurrected transaction', async () => (await get('mempool')).count === 1 && !(await get(`tx/${txid}`)).status.confirmed);
  await until('reorg WebSocket cache refresh', () => frames.slice(rollbackStart).some(frame => Array.isArray(frame.blocks) && frame.blocks.every(block => block.id !== firstHash)));
  passed('rollback updates HTTP, WebSocket blocks and mempool resurrection');

  await rpc('reconsiderblock', [firstHash]);
  await until('restored canonical block', async () => (await get(`tx/${txid}`)).status.block_hash === firstHash && (await get('mempool')).count === 0);
  passed('reconsider restores transaction confirmation');

  const replacementStart = frames.length;
  await rpc('invalidateblock', [firstHash]);
  // A different coinbase script prevents mining the same invalidated header again.
  const replacementAddress = await rpc('getnewaddress');
  const replacementHash = (await rpc('generatetoaddress', [1, replacementAddress]))[0];
  assert.notEqual(replacementHash, firstHash);
  await until('same-height replacement', async () => {
    const blocks = await get('blocks');
    return blocks.some(block => block.id === replacementHash) && blocks.every(block => block.id !== firstHash);
  });
  await until('replacement WebSocket update', () => frames.slice(replacementStart).some(frame => frame.block?.id === replacementHash || frame.blocks?.some(block => block.id === replacementHash)));
  assert.equal((await get(`tx/${txid}`)).status.block_hash, replacementHash);
  passed('same-height replacement removes the stale block from recent history');

  const block = decodeVergeBlock(await rpc('getblock', [replacementHash, 0]));
  assert.ok(block.tx.some(tx => tx.txid === txid));
  const statistics = await get('mining/algorithms');
  assert.equal(statistics.algorithms.length, 5);
  passed('replacement serialization and per-algorithm mining API');

  if (process.argv.includes('--pos')) {
    // Requires the fresh node's explicit -posactivationheight=1500 override.
    // Core's createbond also requires its funding inputs to have 720 confirmations.
    while (await rpc('getblockcount') < 721) {
      await rpc('generatetoaddress', [Math.min(100, 721 - await rpc('getblockcount')), address]);
    }
    await rpc('createbond', [1000]);
    while (await rpc('getblockcount') < 1499) {
      const remaining = 1499 - await rpc('getblockcount');
      await rpc('generatetoaddress', [Math.min(100, remaining), address]);
    }
    await until('last PoW block', async () => Number(await get('blocks/tip/height', 'text')) === 1499);
    assert.equal((await rpc('getposinfo')).next_block_proof, 'pos');
    const finalPowTime = (await rpc('getblockheader', [await rpc('getbestblockhash')])).time;
    const firstSlot = (Math.floor(finalPowTime / 30) + 1) * 30;
    await rpc('setmocktime', [firstSlot]);
    const firstPos = await rpc('generatestake');
    await until('PoS activation event', () => frames.some(frame => frame.block?.id === firstPos && frame.block.proof === 'pos'));
    const header = await get(`block/${firstPos}/header`, 'text');
    assert.equal(header.length, 112 * 2);
    assert.equal((await get(`block/${firstPos}`)).extras.reward, 0);
    const posMining = await get('mining/algorithms');
    assert.equal(posMining.hash, firstPos, 'A new tip must invalidate the cached PoW sample');
    assert.equal(posMining.proof, 'pos');
    assert.ok(posMining.algorithms.every(row => row.hashrate === null));
    passed('PoS activation, 112-byte headers and immediate mining-cache refresh');

    const input = (await rpc('listunspent', [120])).find(coin => coinToAtomic(coin.amount) > 10000000000n && coin.scriptPubKey.startsWith('76a914'));
    assert.ok(input);
    const posTxid = await spend(input.txid, input.vout, coinToAtomic(input.amount), recipient);
    await until('replay-protected mempool transaction', () => frames.some(frame => frame['mempool-txids']?.added.includes(posTxid)));
    const posTransaction = await get(`tx/${posTxid}`);
    assert.equal(posTransaction.version, 0x05475658);
    assert.equal(posTransaction.fee, 200000);
    await rpc('setmocktime', [firstSlot + 120 * 30]);
    const feeBlock = await rpc('generatestake');
    await until('PoS spend confirmation', () => frames.some(frame => frame.block?.id === feeBlock && frame['mempool-txids']?.mined.includes(posTxid)));
    assert.equal((await get(`block/${feeBlock}`)).extras.reward, 200000);
    assert.equal((await get(`tx/${posTxid}`)).status.block_hash, feeBlock);
    const feeRaw = await rpc('getblock', [feeBlock, 0]);
    assert.equal(decodeVergeBlock(feeRaw).id, feeBlock);
    passed('replay-protected live transaction and exact fee-only PoS reward');

    await rpc('invalidateblock', [feeBlock]);
    await until('PoS rollback', async () => Number(await get('blocks/tip/height', 'text')) === 1500 && !(await get(`tx/${posTxid}`)).status.confirmed);
    await rpc('reconsiderblock', [feeBlock]);
    await until('PoS restoration', async () => (await get(`tx/${posTxid}`)).status.block_hash === feeBlock);
    passed('PoS rollback, transaction resurrection and restoration');
  }
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ network: 'regtest', height: await rpc('getblockcount'), firstHash, replacementHash, checks, finishedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`All ${checks.length} live HTTP/WebSocket scenarios passed. Evidence: ${directory}`);
}

async function cleanup() {
  socket?.terminate();
  if (backend && backend.exitCode === null && backend.signalCode === null) {
    const exited = once(backend, 'exit');
    backend.kill('SIGTERM'); await exited;
  }
}
main().catch(error => { console.error(`Live regtest failed: ${error.stack}`); if (directory) { console.error(`Backend evidence: ${directory}`); } process.exitCode = 1; }).finally(cleanup);
