const fs = require('node:fs');
const assert = require('node:assert/strict');
const profile = JSON.parse(fs.readFileSync(process.argv[2]));
assert.equal(profile.CHAIN, 'verge', 'Select CHAIN=verge');
assert.ok(['', 'testnet', 'regtest'].includes(profile.ROOT_NETWORK), 'Select mainnet (empty root), testnet or regtest');
for (const [key, network] of [['MAINNET_ENABLED',''], ['TESTNET_ENABLED','testnet'], ['REGTEST_ENABLED','regtest']]) {
  assert.equal(profile[key], profile.ROOT_NETWORK === network, `Enable only the selected network: ${key}`);
}
for (const key of ['MINING_DASHBOARD','LIGHTNING','HISTORICAL_PRICE','ACCELERATOR','ACCELERATOR_BUTTON','PUBLIC_ACCELERATIONS','STRATUM_ENABLED','AUDIT','LIQUID_ENABLED','LIQUID_TESTNET_ENABLED','TESTNET4_ENABLED','SIGNET_ENABLED']) {
  assert.equal(profile[key], false, `${key} must be disabled for the qualified Verge profile`);
}
const website = new URL(profile.MEMPOOL_WEBSITE_URL);
assert.ok(['http:', 'https:'].includes(website.protocol));
const localWebsite = ['127.0.0.1', 'localhost', '[::1]'].includes(website.hostname);
if (profile.ROOT_NETWORK === '' || !localWebsite) {
  assert.equal(website.protocol, 'https:', 'Use the intended public HTTPS origin');
  assert.ok(!website.hostname.endsWith('.invalid'), 'Replace the example website origin');
  assert.ok(!website.username && !website.password && website.pathname === '/' && !website.search && !website.hash,
    'Use a public website origin without credentials, path, query or fragment');
  const source = new URL(profile.SOURCE_CODE_URL);
  assert.equal(source.protocol, 'https:', 'Provide the source URL for this modified deployment');
  assert.ok(!source.hostname.endsWith('.invalid'), 'Replace the example source URL');
}
for (const key of ['VERGE_MAINNET_WEBSITE_URL', 'VERGE_TESTNET_WEBSITE_URL']) {
  if (!profile[key]) continue;
  const target = new URL(profile[key]);
  assert.equal(target.protocol, 'https:', `${key} must be an HTTPS origin`);
  assert.ok(!target.hostname.endsWith('.invalid'), `Replace the example ${key} origin`);
  assert.ok(!target.username && !target.password && target.pathname === '/' && !target.search && !target.hash,
    `${key} must be an origin without credentials, path, query or fragment`);
}
if (profile.ROOT_NETWORK === '') {
  assert.equal(profile.MAINNET_ENABLED, true);
  assert.ok(!profile.VERGE_MAINNET_WEBSITE_URL, 'A mainnet profile cannot link to itself as mainnet');
} else {
  assert.equal(profile.MAINNET_ENABLED, false, 'Keep test databases and network indicators separate');
  assert.equal(profile[profile.ROOT_NETWORK === 'testnet' ? 'TESTNET_ENABLED' : 'REGTEST_ENABLED'], true);
  if (profile.ROOT_NETWORK === 'testnet') {
    assert.ok(!profile.VERGE_TESTNET_WEBSITE_URL, 'A testnet profile cannot link to itself as testnet');
  }
}
console.log('Verge frontend profile validated:', profile.ROOT_NETWORK || 'mainnet');
