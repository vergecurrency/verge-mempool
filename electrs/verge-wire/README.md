# Verge wire types

Verge network parameters, timestamped and replay-protected transactions, signed blocks, PoW/PoS headers and ordinary address encoding for the `verge` electrs build. The crate reuses rust-bitcoin's hash, script, outpoint and integer amount containers. Bitcoin transaction and header codecs never decode Verge data.

PoW block IDs use Scrypt(1024,1,1), independently of the five mining algorithms. PoS headers use SHA256d and include the PoS data commitment. Decoding checks canonical CompactSize values, resource bounds, monetary ranges, transaction merkle roots, extension versions/counts and PoS header/authorization commitments. Core remains responsible for scripts, cryptographic signatures and consensus validation. Unsupported versions fail explicitly.

Amounts use 1,000,000 atomic units per XVG. Bitcoin formatting and money-range checks must not be used. Address parsing accepts only the selected network's ordinary P2PKH/P2SH addresses; stealth addresses require a separate flow.

Run `cargo fmt` and `cargo fmt --manifest-path verge-wire/Cargo.toml`, then `cargo test --manifest-path verge-wire/Cargo.toml --locked` from the electrs root. Tests cover all five PoW algorithms, testnet genesis, signed blocks, PoS/votes, exact large amounts, address networks and malformed/truncated data. The independent crate builds on Windows and Linux.

The fixed Scrypt routine is translated from Verge Core's BSD-2-Clause implementation. Preserve and distribute [NOTICE](NOTICE) with source and binaries. Other sources use the repository MIT license. See [Verge server usage](../doc/verge.md) for the integrated indexer.
