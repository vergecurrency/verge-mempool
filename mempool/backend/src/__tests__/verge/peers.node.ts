import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVergePeers } from '../../api/verge/peers';

test('Verge peers expose only public display fields and last received message time', () => {
  const now = 1_800_000_000_000;
  const result = normalizeVergePeers([
    { addr: '8.8.8.8:21102', addrlocal: '192.168.1.4:21102', subver: '/verge:26.10.0/',
      lastrecv: 1_799_999_990, lastsend: 1_799_999_999, inbound: false, id: 42, banscore: 0 },
    { addr: '[2606:4700:4700::1111]:21102', subver: '/verge:26.9.0/', lastrecv: 0, inbound: true },
    { addr: '127.0.0.1:21102', subver: '/local/', lastrecv: 1_799_999_999 },
    { addr: '10.0.0.5:21102', subver: '/private/', lastrecv: 1_799_999_999 },
    { addr: '[fc00::1]:21102', subver: '/private/', lastrecv: 1_799_999_999 },
    { addr: '[::ffff:192.168.1.4]:21102', subver: '/private/', lastrecv: 1_799_999_999 },
  ], now);
  assert.equal(result.count, 2);
  assert.deepEqual(result.peers, [
    { address: '8.8.8.8:21102', direction: 'Outbound', lastSeen: 1_799_999_990_000, version: '/verge:26.10.0/' },
    { address: '[2606:4700:4700::1111]:21102', direction: 'Inbound', lastSeen: null, version: '/verge:26.9.0/' },
  ]);
  assert.equal(result.updatedAt, new Date(now).toISOString());
  assert.ok(!JSON.stringify(result).includes('addrlocal'));
  assert.ok(!JSON.stringify(result).includes('banscore'));
});

test('Verge peer parser rejects invalid responses and future timestamps', () => {
  assert.throws(() => normalizeVergePeers({ peers: [] }), /Invalid Verge peer response/);
  const result = normalizeVergePeers([{ addr: '1.1.1.1:21102', lastrecv: 1_800_000_120,
    subver: '/verge:<script>\n/' }], 1_800_000_000_000);
  assert.equal(result.peers[0].lastSeen, null);
  assert.equal(result.peers[0].version, '/verge:<script>/');
});
