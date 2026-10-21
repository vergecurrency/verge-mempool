import { createHash } from 'crypto';

export function scriptHashForElectrum(script: string): string {
  if (script.length % 2 || (script.length > 0 && !/^[a-f0-9]+$/i.test(script))) { throw new Error('Invalid script hex'); }
  return createHash('sha256').update(Buffer.from(script, 'hex')).digest().reverse().toString('hex');
}

export function compareElectrumHistory(a: { height: number; tx_hash: string }, b: { height: number; tx_hash: string }): number {
  const aHeight = a.height <= 0 ? Infinity : a.height;
  const bHeight = b.height <= 0 ? Infinity : b.height;
  if (aHeight !== bHeight) { return aHeight > bHeight ? -1 : 1; }
  return a.tx_hash < b.tx_hash ? -1 : a.tx_hash > b.tx_hash ? 1 : 0;
}

export function electrumCursorStart(history: { tx_hash: string }[], lastSeen?: string): number {
  if (!lastSeen) { return 0; }
  const index = history.findIndex(item => item.tx_hash === lastSeen);
  if (index < 0) { throw new Error('Electrum history cursor is no longer available; refresh the history'); }
  return index + 1;
}

export function assertElectrumGenesis(features: any, expected: string): void {
  if (features?.genesis_hash !== expected) { throw new Error('Electrum server genesis does not match the configured Verge network'); }
}
