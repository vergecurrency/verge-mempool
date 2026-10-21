export interface CachedVergeBlock { id: string; height: number; }

/** Find the retained canonical prefix even when the new tip has the same or a lower height. @asyncUnsafe */
export async function reconcileVergeBlockCache<T extends CachedVergeBlock>(cached: T[], tipHeight: number, blockHash: (height: number) => Promise<string>) {
  if (!Number.isSafeInteger(tipHeight) || tipHeight < 0) { throw new Error('Invalid Verge tip height'); }
  if (!cached.length) { return { blocks: cached, changed: false }; }
  for (let index = cached.length - 1; index >= 0; index--) {
    const block = cached[index];
    if (block.height > tipHeight) { continue; }
    if (await blockHash(block.height) === block.id) {
      return { blocks: index === cached.length - 1 ? cached : cached.slice(0, index + 1), changed: index !== cached.length - 1 };
    }
  }
  return { blocks: [] as T[], changed: true };
}
