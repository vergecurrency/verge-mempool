const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const release = path.resolve(process.argv[2]);
const profile = JSON.parse(fs.readFileSync(process.argv[3]));
const config = {};
vm.runInNewContext(fs.readFileSync(path.join(release,'frontend/resources/config.js'),'utf8'),config);
assert.equal(config.__env.CHAIN,'verge');
assert.equal(config.__env.ROOT_NETWORK,profile.ROOT_NETWORK);
assert.equal(config.__env.GIT_COMMIT_HASH,process.env.MEMPOOL_COMMIT_HASH);
assert.ok(fs.readFileSync(path.join(release,'bin/electrs')).subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])),'Indexer must be a Linux ELF binary');
assert.ok(fs.statSync(path.join(release,'frontend/3rdpartylicenses.txt')).size>0);
const {vergeProfile}=require(path.join(release,'backend/dist/api/verge/chain-profile'));
const chain=vergeProfile(profile.ROOT_NETWORK||'mainnet');
fs.writeFileSync(path.join(release,'BUILD.json'),JSON.stringify({
  builtAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,node:process.version,
  chain:chain.chain,network:chain.network,genesis:chain.genesis,sourceSha256:process.env.VERGE_SOURCE_SHA256,
  sourceId:process.env.MEMPOOL_COMMIT_HASH,upstream:{mempool:process.env.MEMPOOL_UPSTREAM_REVISION,electrs:process.env.ELECTRS_UPSTREAM_REVISION},
  productionQualified:false,qualification:'Application builds and unit checks only; chain-scale, staging, restore and operational acceptance are separate release gates.'
},null,2)+'\n');
