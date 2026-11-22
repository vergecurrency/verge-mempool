/** A coinbase tag is a miner's claim, so only label tags we recognize exactly. */
export function vergePoolFromCoinbase(scriptsig: string | undefined): { name: string; slug: string; link: string } | undefined {
  if (!scriptsig || !/^(?:[0-9a-f]{2})+$/i.test(scriptsig)) {
    return undefined;
  }

  const coinbase = Buffer.from(scriptsig, 'hex').toString('latin1');
  if (/(?:^|[^a-z0-9])xvg-pool(?:\.com)?(?=$|[^a-z0-9.])/i.test(coinbase)) {
    return { name: 'XVG Pool', slug: 'xvgpool', link: 'https://xvg-pool.com' };
  }

  return undefined;
}
