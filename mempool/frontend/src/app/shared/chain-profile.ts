// Copyright (c) 2026 The Verge Currency Developers
// Distributed under the GNU Affero General Public License; see COPYING.md.

export function chainDisplay(chain: string) {
  if (chain !== 'bitcoin' && chain !== 'verge') { throw new Error('Unsupported explorer chain'); }
  return chain === 'verge'
    ? { name: 'Verge', ticker: 'XVG', decimals: 6, unitsPerCoin: 1_000_000, targetBlockSeconds: 30, atomicLabel: 'atomic XVG' }
    : { name: 'Bitcoin', ticker: 'BTC', decimals: 8, unitsPerCoin: 100_000_000, targetBlockSeconds: 600, atomicLabel: 'sats' };
}

/** These genesis IDs are independently checked against Verge Core's chain parameters. */
export function assertVergeChainIdentity(value: unknown, selectedNetwork: string): void {
  const network = selectedNetwork || 'mainnet';
  const genesis: Record<string, string> = {
    mainnet: '00000fc63692467faeb20cdb3b53200dc601d75bdfa1001463304cc790d77278',
    testnet: '000005e0bb94e3a30a565d1a14ad95a189d47ca45c5bbbe48ee7a32eab8cb980',
    regtest: '65b4e101cacf3e1e4f3a9237e3a74ffd1186e595d8b78fa8ea22c21ef5bf9347',
  };
  const actual = value as { chain?: string; network?: string; genesis?: string; decimals?: number; unitsPerCoin?: number };
  if (!genesis[network] || !actual || actual.chain !== 'verge' || actual.network !== network
      || actual.genesis !== genesis[network] || actual.decimals !== 6 || actual.unitsPerCoin !== 1000000) {
    throw new Error('Explorer server does not match the selected Verge network');
  }
}

/** Display classification only: the indexer validates the Base58Check checksum.
 * Decode the whole version byte; first-character rules confuse Verge networks. */
export function vergeAddressType(address: string, network: string): 'p2pkh' | 'p2sh' | 'p2pk' | 'unknown' {
  if (/^(?:04[\da-fA-F]{128}|0[23][\da-fA-F]{64})$/.test(address)) { return 'p2pk'; }
  if (!/^[1-9A-HJ-NP-Za-km-z]{26,35}$/.test(address)) { return 'unknown'; }
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let decoded = 0n;
  for (const char of address) { decoded = decoded * 58n + BigInt(alphabet.indexOf(char)); }
  const hex = decoded.toString(16).padStart(50, '0');
  if (hex.length !== 50) { return 'unknown'; }
  const prefix = Number.parseInt(hex.slice(0, 2), 16);
  const prefixes = network === '' || network === 'mainnet' ? [30, 33]
    : network === 'testnet' ? [115, 198] : network === 'regtest' ? [111, 196] : [];
  return prefix === prefixes[0] ? 'p2pkh' : prefix === prefixes[1] ? 'p2sh' : 'unknown';
}

export interface ChainBlock { id: string; height: number; previousblockhash?: string; }

/** A canonical snapshot can lower the tip. Avoid mutating shared response arrays. */
export function canonicalBlockWindow<T extends ChainBlock>(blocks: readonly T[], limit: number): T[] {
  const ordered = [...blocks].sort((a, b) => b.height - a.height);
  const seen = new Set<number>();
  return ordered.filter(block => {
    if (!Number.isSafeInteger(block.height) || block.height < 0 || seen.has(block.height)) { return false; }
    seen.add(block.height); return true;
  }).slice(0, limit);
}

export function matchesBlockExtension(tip: ChainBlock | undefined, block: ChainBlock): boolean {
  return !!tip && block.height === tip.height + 1 && block.previousblockhash === tip.id;
}

export function snapshotChangesBranch(previous: ChainBlock | undefined, next: readonly ChainBlock[]): boolean {
  if (!previous) { return false; }
  if (!next.length) { return true; }
  const tip = next.reduce((a, b) => a.height > b.height ? a : b);
  return tip.height < previous.height || !next.some(block => block.height === previous.height && block.id === previous.id);
}

/** Format XVG without dividing a floating-point number, and fail closed when
 * an upstream JSON number has already exceeded JavaScript's exact range. */
export function formatVergeAmount(value: number | string | bigint): string | null {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) { return null; }
  if (typeof value === 'string' && !/^-?\d+$/.test(value)) { return null; }
  if (value === undefined || value === null) { return null; }
  const atomic = BigInt(value);
  const absolute = atomic < 0n ? -atomic : atomic;
  return (atomic < 0n ? '-' : '') + (absolute / 1_000_000n).toString() + '.' + (absolute % 1_000_000n).toString().padStart(6, '0');
}

const atomicFields = new Set(['value', 'fee', 'total_fee', 'totalFees', 'reward', 'funded_txo_sum', 'spent_txo_sum']);
export function assertSafeVergeAmounts(value: unknown): void {
  if (value === null || typeof value !== 'object') { return; }
  for (const [key, item] of Object.entries(value)) {
    if (atomicFields.has(key) && typeof item === 'number' && !Number.isSafeInteger(item)) {
      throw new Error('Verge amount exceeds the exact numeric API range');
    }
    if (item && typeof item === 'object') { assertSafeVergeAmounts(item); }
  }
}
