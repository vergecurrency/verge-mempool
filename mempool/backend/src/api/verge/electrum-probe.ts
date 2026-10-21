import { connect as connectTcp, Socket, isIP } from 'net';
import { connect as connectTls, TLSSocket } from 'tls';
import { VergeChainProfile } from './chain-profile';
import { assertElectrumGenesis, scriptHashForElectrum } from './electrum-utils';
import { parseVergeRpcJson } from './amounts';
import { decodeVergeHeader, decodeVergeTransaction, doubleSha256 } from './codec';
import { assertElectrumTlsPeer } from './electrum-tls';

export interface ElectrumProbeClient {
  request(method: string, params: unknown[]): Promise<any>;
}

/** A bounded diagnostic transport with certificate verification and no transaction broadcast methods. @asyncUnsafe */
export async function connectElectrumProbe(host: string, port = 50002, tls = true, timeout = 10000, fingerprint = '') {
  if (fingerprint && !tls) { throw new Error('An Electrum certificate fingerprint requires TLS'); }
  const socket: Socket = tls ? connectTls({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: !fingerprint }) : connectTcp({ host, port });
  socket.setEncoding('utf8');
  let sequence = 0;
  let buffer = '';
  let closed = false;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (error: Error) => {
    closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('Electrum connection closed')));
  socket.on('data', data => {
    buffer += data.toString('utf8');
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { socket.destroy(new Error('Electrum response exceeds diagnostic limit')); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) { continue; }
      try {
        const response = parseVergeRpcJson(line);
        const request = pending.get(response.id);
        if (!request) { continue; } // Subscription notifications are not RPC responses.
        clearTimeout(request.timer); pending.delete(response.id);
        if (response.error) { request.reject(new Error(`Electrum RPC ${response.error.code}: ${response.error.message}`)); }
        else { request.resolve(response.result); }
      } catch { socket.destroy(new Error('Invalid Electrum JSON response')); return; }
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Electrum connection timeout')); }, timeout);
    socket.once(tls ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      try {
        if (tls) { assertElectrumTlsPeer(socket as TLSSocket, host, fingerprint); }
        resolve();
      } catch (error) { socket.destroy(); reject(error); }
    });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return {
    request(method: string, params: unknown[]): Promise<any> {
      if (closed) { return Promise.reject(new Error('Electrum connection closed')); }
      if (!/^(server\.(version|features)|blockchain\.(headers\.subscribe|block\.header|transaction\.(get|get_merkle)|scripthash\.(get_balance|get_history|listunspent)))$/.test(method)) {
        return Promise.reject(new Error('Method is outside the read-only Electrum diagnostic'));
      }
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Electrum ${method} timeout`)); socket.destroy(); }, timeout);
        pending.set(id, { resolve, reject, timer });
        socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    close(): void { socket.destroy(); },
  };
}

export function verifyElectrumMerkle(txid: string, proof: { merkle: string[]; pos: number }, merkleRoot: string): void {
  if (!/^[a-f\d]{64}$/i.test(txid) || !Array.isArray(proof.merkle) || proof.merkle.length > 32 || !Number.isSafeInteger(proof.pos) || proof.pos < 0) {
    throw new Error('Invalid Electrum merkle proof');
  }
  let hash = Buffer.from(txid, 'hex').reverse();
  let position = proof.pos;
  for (const branch of proof.merkle) {
    if (!/^[a-f\d]{64}$/i.test(branch)) { throw new Error('Invalid Electrum merkle branch'); }
    const sibling = Buffer.from(branch, 'hex').reverse();
    hash = doubleSha256(Buffer.concat(position % 2 ? [sibling, hash] : [hash, sibling]));
    position = Math.floor(position / 2);
  }
  if (position !== 0 || hash.reverse().toString('hex') !== merkleRoot) { throw new Error('Electrum merkle proof does not match the block header'); }
}

/** Protocol observations only: availability, reorg safety and activation coverage need separate qualification. @asyncUnsafe */
export async function probeElectrum(client: ElectrumProbeClient, profile: VergeChainProfile, script?: string, coreBlockHash?: (height: number) => Promise<string>) {
  const version = await client.request('server.version', ['verge-explorer-check', '1.4']);
  const features = await client.request('server.features', []);
  assertElectrumGenesis(features, profile.genesis);
  if (features.hash_function && features.hash_function !== 'sha256') { throw new Error('Unsupported Electrum script hash function'); }
  const tip = await client.request('blockchain.headers.subscribe', []);
  if (!Number.isSafeInteger(tip?.height) || tip.height < 0 || typeof tip.hex !== 'string') { throw new Error('Invalid Electrum tip'); }
  const header = decodeVergeHeader(tip.hex);
  if (await client.request('blockchain.block.header', [tip.height]) !== tip.hex) { throw new Error('Electrum tip changed or header lookup disagrees; retry'); }
  if (coreBlockHash && await coreBlockHash(tip.height) !== header.id) { throw new Error('Electrum tip does not match Verge Core'); }
  let addressSample: { confirmed: string; unconfirmed: string; historyCount: number; unspentCount: number; merkleVerified: boolean } | undefined;
  if (script !== undefined) {
    const scripthash = scriptHashForElectrum(script);
    const balance = await client.request('blockchain.scripthash.get_balance', [scripthash]);
    const history = await client.request('blockchain.scripthash.get_history', [scripthash]);
    const unspent = await client.request('blockchain.scripthash.listunspent', [scripthash]);
    if (!Array.isArray(history) || !Array.isArray(unspent) || history.some(h => !/^[a-f\d]{64}$/i.test(h.tx_hash) || !Number.isSafeInteger(h.height) || h.height < -1)) { throw new Error('Invalid Electrum script history'); }
    const integer = (value: unknown) => {
      if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^-?\d+$/.test(String(value))) { throw new Error('Invalid Electrum atomic amount'); }
      return BigInt(String(value));
    };
    const confirmed = integer(balance.confirmed), unconfirmed = integer(balance.unconfirmed);
    const sum = unspent.reduce((total: bigint, output: any) => {
      const value = integer(output.value);
      if (value < 0n || !/^[a-f\d]{64}$/i.test(output.tx_hash) || !Number.isSafeInteger(output.tx_pos) || output.tx_pos < 0 || !Number.isSafeInteger(output.height) || output.height < -1) { throw new Error('Invalid Electrum unspent output'); }
      return total + value;
    }, 0n);
    if (confirmed < 0n || sum !== confirmed + unconfirmed) { throw new Error('Electrum balance and unspent outputs disagree'); }
    let merkleVerified = false;
    const sample = history.find(h => h.height > 0);
    if (sample) {
      const raw = await client.request('blockchain.transaction.get', [sample.tx_hash, false]);
      if (decodeVergeTransaction(raw).txid !== sample.tx_hash) { throw new Error('Electrum transaction ID mismatch'); }
      const sampleHeader = decodeVergeHeader(await client.request('blockchain.block.header', [sample.height]));
      if (coreBlockHash && await coreBlockHash(sample.height) !== sampleHeader.id) { throw new Error('Electrum transaction block does not match Verge Core'); }
      const proof = await client.request('blockchain.transaction.get_merkle', [sample.tx_hash, sample.height]);
      if (proof.block_height !== sample.height) { throw new Error('Electrum merkle proof height mismatch'); }
      verifyElectrumMerkle(sample.tx_hash, proof, sampleHeader.merkle_root);
      merkleVerified = true;
    }
    addressSample = { confirmed: confirmed.toString(), unconfirmed: unconfirmed.toString(), historyCount: history.length, unspentCount: unspent.length, merkleVerified };
  }
  return { network: profile.network, genesis: features.genesis_hash, version, height: tip.height, hash: header.id, proof: header.proof,
    comparedWithCore: Boolean(coreBlockHash), addressSample };
}
