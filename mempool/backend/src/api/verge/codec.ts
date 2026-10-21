// Copyright (c) 2026 The Verge Currency Developers
// Distributed under the GNU Affero General Public License; see COPYING.md.

import { createHash, scryptSync } from 'crypto';
import { isProofOfStake, vergeAlgorithm } from './chain-profile';

export const POS_TRANSACTION_VERSION = 0x05475658;
export const POS_REPLAY_MARKER = 0x47565800;
const MAX_BLOCK_BYTES = 4000000;

export function doubleSha256(bytes: Buffer): Buffer {
  return createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest();
}

class Reader {
  public offset = 0;
  constructor(public readonly bytes: Buffer) {}
  take(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      throw new Error('Truncated Verge serialization');
    }
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  u32(): number { return this.take(4).readUInt32LE(); }
  u64(): bigint { return this.take(8).readBigUInt64LE(); }
  hash(): string { return Buffer.from(this.take(32)).reverse().toString('hex'); }
  compact(): number {
    const first = this.take(1)[0];
    if (first < 253) { return first; }
    const size = first === 253 ? 2 : first === 254 ? 4 : 8;
    const bytes = this.take(size);
    const value = size === 2 ? BigInt(bytes.readUInt16LE()) : size === 4 ? BigInt(bytes.readUInt32LE()) : bytes.readBigUInt64LE();
    if ((size === 2 && value < 253n) || (size === 4 && value <= 65535n) || (size === 8 && value <= 4294967295n)) {
      throw new Error('Noncanonical CompactSize');
    }
    if (value > BigInt(MAX_BLOCK_BYTES)) { throw new Error('Oversized CompactSize'); }
    return Number(value);
  }
  vector(): Buffer { return this.take(this.compact()); }
}

function rawBytes(hex: string): Buffer {
  if (!hex.length || hex.length % 2 || !/^[a-f\d]+$/i.test(hex) || hex.length > MAX_BLOCK_BYTES * 2) {
    throw new Error('Invalid Verge hex');
  }
  return Buffer.from(hex, 'hex');
}

function readTransaction(reader: Reader) {
  const start = reader.offset;
  const version = reader.take(4).readInt32LE();
  const time = reader.u32();
  if (version === POS_TRANSACTION_VERSION && reader.u32() !== POS_REPLAY_MARKER) {
    throw new Error('Invalid PoS replay marker');
  }
  const inputCount = reader.compact();
  if (!inputCount || inputCount > (reader.bytes.length - reader.offset) / 41) { throw new Error('Invalid transaction input count'); }
  const vin: { txid: string; vout: number; scriptsig: string; sequence: number; is_coinbase: boolean }[] = [];
  for (let i = 0; i < inputCount; i++) {
    const txid = Buffer.from(reader.take(32)).reverse().toString('hex');
    const vout = reader.u32();
    const scriptsig = reader.vector().toString('hex');
    const sequence = reader.u32();
    vin.push({ txid, vout, scriptsig, sequence, is_coinbase: txid === '0'.repeat(64) && vout === 0xffffffff });
  }
  const outputCount = reader.compact();
  if (!outputCount || outputCount > (reader.bytes.length - reader.offset) / 9) { throw new Error('Invalid transaction output count'); }
  const vout: { value: bigint; scriptpubkey: string }[] = [];
  for (let i = 0; i < outputCount; i++) {
    const value = reader.take(8).readBigInt64LE();
    if (value < 0n || value > 16555000000000000n) { throw new Error('Invalid Verge output value'); }
    vout.push({ value, scriptpubkey: reader.vector().toString('hex') });
  }
  const locktime = reader.u32();
  const raw = reader.bytes.subarray(start, reader.offset);
  return { txid: doubleSha256(raw).reverse().toString('hex'), version, time, locktime, vin, vout, size: raw.length, weight: raw.length * 4, hex: raw.toString('hex') };
}

export function decodeVergeTransaction(hex: string) {
  const reader = new Reader(rawBytes(hex));
  const tx = readTransaction(reader);
  if (reader.offset !== reader.bytes.length) { throw new Error('Unexpected transaction data'); }
  return tx;
}

function readHeader(reader: Reader) {
  const start = reader.offset;
  const version = reader.take(4).readInt32LE();
  const previousblockhash = Buffer.from(reader.take(32)).reverse().toString('hex');
  const merkle_root = Buffer.from(reader.take(32)).reverse().toString('hex');
  const timestamp = reader.u32();
  const bits = reader.u32();
  const nonce = reader.u32();
  const pos = isProofOfStake(version);
  const posDataHash = pos ? Buffer.from(reader.take(32)).reverse().toString('hex') : undefined;
  if (pos && (bits !== 0 || nonce !== 0)) { throw new Error('Nonzero PoS work fields'); }
  const raw = reader.bytes.subarray(start, reader.offset);
  const hash = pos ? doubleSha256(raw) : scryptSync(raw, raw, 32, { N: 1024, r: 1, p: 1 });
  return { id: hash.reverse().toString('hex'), version, previousblockhash, merkle_root, timestamp, bits, nonce,
    proof: pos ? 'pos' as const : 'pow' as const, algo: pos ? undefined : vergeAlgorithm(version), posDataHash, hex: raw.toString('hex') };
}

export function decodeVergeHeader(hex: string) {
  const reader = new Reader(rawBytes(hex));
  const header = readHeader(reader);
  if (reader.offset !== reader.bytes.length) { throw new Error('Unexpected header data'); }
  return header;
}

function taggedHash(tag: string, bytes: Buffer): string {
  const prefix = createHash('sha256').update(tag).digest();
  return createHash('sha256').update(prefix).update(prefix).update(bytes).digest().reverse().toString('hex');
}

function objectVersion(reader: Reader): number {
  const version = reader.take(1)[0];
  if (version !== 1) { throw new Error('Unsupported Verge PoS object version'); }
  return version;
}

function outpoint(reader: Reader) { return { txid: reader.hash(), vout: reader.u32() }; }

function stakeProof(reader: Reader) {
  const start = reader.offset;
  const result = {
    version: objectVersion(reader), bondOutpoint: outpoint(reader), slot: reader.u64(), snapshotEpoch: reader.u64(),
    snapshotRoot: reader.hash(), epochSeed: reader.hash(), vrfPublicKey: reader.take(33).toString('hex'),
    vrfOutput: reader.take(32).toString('hex'), vrfProof: reader.take(81).toString('hex'), signingPublicKey: reader.take(32).toString('hex'),
  };
  return { ...result, hash: taggedHash('VergePoS/StakeProof/v1', reader.bytes.subarray(start, reader.offset)) };
}

function blockAuthorization(reader: Reader) {
  return {
    version: objectVersion(reader), networkId: reader.u32(), parentBlockRoot: reader.hash(), candidateHeaderHash: reader.hash(),
    slot: reader.u64(), bondOutpoint: outpoint(reader), stakeProofHash: reader.hash(), feeRewardTransactionHash: reader.hash(),
    parentRandomness: reader.hash(), signature: reader.take(64).toString('hex'),
  };
}

function checkpointVote(reader: Reader) {
  return {
    version: objectVersion(reader), bondOutpoint: outpoint(reader), snapshotEpoch: reader.u64(), sourceEpoch: reader.u64(),
    sourceCheckpointRoot: reader.hash(), targetEpoch: reader.u64(), targetCheckpointRoot: reader.hash(), headSlot: reader.u64(),
    headBlockRoot: reader.hash(), signature: reader.take(64).toString('hex'),
  };
}

function boundedVector<T>(reader: Reader, maximum: number, read: (reader: Reader) => T): T[] {
  const count = reader.compact();
  if (count > maximum) { throw new Error('Too many Verge PoS objects'); }
  return Array.from({ length: count }, () => read(reader));
}

/** Decode the signed extension and check its byte commitment; Core remains the consensus validator. */
function blockExtension(reader: Reader) {
  const start = reader.offset;
  const version = objectVersion(reader);
  const proof = stakeProof(reader);
  const authorization = blockAuthorization(reader);
  const votes = boundedVector(reader, 1024, checkpointVote);
  const blockEvidence = boundedVector(reader, 16, r => ({ version: objectVersion(r), first: blockAuthorization(r), second: blockAuthorization(r) }));
  const voteEvidence = boundedVector(reader, 16 - blockEvidence.length, r => ({ version: objectVersion(r), first: checkpointVote(r), second: checkpointVote(r) }));
  const raw = reader.bytes.subarray(start, reader.offset);
  if (authorization.slot !== proof.slot || authorization.stakeProofHash !== proof.hash ||
      authorization.bondOutpoint.txid !== proof.bondOutpoint.txid || authorization.bondOutpoint.vout !== proof.bondOutpoint.vout) {
    throw new Error('Inconsistent Verge PoS authorization');
  }
  return { version, stakeProof: proof, authorization, votes, blockEvidence, voteEvidence,
    hash: taggedHash('VergePoS/Data/v1', raw), hex: raw.toString('hex') };
}

function readBlock(hex: string, powOnly: boolean) {
  const reader = new Reader(rawBytes(hex));
  const header = readHeader(reader);
  if (powOnly && header.proof === 'pos') { throw new Error('PoS block extension requires decodeVergeBlock'); }
  const count = reader.compact();
  if (!count || count > reader.bytes.length / 60) { throw new Error('Invalid block transaction count'); }
  const tx = Array.from({ length: count }, () => readTransaction(reader));
  const signature = reader.vector().toString('hex');
  const posExtension = header.proof === 'pos' ? blockExtension(reader) : undefined;
  if (posExtension) {
    const unsignedHeader = Buffer.from(header.hex, 'hex');
    unsignedHeader.fill(0, 80, 112);
    if (signature || posExtension.hash !== header.posDataHash || posExtension.authorization.parentBlockRoot !== header.previousblockhash ||
        posExtension.authorization.feeRewardTransactionHash !== tx[0].txid ||
        posExtension.authorization.candidateHeaderHash !== doubleSha256(unsignedHeader).reverse().toString('hex')) {
      throw new Error('Invalid Verge PoS block commitment');
    }
  }
  if (reader.offset !== reader.bytes.length) { throw new Error('Unexpected block data'); }
  let merkle = tx.map(t => Buffer.from(t.txid, 'hex').reverse());
  while (merkle.length > 1) {
    if (merkle.length % 2) { merkle.push(merkle[merkle.length - 1]); }
    const next: Buffer[] = [];
    for (let i = 0; i < merkle.length; i += 2) { next.push(doubleSha256(Buffer.concat([merkle[i], merkle[i + 1]]))); }
    merkle = next;
  }
  if (Buffer.from(merkle[0]).reverse().toString('hex') !== header.merkle_root) { throw new Error('Invalid block merkle root'); }
  return { ...header, tx, signature, posExtension, tx_count: count, size: reader.bytes.length, weight: reader.bytes.length * 4 };
}

export function decodeVergeBlock(hex: string) { return readBlock(hex, false); }

export function decodeVergePowBlock(hex: string) {
  return readBlock(hex, true);
}
