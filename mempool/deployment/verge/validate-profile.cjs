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
if (profile.ROOT_NETWORK === '') {
  assert.equal(profile.MAINNET_ENABLED, true);
  assert.equal(website.protocol, 'https:', 'Use the intended public HTTPS origin');
  assert.ok(!website.hostname.endsWith('.invalid'), 'Replace the example website origin');
  const source = new URL(profile.SOURCE_CODE_URL);
  assert.equal(source.protocol, 'https:', 'Provide the source URL for this modified deployment');
  assert.ok(!source.hostname.endsWith('.invalid'), 'Replace the example source URL');
} else {
  assert.equal(profile.MAINNET_ENABLED, false, 'Keep test databases and network indicators separate');
  assert.equal(profile[profile.ROOT_NETWORK === 'testnet' ? 'TESTNET_ENABLED' : 'REGTEST_ENABLED'], true);
}
console.log('Verge frontend profile validated:', profile.ROOT_NETWORK || 'mainnet');
