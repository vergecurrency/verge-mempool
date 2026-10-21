// Read-only gateway health check. Uses Node's HTTP and WebSocket clients; no RPC secrets.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const network = option('network') || 'mainnet';
const genesis = {
  mainnet: '00000fc63692467faeb20cdb3b53200dc601d75bdfa1001463304cc790d77278',
  testnet: '000005e0bb94e3a30a565d1a14ad95a189d47ca45c5bbbe48ee7a32eab8cb980',
  regtest: '65b4e101cacf3e1e4f3a9237e3a74ffd1186e595d8b78fa8ea22c21ef5bf9347',
}[network];
assert.ok(genesis, 'Select mainnet, testnet or regtest');
const base = new URL(option('url') || 'http://127.0.0.1:8080/');
assert.ok(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash,
  'Use an HTTP(S) gateway URL without credentials, query parameters or fragments');
if (!base.pathname.endsWith('/')) base.pathname += '/';
const maximumLag = Number(option('max-lag') || 2);
assert.ok(Number.isSafeInteger(maximumLag) && maximumLag >= 0 && maximumLag <= 100);
const latency = {};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function get(route, format = 'json') {
  const started = performance.now();
  const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, `${route}: HTTP ${response.status}`);
  const result = format === 'text' ? (await response.text()).trim() : await response.json();
  latency[route] = Math.round(performance.now() - started);
  return result;
}
function identity(chain) {
  assert.ok(chain && chain.chain === 'verge' && chain.network === network && chain.genesis === genesis
    && chain.decimals === 6 && chain.unitsPerCoin === 1000000, 'Wrong chain, network, genesis or money scale');
}
async function socket() {
  const url = new URL('api/v1/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  const frames = [];
  let failure;
  const timeout = setTimeout(() => { failure = Error('WebSocket health check timed out'); ws.close(); }, 12000);
  ws.addEventListener('error', () => { failure = Error('WebSocket connection failed'); });
  ws.addEventListener('message', event => {
    try { frames.push(JSON.parse(String(event.data))); } catch { failure = Error('Invalid WebSocket JSON'); }
  });
  try {
    while (ws.readyState === WebSocket.CONNECTING && !failure) await pause(25);
    assert.ok(!failure && ws.readyState === WebSocket.OPEN, failure?.message || 'WebSocket did not open');
    ws.send(JSON.stringify({ action: 'want', data: ['blocks', 'stats', 'mempool-blocks'] }));
    ws.send(JSON.stringify({ action: 'init' }));
    ws.send(JSON.stringify({ action: 'ping' }));
    while ((!frames.some(f => f.chain && f.blocks?.length) || !frames.some(f => f.pong)) && !failure && ws.readyState === WebSocket.OPEN) await pause(25);
    if (failure) throw failure;
    const init = frames.find(f => f.chain && f.blocks?.length);
    assert.ok(init && frames.some(f => f.pong), 'Missing canonical WebSocket initialization or pong');
    identity(init.chain);
    assert.equal(init.fees, undefined, 'Bitcoin priority fees must be disabled');
    assert.equal(init.da, undefined, 'Bitcoin difficulty epoch must be disabled');
    return init.blocks.reduce((tip, block) => block.height > tip.height ? block : tip);
  } finally { clearTimeout(timeout); ws.close(); }
}
async function main() {
  identity(await get('api/v1/chain'));
  assert.equal(await get('api/block-height/0', 'text'), genesis, 'Indexer genesis differs');
  const initialHeight = Number(await get('api/blocks/tip/height', 'text'));
  assert.ok(Number.isSafeInteger(initialHeight) && initialHeight >= 0);
  const initialHash = await get(`api/block-height/${initialHeight}`, 'text');
  assert.equal(await get(`api/v1/block-height/${initialHeight}`, 'text'), initialHash, 'Core/backend and index disagree');
  const wsTip = await socket();
  const backendHeight = Number(await get('api/v1/blocks/tip/height', 'text'));
  const indexedHeight = Number(await get('api/blocks/tip/height', 'text'));
  assert.ok(Number.isSafeInteger(backendHeight) && Number.isSafeInteger(indexedHeight));
  assert.ok(Math.abs(backendHeight - indexedHeight) <= maximumLag, 'Indexer/backend lag exceeds the selected limit');
  assert.ok(Math.abs(backendHeight - wsTip.height) <= maximumLag, 'WebSocket snapshot lag exceeds the selected limit');
  assert.equal(await get(`api/block-height/${initialHeight}`, 'text'), initialHash, 'Chain reorganized during check; retry');
  assert.equal(await get(`api/v1/block-height/${wsTip.height}`, 'text'), wsTip.id, 'WebSocket snapshot is not canonical');
  console.log(JSON.stringify({ healthy: true, checkedAt: new Date().toISOString(), network, genesis,
    indexedHeight, backendHeight, websocketHeight: wsTip.height, latencyMs: latency,
    scope: 'Gateway identity, canonical agreement, bounded index lag and WebSocket. Independent Core liveness, block age and host resources need separate monitoring.' }, null, 2));
}
main().catch(error => { console.error(JSON.stringify({ healthy: false, network, error: error.message })); process.exitCode = 1; });
