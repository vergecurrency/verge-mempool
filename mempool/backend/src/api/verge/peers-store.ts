import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPublicVergePeerAddress, VergePeersSnapshot } from './peers';

export function vergePeerStorePath(network: string): string {
  const stateRoot = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const file = process.env.VERGE_PEERS_STORE_PATH || path.join(stateRoot, 'verge-mempool', `peers-${network}.json`);
  if (!path.isAbsolute(file)) { throw new Error('Verge peer store path must be absolute'); }
  return file;
}

export function loadVergePeerHistory(file: string): VergePeersSnapshot | null {
  let contents: string;
  try { contents = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; }
    throw error;
  }
  const stored = JSON.parse(contents);
  if (stored.version !== 1 || !stored.snapshot || !Array.isArray(stored.snapshot.peers)) {
    throw new Error('Invalid Verge peer history format');
  }
  const snapshot = stored.snapshot as VergePeersSnapshot;
  if (!Number.isSafeInteger(snapshot.count) || snapshot.count < 0 || snapshot.count > snapshot.peers.length
    || !Number.isSafeInteger(snapshot.privateLocalCount) || snapshot.privateLocalCount < 0
    || snapshot.knownCount !== snapshot.peers.length
    || typeof snapshot.updatedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.updatedAt))) {
    throw new Error('Invalid Verge peer history summary');
  }
  const addresses = new Set<string>();
  for (const peer of snapshot.peers) {
    if (!isPublicVergePeerAddress(peer.address) || addresses.has(peer.address)
      || !['Inbound', 'Outbound'].includes(peer.direction)
      || (peer.lastSeen !== null && (!Number.isSafeInteger(peer.lastSeen) || peer.lastSeen < 0))
      || typeof peer.version !== 'string' || peer.version.length > 80
      || typeof peer.smsgSupport !== 'boolean' || typeof peer.connected !== 'boolean') {
      throw new Error('Invalid Verge peer history entry');
    }
    addresses.add(peer.address);
  }
  return snapshot;
}

/** Replace the complete state atomically so a crash cannot truncate peer history. */
export function saveVergePeerHistory(file: string, snapshot: VergePeersSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o640);
    fs.writeFileSync(descriptor, JSON.stringify({ version: 1, snapshot }) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) { fs.closeSync(descriptor); }
    if (fs.existsSync(temporary)) { fs.unlinkSync(temporary); }
  }
}
