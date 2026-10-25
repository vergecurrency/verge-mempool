import { BlockList, isIP } from 'node:net';

export interface VergePeer {
  address: string;
  direction: 'Inbound' | 'Outbound';
  lastSeen: number | null;
  version: string;
}

export interface VergePeersSnapshot {
  count: number;
  updatedAt: string;
  peers: VergePeer[];
}

const privateAddresses = new BlockList();
for (const [subnet, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
] as const) {
  privateAddresses.addSubnet(subnet, prefix, family);
}

function safeVisibleCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code > 32 && code !== 127;
}

function publicAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 255 || !Array.from(value).every(safeVisibleCharacter)) { return null; }
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(value);
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) { return null; }
  const host = match[1] || match[2];
  const family = isIP(host);
  if (family === 4 || family === 6) {
    const mapped = host.toLowerCase().startsWith('::ffff:') ? host.slice(7) : null;
    if (mapped && isIP(mapped) === 4) {
      if (privateAddresses.check(mapped, 'ipv4')) { return null; }
    } else if (privateAddresses.check(host, family === 4 ? 'ipv4' : 'ipv6')) { return null; }
  } else if (!/^[a-z2-7]{16,56}\.onion$/i.test(host) && !/^[a-z2-7]{52}\.b32\.i2p$/i.test(host)) {
    return null;
  }
  return value;
}

/** Only expose display fields from Core getpeerinfo. lastrecv is the last message heard from a peer. */
export function normalizeVergePeers(raw: unknown, now = Date.now()): VergePeersSnapshot {
  if (!Array.isArray(raw)) { throw new Error('Invalid Verge peer response'); }
  const peers: VergePeer[] = [];
  for (const peer of raw) {
    const address = publicAddress(peer?.addr);
    if (!address) { continue; }
    const lastrecv = peer.lastrecv;
    const lastSeen = Number.isSafeInteger(lastrecv) && lastrecv > 0 && lastrecv * 1000 <= now + 60_000
      ? lastrecv * 1000 : null;
    const advertised: string = typeof peer.subver === 'string' ? peer.subver : '';
    const subver = Array.from(advertised).filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').slice(0, 80);
    peers.push({ address, direction: peer.inbound === true ? 'Inbound' : 'Outbound',
      lastSeen, version: subver || 'Unknown' });
  }
  peers.sort((a, b) => (b.lastSeen ?? -1) - (a.lastSeen ?? -1) || a.address.localeCompare(b.address));
  return { count: peers.length, updatedAt: new Date(now).toISOString(), peers };
}
