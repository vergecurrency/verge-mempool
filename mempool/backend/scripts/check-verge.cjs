require('./register-typescript.cjs');
const { verifyVergeRpc } = require('../src/api/verge/rpc.ts');
const { activeVergeProfile } = require('../src/api/verge/runtime.ts');
const client = require('../src/api/bitcoin/bitcoin-client.ts').default;
const { getVergeMiningStatistics } = require('../src/api/verge/mining.ts');
const { getVergeFeePolicy } = require('../src/api/verge/fee-policy.ts');

if (!activeVergeProfile) {
  console.error('Select MEMPOOL.CHAIN=verge in MEMPOOL_CONFIG_FILE before running this check.');
  process.exitCode = 1;
} else {
  verifyVergeRpc(client, activeVergeProfile).then(async result => {
    console.log(JSON.stringify(result, null, 2));
    console.log(JSON.stringify(getVergeFeePolicy(await client.getMempoolInfo(), 200), null, 2));
    if (process.argv.includes('--mining')) { console.log(JSON.stringify(await getVergeMiningStatistics(client, 32), null, 2)); }
  }).catch(error => {
    console.error(`Verge RPC check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
