// Runtime entry point for the Linux x86_64/glibc addon built by build-linux.sh.
// Keep the loader as source so a clean checkout needs no generated NAPI files.
module.exports = require('./gbt.linux-x64-gnu.node');
