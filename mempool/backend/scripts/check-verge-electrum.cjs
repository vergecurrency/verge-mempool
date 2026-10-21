require('./register-typescript.cjs');
const { connectElectrumProbe, probeElectrum } = require('../src/api/verge/electrum-probe.ts');
const { vergeProfile } = require('../src/api/verge/chain-profile.ts');

async function main() {
  const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const network = argument('network') || 'mainnet';
  const hosts = (argument('host') || 'electrumx-verge.cloud,electrum-verge.cloud').split(',');
  const port = Number(argument('port') || '50002');
  if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error('Invalid Electrum port'); }
  const profile = vergeProfile(network);
  let coreBlockHash;
  if (process.argv.includes('--compare-core')) {
    const { activeVergeProfile } = require('../src/api/verge/runtime.ts');
    if (activeVergeProfile?.network !== network) { throw new Error('Core configuration and probe network must match'); }
    const client = require('../src/api/bitcoin/bitcoin-client.ts').default;
    if (await client.getBlockHash(0) !== profile.genesis) { throw new Error('Core genesis mismatch'); }
    coreBlockHash = height => client.getBlockHash(height);
  }
  for (const host of hosts) {
    let client;
    try {
      client = await connectElectrumProbe(host, port, !process.argv.includes('--tcp'), 10000, argument('fingerprint') || '');
      console.log(JSON.stringify({ host, port, result: await probeElectrum(client, profile, argument('script'), coreBlockHash) }, null, 2));
    } catch (error) { console.error(JSON.stringify({ host, port, error: error.message })); process.exitCode = 1; }
    finally { client?.close(); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
