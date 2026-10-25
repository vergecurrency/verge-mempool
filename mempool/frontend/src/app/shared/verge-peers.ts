import type { VergePeer } from '@interfaces/verge.interface';

export type VergePeerSortKey = 'address' | 'lastSeen' | 'version';
export type VergePeerSortDirection = 'asc' | 'desc';

const naturalOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function sortVergePeers(peers: VergePeer[], key: VergePeerSortKey, direction: VergePeerSortDirection): VergePeer[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...peers].sort((left, right) => {
    if (key === 'lastSeen') {
      if (left.lastSeen === null) { return right.lastSeen === null ? naturalOrder.compare(left.address, right.address) : 1; }
      if (right.lastSeen === null) { return -1; }
      const difference = (left.lastSeen - right.lastSeen) * multiplier;
      return difference || naturalOrder.compare(left.address, right.address);
    }
    return naturalOrder.compare(left[key], right[key]) * multiplier || naturalOrder.compare(left.address, right.address);
  });
}
