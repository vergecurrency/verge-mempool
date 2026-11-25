import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeVergeBlock, decodeVergeHeader, decodeVergeTransaction, doubleSha256 } from '../../api/verge/codec';
import { vergeProfile } from '../../api/verge/chain-profile';

const fixtures: {
  blocks: { raw: string; hash: string; header: string; tx: { txid: string; hex: string }[] }[];
  transactions: { txid: string; hex: string; version: number }[];
} = require('../../../../../electrs/verge-wire/tests/fixtures/pq-blocks.json');

test('Core-generated hybrid blocks preserve exact IDs, full signatures, transactions and headers', () => {
  for (const fixture of fixtures.blocks) {
    const block = decodeVergeBlock(fixture.raw);
    assert.equal(block.id, fixture.hash);
    assert.equal(decodeVergeHeader(fixture.header).id, fixture.hash);
    assert.equal(block.posExtension!.version, 2);
    assert.equal(block.posExtension!.authorization.pqPublicKey!.length, 1312 * 2);
    assert.equal(block.posExtension!.authorization.pqSignature!.length, 2420 * 2);
    assert.equal(block.size, fixture.raw.length / 2);
    assert.deepEqual(block.tx.map(tx => tx.txid), fixture.tx.map(tx => tx.txid));
    assert.deepEqual(block.tx.map(tx => tx.hex), fixture.tx.map(tx => tx.hex));
  }
  for (const tx of fixtures.transactions) {
    assert.equal(decodeVergeTransaction(tx.hex).txid, tx.txid);
    assert.equal(decodeVergeTransaction(tx.hex).version, tx.version);
  }
  assert.equal(vergeProfile('testnet').magic, '524c7f07');
});

// Synthetic wire records test commitment handling, not consensus-valid evidence.
function hybridCase(votes = 0, blocks = 0, evidence = 0) {
  const base = decodeVergeBlock(fixtures.blocks[0].raw);
  const raw = Buffer.from(fixtures.blocks[0].raw, 'hex');
  const offset = raw.length - base.posExtension!.hex.length / 2;
  const original = Buffer.from(base.posExtension!.hex, 'hex');
  const parts = [original.subarray(0, 296)];
  const signatures: [number, number][] = [];
  const keys: number[] = [];
  let length = 296;
  const append = (bytes: Buffer) => { parts.push(bytes); length += bytes.length; };
  const record = (size: number, producer = false) => {
    const bytes = producer ? Buffer.from(original.subarray(296, 4301)) : Buffer.alloc(size + 3732, 0x42);
    bytes[0] = 2;
    signatures.push([length + size - 64, length + size], [length + size + 1312, length + size + 3732]);
    keys.push(length + size);
    append(bytes);
  };
  record(273, true);
  append(Buffer.from([votes]));
  for (let i = 0; i < votes; i++) { record(229); }
  append(Buffer.from([blocks]));
  for (let i = 0; i < blocks; i++) { append(Buffer.from([2])); record(273); record(273); }
  append(Buffer.from([evidence]));
  for (let i = 0; i < evidence; i++) { append(Buffer.from([2])); record(229); record(229); }
  const extension = Buffer.concat(parts);
  const committed = Buffer.from(extension);
  for (const [start, end] of signatures) { committed.fill(0, start, end); }
  const tag = createHash('sha256').update('VergePoS/Data/v1').digest();
  const headerAndTransactions = Buffer.from(raw.subarray(0, offset));
  createHash('sha256').update(tag).update(tag).update(committed).digest().copy(headerAndTransactions, 80);
  return { raw: Buffer.concat([headerAndTransactions, extension]), offset, signatures, keys };
}

test('hybrid commitment normalizes every authentication signature but commits all public keys', () => {
  const sample = hybridCase(1, 1, 1);
  const block = decodeVergeBlock(sample.raw.toString('hex'));
  for (const [start, end] of sample.signatures) {
    const changed = Buffer.from(sample.raw);
    changed[sample.offset + start] ^= 1;
    changed[sample.offset + end - 1] ^= 1;
    assert.equal(decodeVergeBlock(changed.toString('hex')).id, block.id);
  }
  for (const key of sample.keys) {
    const changed = Buffer.from(sample.raw);
    changed[sample.offset + key] ^= 1;
    assert.throws(() => decodeVergeBlock(changed.toString('hex')), /commitment/);
  }
  assert.equal(block.id, doubleSha256(sample.raw.subarray(0, 112)).reverse().toString('hex'));
});

test('hybrid decoding enforces vote/evidence bounds, object versions and canonical eligibility fields', () => {
  assert.equal(decodeVergeBlock(hybridCase(192, 8, 8).raw.toString('hex')).posExtension!.votes.length, 192);
  assert.throws(() => decodeVergeBlock(hybridCase(193).raw.toString('hex')), /Too many/);
  assert.throws(() => decodeVergeBlock(hybridCase(0, 8, 9).raw.toString('hex')), /Too many/);
  const sample = hybridCase(1, 1, 1);
  for (const position of [0, 1, 296, 4302, 4302 + 3961 + 1]) {
    const changed = Buffer.from(sample.raw);
    changed[sample.offset + position] = 1;
    assert.throws(() => decodeVergeBlock(changed.toString('hex')));
  }
  for (const position of [1 + 117, 1 + 182]) {
    const changed = Buffer.from(sample.raw);
    changed[sample.offset + position] = 1;
    assert.throws(() => decodeVergeBlock(changed.toString('hex')), /eligibility/);
  }
  for (const end of [112, sample.offset, sample.offset + 1, sample.offset + 296, sample.offset + 569,
    sample.offset + 1585, sample.offset + 4301, sample.raw.length - 1]) {
    assert.throws(() => decodeVergeBlock(sample.raw.subarray(0, end).toString('hex')));
  }
  assert.throws(() => decodeVergeBlock(Buffer.concat([sample.raw, Buffer.from([0])]).toString('hex')), /Unexpected/);
});
