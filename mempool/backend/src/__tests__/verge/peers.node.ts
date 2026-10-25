import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeVergePeerHistory, normalizeVergePeers } from '../../api/verge/peers';
import { loadVergePeerHistory, saveVergePeerHistory } from '../../api/verge/peers-store';

test('Verge peers expose only public display fields and last received message time', () => {
  const now = 1_800_000_000_000;
  const result = normalizeVergePeers([
    { addr: '8.8.8.8:21102', addrlocal: '192.168.1.4:21102', subver: '/verge:26.10.0/',
      lastrecv: 1_799_999_990, lastsend: 1_799_999_999, inbound: false, id: 42, banscore: 0,
      services: '0000000001000001' },
    { addr: '[2606:4700:4700::1111]:21102', subver: '/verge:26.9.0/', lastrecv: 0, inbound: true,
      services: '0000000000000001' },
    { addr: '127.0.0.1:21102', subver: '/local/', lastrecv: 1_799_999_999 },
    { addr: '10.0.0.5:21102', subver: '/private/', lastrecv: 1_799_999_999 },
    { addr: '[fc00::1]:21102', subver: '/private/', lastrecv: 1_799_999_999 },
    { addr: '[::ffff:192.168.1.4]:21102', subver: '/private/', lastrecv: 1_799_999_999 },
  ], now);
  assert.equal(result.count, 2);
  assert.equal(result.privateLocalCount, 4);
  assert.equal(result.knownCount, 2);
  assert.deepEqual(result.peers, [
    { address: '8.8.8.8:21102', direction: 'Outbound', lastSeen: 1_799_999_990_000, version: '/verge:26.10.0/', smsgSupport: true, connected: true },
    { address: '[2606:4700:4700::1111]:21102', direction: 'Inbound', lastSeen: null, version: '/verge:26.9.0/', smsgSupport: false, connected: true },
  ]);
  assert.equal(result.updatedAt, new Date(now).toISOString());
  assert.ok(!JSON.stringify(result).includes('addrlocal'));
  assert.ok(!JSON.stringify(result).includes('banscore'));
});

test('Verge peer parser rejects invalid responses and future timestamps', () => {
  assert.throws(() => normalizeVergePeers({ peers: [] }), /Invalid Verge peer response/);
  const result = normalizeVergePeers([{ addr: '1.1.1.1:21102', lastrecv: 1_800_000_120,
    subver: '/verge:<script>\n/' }, { addr: 'garbage' }], 1_800_000_000_000);
  assert.equal(result.privateLocalCount, 0);
  assert.equal(result.peers[0].lastSeen, null);
  assert.equal(result.peers[0].version, '/verge:<script>/');
  assert.equal(result.peers[0].smsgSupport, false);
});

test('Verge SMSG support requires a valid advertised service bit', () => {
  const services = ['01000000', '0000000001000000', '0000000001000001',
    '0000000000000001', 'not-hex', '10000000000000000'];
  const result = normalizeVergePeers(services.map((service, index) => ({
    addr: `1.1.1.${index + 1}:21102`, services: service,
  })));
  assert.deepEqual(result.peers.map(peer => peer.smsgSupport), [true, true, true, false, false, false]);
});

test('Verge peer history retains disconnected public peers and last message times', () => {
  const before = normalizeVergePeers([
    { addr: '8.8.8.8:21102', lastrecv: 1_799_999_990, subver: '/verge:26.10/', services: '01000001' },
    { addr: '1.1.1.1:21102', lastrecv: 1_799_999_980, subver: '/verge:26.9/', services: '1' },
    { addr: '127.0.0.1:21102' },
  ], 1_800_000_000_000);
  const now = normalizeVergePeers([
    { addr: '8.8.8.8:21102', lastrecv: 1_799_999_985, subver: '/verge:26.11/', services: '1' },
    { addr: '9.9.9.9:21102', lastrecv: 1_799_999_999, subver: '/verge:26.11/', services: '01000001' },
  ], 1_800_000_010_000);
  const merged = mergeVergePeerHistory(before, now);
  assert.equal(merged.count, 2);
  assert.equal(merged.knownCount, 3);
  assert.equal(merged.privateLocalCount, 0);
  assert.deepEqual(merged.peers.map(peer => [peer.address, peer.connected]), [
    ['9.9.9.9:21102', true], ['8.8.8.8:21102', true], ['1.1.1.1:21102', false],
  ]);
  assert.equal(merged.peers[1].lastSeen, 1_799_999_990_000, 'last message time never moves backward');
  assert.equal(merged.peers[1].smsgSupport, false, 'current advertisement replaces an old advertisement');
  assert.ok(!JSON.stringify(merged).includes('127.0.0.1'));
});

test('Verge peer history survives a file round trip and refuses malformed state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'verge-peers-test-'));
  const file = join(directory, 'peers.json');
  try {
    assert.equal(loadVergePeerHistory(file), null);
    const snapshot = normalizeVergePeers([{ addr: '8.8.8.8:21102', lastrecv: 1_799_999_990,
      subver: '/verge:26.10/', services: '01000001' }, { addr: '10.0.0.1:21102' }], 1_800_000_000_000);
    saveVergePeerHistory(file, snapshot);
    assert.deepEqual(loadVergePeerHistory(file), snapshot);
    assert.ok(!readFileSync(file, 'utf8').includes('10.0.0.1'));
    assert.deepEqual(mergeVergePeerHistory(loadVergePeerHistory(file), normalizeVergePeers([], 1_800_000_010_000)).peers.map(peer => peer.connected), [false]);
    writeFileSync(file, '{broken');
    assert.throws(() => loadVergePeerHistory(file));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
