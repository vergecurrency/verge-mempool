// Read-only acceptance checks against the built backend and its configured Core.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
const config = require('../dist/config').default;
const core = require('../dist/api/bitcoin/bitcoin-client').default;
const { activeVergeProfile } = require('../dist/api/verge/runtime');
const { getVergeFeePolicy } = require('../dist/api/verge/fee-policy');
const { decodeVergeBlock, decodeVergeHeader } = require('../dist/api/verge/codec');

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = new URL(option('url') || `http://127.0.0.1:${config.MEMPOOL.HTTP_PORT}${config.MEMPOOL.API_URL_PREFIX}`);
if (!['http:', 'https:'].includes(base.protocol)) { throw new Error('Use an HTTP(S) backend URL'); }
if (!base.pathname.endsWith('/')) { base.pathname += '/'; }
const results = [];
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function request(route, status = 200, format = 'json') {
  const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, status, `${route}: unexpected HTTP status`);
  if (format === 'bytes') { return Buffer.from(await response.arrayBuffer()); }
  return format === 'text' ? response.text() : response.json();
}

async function check(name, callback) {
  await callback();
  results.push(name);
  console.log(`PASS ${name}`);
}

async function socketCheck() {
  const url = new URL('ws', base);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  const frames = [];
  const timer = setTimeout(() => socket.terminate(), 15000);
  socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
  try {
    await once(socket, 'open');
    socket.send(JSON.stringify({ action: 'want', data: ['blocks', 'stats', 'mempool-blocks'] }));
    socket.send(JSON.stringify({ action: 'init' }));
    socket.send(JSON.stringify({ action: 'ping' }));
    const deadline = Date.now() + 10000;
    while (!frames.some(frame => frame.chain && frame.backendInfo) || !frames.some(frame => frame.pong)) {
      assert.ok(Date.now() < deadline && socket.readyState === WebSocket.OPEN, 'WebSocket initialization/ping timed out');
      await wait(25);
    }
    const init = frames.find(frame => frame.chain && frame.backendInfo);
    assert.deepEqual(init.chain, activeVergeProfile);
    assert.ok(init.blocks.length > 0);
    assert.equal(typeof init.mempoolInfo.size, 'number');
    assert.ok(Array.isArray(init['mempool-blocks']));
    assert.equal(init.fees, undefined, 'Bitcoin priority fee estimates must be absent');
    assert.equal(init.da, undefined, 'Bitcoin difficulty epoch must be absent');
  } finally {
    clearTimeout(timer);
    socket.terminate();
  }
}

async function main() {
  assert.ok(activeVergeProfile, 'Select MEMPOOL.CHAIN=verge in MEMPOOL_CONFIG_FILE');
  assert.equal(await core.getBlockHash(0), activeVergeProfile.genesis);
  const height = await core.getBlockCount();
  const hash = await core.getBlockHash(height);
  const block = await core.getBlock(hash, 2);
  const deadline = Date.now() + 30000;
  while (Number(await request('blocks/tip/height', 200, 'text')) < height) {
    assert.ok(Date.now() < deadline, 'Backend did not catch up to Core');
    await wait(250);
  }

  await check('HTTP chain identity and six-decimal XVG profile', async () => assert.deepEqual(await request('chain'), activeVergeProfile));
  await check('genesis block identity and known zero fees', async () => {
    const genesis = await request(`block/${activeVergeProfile.genesis}`);
    assert.equal(genesis.height, 0);
    assert.equal(genesis.id, activeVergeProfile.genesis);
    assert.equal(genesis.extras.feeStatsAvailable, true);
    assert.equal(genesis.extras.totalFees, 0);
  });
  await check('recent blocks agree with canonical Core hashes', async () => {
    const blocks = await request('blocks');
    assert.ok(blocks.length > 0);
    for (const recent of blocks) {
      assert.equal(recent.id, await core.getBlockHash(recent.height));
      assert.ok(recent.extras);
      assert.equal(typeof recent.extras.feeStatsAvailable, 'boolean');
      if (!recent.extras.feeStatsAvailable) {
        assert.equal(recent.extras.totalFees, undefined);
        assert.equal(recent.extras.medianFee, undefined);
      }
    }
  });
  await check('block details and exact coinbase reward', async () => {
    const actual = await request(`block/${hash}`);
    assert.equal(actual.id, hash);
    assert.equal(actual.height, height);
    assert.equal(actual.tx_count, block.tx.length);
    const reward = decodeVergeBlock(await core.getBlock(hash, 0)).tx[0].vout.reduce((sum, output) => sum + output.value, 0n);
    assert.equal(BigInt(actual.extras.reward), reward);
  });
  await check('timestamped raw block, header and transaction IDs', async () => {
    const raw = await request(`block/${hash}/raw`, 200, 'bytes');
    assert.equal(raw.toString('hex'), await core.getBlock(hash, 0));
    assert.equal(decodeVergeBlock(raw.toString('hex')).id, hash);
    const header = await request(`block/${hash}/header`, 200, 'text');
    assert.equal(header, await core.getBlockHeader(hash, false));
    assert.equal(decodeVergeHeader(header).id, hash);
    assert.deepEqual(await request(`block/${hash}/txids`), block.tx.map(tx => tx.txid));
    assert.equal(await request(`block-height/${height}`, 200, 'text'), hash);
  });
  await check('coinbase transaction hex and confirming height', async () => {
    const tx = block.tx[0];
    assert.equal(await request(`tx/${tx.txid}/hex`, 200, 'text'), tx.hex);
    const actual = await request(`tx/${tx.txid}`);
    assert.equal(actual.txid, tx.txid);
    assert.equal(actual.status.block_height, height);
    assert.equal(actual.status.block_hash, hash);
  });
  await check('mempool fields use atomic XVG units', async () => {
    const info = await request('mempool');
    assert.ok(Number.isSafeInteger(info.count) && info.count >= 0);
    assert.ok(Number.isSafeInteger(info.vsize) && info.vsize >= 0);
    assert.ok(info.total_fee === null || Number.isSafeInteger(info.total_fee));
    if (info.count === 0) { assert.equal(info.total_fee, 0); }
    const ids = await request('mempool/txids');
    assert.ok(Array.isArray(ids) && ids.every(id => /^[a-f0-9]{64}$/.test(id)));
  });
  await check('999-byte fee chunks and invalid parameter handling', async () => {
    const info = await core.getMempoolInfo();
    for (const bytes of [1, 200, 999, 1000]) {
      assert.deepEqual(await request(`fees/policy?bytes=${bytes}`), getVergeFeePolicy(info, bytes));
    }
    for (const bytes of ['0', '-1', '1.5', '1000001', '1&bytes=2']) { await request(`fees/policy?bytes=${bytes}`, 400); }
  });
  await check('five mining algorithms with separate hashrate fields', async () => {
    const mining = await request('mining/algorithms');
    assert.deepEqual(mining.algorithms.map(row => row.algorithm), ['scrypt', 'x17', 'lyra2re', 'blake', 'groestl']);
    assert.ok(mining.height >= 0 && mining.height <= await core.getBlockCount());
    for (const row of mining.algorithms) { assert.ok(row.hashrate === null || Number.isFinite(row.hashrate)); }
  });
  await check('Bitcoin priority fee and epoch endpoints are unavailable', async () => {
    for (const route of ['fees/recommended', 'fees/precise', 'fee-estimates', 'difficulty-adjustment']) {
      await request(route, 503, 'text');
    }
  });
  await check('WebSocket initialization, subscriptions and ping', socketCheck);
  await check('WebSocket reconnect preserves chain identity', socketCheck);
  assert.equal(await core.getBlockHash(height), hash, 'Chain changed during HTTP checks; retry');
  const directory = path.resolve(__dirname, '../.local');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'http-check-results.json'), JSON.stringify({
    network: activeVergeProfile.network, genesis: activeVergeProfile.genesis, height, hash,
    finishedAt: new Date().toISOString(), checks: results,
  }, null, 2) + '\n');
  console.log(`All ${results.length} read-only HTTP/WebSocket checks passed.`);
}

main().catch(error => { console.error(`HTTP/WebSocket check failed: ${error.message}`); process.exitCode = 1; });
