#![recursion_limit = "1024"]

#[cfg(all(
    feature = "verge",
    any(feature = "liquid", feature = "electrum-discovery")
))]
compile_error!("Build Verge separately from Liquid and Bitcoin Electrum peer discovery");

extern crate rocksdb;

#[macro_use]
extern crate clap;
#[macro_use]
extern crate arrayref;
#[macro_use]
extern crate error_chain;
#[macro_use]
extern crate log;
#[macro_use]
extern crate serde_derive;
#[macro_use]
extern crate serde_json;

#[macro_use]
extern crate lazy_static;

pub mod chain;
pub mod config;
pub mod daemon;
pub mod electrum;
pub mod errors;
pub mod metrics;
pub mod new_index;
pub mod rest;
pub mod signal;
pub mod util;

// Shared wire types for the explicit Verge server feature and protocol tests.
pub use verge_wire as verge;

#[cfg(feature = "liquid")]
pub mod elements;
