// Copyright (c) 2026 The Verge Currency Developers
// Distributed under the GNU Affero General Public License; see COPYING.md.

export type CoinAmount = number | string;

/** Convert decimal coin amounts without passing the fractional part through a float. */
export function coinToAtomic(value: CoinAmount, decimals = 6): bigint {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('Invalid monetary amount');
  }
  const exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30 || text.length > 100) {
    throw new Error('Monetary amount out of range');
  }
  const fraction = match[3] || '';
  let digits = match[2] + fraction;
  const shift = decimals + exponent - fraction.length;
  if (shift < 0) {
    const removed = digits.slice(Math.max(0, digits.length + shift));
    if (/[1-9]/.test(removed)) {
      throw new Error('Amount has fractional base units');
    }
    digits = digits.slice(0, Math.max(0, digits.length + shift)) || '0';
  } else {
    digits += '0'.repeat(shift);
  }
  return BigInt((match[1] || '') + digits);
}

export function safeAtomicNumber(value: bigint | string | number): number {
  const amount = typeof value === 'bigint' ? value : BigInt(value);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('Amount exceeds the numeric API range; use the exact amount representation');
  }
  return Number(amount);
}

export function coinToAtomicNumber(value: CoinAmount, decimals = 6): number {
  return safeAtomicNumber(coinToAtomic(value, decimals));
}

export function atomicToCoin(value: bigint, decimals = 6): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) { throw new Error('Invalid decimal precision'); }
  if (decimals === 0) { return value.toString(); }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

const decimalAmountKeys = new Set([
  'value', 'fee', 'modifiedfee', 'base', 'modified', 'ancestor', 'descendant',
  'relayfee', 'incrementalfee', 'mempoolminfee', 'minrelaytxfee', 'total_fee', 'feerate',
]);

/** Preserve RPC decimal monetary tokens and unsafe integers before JSON.parse can round them. */
export function parseVergeRpcJson(source: string): any {
  let output = '';
  let offset = 0;
  let key = '';
  while (offset < source.length) {
    const char = source[offset];
    if (char === '"') {
      const start = offset++;
      while (offset < source.length) {
        if (source[offset] === '\\') { offset += 2; continue; }
        if (source[offset++] === '"') { break; }
      }
      const token = source.slice(start, offset);
      output += token;
      const remaining = source.slice(offset).match(/^\s*:/);
      if (remaining) { key = JSON.parse(token); }
      continue;
    }
    if (char === '-' || /[0-9]/.test(char)) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(offset));
      if (match) {
        const token = match[0];
        const unsafeInteger = !/[.eE]/.test(token) && !Number.isSafeInteger(Number(token));
        output += decimalAmountKeys.has(key) || unsafeInteger ? JSON.stringify(token) : token;
        offset += token.length;
        continue;
      }
    }
    output += char;
    offset++;
  }
  return JSON.parse(output);
}
