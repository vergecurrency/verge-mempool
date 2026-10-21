// Integration acceptance against an explicitly selected, initially empty regtest.
// Requires a built --features verge indexer and Node.js 18+.
// Index-only tests need no npm packages; --live uses the built backend and its ws dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
if (process.argv.includes('--live') && !arg('backend-dir')) throw Error('--live requires --backend-dir=BUILT_MEMPOOL_BACKEND');
if (!arg('datadir') || !arg('binary')) throw Error('Pass --datadir=FRESH_CORE_REGTEST_DATADIR --binary=VERGE_ELECTRS_BINARY');
const datadir = path.resolve(arg('datadir'));
const binary = path.resolve(arg('binary'));
const rpcPort = Number(arg('rpc-port') || 20340);
const httpPort = Number(arg('http-port') || 30340);
const electrumPort = Number(arg('electrum-port') || 50340);
const monitoringPort = Number(arg('monitoring-port') || 42340);
for (const port of [rpcPort, httpPort, electrumPort, monitoringPort]) assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
const checks = [];
let directory, indexer, socket, sequence = 0;
let backend;
const pending = new Map(); const frames = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function rpc(method, params = []) {
  const cookie = fs.readFileSync(path.join(datadir, 'regtest/.cookie'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${rpcPort}/`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(cookie).toString('base64')}` }, body: JSON.stringify({ id: 1, method, params }), signal: AbortSignal.timeout(120000) });
  const value = await response.json(); if (value.error) throw Error(`${method}: ${JSON.stringify(value.error)}`); return value.result;
}
async function get(route, format = 'json') {
  const response = await fetch(`http://127.0.0.1:${httpPort}/${route}`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error(`HTTP ${response.status} ${route}: ${await response.text()}`);
  return format === 'json' ? response.json() : format === 'bytes' ? Buffer.from(await response.arrayBuffer()) : response.text();
}
async function until(label, predicate) {
  const deadline = Date.now() + 90000; let last;
  do {
    if (indexer && (indexer.exitCode !== null || indexer.signalCode !== null)) throw Error(`Indexer exited during ${label}; inspect ${directory}`);
    try { if (await predicate()) return; } catch (error) { last = error; }
    await pause(100);
  } while (Date.now() < deadline);
  throw Error(`Timed out: ${label}${last ? ': ' + last.message : ''}`);
}
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
async function startIndex(extra = []) {
  const log = fs.openSync(path.join(directory, `index-${sequence++}.log`), 'w');
  indexer = spawn(binary, indexArgs(extra), { windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  const tip = await rpc('getbestblockhash');
  await until('index tip', async () => (await get('blocks/tip/hash', 'text')) === tip);
}
function indexArgs(extra = []) { return ['--network=regtest', `--daemon-dir=${datadir}`, `--daemon-rpc-addr=127.0.0.1:${rpcPort}`, `--http-addr=127.0.0.1:${httpPort}`, `--electrum-rpc-addr=127.0.0.1:${electrumPort}`, `--monitoring-addr=127.0.0.1:${monitoringPort}`, `--db-dir=${directory}`, '--main-loop-delay=100', '-v', ...extra]; }
async function rejectsConfiguration(args, pattern, name) {
  const file = path.join(directory, `${name}.log`); const log = fs.openSync(file, 'w');
  const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', log, log] }); fs.closeSync(log);
  const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
  const [code] = await once(child, 'exit'); clearTimeout(timer);
  assert.notEqual(code, 0); assert.match(fs.readFileSync(file, 'utf8'), pattern);
}
async function stopIndex() {
  socket?.destroy(); socket = undefined;
  if (indexer && indexer.exitCode === null && indexer.signalCode === null) { const exited = once(indexer, 'exit'); indexer.kill('SIGTERM'); await exited; }
  indexer = undefined;
}
async function stopBackend() {
  if (backend && backend.exitCode === null && backend.signalCode === null) { const exited = once(backend, 'exit'); backend.kill('SIGTERM'); await exited; }
  backend = undefined;
}
async function checkBackend(address, parent, child) {
  const cwd = path.resolve(arg('backend-dir'));
  const config = {
    MEMPOOL: { CHAIN: 'verge', NETWORK: 'regtest', BACKEND: 'electrum', HTTP_PORT: 8934, POLL_RATE_MS: 100, CACHE_ENABLED: false, CACHE_DIR: path.join(directory, 'backend-cache'), INDEXING_BLOCKS_AMOUNT: 0, RUST_GBT: false, AUDIT: false, CLUSTER_MEMPOOL: false },
    CORE_RPC: { HOST: '127.0.0.1', PORT: rpcPort, COOKIE: true, COOKIE_PATH: path.join(datadir, 'regtest/.cookie') },
    ELECTRUM: { HOST: '127.0.0.1', PORT: electrumPort, TLS_ENABLED: false },
    DATABASE: { ENABLED: false }, FIAT_PRICE: { ENABLED: false }, LIGHTNING: { ENABLED: false }, STRATUM: { ENABLED: false }, STATISTICS: { ENABLED: false }, SYSLOG: { ENABLED: false }, WALLETS: { ENABLED: false }, MEMPOOL_SERVICES: { ACCELERATIONS: false },
  };
  const file = path.join(directory, 'backend.json'); fs.writeFileSync(file, JSON.stringify(config, null, 2));
  const log = fs.openSync(path.join(directory, 'backend.log'), 'w');
  backend = spawn(process.execPath, ['dist/index.js'], { cwd, env: { ...process.env, MEMPOOL_CONFIG_FILE: file }, windowsHide: true, stdio: ['ignore', log, log] }); fs.closeSync(log);
  async function backendGet(route) {
    if (backend.exitCode !== null) throw Error('Backend exited');
    const response = await fetch(`http://127.0.0.1:8934/api/v1/${route}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error(`Backend ${route} HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }
  const tip = await rpc('getblockcount');
  await until('Mempool backend startup and Electrum identity', async () => await backendGet('blocks/tip/height') === tip && (await backendGet(`address/${address}`)).electrum);
  const history = await backendGet(`address/${address}/txs`);
  assert.ok(history.some(tx => tx.txid === parent.id)); assert.ok(history.some(tx => tx.txid === child.id));
  const historical = await backendGet(`tx/${parent.id}`);
  assert.equal(historical.txid, parent.id); assert.equal(historical.fee, 200000); assert.equal(historical.status.confirmed, true);
  const proof = await backendGet(`tx/${child.id}/merkle-proof`); assert.ok(proof.merkle);
  const actual = await backendGet(`address/${address}`); const indexed = await get(`address/${address}`);
  assert.equal(actual.chain_stats.funded_txo_sum, indexed.chain_stats.funded_txo_sum - indexed.chain_stats.spent_txo_sum);
  pass('full Mempool backend uses the Rust Electrum index for cold history, balances, spent parents and proofs');
  if (process.argv.includes('--live')) await checkLiveBackend(cwd, backendGet, address);
  await stopBackend();
}

async function checkLiveBackend(cwd, backendGet, address) {
  const WebSocket = require(path.join(cwd, 'node_modules/ws'));
  let liveSocket; let received = [];
  const latency = [];
  const contains = (rows, id) => rows?.some(tx => tx.txid === id);
  const send = value => liveSocket.send(JSON.stringify(value));
  async function connect() {
    received = [];
    liveSocket = new WebSocket('ws://127.0.0.1:8934/api/v1/ws');
    liveSocket.on('message', bytes => received.push({ at:Date.now(), data:JSON.parse(bytes.toString()) }));
    await once(liveSocket, 'open');
    send({action:'init'});
    send({action:'want',data:['blocks','stats','mempool-blocks']});
    send({'track-address':address,'track-addresses':[address], 'track-mempool-txids':true, 'track-mempool':true, 'track-mempool-block':0});
    await until('live socket initialization', () => received.some(frame => frame.data.chain?.chain === 'verge' && frame.data.blocks?.length));
  }
  async function seen(label, start, predicate) {
    await until(label, () => received.some(frame => frame.at >= start && predicate(frame.data)));
    const frame = received.find(frame => frame.at >= start && predicate(frame.data));
    assert.ok(frame, label);
    const elapsed = frame.at - start; latency.push({label, milliseconds:elapsed});
    assert.ok(elapsed < 5000, `${label} took ${elapsed}ms`);
  }
  async function nextBlock() {
    const tip = await rpc('getbestblockhash'); const header = await rpc('getblockheader',[tip]);
    if (process.argv.includes('--pos')) {
      await rpc('setmocktime',[header.time + 120 * 30]); return rpc('generatestake');
    }
    const mining = await rpc('getnewaddress'); return (await rpc('generatetoaddress',[1,mining]))[0];
  }
  try {
    await connect();
    const destination = await rpc('getnewaddress');
    const source = (await rpc('listunspent',[120])).find(coin => atomic(coin.amount) > 10000000000 && coin.scriptPubKey.startsWith('76a914'));
    assert.ok(source);
    const start = Date.now(); const parent = await spend(source.txid,source.vout,atomic(source.amount),address);
    await seen('transaction arrival',start, frame => frame['mempool-txids']?.added.includes(parent.id));
    await seen('tracked address arrival',start, frame => contains(frame['address-transactions'],parent.id));
    await seen('tracked multiple-address arrival',start, frame => contains(frame['multi-address-transactions']?.[address]?.mempool,parent.id));
    await seen('live visualization delta',start, frame => frame['projected-block-transactions']?.delta?.added?.some(tx=>tx[0]===parent.id) || frame['projected-block-transactions']?.blockTransactions?.some(tx=>tx[0]===parent.id));
    const paid = await get(`tx/${parent.id}`);
    const overview = await backendGet('fees/mempool-blocks');
    assert.ok(overview.some(block=>Math.abs(block.medianFee-paid.fee/paid.size)<1e-8), 'Observed fee overview must retain the paid XVG/byte rate');
    const childStart = Date.now(); const child = await spend(parent.id,0,parent.value,destination);
    await seen('unconfirmed child arrival',childStart, frame => frame['mempool-txids']?.added.includes(child.id));
    send({'track-txs':[parent.id,child.id]});
    const minedStart = Date.now(); const mined = await nextBlock();
    await seen('block confirmation',minedStart, frame => frame.block?.id===mined && frame['mempool-txids']?.mined.includes(child.id));
    await seen('tracked address confirmation',minedStart, frame => contains(frame['block-transactions'],parent.id));
    await until('Rust and backend confirmation', async () => (await get(`tx/${child.id}`)).status.block_hash===mined && (await backendGet('blocks/tip/height')) === await rpc('getblockcount'));
    pass('live transaction/address/parent-child/visualization and confirmation updates within five seconds');

    liveSocket.terminate(); await once(liveSocket,'close'); await connect();
    assert.ok(received.some(frame => frame.data.blocks?.some(block=>block.id===mined)));
    const rollbackHeight = (await rpc('getblockcount')) - 1;
    const rollbackStart = Date.now(); await rpc('invalidateblock',[mined]);
    await seen('canonical rollback snapshot',rollbackStart, frame=>frame.blocks?.length && frame.blocks.at(-1).height===rollbackHeight);
    await seen('transaction resurrection',rollbackStart, frame=>frame['mempool-txids']?.added.includes(child.id));
    await until('rollback convergence',async()=>!(await get(`tx/${child.id}`)).status.confirmed && await backendGet('blocks/tip/height')===rollbackHeight);
    const restoreStart=Date.now(); await rpc('reconsiderblock',[mined]);
    await seen('restored block',restoreStart,frame=>frame.block?.id===mined);
    pass('reconnect snapshot, lower-height rollback, resurrection and restoration through the real indexed backend');

    const burstStart=Date.now(); const burst=[];
    for(let i=0;i<3;i++)burst.push(await nextBlock());
    await seen('three-block catch-up',burstStart,frame=>frame.block?.id===burst.at(-1) || frame.blocks?.at(-1)?.id===burst.at(-1));
    await until('burst convergence',async()=>await get('blocks/tip/hash','text')===burst.at(-1) && await backendGet('blocks/tip/height')===await rpc('getblockcount'));
    pass('burst blocks converge across Core, Rust, backend and live feed');

    // A coinbase at exactly spend maturity becomes immature after one rollback.
    // This causes a real Core mempool eviction without a fixture or clear-pool RPC.
    const height=await rpc('getblockcount');
    const funding=(await rpc('getblock',[await rpc('getblockhash',[height-119]),2])).tx[0];
    const fundingVout=funding.vout.findIndex(output=>atomic(output.value)>1000000);
    assert.ok(fundingVout>=0);
    const evictionTx=await spend(funding.txid,fundingVout,atomic(funding.vout[fundingVout].value),address);
    await until('eviction candidate in live pool',()=>received.some(frame=>frame.data['mempool-txids']?.added.includes(evictionTx.id)));
    const evictionStart=Date.now(); await rpc('invalidateblock',[burst.at(-1)]);
    await seen('maturity-driven eviction',evictionStart,frame=>frame['mempool-txids']?.removed.includes(evictionTx.id));
    await seen('tracked address eviction',evictionStart,frame=>contains(frame['address-removed-transactions'],evictionTx.id));
    await until('eviction convergence',async()=>!(await rpc('getrawmempool')).includes(evictionTx.id) && !(await get('mempool/txids')).includes(evictionTx.id));
    await rpc('reconsiderblock',[burst.at(-1)]);
    pass('actual Core mempool eviction removes transactions from Rust and tracked address/live views');
    fs.writeFileSync(path.join(directory,'live-results.json'),JSON.stringify({latency,network:'regtest',height:await rpc('getblockcount'),finishedAt:new Date().toISOString()},null,2)+'\n');
  } finally { liveSocket?.terminate(); }
}
async function connectElectrum() {
  await until('Electrum listener', async () => {
    socket = net.createConnection({ host: '127.0.0.1', port: electrumPort });
    try { await once(socket, 'connect'); return true; }
    catch { socket.destroy(); return false; }
  });
  socket.setEncoding('utf8'); let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (value.id != null && pending.has(value.id)) { const pair = pending.get(value.id); pending.delete(value.id); value.error ? pair.reject(Error(JSON.stringify(value.error))) : pair.resolve(value.result); }
      else frames.push(value);
    }
  });
}
function electrum(method, params = []) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Electrum timeout ${method}`)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const atomic = coins => Math.round(Number(coins) * 1e6);
const hashScript = script => Buffer.from(crypto.createHash('sha256').update(Buffer.from(script, 'hex')).digest()).reverse().toString('hex');
async function spend(txid, vout, value, address) {
  const hex = await rpc('createrawtransaction', [[{ txid, vout }], { [address]: (value - 200000) / 1e6 }]);
  const signed = await rpc('signrawtransactionwithwallet', [hex]); assert.equal(signed.complete, true);
  return { id: await rpc('sendrawtransaction', [signed.hex, true]), hex: signed.hex, value: value - 200000 };
}
async function main() {
  assert.equal((await rpc('getblockchaininfo')).chain, 'regtest');
  assert.equal(await rpc('getblockhash', [0]), '65b4e101cacf3e1e4f3a9237e3a74ffd1186e595d8b78fa8ea22c21ef5bf9347');
  assert.equal(await rpc('getblockcount'), 0, 'Refusing mutations: Core regtest must initially be empty');
  directory = fs.mkdtempSync(path.join(datadir, 'index-acceptance-'));
  console.log(`Evidence: ${directory}`);
  const mining = await rpc('getnewaddress'), recipient = await rpc('getnewaddress'), destination = await rpc('getnewaddress');
  await rpc('generatetoaddress', [100, mining]); await rpc('generatetoaddress', [30, mining]);
  const first = (await rpc('getblock', [await rpc('getblockhash', [1]), 2])).tx[0];
  const vout = first.vout.findIndex(out => atomic(out.value) > 1000000);
  const amount = atomic(first.vout[vout].value);
  // Initial import exercises native blk*.dat parsing; restart uses RPC import.
  await startIndex(); await connectElectrum();
  const features = await electrum('server.features'); assert.equal(features.genesis_hash, await rpc('getblockhash', [0]));
  const genesis = await rpc('getblock', [await rpc('getblockhash', [0]), 2]);
  const genesisHash = hashScript(genesis.tx[0].vout[0].scriptPubKey.hex);
  assert.deepEqual(await electrum('blockchain.scripthash.listunspent', [genesisHash]), []);
  assert.equal((await get(`tx/${genesis.tx[0].txid}`)).txid, genesis.tx[0].txid);
  pass('native block-file import, genesis identity and exclusion of genesis outputs');
  const parent = await spend(first.txid, vout, amount, recipient);
  await until('mempool parent', async () => (await get(`tx/${parent.id}`)).status.confirmed === false);
  const parentDecoded = await rpc('decoderawtransaction', [parent.hex]);
  const scriptHash = hashScript(parentDecoded.vout[0].scriptPubKey.hex);
  await electrum('blockchain.scripthash.subscribe', [scriptHash]);
  await electrum('blockchain.headers.subscribe');
  assert.equal((await get(`address/${recipient}`)).mempool_stats.funded_txo_sum, parent.value);
  assert.equal((await electrum('blockchain.scripthash.get_balance', [scriptHash])).unconfirmed, parent.value);
  const tx = await get(`tx/${parent.id}`); assert.equal(tx.fee, 200000); assert.equal(tx.size * 4, tx.weight);
  assert.equal(tx.vout[0].scriptpubkey_address, recipient);
  assert.equal(await get(`tx/${parent.id}/hex`, 'text'), parent.hex);
  pass('unconfirmed history, exact atomic balance, fee, address and raw transaction');
  const parentBlock = (await rpc('generatetoaddress', [1, mining]))[0];
  await until('parent confirmation', async () => (await get(`tx/${parent.id}`)).status.block_hash === parentBlock);
  const child = await spend(parent.id, 0, parent.value, destination);
  const childBlock = (await rpc('generatetoaddress', [1, mining]))[0];
  await until('fully spent parent', async () => (await get(`tx/${parent.id}/outspend/0`)).status?.block_hash === childBlock);
  await until('confirmed transaction removed from mempool', async () => !(await get('mempool/txids')).includes(child.id));
  const stats = await get(`address/${recipient}`); assert.equal(stats.chain_stats.funded_txo_sum, parent.value); assert.equal(stats.chain_stats.spent_txo_sum, parent.value);
  assert.equal((await get(`address/${recipient}/utxo`)).length, 0);
  assert.ok((await get(`address/${recipient}/txs`)).some(tx => tx.txid === parent.id));
  assert.deepEqual(await electrum('blockchain.scripthash.get_balance', [scriptHash]), { confirmed: 0, unconfirmed: 0 });
  assert.equal((await electrum('blockchain.scripthash.get_history', [scriptHash])).length, 2);
  assert.equal(await electrum('blockchain.transaction.get', [parent.id]), parent.hex);
  assert.equal((await electrum('blockchain.transaction.get_merkle', [child.id, 132])).block_height, 132);
  assert.ok(frames.some(frame => frame.method === 'blockchain.headers.subscribe'));
  assert.ok(frames.some(frame => frame.method === 'blockchain.scripthash.subscribe'));
  const raw = await get(`block/${childBlock}/raw`, 'bytes'); assert.equal(raw.toString('hex'), await rpc('getblock', [childBlock, 0]));
  assert.ok((await get(`tx/${child.id}/merkleblock-proof`, 'text')).length > 160);
  pass('confirmed history, fully spent transaction lookup without txindex, spends, proofs and subscriptions');
  await stopIndex(); await startIndex(['--jsonrpc-import']); await connectElectrum();
  assert.equal(await electrum('blockchain.transaction.get', [parent.id]), parent.hex);
  assert.equal((await get(`tx/${parent.id}/outspend/0`)).txid, child.id);
  pass('persistent database restart and historical transaction recovery');
  await rpc('invalidateblock', [childBlock]);
  await until('rollback with resurrection', async () => (await get('blocks/tip/hash', 'text')) === parentBlock && (await get(`tx/${child.id}`)).status.confirmed === false);
  assert.equal((await get(`address/${recipient}`)).chain_stats.spent_txo_sum, 0);
  assert.equal((await get(`address/${recipient}`)).mempool_stats.spent_txo_sum, parent.value);
  assert.equal((await get(`tx/${parent.id}/outspend/0`)).status.confirmed, false);
  await rpc('reconsiderblock', [childBlock]);
  await until('restore', async () => (await get(`tx/${child.id}`)).status.block_hash === childBlock);
  await rpc('invalidateblock', [childBlock]);
  await until('rollback again', async () => (await get('blocks/tip/hash', 'text')) === parentBlock);
  const replacement = (await rpc('generatetoaddress', [1, mining]))[0]; assert.notEqual(replacement, childBlock);
  await until('same-height replacement', async () => (await get(`tx/${child.id}`)).status.block_hash === replacement);
  assert.equal((await get(`address/${recipient}`)).chain_stats.spent_txo_sum, parent.value);
  pass('rollback, mempool resurrection, restoration and same-height replacement');
  const source = (await rpc('getblock', [await rpc('getblockhash', [2]), 2])).tx[0];
  const sourceVout = source.vout.findIndex(out => atomic(out.value) > 1000000);
  const pubkey = (await rpc('getaddressinfo', [destination])).pubkey;
  assert.ok(pubkey);
  const multisig = await rpc('addmultisigaddress', [1, [pubkey]]);
  const p2sh = typeof multisig === 'string' ? multisig : multisig.address;
  const chainParent = await spend(source.txid, sourceVout, atomic(source.vout[sourceVout].value), recipient);
  const chainChild = await spend(chainParent.id, 0, chainParent.value, p2sh);
  await until('unconfirmed parent and child', async () => (await get('mempool/txids')).includes(chainChild.id));
  assert.equal((await get(`address/${p2sh}/utxo`))[0].value, chainChild.value);
  const p2shTx = await get(`tx/${chainChild.id}`);
  assert.equal(p2shTx.vout[0].scriptpubkey_type, 'p2sh');
  const p2shHash = hashScript(p2shTx.vout[0].scriptpubkey);
  assert.equal((await electrum('blockchain.scripthash.get_history', [p2shHash]))[0].height, -1);
  const together = (await rpc('generatetoaddress', [1, mining]))[0];
  await until('same-block child', async () => (await get(`tx/${chainChild.id}`)).status.block_hash === together && !(await get('mempool/txids')).includes(chainChild.id));
  assert.equal((await get(`tx/${chainParent.id}/outspend/0`)).txid, chainChild.id);
  assert.equal((await get(`address/${p2sh}`)).chain_stats.funded_txo_sum, chainChild.value);
  assert.equal((await get(`address/${p2sh}/utxo`))[0].status.block_hash, together);
  await rpc('invalidateblock', [together]);
  await until('same-block rollback', async () => (await get('blocks/tip/hash', 'text')) === replacement && !(await get(`tx/${chainChild.id}`)).status.confirmed);
  await rpc('reconsiderblock', [together]);
  await until('same-block restoration', async () => (await get(`tx/${chainChild.id}`)).status.block_hash === together);
  pass('unconfirmed parent-child chain, P2SH balances/UTXOs and intra-block spend reorganization');
  if (process.argv.includes('--pos')) {
    // The first two coinbases were spent above; mature another funding output
    // to Core's 720-confirmation createbond threshold.
    while (await rpc('getblockcount') < 723) await rpc('generatetoaddress', [Math.min(100, 723 - await rpc('getblockcount')), mining]);
    const bond = await rpc('createbond', [1000]);
    while (await rpc('getblockcount') < 1499) await rpc('generatetoaddress', [Math.min(100, 1499 - await rpc('getblockcount')), mining]);
    await until('last PoW index', async () => Number(await get('blocks/tip/height', 'text')) === 1499);
    const bondTx = await get(`tx/${bond.txid}`);
    assert.equal(bondTx.vout[bond.vout].value, 1000 * 1e6);
    assert.notEqual(bondTx.vout[bond.vout].scriptpubkey_type, 'op_return');
    const bondScriptHash = hashScript(bondTx.vout[bond.vout].scriptpubkey);
    assert.ok((await electrum('blockchain.scripthash.listunspent', [bondScriptHash])).some(utxo => utxo.tx_hash === bond.txid && utxo.tx_pos === bond.vout && utxo.value === 1000 * 1e6));
    const tip = await rpc('getbestblockhash'); const lastTime = (await rpc('getblockheader', [tip])).time;
    const firstSlot = (Math.floor(lastTime / 30) + 1) * 30;
    await rpc('setmocktime', [firstSlot]); const firstPos = await rpc('generatestake');
    await until('PoS activation', async () => (await get('blocks/tip/hash', 'text')) === firstPos);
    const block = await get(`block/${firstPos}`); assert.equal(block.proof_type, 'pos'); assert.equal(block.algorithm, null); assert.equal(block.difficulty, 0);
    assert.equal((await get(`block/${firstPos}/header`, 'text')).length, 224);
    assert.equal((await get(`block/${firstPos}/raw`, 'bytes')).toString('hex'), await rpc('getblock', [firstPos, 0]));
    const input = (await rpc('listunspent', [120])).find(coin => atomic(coin.amount) > 10000000000 && coin.scriptPubKey.startsWith('76a914'));
    assert.ok(input); const posSpend = await spend(input.txid, input.vout, atomic(input.amount), recipient);
    await until('replay-protected mempool tx', async () => (await get(`tx/${posSpend.id}`)).version === 0x05475658);
    await rpc('setmocktime', [firstSlot + 120 * 30]); const secondPos = await rpc('generatestake');
    await until('PoS confirmation', async () => (await get(`tx/${posSpend.id}`)).status.block_hash === secondPos);
    assert.equal((await get(`tx/${posSpend.id}`)).fee, 200000);
    assert.equal((await get(`block/${secondPos}/raw`, 'bytes')).toString('hex'), await rpc('getblock', [secondPos, 0]));
    await rpc('invalidateblock', [secondPos]);
    await until('PoS rollback', async () => (await get('blocks/tip/hash', 'text')) === firstPos && !(await get(`tx/${posSpend.id}`)).status.confirmed);
    await rpc('reconsiderblock', [secondPos]);
    await until('PoS restore', async () => (await get(`tx/${posSpend.id}`)).status.block_hash === secondPos);
    pass('PoS activation, bond indexing, replay marker, signed extension, fee-only reward and reorganization');
  }
  if (arg('backend-dir')) await checkBackend(recipient, parent, child);
  await stopIndex();
  await rejectsConfiguration(indexArgs(['--jsonrpc-import', '--index-unspendables']), /Incompatible database/, 'reject-database-mode');
  await rejectsConfiguration(indexArgs().map(value => value === '--network=regtest' ? '--network=mainnet' : value === `--daemon-dir=${datadir}` ? `--daemon-dir=${path.join(datadir, 'regtest')}` : value), /Verge daemon network mismatch/, 'reject-wrong-network');
  assert.equal(fs.existsSync(path.join(directory, 'verge-mainnet-v1/newindex')), false);
  await startIndex(['--jsonrpc-import']);
  assert.equal((await get(`tx/${parent.id}`)).txid, parent.id);
  const recoveredTip = await rpc('getbestblockhash');
  assert.equal((await get(`block/${recoveredTip}/raw`, 'bytes')).toString('hex'), await rpc('getblock', [recoveredTip, 0]));
  pass('wrong-network rejection before indexing, incompatible database rejection and unchanged index recovery');
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ checks, height: await rpc('getblockcount'), finishedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`All ${checks.length} index acceptance scenarios passed.`);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => { await stopBackend(); await stopIndex(); });
