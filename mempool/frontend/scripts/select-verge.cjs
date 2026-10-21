const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const selected = path.join(root, 'mempool-frontend-config.json');
if (!fs.existsSync(selected)) fs.copyFileSync(path.join(root, 'mempool-frontend-config.verge.sample.json'), selected);
if (JSON.parse(fs.readFileSync(selected)).CHAIN !== 'verge') throw Error('Select a CHAIN=verge frontend configuration for this build.');
