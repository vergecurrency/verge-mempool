// Controlled Core/Electrum protocol integration. HTTP, SQL, mining analytics and script rendering are isolated.
require('./register-typescript.cjs');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const assert = require('assert/strict');
const { JsonRPC } = require('../src/rpc-api/jsonrpc.ts');
const { Client } = require('../src/rpc-api/index.ts');
const { parseVergeRpcJson, coinToAtomic, coinToAtomicNumber, atomicToCoin } = require('../src/api/verge/amounts.ts');
const { adaptVergeRpcClient } = require('../src/api/verge/rpc.ts');
const { vergeProfile } = require('../src/api/verge/chain-profile.ts');
const { scriptHashForElectrum } = require('../src/api/verge/electrum-utils.ts');
const { doubleSha256 } = require('../src/api/verge/codec.ts');
const { importWithDependencies } = require('../src/__tests__/verge/module-harness.ts');
const { connectElectrumProbe, probeElectrum } = require('../src/api/verge/electrum-probe.ts');
const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!argument('datadir')) { throw new Error('Select a fresh isolated regtest data directory with --datadir=PATH'); }
const port = Number(argument('rpc-port') || '20337');
if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error('Invalid RPC port'); }
const options = { host: '127.0.0.1', port, cookie: path.join(path.resolve(argument('datadir')), 'regtest', '.cookie'), timeout: 120000, parseResponse: parseVergeRpcJson };
const wire = new JsonRPC(options);
const rpc = (method, params = []) => wire.call(method, params);
const core = adaptVergeRpcClient(new Client(options));
const profile = vergeProfile('regtest');
const txidQueries = [];
const coreQueries = new Proxy(core, { get(target, name) {
  if (name === 'getRawTransaction') { return (...params) => { txidQueries.push(params); return target.getRawTransaction(...params); }; }
  return target[name];
} });
const certificate = argument('tls-cert') ? fs.readFileSync(path.resolve(argument('tls-cert'))) : undefined;
const key = argument('tls-key') ? fs.readFileSync(path.resolve(argument('tls-key'))) : undefined;
if (Boolean(certificate) !== Boolean(key)) { throw new Error('Both TLS certificate and key are required'); }

async function waitUntil(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() >= deadline) { throw new Error('Electrum connection did not become ready'); } await new Promise(done => setTimeout(done, 25)); }
}
function merkleBranch(txids, position) {
  let nodes = txids.map(id => Buffer.from(id, 'hex').reverse());
  const branch = [];
  while (nodes.length > 1) {
    if (nodes.length % 2) { nodes.push(nodes[nodes.length - 1]); }
    branch.push(Buffer.from(nodes[position ^ 1]).reverse().toString('hex'));
    const next = [];
    for (let index = 0; index < nodes.length; index += 2) { next.push(doubleSha256(Buffer.concat([nodes[index], nodes[index + 1]]))); }
    nodes = next; position = Math.floor(position / 2);
  }
  return branch;
}

async function main() {
  assert.equal((await rpc('getblockchaininfo')).chain, 'regtest');
  assert.equal(await rpc('getblockhash', [0]), profile.genesis);
  assert.equal(await rpc('getblockcount'), 0, 'Use a fresh regtest node started with -txindex=0');
  const miningAddress = await rpc('getnewaddress');
  const firstAddress = await rpc('getnewaddress');
  const secondAddress = await rpc('getnewaddress');
  await rpc('generatetoaddress', [100, miningAddress]); await rpc('generatetoaddress', [30, miningAddress]);
  const originalBlock = await rpc('getblock', [await rpc('getblockhash', [1]), 2]);
  const original = originalBlock.tx[0];
  const spendable = original.vout.findIndex(output => coinToAtomic(output.value) > 1000000n);
  assert.ok(spendable >= 0);
  async function spend(txid, vout, amount, address) {
    const hex = await rpc('createrawtransaction', [[{ txid, vout }], { [address]: Number(atomicToCoin(amount - 200000n)) }]);
    const signed = await rpc('signrawtransactionwithwallet', [hex]);
    assert.equal(signed.complete, true);
    const id = await rpc('sendrawtransaction', [signed.hex, true]);
    const blockhash = (await rpc('generatetoaddress', [1, miningAddress]))[0];
    return { txid: id, hex: signed.hex, blockhash, block: await rpc('getblock', [blockhash, 2]) };
  }
  const originalAmount = coinToAtomic(original.vout[spendable].value);
  const parent = await spend(original.txid, spendable, originalAmount, firstAddress);
  const child = await spend(parent.txid, 0, originalAmount - 200000n, secondAddress);
  // Fully spending the parent removes the slow UTXO-assisted transaction lookup too.
  await assert.rejects(rpc('getrawtransaction', [parent.txid, true]), /txindex/);
  assert.equal((await rpc('getrawtransaction', [parent.txid, true, parent.blockhash])).txid, parent.txid);
  const scripts = await Promise.all([firstAddress, secondAddress].map(address => rpc('validateaddress', [address])));
  const hashes = scripts.map(info => scriptHashForElectrum(info.scriptPubKey));
  const outputValue = (originalAmount - 400000n).toString();
  const raw = new Map([[original.txid, original.hex], [parent.txid, parent.hex], [child.txid, child.hex]]);
  const rawRequests = [];
  let childConfirmed = true;
  let featureRequests = 0;
  const sockets = new Set();
  let adapter;
  async function response(method, params) {
    switch (method) {
      case 'server.version': return ['controlled-regtest', '1.4'];
      case 'server.features': featureRequests++; return { genesis_hash: profile.genesis, hash_function: 'sha256' };
      case 'server.ping': return null;
      case 'blockchain.headers.subscribe': {
        const height = childConfirmed ? 132 : 131;
        return { height, hex: await rpc('getblockheader', [await rpc('getblockhash', [height]), false]) };
      }
      case 'blockchain.block.header': return rpc('getblockheader', [await rpc('getblockhash', [params[0]]), false]);
      case 'blockchain.scripthash.get_history':
        return params[0] === hashes[0] ? [{ tx_hash: parent.txid, height: 131 }, { tx_hash: child.txid, height: childConfirmed ? 132 : 0 }] : params[0] === hashes[1] ? [{ tx_hash: child.txid, height: childConfirmed ? 132 : 0 }] : [];
      case 'blockchain.scripthash.get_balance':
        if (params[0] === hashes[1]) { return { confirmed: childConfirmed ? Number(outputValue) : 0, unconfirmed: childConfirmed ? 0 : Number(outputValue) }; }
        return { confirmed: childConfirmed ? 0 : Number(originalAmount - 200000n), unconfirmed: childConfirmed ? 0 : -Number(originalAmount - 200000n) };
      case 'blockchain.scripthash.listunspent':
        return params[0] === hashes[1] ? [{ tx_hash: child.txid, tx_pos: 0, height: childConfirmed ? 132 : 0, value: Number(outputValue) }] : [];
      case 'blockchain.transaction.get':
        rawRequests.push(params[0]);
        if (!raw.has(params[0])) { throw new Error('Unknown controlled transaction'); }
        return raw.get(params[0]);
      case 'blockchain.transaction.get_merkle':
        assert.equal(childConfirmed, true); assert.equal(params[0], child.txid); assert.equal(params[1], 132);
        return { block_height: 132, pos: child.block.tx.findIndex(tx => tx.txid === child.txid), merkle: merkleBranch(child.block.tx.map(tx => tx.txid), child.block.tx.findIndex(tx => tx.txid === child.txid)) };
      default: throw new Error(`Unexpected controlled method: ${method}`);
    }
  }
  const accept = socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        void response(request.method, request.params).then(result => socket.write(JSON.stringify({ id: request.id, result }) + '\n')).catch(error => socket.write(JSON.stringify({ id: request.id, error: { code: -1, message: error.message } }) + '\n'));
      }
    });
  };
  const server = certificate ? tls.createServer({ cert: certificate, key }, accept) : net.createServer(accept);
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  try {
    const cache = new Map();
    const { default: CoreApi } = importWithDependencies(path.resolve(__dirname, '../src/api/bitcoin/bitcoin-api.ts'), {
      '../blocks': { getBlocks: () => [], getCurrentBlockHeight: () => 132 },
      '../mempool': { getMempool: () => ({}), isInSync: () => true, getSpendMap: () => new Map() },
      '../transaction-utils': { convertScriptSigAsm: hex => hex, addInnerScriptsToVin: () => {} },
      '../common': { Common: { getTransactionFlags: () => 0 } }, '../../indexer': { isCoreIndexReady: () => null },
      '../verge/runtime': { isVerge: true, rpcCoinToAtomic: coinToAtomicNumber },
    });
    const electrumSource = argument('client-source');
    const ElectrumClient = electrumSource ? require(path.resolve(electrumSource)) : require('@mempool/electrum-client');
    const fingerprint = certificate ? crypto.createHash('sha256').update(new crypto.X509Certificate(certificate).raw).digest('hex') : '';
    const { default: ElectrumApi } = importWithDependencies(path.resolve(__dirname, '../src/api/bitcoin/electrum-api.ts'), {
      '../../config': { ELECTRUM: { HOST: '127.0.0.1', PORT: server.address().port, TLS_ENABLED: Boolean(certificate), TLS_CERTIFICATE_FINGERPRINT: fingerprint, MAX_BEHIND_TIP: 0 } },
      '@mempool/electrum-client': ElectrumClient, './bitcoin-api': CoreApi,
      '../../logger': { info: () => {}, err: message => console.error(message), debug: () => {} },
      '../verge/runtime': { isVerge: true, activeVergeProfile: profile }, '../loading-indicators': { setProgress: () => {} },
      '../memory-cache': { get: (type, key) => cache.get(`${type}:${key}`), set: (type, key, value) => cache.set(`${type}:${key}`, value) },
    });
    adapter = new ElectrumApi(coreQueries);
    await waitUntil(() => adapter.chainVerified);
    const history = await adapter.$getAddressTransactions(secondAddress);
    assert.equal(history.length, 1); assert.equal(history[0].fee, 200000); assert.equal(history[0].status.block_height, 132);
    assert.equal(history[0].vin[0].prevout.value, Number(originalAmount - 200000n));
    assert.ok(rawRequests.includes(parent.txid));
    assert.ok(txidQueries.some(query => query[0] === child.txid && query[2] === child.blockhash));
    assert.equal((await adapter.$getAddress(secondAddress)).chain_stats.funded_txo_sum, Number(outputValue));
    assert.equal((await adapter.$getAddressUtxos(secondAddress))[0].value, Number(outputValue));
    assert.equal((await adapter.$getTransactionMerkleProof(child.txid)).block_height, 132);
    const probe = await connectElectrumProbe('127.0.0.1', server.address().port, Boolean(certificate), 2000, fingerprint);
    try {
      const observation = await probeElectrum(probe, profile, scripts[1].scriptPubKey, height => rpc('getblockhash', [height]));
      assert.equal(observation.comparedWithCore, true); assert.equal(observation.addressSample.confirmed, outputValue);
    } finally { probe.close(); }
    if (certificate) {
      await assert.rejects(connectElectrumProbe('127.0.0.1', server.address().port, true, 2000, '0'.repeat(64)), /fingerprint mismatch/);
      await assert.rejects(connectElectrumProbe('127.0.0.1', server.address().port, true, 2000), /certificate/i);
    }
    await adapter.$getAddressTransactions(firstAddress);
    assert.deepEqual(await adapter.$getOutspend(parent.txid, 0), { spent: true });
    await rpc('invalidateblock', [child.blockhash]); assert.ok((await rpc('getrawmempool')).includes(child.txid));
    childConfirmed = false;
    const generation = adapter.connectionGeneration;
    for (const socket of sockets) { socket.destroy(); }
    await waitUntil(() => adapter.chainVerified && adapter.connectionGeneration > generation);
    assert.equal((await adapter.$getAddressTransactions(secondAddress))[0].status.confirmed, false);
    assert.equal((await adapter.$getAddress(secondAddress)).mempool_stats.funded_txo_sum, Number(outputValue));
    assert.equal((await adapter.$getAddressUtxos(secondAddress))[0].status.confirmed, false);
    await assert.rejects(adapter.$getTransactionMerkleProof(child.txid), /unconfirmed/);
    await rpc('reconsiderblock', [child.blockhash]); assert.equal((await rpc('getrawmempool')).length, 0);
    childConfirmed = true;
    const previousGeneration = adapter.connectionGeneration;
    for (const socket of sockets) { socket.destroy(); }
    await waitUntil(() => adapter.chainVerified && adapter.connectionGeneration > previousGeneration);
    assert.equal((await adapter.$getAddressTransactions(secondAddress))[0].status.block_height, 132);
    const result = { network: 'regtest', coreTxindex: false, height: 132, tls: Boolean(certificate), featureRequests, rawPrevoutFallbacks: rawRequests.filter(txid => txid !== child.txid).length,
      checks: ['confirmed history with Core block hint', 'fully-spent prevout without txindex', 'exact address net balance', 'UTXO lookup', 'Core-verified merkle proof', 'Core tip agreement', 'diagnostic protocol and TLS validation', 'spent output without fabricated confirmed spender', 'reconnect identity checks', 'rollback unconfirmed history/balance/UTXO', 'restored confirmed history'] };
    const output = path.resolve(__dirname, '../.local'); fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'electrum-regtest-results.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    adapter?.electrumClient.close();
    for (const socket of sockets) { socket.destroy(); }
    await new Promise(done => server.close(done));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
