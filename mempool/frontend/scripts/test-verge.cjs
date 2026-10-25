const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
let ts;
try { ts = require('typescript'); }
catch { ts = require('../../backend/node_modules/typescript'); }
function loadShared(name) {
  const file = path.resolve(__dirname, '../src/app/shared/' + name + '.ts');
  const loaded = new Module(file, module);
  loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText, file);
  return loaded.exports;
}
const { canonicalBlockWindow, matchesBlockExtension, snapshotChangesBranch, chainDisplay, formatVergeAmount, assertSafeVergeAmounts, vergeAddressType, assertVergeChainIdentity } = loadShared('chain-profile');
const { AddressStats } = loadShared('address-stats');
const { sortVergePeers } = loadShared('verge-peers');

test('peer columns sort naturally by address and advertised version, and chronologically by last message', () => {
  const peer = (address, version, lastSeen) => ({ address, direction: 'Outbound', version, lastSeen });
  const peers = [peer('10.0.0.2:21102', '/verge:26.10.0/', null),
    peer('2.0.0.2:21102', '/verge:8.3.0/', 2000),
    peer('8.0.0.2:21102', '/verge:26.8.0/', 1000)];
  assert.deepEqual(sortVergePeers(peers, 'address', 'asc').map(p => p.address),
    ['2.0.0.2:21102', '8.0.0.2:21102', '10.0.0.2:21102']);
  assert.deepEqual(sortVergePeers(peers, 'version', 'asc').map(p => p.version),
    ['/verge:8.3.0/', '/verge:26.8.0/', '/verge:26.10.0/']);
  assert.deepEqual(sortVergePeers(peers, 'lastSeen', 'desc').map(p => p.lastSeen), [2000, 1000, null]);
  assert.deepEqual(sortVergePeers(peers, 'lastSeen', 'asc').map(p => p.lastSeen), [1000, 2000, null]);
  assert.equal(peers[0].address, '10.0.0.2:21102', 'sorting does not mutate the latest snapshot');
});

test('SMSG peer sorting places supporting peers first on the first click', () => {
  const peers = [
    { address: 'z.onion:21102', smsgSupport: false },
    { address: 'b.onion:21102', smsgSupport: true },
    { address: 'a.onion:21102', smsgSupport: true },
  ];
  assert.deepEqual(sortVergePeers(peers, 'smsgSupport', 'desc').map(p => p.address),
    ['a.onion:21102', 'b.onion:21102', 'z.onion:21102']);
  assert.deepEqual(sortVergePeers(peers, 'smsgSupport', 'asc').map(p => p.address),
    ['z.onion:21102', 'a.onion:21102', 'b.onion:21102']);
});

test('canonical rollback snapshots lower the tip and leave response arrays intact', () => {
  const before = [{ id:'a',height:10 }, { id:'b',height:11 }, { id:'c',height:12 }];
  const copy = JSON.stringify(before);
  assert.deepEqual(canonicalBlockWindow(before, 8).map(b => b.id), ['c','b','a']);
  assert.equal(JSON.stringify(before), copy);
  assert.deepEqual(canonicalBlockWindow(before.slice(0,2), 8).map(b => b.id), ['b','a']);
  assert.deepEqual(canonicalBlockWindow([], 8), []);
});
test('same-height replacement and catch-up use the new canonical snapshot', () => {
  assert.deepEqual(canonicalBlockWindow([{id:'replacement',height:12},{id:'b',height:11}],1).map(b=>b.id), ['replacement']);
  const tip={id:'a',height:10};
  assert.equal(matchesBlockExtension(tip,{id:'b',height:11,previousblockhash:'a'}),true);
  assert.equal(matchesBlockExtension(tip,{id:'fork',height:11,previousblockhash:'other'}),false);
  assert.equal(matchesBlockExtension(tip,{id:'gap',height:12,previousblockhash:'a'}),false);
});
test('the chain profile uses six XVG decimals and a 30-second target', () => {
  assert.equal(chainDisplay('verge').unitsPerCoin,1000000);
  assert.equal(chainDisplay('verge').targetBlockSeconds,30);
  assert.equal(chainDisplay('bitcoin').unitsPerCoin,100000000);
  assert.throws(()=>chainDisplay('unknown'));
});

test('live chain identity refuses mismatched network, genesis and amount scale', () => {
  const core = {chain:'verge',network:'testnet',genesis:'000005e0bb94e3a30a565d1a14ad95a189d47ca45c5bbbe48ee7a32eab8cb980',decimals:6,unitsPerCoin:1000000};
  assertVergeChainIdentity(core,'testnet');
  assert.throws(()=>assertVergeChainIdentity(core,'mainnet'));
  assert.throws(()=>assertVergeChainIdentity({...core,genesis:'0'.repeat(64)},'testnet'));
  assert.throws(()=>assertVergeChainIdentity({...core,unitsPerCoin:100000000},'testnet'));
  assert.throws(()=>assertVergeChainIdentity({...core,decimals:8},'testnet'));
  assert.throws(()=>assertVergeChainIdentity(undefined,'testnet'));
});
test('branch changes invalidate confirmed address and transaction views, while a normal extension does not', () => {
  const tip={id:'b',height:11};
  assert.equal(snapshotChangesBranch(tip,[{id:'c',height:12},tip]),false);
  assert.equal(snapshotChangesBranch(tip,[{id:'a',height:10}]),true);
  assert.equal(snapshotChangesBranch(tip,[{id:'fork',height:11}]),true);
  assert.equal(snapshotChangesBranch(tip,[]),true);
});
test('XVG formatting preserves single atoms and exact decimal digits near numeric limits', () => {
  assert.equal(formatVergeAmount(1),'0.000001');
  assert.equal(formatVergeAmount(-200000),'-0.200000');
  assert.equal(formatVergeAmount(Number.MAX_SAFE_INTEGER),'9007199254.740991');
  assert.equal(formatVergeAmount('16555000000000000'),'16555000000.000000');
  assert.equal(formatVergeAmount(Number.MAX_SAFE_INTEGER+1),null);
  assert.equal(formatVergeAmount(0.1),null);
  assert.equal(formatVergeAmount('1e6'),null);
});
test('HTTP and socket money checks reject rounded numbers while preserving fee rates', () => {
  assertSafeVergeAmounts({block:{extras:{reward:200000}},fees:{fastestFee:0.01},vout:[{value:123456}]});
  assert.throws(()=>assertSafeVergeAmounts({tx:{vout:[{value:Number.MAX_SAFE_INTEGER+1}]}}));
  assert.throws(()=>assertSafeVergeAmounts({chain_stats:{funded_txo_sum:1.1}}));
  assertSafeVergeAmounts({minimumRelayPerChunkAtomic:'100000'});
});

test('Verge address display classifies actual Core fixtures and all network version bytes', () => {
  assert.equal(vergeAddressType('oJNHMsjPms1CigAo2mwXrnqXh1Mn1KAkaK','testnet'),'p2pkh');
  assert.equal(vergeAddressType('n48JHfc9qN3DfUMyYGxkeLQuYgTGRdyMKj','regtest'),'p2pkh');
  // Independently Base58Check-encoded zero-hash payloads for each Core version.
  for (const [network,address,type] of [
    ['mainnet','D596YFweJQuHY1BbjazZYmAbt8jJPbKehC','p2pkh'],
    ['mainnet','EH9uVaqWRxHuzJbroqzX18yxmeW8XVJyV9','p2sh'],
    ['testnet','oGsNEVH8ekHm3r2xpFJemRJUP1dUrQ9Tgo','p2pkh'],
    ['testnet','2NfvRxW23aikUvpc9r4x71ptmct1mnVAMDo','p2sh'],
    ['regtest','mfWxJ45yp2SFn7UciZyNpvDKrzbhyfKrY8','p2pkh'],
    ['regtest','2MsFDzHRUAMpjHxKyoEHU3aMCMsVtMqs1PV','p2sh'],
  ]) assert.equal(vergeAddressType(address,network),type);
  assert.equal(vergeAddressType('2NfvRxW23aikUvpc9r4x71ptmct1mnVAMDo','regtest'),'unknown');
  assert.equal(vergeAddressType('bc1qexample','mainnet'),'unknown');
  assert.equal(vergeAddressType('0invalid','testnet'),'unknown');
});

test('live coinbase address counters tolerate absent prevouts and reverse on removal', () => {
  const initial = {funded_txo_count:0,funded_txo_sum:0,spent_txo_count:0,spent_txo_sum:0,tx_count:0};
  const stats = new AddressStats(initial, 'recipient');
  const coinbase = {vin:[{is_coinbase:true}],vout:[{scriptpubkey:'76a9',scriptpubkey_address:'recipient',value:200000000000}]};
  stats.addTx(coinbase);
  assert.equal(stats.balance,200000000000); assert.equal(stats.utxos,1); assert.equal(stats.tx_count,1);
  stats.removeTx(coinbase);
  assert.equal(stats.balance,0); assert.equal(stats.utxos,0); assert.equal(stats.tx_count,0);
  assert.deepEqual(initial,{funded_txo_count:0,funded_txo_sum:0,spent_txo_count:0,spent_txo_sum:0,tx_count:0});
});

test('live P2PK balances match scripts without an address field and count spends/change exactly', () => {
  const initial = {funded_txo_count:1,funded_txo_sum:200000000000,spent_txo_count:0,spent_txo_sum:0,tx_count:1};
  const script = '2103c228f17f44000574d4af876f9908458a9fe769408c3384bdcb211f592e514f0eac';
  const stats = new AddressStats(initial, script.slice(2,-2), script);
  const spend = {vin:[{prevout:{scriptpubkey:script,value:200000000000}},{prevout:{scriptpubkey:'other',value:10}}],
    vout:[{scriptpubkey:script,value:199999800000},{scriptpubkey:'other',value:1}]};
  stats.addTx(spend);
  assert.equal(stats.balance,199999800000); assert.equal(stats.utxos,1); assert.equal(stats.tx_count,2);
  stats.removeTx(spend);
  assert.equal(stats.balance,200000000000); assert.equal(stats.utxos,1); assert.equal(stats.tx_count,1);
});
