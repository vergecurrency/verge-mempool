use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Lines, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64;
use bitcoin::hashes::Hash;
use glob;
use hex;
use serde_json::{from_str, from_value, Value};

#[cfg(not(feature = "liquid"))]
use bitcoin::consensus::encode::{deserialize, serialize};
#[cfg(feature = "liquid")]
use elements::encode::{deserialize, serialize};

use crate::chain::{Block, BlockHash, BlockHeader, Network, Transaction, Txid};
use crate::config::BITCOIND_SUBVER;
use crate::metrics::{HistogramOpts, HistogramVec, Metrics};
use crate::signal::Waiter;
use crate::util::{HeaderEntry, HeaderList};

use crate::errors::*;

const RPC_BATCH_SIZE: usize = 1_000;

#[cfg(test)]
mod import_tests {
    use super::*;

    #[test]
    fn batches_match_unique_ids_instead_of_response_order() {
        let ordered = ordered_batch_replies(
            json!([
                {"id": 8, "result": "second", "error": null},
                {"id": 7, "result": "first", "error": null}
            ]),
            &[7, 8],
        )
        .unwrap();
        assert_eq!(
            parse_jsonrpc_reply(ordered[0].clone(), "test", 7).unwrap(),
            "first"
        );
        assert_eq!(
            parse_jsonrpc_reply(ordered[1].clone(), "test", 8).unwrap(),
            "second"
        );
        assert!(ordered_batch_replies(json!([{"id": 7}, {"id": 7}]), &[7, 8]).is_err());
        assert!(ordered_batch_replies(json!([{"id": 7}]), &[7, 8]).is_err());
        assert!(ordered_batch_replies(json!([{"id": 7}, {"id": 9}]), &[7, 8]).is_err());
    }

    #[cfg(not(feature = "liquid"))]
    fn child(parent: BlockHash, nonce: u32) -> BlockHeader {
        let mut raw = [0_u8; 80];
        raw[..4].copy_from_slice(&1_i32.to_le_bytes());
        raw[4..36].copy_from_slice(&parent.to_byte_array());
        raw[76..80].copy_from_slice(&nonce.to_le_bytes());
        deserialize(&raw).unwrap()
    }

    #[cfg(not(feature = "liquid"))]
    #[test]
    fn initial_import_keeps_original_tip_during_reorg() {
        let genesis = child(BlockHash::all_zeros(), 0);
        let old = child(genesis.block_hash(), 1);
        let replacement = child(genesis.block_hash(), 2);
        let result = download_all_headers(
            old.block_hash(),
            1,
            |_| Ok(vec![genesis.clone(), replacement.clone()]),
            |hash| {
                assert_eq!(*hash, old.block_hash());
                Ok(old.clone())
            },
        )
        .unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(*result[1].hash(), old.block_hash());
        assert_eq!(result[1].header().prev_blockhash, *result[0].hash());
    }

    #[cfg(not(feature = "liquid"))]
    #[test]
    fn initial_import_repairs_a_reorg_inside_a_height_batch() {
        let genesis = child(BlockHash::all_zeros(), 0);
        let old = child(genesis.block_hash(), 1);
        let replacement = child(genesis.block_hash(), 2);
        let tip = child(replacement.block_hash(), 3);
        let mut repairs = 0;
        let result = download_all_headers(
            tip.block_hash(),
            2,
            |_| Ok(vec![genesis.clone(), old.clone(), tip.clone()]),
            |hash| {
                repairs += 1;
                assert_eq!(*hash, replacement.block_hash());
                Ok(replacement.clone())
            },
        )
        .unwrap();
        assert_eq!(repairs, 1);
        assert_eq!(*result[1].hash(), replacement.block_hash());
        assert_eq!(*result[2].hash(), tip.block_hash());
    }

    #[cfg(not(feature = "liquid"))]
    #[test]
    fn missing_active_height_falls_back_to_verified_pinned_ancestry() {
        let genesis = child(BlockHash::all_zeros(), 0);
        let tip = child(genesis.block_hash(), 1);
        let result = download_all_headers(
            tip.block_hash(),
            1,
            |_| Err("active height temporarily unavailable".into()),
            |hash| {
                if *hash == tip.block_hash() {
                    Ok(tip.clone())
                } else {
                    assert_eq!(*hash, genesis.block_hash());
                    Ok(genesis.clone())
                }
            },
        )
        .unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(*result[0].hash(), genesis.block_hash());
        assert_eq!(*result[1].hash(), tip.block_hash());
    }

    #[test]
    fn interrupted_import_does_not_restart_via_hash_fallback() {
        let result = download_all_headers(
            BlockHash::all_zeros(),
            0,
            |_| Err(ErrorKind::Interrupt(15).into()),
            |_| panic!("must honor interruption"),
        );
        assert!(matches!(
            result.unwrap_err().kind(),
            ErrorKind::Interrupt(15)
        ));
    }

    #[cfg(not(feature = "liquid"))]
    #[test]
    fn initial_import_batches_are_bounded() {
        let count = RPC_BATCH_SIZE + 3;
        let mut chain = Vec::new();
        let mut prev = BlockHash::all_zeros();
        for nonce in 0..count {
            let header = child(prev, nonce as u32);
            prev = header.block_hash();
            chain.push(header);
        }
        let mut requests = 0;
        let imported = download_all_headers(
            prev,
            count - 1,
            |heights| {
                assert!(heights.len() <= RPC_BATCH_SIZE);
                requests += 1;
                Ok(heights
                    .iter()
                    .map(|height| chain[*height].clone())
                    .collect())
            },
            |_| panic!("unchanged chain must not refetch a suffix"),
        )
        .unwrap();
        assert_eq!(requests, 2);
        assert_eq!(imported.len(), count);
        assert_eq!(*imported.last().unwrap().hash(), prev);
    }

    #[cfg(feature = "verge")]
    fn captured() -> Vec<(usize, BlockHeader)> {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/mainnet-reorg-9550376.json"))
                .unwrap();
        fixture["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|block| {
                let raw = hex::decode(block["header"].as_str().unwrap()).unwrap();
                let header: BlockHeader = deserialize(&raw).unwrap();
                assert_eq!(
                    header.block_hash().to_string(),
                    block["hash"].as_str().unwrap()
                );
                (block["height"].as_u64().unwrap() as usize, header)
            })
            .collect()
    }

    #[cfg(feature = "verge")]
    #[test]
    fn real_mainnet_reorg_repairs_only_suffix_and_preserves_pinned_tip() {
        let blocks = captured();
        for (from, to) in [(1, 2), (2, 1)] {
            let parent = HeaderEntry::new(blocks[0].0, blocks[0].1.clone());
            let mut imported = vec![
                parent.clone(),
                HeaderEntry::new(blocks[from].0, blocks[from].1.clone()),
            ];
            let mut requests = 0;
            reconcile_header_suffix(
                &mut imported,
                blocks[to].1.block_hash(),
                blocks[to].0,
                &mut |hash| {
                    requests += 1;
                    assert_eq!(*hash, blocks[to].1.block_hash());
                    Ok(blocks[to].1.clone())
                },
            )
            .unwrap();
            assert_eq!(requests, 1);
            assert!(std::ptr::eq(imported[0].header(), parent.header()));
            assert_eq!(*imported[1].hash(), blocks[to].1.block_hash());
            assert_eq!(imported[1].header().prev_blockhash, *parent.hash());
        }
    }

    #[cfg(feature = "verge")]
    #[test]
    #[should_panic(expected = "assertion `left == right` failed")]
    fn incorrect_header_still_fails_hash_assertion() {
        let blocks = captured();
        let mut headers = vec![HeaderEntry::new(blocks[0].0, blocks[0].1.clone())];
        reconcile_header_suffix(
            &mut headers,
            blocks[1].1.block_hash(),
            blocks[1].0,
            &mut |_| Ok(blocks[2].1.clone()),
        )
        .unwrap();
    }
}

fn ordered_batch_replies(replies: Value, ids: &[u64]) -> Result<Vec<Value>> {
    let mut replies = match replies {
        Value::Array(replies) if replies.len() == ids.len() => replies,
        _ => bail!("RPC batch response count does not match request count"),
    };
    replies.sort_unstable_by_key(|reply| reply.get("id").and_then(Value::as_u64));
    for (reply, id) in replies.iter().zip(ids) {
        if reply.get("id").and_then(Value::as_u64) != Some(*id) {
            bail!("missing, duplicate or unexpected RPC response id");
        }
    }
    Ok(replies)
}

// Keep the requested hash as the anchor when height lookups cross a reorg.
fn reconcile_header_suffix<F>(
    headers: &mut Vec<HeaderEntry>,
    target: BlockHash,
    target_height: usize,
    fetch: &mut F,
) -> Result<()>
where
    F: FnMut(&BlockHash) -> Result<BlockHeader>,
{
    let base_height = headers.first().map_or(0, HeaderEntry::height);
    let mut height = target_height;
    let mut hash = target;
    let mut suffix = Vec::new();
    loop {
        if let Some(entry) = height.checked_sub(base_height).and_then(|i| headers.get(i)) {
            if *entry.hash() == hash {
                headers.truncate(height - base_height + 1);
                break;
            }
        }
        let header = fetch(&hash)?;
        let entry = HeaderEntry::new(height, header);
        assert_eq!(*entry.hash(), hash);
        hash = entry.header().prev_blockhash;
        suffix.push(entry);
        if height == 0 {
            assert_eq!(hash, BlockHash::all_zeros());
            headers.clear();
            break;
        }
        assert_ne!(hash, BlockHash::all_zeros());
        height -= 1;
    }
    headers.extend(suffix.into_iter().rev());
    assert_eq!(*headers.last().unwrap().hash(), target);
    Ok(())
}

fn download_all_headers<R, F>(
    tip: BlockHash,
    tip_height: usize,
    mut fetch_range: R,
    mut fetch_header: F,
) -> Result<Vec<HeaderEntry>>
where
    R: FnMut(&[usize]) -> Result<Vec<BlockHeader>>,
    F: FnMut(&BlockHash) -> Result<BlockHeader>,
{
    let mut result: Vec<HeaderEntry> = Vec::new();
    for start in (0..=tip_height).step_by(RPC_BATCH_SIZE) {
        let end = start.saturating_add(RPC_BATCH_SIZE).min(tip_height + 1);
        let heights: Vec<usize> = (start..end).collect();
        let headers = match fetch_range(&heights) {
            Ok(headers) => headers,
            Err(error) => {
                if matches!(error.kind(), ErrorKind::Interrupt(_)) {
                    return Err(error);
                }
                warn!(
                    "height-based header fetch failed; following verified ancestry of {}: {}",
                    tip, error
                );
                reconcile_header_suffix(&mut result, tip, tip_height, &mut fetch_header)?;
                break;
            }
        };
        assert_eq!(headers.len(), heights.len());
        for (height, header) in heights.into_iter().zip(headers) {
            let previous = result.last().map_or(BlockHash::all_zeros(), |h| *h.hash());
            if header.prev_blockhash != previous && height > 0 {
                reconcile_header_suffix(
                    &mut result,
                    header.prev_blockhash,
                    height - 1,
                    &mut fetch_header,
                )?;
            }
            assert_eq!(result.len(), height);
            assert_eq!(
                header.prev_blockhash,
                result.last().map_or(BlockHash::all_zeros(), |h| *h.hash())
            );
            result.push(HeaderEntry::new(height, header));
        }
    }
    reconcile_header_suffix(&mut result, tip, tip_height, &mut fetch_header)?;
    let mut blockhash = BlockHash::all_zeros();
    for header in &result {
        assert_eq!(header.header().prev_blockhash, blockhash);
        blockhash = *header.hash();
    }
    assert_eq!(blockhash, tip);
    Ok(result)
}

fn parse_hash<T>(value: &Value) -> Result<T>
where
    T: FromStr,
    <T as FromStr>::Err: std::fmt::Debug,
{
    value
        .as_str()
        .chain_err(|| format!("non-string value: {}", value))?
        .parse::<T>()
        .map_err(|e| format!("failed to parse hash: {:?}", e).into())
}

fn header_from_value(value: Value) -> Result<BlockHeader> {
    let header_hex = value
        .as_str()
        .chain_err(|| format!("non-string header: {}", value))?;
    let header_bytes = hex::decode(header_hex).chain_err(|| "non-hex header")?;
    deserialize(&header_bytes).chain_err(|| format!("failed to parse header {}", header_hex))
}

fn block_from_value(value: Value) -> Result<Block> {
    let block_hex = value.as_str().chain_err(|| "non-string block")?;
    let block_bytes = hex::decode(block_hex).chain_err(|| "non-hex block")?;
    deserialize(&block_bytes).chain_err(|| format!("failed to parse block {}", block_hex))
}

fn tx_from_value(value: Value) -> Result<Transaction> {
    let tx_hex = value.as_str().chain_err(|| "non-string tx")?;
    let tx_bytes = hex::decode(tx_hex).chain_err(|| "non-hex tx")?;
    deserialize(&tx_bytes).chain_err(|| format!("failed to parse tx {}", tx_hex))
}

/// Parse JSONRPC error code, if exists.
fn parse_error_code(err: &Value) -> Option<i64> {
    err.as_object()?.get("code")?.as_i64()
}

fn parse_jsonrpc_reply(mut reply: Value, method: &str, expected_id: u64) -> Result<Value> {
    if let Some(reply_obj) = reply.as_object_mut() {
        if let Some(err) = reply_obj.get("error") {
            if !err.is_null() {
                if let Some(code) = parse_error_code(err) {
                    match code {
                        // RPC_IN_WARMUP -> retry by later reconnection
                        -28 => bail!(ErrorKind::Connection(err.to_string())),
                        _ => bail!("{} RPC error: {}", method, err),
                    }
                }
            }
        }
        let id = reply_obj
            .get("id")
            .chain_err(|| format!("no id in reply: {:?}", reply_obj))?
            .clone();
        if id != expected_id {
            bail!(
                "wrong {} response id {}, expected {}",
                method,
                id,
                expected_id
            );
        }
        if let Some(result) = reply_obj.get_mut("result") {
            return Ok(result.take());
        }
        bail!("no result in reply: {:?}", reply_obj);
    }
    bail!("non-object reply: {:?}", reply);
}

#[derive(Serialize, Deserialize, Debug)]
pub struct BlockchainInfo {
    pub chain: String,
    pub blocks: u32,
    pub headers: u32,
    pub bestblockhash: String,
    pub pruned: bool,
    pub verificationprogress: f32,
    pub initialblockdownload: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MempoolInfo {
    #[cfg_attr(feature = "verge", serde(default = "verge_mempool_ready"))]
    pub loaded: bool,
}

#[cfg(feature = "verge")]
fn verge_mempool_ready() -> bool {
    true
}

#[derive(Serialize, Deserialize, Debug)]
struct NetworkInfo {
    version: u64,
    subversion: String,
    relayfee: f64, // in BTC/kB
}

#[derive(Serialize, Deserialize, Debug)]
struct MempoolFees {
    base: f64,
    #[serde(rename = "effective-feerate")]
    effective_feerate: f64,
    #[serde(rename = "effective-includes")]
    effective_includes: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MempoolAcceptResult {
    txid: String,
    #[serde(default)]
    wtxid: String,
    allowed: Option<bool>,
    vsize: Option<u32>,
    fees: Option<MempoolFees>,
    #[serde(rename = "reject-reason")]
    reject_reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct MempoolFeesSubmitPackage {
    base: f64,
    #[serde(rename = "effective-feerate")]
    effective_feerate: Option<f64>,
    #[serde(rename = "effective-includes")]
    effective_includes: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SubmitPackageResult {
    package_msg: String,
    #[serde(rename = "tx-results")]
    tx_results: HashMap<String, TxResult>,
    #[serde(rename = "replaced-transactions")]
    replaced_transactions: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TxResult {
    txid: String,
    #[serde(rename = "other-wtxid")]
    other_wtxid: Option<String>,
    vsize: Option<u32>,
    fees: Option<MempoolFeesSubmitPackage>,
    error: Option<String>,
}

pub trait CookieGetter: Send + Sync {
    fn get(&self) -> Result<Vec<u8>>;
}

struct Connection {
    tx: TcpStream,
    rx: Lines<BufReader<TcpStream>>,
    cookie_getter: Arc<dyn CookieGetter>,
    addr: SocketAddr,
    signal: Waiter,
}

fn tcp_connect(addr: SocketAddr, signal: &Waiter) -> Result<TcpStream> {
    loop {
        match TcpStream::connect(addr) {
            Ok(conn) => return Ok(conn),
            Err(err) => {
                warn!("failed to connect daemon at {}: {}", addr, err);
                signal.wait(Duration::from_secs(3), false)?;
                continue;
            }
        }
    }
}

impl Connection {
    fn new(
        addr: SocketAddr,
        cookie_getter: Arc<dyn CookieGetter>,
        signal: Waiter,
    ) -> Result<Connection> {
        let conn = tcp_connect(addr, &signal)?;
        let reader = BufReader::new(
            conn.try_clone()
                .chain_err(|| format!("failed to clone {:?}", conn))?,
        );
        Ok(Connection {
            tx: conn,
            rx: reader.lines(),
            cookie_getter,
            addr,
            signal,
        })
    }

    fn reconnect(&self) -> Result<Connection> {
        Connection::new(self.addr, self.cookie_getter.clone(), self.signal.clone())
    }

    fn send(&mut self, request: &str) -> Result<()> {
        let cookie = &self.cookie_getter.get()?;
        let msg = format!(
            "POST / HTTP/1.1\nAuthorization: Basic {}\nContent-Length: {}\n\n{}",
            base64::encode(cookie),
            request.len(),
            request,
        );
        self.tx.write_all(msg.as_bytes()).chain_err(|| {
            ErrorKind::Connection("disconnected from daemon while sending".to_owned())
        })
    }

    fn recv(&mut self) -> Result<String> {
        // TODO: use proper HTTP parser.
        let mut in_header = true;
        let mut contents: Option<String> = None;
        let iter = self.rx.by_ref();
        let status = iter
            .next()
            .chain_err(|| {
                ErrorKind::Connection("disconnected from daemon while receiving".to_owned())
            })?
            .chain_err(|| ErrorKind::Connection("failed to read status".to_owned()))?;
        let mut headers = HashMap::new();
        for line in iter {
            let line = line.chain_err(|| ErrorKind::Connection("failed to read".to_owned()))?;
            if line.is_empty() {
                in_header = false; // next line should contain the actual response.
            } else if in_header {
                let parts: Vec<&str> = line.splitn(2, ": ").collect();
                if parts.len() == 2 {
                    headers.insert(parts[0].to_owned(), parts[1].to_owned());
                } else {
                    warn!("invalid header: {:?}", line);
                }
            } else {
                contents = Some(line);
                break;
            }
        }

        let contents =
            contents.chain_err(|| ErrorKind::Connection("no reply from daemon".to_owned()))?;
        let contents_length: &str = headers
            .get("Content-Length")
            .chain_err(|| format!("Content-Length is missing: {:?}", headers))?;
        let contents_length: usize = contents_length
            .parse()
            .chain_err(|| format!("invalid Content-Length: {:?}", contents_length))?;

        let expected_length = contents_length - 1; // trailing EOL is skipped
        if expected_length != contents.len() {
            bail!(ErrorKind::Connection(format!(
                "expected {} bytes, got {}",
                expected_length,
                contents.len()
            )));
        }

        Ok(if status == "HTTP/1.1 200 OK" {
            contents
        } else if status == "HTTP/1.1 500 Internal Server Error" {
            warn!("HTTP status: {}", status);
            contents // the contents should have a JSONRPC error field
        } else {
            bail!(
                "request failed {:?}: {:?} = {:?}",
                status,
                headers,
                contents
            );
        })
    }
}

struct Counter {
    value: Mutex<u64>,
}

impl Counter {
    fn new() -> Self {
        Counter {
            value: Mutex::new(0),
        }
    }

    fn next(&self) -> u64 {
        let mut value = self.value.lock().unwrap();
        *value += 1;
        *value
    }
}

pub struct Daemon {
    daemon_dir: PathBuf,
    blocks_dir: PathBuf,
    network: Network,
    magic: Option<u32>,
    conn: Mutex<Connection>,
    message_id: Counter, // for monotonic JSONRPC 'id'
    signal: Waiter,

    // monitoring
    latency: HistogramVec,
    size: HistogramVec,
}

impl Daemon {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        daemon_dir: PathBuf,
        blocks_dir: PathBuf,
        daemon_rpc_addr: SocketAddr,
        cookie_getter: Arc<dyn CookieGetter>,
        network: Network,
        magic: Option<u32>,
        signal: Waiter,
        metrics: &Metrics,
    ) -> Result<Daemon> {
        let daemon = Daemon {
            daemon_dir,
            blocks_dir,
            network,
            magic,
            conn: Mutex::new(Connection::new(
                daemon_rpc_addr,
                cookie_getter,
                signal.clone(),
            )?),
            message_id: Counter::new(),
            signal: signal.clone(),
            latency: metrics.histogram_vec(
                HistogramOpts::new("daemon_rpc", "Bitcoind RPC latency (in seconds)"),
                &["method"],
            ),
            size: metrics.histogram_vec(
                HistogramOpts::new("daemon_bytes", "Bitcoind RPC size (in bytes)"),
                &["method", "dir"],
            ),
        };
        let network_info = daemon.getnetworkinfo()?;
        info!("{:?}", network_info);
        if !cfg!(feature = "verge") && network_info.version < 16_00_00 {
            bail!(
                "{} is not supported - please use bitcoind 0.16+",
                network_info.subversion,
            )
        }
        // Insert the subversion (/Satoshi xx.xx.xx(comment)/) string from bitcoind
        _ = BITCOIND_SUBVER.set(network_info.subversion);

        let blockchain_info = daemon.getblockchaininfo()?;
        #[cfg(feature = "verge")]
        {
            let expected_chain = match network {
                Network::Bitcoin => "main",
                Network::Testnet => "test",
                Network::Regtest => "regtest",
                _ => bail!("unsupported Verge network"),
            };
            if blockchain_info.chain != expected_chain {
                bail!("Verge daemon network mismatch");
            }
            let hash: BlockHash = parse_hash(&daemon.request("getblockhash", json!([0]))?)?;
            if hash != crate::chain::genesis_hash(network) {
                bail!("Verge daemon genesis mismatch");
            }
        }
        info!("{:?}", blockchain_info);
        if blockchain_info.pruned {
            bail!("pruned node is not supported (use '-prune=0' bitcoind flag)".to_owned())
        }
        loop {
            let info = daemon.getblockchaininfo()?;
            let mempool = daemon.getmempoolinfo()?;

            let ibd_done = if network.is_regtest() {
                info.blocks == info.headers
            } else {
                !info.initialblockdownload.unwrap_or(false)
            };

            if mempool.loaded && ibd_done && info.blocks == info.headers {
                break;
            }

            warn!(
                "waiting for bitcoind sync and mempool load to finish: {}/{} blocks, verification progress: {:.3}%, mempool loaded: {}",
                info.blocks,
                info.headers,
                info.verificationprogress * 100.0,
                mempool.loaded
            );
            signal.wait(Duration::from_secs(5), false)?;
        }
        Ok(daemon)
    }

    pub fn reconnect(&self) -> Result<Daemon> {
        Ok(Daemon {
            daemon_dir: self.daemon_dir.clone(),
            blocks_dir: self.blocks_dir.clone(),
            network: self.network,
            magic: self.magic,
            conn: Mutex::new(self.conn.lock().unwrap().reconnect()?),
            message_id: Counter::new(),
            signal: self.signal.clone(),
            latency: self.latency.clone(),
            size: self.size.clone(),
        })
    }

    pub fn list_blk_files(&self) -> Result<Vec<PathBuf>> {
        let path = self.blocks_dir.join("blk*.dat");
        debug!("listing block files at {:?}", path);
        let mut paths: Vec<PathBuf> = glob::glob(path.to_str().unwrap())
            .chain_err(|| "failed to list blk*.dat files")?
            .map(|res| res.unwrap())
            .collect();
        paths.sort();
        Ok(paths)
    }

    pub fn magic(&self) -> u32 {
        self.magic.unwrap_or_else(|| self.network.magic())
    }

    fn call_jsonrpc(&self, method: &str, request: &Value) -> Result<Value> {
        let mut conn = self.conn.lock().unwrap();
        let timer = self.latency.with_label_values(&[method]).start_timer();
        let request = request.to_string();
        conn.send(&request)?;
        self.size
            .with_label_values(&[method, "send"])
            .observe(request.len() as f64);
        let response = conn.recv()?;
        let result: Value = from_str(&response).chain_err(|| "invalid JSON")?;
        timer.observe_duration();
        self.size
            .with_label_values(&[method, "recv"])
            .observe(response.len() as f64);
        Ok(result)
    }

    fn handle_request_batch(
        &self,
        method: &str,
        params_list: &[Value],
        failure_threshold: f64,
    ) -> Result<Vec<Value>> {
        let mut results = vec![];
        let total_requests = params_list.len();
        let mut failed_requests: u64 = 0;
        let threshold = (failure_threshold * total_requests as f64).round() as u64;
        let mut n = 0;

        for chunk in params_list.chunks(RPC_BATCH_SIZE) {
            let ids: Vec<u64> = chunk.iter().map(|_| self.message_id.next()).collect();
            let reqs: Vec<Value> = chunk
                .iter()
                .zip(&ids)
                .map(|(params, id)| json!({"method": method, "params": params, "id": id}))
                .collect();
            let replies = ordered_batch_replies(self.call_jsonrpc(method, &json!(reqs))?, &ids)?;
            for (reply, id) in replies.into_iter().zip(ids) {
                n += 1;
                match parse_jsonrpc_reply(reply, method, id) {
                    Ok(parsed_reply) => results.push(parsed_reply),
                    Err(e) => {
                        failed_requests += 1;
                        warn!(
                            "batch request {} {}/{} failed: {}",
                            method,
                            n,
                            total_requests,
                            e.to_string()
                        );
                        // abort and return the last error once a threshold number of requests have failed
                        if failed_requests > threshold {
                            return Err(e);
                        }
                    }
                }
            }
        }

        Ok(results)
    }

    fn retry_request_batch(
        &self,
        method: &str,
        params_list: &[Value],
        failure_threshold: f64,
    ) -> Result<Vec<Value>> {
        loop {
            match self.handle_request_batch(method, params_list, failure_threshold) {
                Err(Error(ErrorKind::Connection(msg), _)) => {
                    warn!("reconnecting to bitcoind: {}", msg);
                    self.signal.wait(Duration::from_secs(3), false)?;
                    let mut conn = self.conn.lock().unwrap();
                    *conn = conn.reconnect()?;
                    continue;
                }
                result => return result,
            }
        }
    }

    fn request(&self, method: &str, params: Value) -> Result<Value> {
        let mut values = self.retry_request_batch(method, &[params], 0.0)?;
        assert_eq!(values.len(), 1);
        Ok(values.remove(0))
    }

    fn requests(&self, method: &str, params_list: &[Value]) -> Result<Vec<Value>> {
        self.retry_request_batch(method, params_list, 0.0)
    }

    // bitcoind JSONRPC API:

    pub fn getblockchaininfo(&self) -> Result<BlockchainInfo> {
        let info: Value = self.request("getblockchaininfo", json!([]))?;
        from_value(info).chain_err(|| "invalid blockchain info")
    }

    fn getmempoolinfo(&self) -> Result<MempoolInfo> {
        let info: Value = self.request("getmempoolinfo", json!([]))?;
        from_value(info).chain_err(|| "invalid mempool info")
    }

    fn getnetworkinfo(&self) -> Result<NetworkInfo> {
        let info: Value = self.request("getnetworkinfo", json!([]))?;
        from_value(info).chain_err(|| "invalid network info")
    }

    pub fn getbestblockhash(&self) -> Result<BlockHash> {
        parse_hash(&self.request("getbestblockhash", json!([]))?)
    }

    pub fn getblockheader(&self, blockhash: &BlockHash) -> Result<BlockHeader> {
        self.signal.wait(Duration::ZERO, false)?;
        let header = header_from_value(self.request(
            "getblockheader",
            json!([blockhash.to_string(), /*verbose=*/ false]),
        )?)?;
        assert_eq!(header.block_hash(), *blockhash);
        Ok(header)
    }

    pub fn getblockheaders(&self, heights: &[usize]) -> Result<Vec<BlockHeader>> {
        self.signal.wait(Duration::ZERO, false)?;
        let heights: Vec<Value> = heights.iter().map(|height| json!([height])).collect();
        let hashes: Vec<BlockHash> = self
            .requests("getblockhash", &heights)?
            .iter()
            .map(parse_hash)
            .collect::<Result<_>>()?;
        let params_list: Vec<Value> = hashes
            .iter()
            .map(|hash| json!([hash.to_string(), /*verbose=*/ false]))
            .collect();
        let mut result = vec![];
        for (h, expected) in self
            .requests("getblockheader", &params_list)?
            .into_iter()
            .zip(hashes)
        {
            let header = header_from_value(h)?;
            assert_eq!(header.block_hash(), expected);
            result.push(header);
        }
        Ok(result)
    }

    pub fn getblock(&self, blockhash: &BlockHash) -> Result<Block> {
        let block = block_from_value(self.request(
            "getblock",
            json!([blockhash.to_string(), /*verbose=*/ false]),
        )?)?;
        assert_eq!(block.block_hash(), *blockhash);
        Ok(block)
    }

    pub fn getblock_raw(&self, blockhash: &BlockHash, verbose: u32) -> Result<Value> {
        self.request("getblock", json!([blockhash.to_string(), verbose]))
    }

    pub fn getblocks(&self, blockhashes: &[BlockHash]) -> Result<Vec<Block>> {
        let params_list: Vec<Value> = blockhashes
            .iter()
            .map(|hash| json!([hash.to_string(), /*verbose=*/ false]))
            .collect();
        let values = self.requests("getblock", &params_list)?;
        let mut blocks = vec![];
        for value in values {
            blocks.push(block_from_value(value)?);
        }
        Ok(blocks)
    }

    pub fn gettransactions(&self, txhashes: &[&Txid]) -> Result<Vec<Transaction>> {
        let params_list: Vec<Value> = txhashes
            .iter()
            .map(|txhash| json!([txhash.to_string(), /*verbose=*/ false]))
            .collect();
        let values = self.retry_request_batch("getrawtransaction", &params_list, 0.25)?;
        let mut txs = vec![];
        for value in values {
            txs.push(tx_from_value(value)?);
        }
        // missing transactions are skipped, so the number of txs returned may be less than the number of txids requested
        Ok(txs)
    }

    pub fn gettransaction_raw(
        &self,
        txid: &Txid,
        blockhash: &BlockHash,
        verbose: bool,
    ) -> Result<Value> {
        self.request(
            "getrawtransaction",
            json!([txid.to_string(), verbose, blockhash]),
        )
    }

    pub fn getmempooltx(&self, txhash: &Txid) -> Result<Transaction> {
        let value = self.request(
            "getrawtransaction",
            json!([txhash.to_string(), /*verbose=*/ false]),
        )?;
        tx_from_value(value)
    }

    pub fn getmempooltxids(&self) -> Result<HashSet<Txid>> {
        let res = self.request("getrawmempool", json!([/*verbose=*/ false]))?;
        serde_json::from_value(res).chain_err(|| "invalid getrawmempool reply")
    }

    pub fn broadcast(&self, tx: &Transaction) -> Result<Txid> {
        self.broadcast_raw(&hex::encode(serialize(tx)))
    }

    pub fn broadcast_raw(&self, txhex: &str) -> Result<Txid> {
        let txid = self.request("sendrawtransaction", json!([txhex]))?;
        txid.as_str()
            .chain_err(|| "non-string txid")?
            .parse::<Txid>()
            .map_err(|e| format!("failed to parse txid: {:?}", e).into())
    }

    pub fn test_mempool_accept(
        &self,
        txhex: Vec<String>,
        maxfeerate: Option<f64>,
    ) -> Result<Vec<MempoolAcceptResult>> {
        #[cfg(feature = "verge")]
        if txhex.len() != 1 || maxfeerate.is_some() {
            bail!("Verge supports one transaction and no Bitcoin maxfeerate parameter");
        }
        let params = match maxfeerate {
            Some(rate) => json!([txhex, format!("{:.8}", rate)]),
            None => json!([txhex]),
        };
        let result = self.request("testmempoolaccept", params)?;
        serde_json::from_value::<Vec<MempoolAcceptResult>>(result)
            .chain_err(|| "invalid testmempoolaccept reply")
    }

    pub fn submit_package(
        &self,
        txhex: Vec<String>,
        maxfeerate: Option<f64>,
        maxburnamount: Option<f64>,
    ) -> Result<SubmitPackageResult> {
        if cfg!(feature = "verge") {
            bail!("Verge Core does not support submitpackage");
        }
        let params = match (maxfeerate, maxburnamount) {
            (Some(rate), Some(burn)) => {
                json!([txhex, format!("{:.8}", rate), format!("{:.8}", burn)])
            }
            (Some(rate), None) => json!([txhex, format!("{:.8}", rate)]),
            (None, Some(burn)) => json!([txhex, null, format!("{:.8}", burn)]),
            (None, None) => json!([txhex]),
        };
        let result = self.request("submitpackage", params)?;
        serde_json::from_value::<SubmitPackageResult>(result)
            .chain_err(|| "invalid submitpackage reply")
    }

    // Get estimated feerates for the provided confirmation targets using a batch RPC request
    // Missing estimates are logged but do not cause a failure, whatever is available is returned
    #[allow(clippy::float_cmp)]
    pub fn estimatesmartfee_batch(&self, conf_targets: &[u16]) -> Result<HashMap<u16, f64>> {
        if cfg!(feature = "verge") {
            return Ok(HashMap::new());
        }
        let params_list: Vec<Value> = conf_targets.iter().map(|t| json!([t])).collect();

        Ok(self
            .requests("estimatesmartfee", &params_list)?
            .iter()
            .zip(conf_targets)
            .filter_map(|(reply, target)| {
                if !reply["errors"].is_null() {
                    warn!(
                        "failed estimating fee for target {}: {:?}",
                        target, reply["errors"]
                    );
                    return None;
                }

                let feerate = reply["feerate"]
                    .as_f64()
                    .unwrap_or_else(|| panic!("invalid estimatesmartfee response: {:?}", reply));

                if feerate == -1f64 {
                    warn!("not enough data to estimate fee for target {}", target);
                    return None;
                }

                // from BTC/kB to sat/b
                Some((*target, feerate * 100_000f64))
            })
            .collect())
    }

    fn get_all_headers(&self, tip: &BlockHash) -> Result<Vec<HeaderEntry>> {
        let info: Value = self.request("getblockheader", json!([tip.to_string()]))?;
        let tip_height = info
            .get("height")
            .expect("missing height")
            .as_u64()
            .expect("non-numeric height") as usize;
        download_all_headers(
            *tip,
            tip_height,
            |heights| self.getblockheaders(heights),
            |hash| self.getblockheader(hash),
        )
    }

    // Returns a list of BlockHeaders in ascending height (i.e. the tip is last).
    pub fn get_new_headers(
        &self,
        indexed_headers: &HeaderList,
        bestblockhash: &BlockHash,
    ) -> Result<Vec<HeaderEntry>> {
        // Iterate back over headers until known blockash is found:
        if indexed_headers.is_empty() {
            debug!("downloading all block headers up to {}", bestblockhash);
            return self.get_all_headers(bestblockhash);
        }
        debug!(
            "downloading new block headers ({} already indexed) from {}",
            indexed_headers.len(),
            bestblockhash,
        );
        let mut new_headers = vec![];
        let null_hash = BlockHash::all_zeros();
        let mut blockhash = *bestblockhash;
        while blockhash != null_hash {
            if indexed_headers.header_by_blockhash(&blockhash).is_some() {
                break;
            }
            let header = self
                .getblockheader(&blockhash)
                .chain_err(|| format!("failed to get {} header", blockhash))?;
            blockhash = header.prev_blockhash;
            new_headers.push(header);
        }
        trace!("downloaded {} block headers", new_headers.len());
        new_headers.reverse(); // so the tip is the last vector entry
        let ordered = indexed_headers.order(new_headers);
        if let Some(last) = ordered.last() {
            assert_eq!(*last.hash(), *bestblockhash);
        }
        Ok(ordered)
    }

    pub fn get_relayfee(&self) -> Result<f64> {
        let relayfee = self.getnetworkinfo()?.relayfee;

        // from BTC/kB to sat/b
        Ok(relayfee
            * if cfg!(feature = "verge") {
                1_000f64
            } else {
                100_000f64
            })
    }
}
