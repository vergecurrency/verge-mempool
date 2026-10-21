// Keep the upstream API split: /api/v1 is Mempool, /api is the Rust index.
// This local profile has no remote Bitcoin fallback.
module.exports = [
  { context: ['/api/v1'], target: 'http://127.0.0.1:8999', ws: true, changeOrigin: true },
  { context: ['/api'], target: 'http://127.0.0.1:3001', changeOrigin: true, pathRewrite: { '^/api': '' } },
];
