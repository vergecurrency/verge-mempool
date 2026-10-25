import type { VergePeer } from '@interfaces/verge.interface';

export type VergePeerSortKey = 'address' | 'lastSeen' | 'version' | 'smsgSupport';
export type VergePeerSortDirection = 'asc' | 'desc';

const naturalOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const VERGE_PEERS_PAGE_SIZE = 20;

export function paginateVergePeers(peers: VergePeer[], requestedPage: number): {
  peers: VergePeer[]; page: number; pageCount: number; from: number; to: number;
} {
  const pageCount = Math.max(1, Math.ceil(peers.length / VERGE_PEERS_PAGE_SIZE));
  const page = Math.min(pageCount, Math.max(1, Math.trunc(requestedPage) || 1));
  const start = (page - 1) * VERGE_PEERS_PAGE_SIZE;
  return {
    peers: peers.slice(start, start + VERGE_PEERS_PAGE_SIZE),
    page, pageCount, from: peers.length ? start + 1 : 0,
    to: Math.min(start + VERGE_PEERS_PAGE_SIZE, peers.length),
  };
}

export function sortVergePeers(peers: VergePeer[], key: VergePeerSortKey, direction: VergePeerSortDirection): VergePeer[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...peers].sort((left, right) => {
    if (key === 'smsgSupport') {
      return (Number(left.smsgSupport) - Number(right.smsgSupport)) * multiplier
        || naturalOrder.compare(left.address, right.address);
    }
    if (key === 'lastSeen') {
      if (left.lastSeen === null) { return right.lastSeen === null ? naturalOrder.compare(left.address, right.address) : 1; }
      if (right.lastSeen === null) { return -1; }
      const difference = (left.lastSeen - right.lastSeen) * multiplier;
      return difference || naturalOrder.compare(left.address, right.address);
    }
    return naturalOrder.compare(left[key], right[key]) * multiplier || naturalOrder.compare(left.address, right.address);
  });
}
