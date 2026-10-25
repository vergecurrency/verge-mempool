import type { Application, Request, Response } from 'express';
import config from '../../config';
import bitcoinClient from '../bitcoin/bitcoin-client';
import { activeVergeProfile } from './runtime';
import { getVergeMiningStatistics } from './mining';
import { getVergeFeePolicy } from './fee-policy';
import { normalizeVergePeers, VergePeersSnapshot } from './peers';
import { mergeVergePeerHistory } from './peers';
import { loadVergePeerHistory, saveVergePeerHistory, vergePeerStorePath } from './peers-store';
import logger from '../../logger';

export function registerVergeRoutes(app: Application): void {
  if (!activeVergeProfile) { return; }
  app.get(config.MEMPOOL.API_URL_PREFIX + 'chain', (_req: Request, res: Response) => res.json(activeVergeProfile));
  const peerStore = vergePeerStorePath(config.MEMPOOL.NETWORK);
  let peerSnapshot: VergePeersSnapshot | null = null;
  let peerStoreReadable = true;
  try { peerSnapshot = loadVergePeerHistory(peerStore); }
  catch {
    peerStoreReadable = false;
    logger.err('Verge peer history is unreadable; preserving it and disabling peer polling');
  }
  let peerPending: Promise<void> | undefined;
  /** @asyncSafe Every RPC and persistence failure is handled inside the promise. */
  const refreshPeers = (): Promise<void> => {
    if (peerPending) { return peerPending; }
    const pending = bitcoinClient.getPeerInfo().then((raw: unknown) => {
      const current = normalizeVergePeers(raw);
      const next = mergeVergePeerHistory(peerSnapshot, current);
      saveVergePeerHistory(peerStore, next);
      peerSnapshot = next;
    }).catch(() => {
      logger.warn('Verge peer refresh failed; retaining the last saved peer history');
    }).finally(() => { peerPending = undefined; });
    peerPending = pending;
    return pending;
  };
  if (peerStoreReadable) {
    void refreshPeers();
    setInterval(() => { void refreshPeers(); }, 120000).unref();
  }
  app.get(config.MEMPOOL.API_URL_PREFIX + 'peers', (_req: Request, res: Response) => {
    if (!peerSnapshot) {
      res.status(503).json({ error: 'Verge peer history is temporarily unavailable' }); return;
    }
    res.setHeader('Cache-Control', 'public, max-age=120');
    res.json(peerSnapshot);
  });
  app.get(config.MEMPOOL.API_URL_PREFIX + 'fees/policy', async (req: Request, res: Response) => {
    const bytes = req.query.bytes;
    if (bytes !== undefined && (typeof bytes !== 'string' || !/^[1-9]\d{0,6}$/.test(bytes) || Number(bytes) > 1000000)) {
      res.status(400).json({ error: 'bytes must be an integer from 1 to 1000000' }); return;
    }
    try {
      res.json(getVergeFeePolicy(await bitcoinClient.getMempoolInfo(), bytes === undefined ? undefined : Number(bytes)));
    } catch { res.status(503).json({ error: 'Verge fee policy is temporarily unavailable' }); }
  });
  let pending: ReturnType<typeof getVergeMiningStatistics> | undefined;
  let cached: Awaited<ReturnType<typeof getVergeMiningStatistics>> | undefined;
  let expires = 0;
  app.get(config.MEMPOOL.API_URL_PREFIX + 'mining/algorithms', async (_req: Request, res: Response) => {
    try {
      const tip = await bitcoinClient.getBestBlockHash();
      if (!cached || cached.hash !== tip || Date.now() >= expires) {
        pending ??= getVergeMiningStatistics(bitcoinClient);
        try {
          const sample = await pending;
          if (sample.hash !== tip) { throw new Error('Mining sample tip changed; retry'); }
          cached = sample; expires = Date.now() + 30000;
        } finally { pending = undefined; }
      }
      res.setHeader('Cache-Control', 'public, max-age=5');
      res.json(cached);
    } catch {
      res.status(503).json({ error: 'Verge mining statistics are temporarily unavailable' });
    }
  });
}
