//! Minimal bitcoind JSON-RPC client for the ingest side (Workstream B4).
//!
//! Supports exactly what chain sync needs — `getbestblockhash`,
//! `getblockheader`, and `getblock <hash> 2` — with cookie-file auth
//! (re-read on every call: bitcoind rotates the cookie on restart) or
//! static user:pass. Full blocks are converted into the
//! `POST /v1/admin/block` DTO and through [`crate::wire::to_block`], so
//! the ZMQ path and the operator path share one conversion (byte-order
//! conventions included — the live-regtest round-trip taught that
//! lesson).
//!
//! All hashes crossing this boundary are **internal byte order**; hex
//! strings on the wire (RPC) are display order, converted here.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

/// A block header as needed by chain sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChainHeader {
    pub hash: [u8; 32],
    pub height: u32,
    /// Parent hash; `None` only for genesis.
    pub prev: Option<[u8; 32]>,
}

/// RPC credentials.
#[derive(Debug, Clone)]
pub enum RpcAuth {
    /// Path to bitcoind's `.cookie` file (re-read on every call).
    Cookie(PathBuf),
    /// Static rpcuser/rpcpassword.
    UserPass { user: String, pass: String },
}

#[derive(Debug)]
pub enum RpcError {
    Http(String),
    /// bitcoind answered with a JSON-RPC error object.
    Rpc {
        code: i64,
        message: String,
    },
    /// bitcoind's reply was not shaped as expected.
    Malformed(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Http(m) => write!(f, "rpc transport: {m}"),
            RpcError::Rpc { code, message } => write!(f, "rpc error {code}: {message}"),
            RpcError::Malformed(m) => write!(f, "rpc reply malformed: {m}"),
        }
    }
}

impl std::error::Error for RpcError {}

/// A configured bitcoind RPC endpoint.
#[derive(Debug, Clone)]
pub struct BitcoinRpc {
    url: String,
    auth: RpcAuth,
}

/// Read a `HOPPER_*` setting with the legacy `FROGGER_*` fallback.
fn env_var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .or_else(|| std::env::var(name.replacen("HOPPER_", "FROGGER_", 1)).ok())
}

impl BitcoinRpc {
    /// Build from `HOPPER_RPC_URL` (default `http://127.0.0.1:18443`),
    /// `HOPPER_RPC_COOKIE`, or `HOPPER_RPC_USER` + `HOPPER_RPC_PASS`.
    pub fn from_env() -> Result<Self, String> {
        let url = env_var("HOPPER_RPC_URL").unwrap_or_else(|| "http://127.0.0.1:18443".into());
        if let Some(cookie) = env_var("HOPPER_RPC_COOKIE") {
            return Ok(Self {
                url,
                auth: RpcAuth::Cookie(PathBuf::from(cookie)),
            });
        }
        if let (Some(user), Some(pass)) = (env_var("HOPPER_RPC_USER"), env_var("HOPPER_RPC_PASS")) {
            return Ok(Self {
                url,
                auth: RpcAuth::UserPass { user, pass },
            });
        }
        Err("bitcoind auth: set HOPPER_RPC_COOKIE or HOPPER_RPC_USER/HOPPER_RPC_PASS".into())
    }

    /// Build from an explicit URL + auth. `from_env` stays for the
    /// server binary; the e2e harness (and anything else embedding the
    /// client) needs one per stack, not one per process env.
    pub fn new(url: impl Into<String>, auth: RpcAuth) -> Self {
        Self {
            url: url.into(),
            auth,
        }
    }

    /// `user:pass` for the Basic auth header. Cookie files contain
    /// `__cookie__:<token>` — exactly the Basic form.
    fn credentials(&self) -> Result<String, RpcError> {
        match &self.auth {
            RpcAuth::Cookie(path) => std::fs::read_to_string(path)
                .map(|s| s.trim().to_string())
                .map_err(|e| RpcError::Http(format!("cookie file {path:?}: {e}"))),
            RpcAuth::UserPass { user, pass } => Ok(format!("{user}:{pass}")),
        }
    }

    /// One JSON-RPC call.
    pub fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let creds = self.credentials()?;
        let auth = format!("Basic {}", base64_encode(creds.as_bytes()));
        let body = json!({
            "jsonrpc": "1.0",
            "id": "hopper-indexer",
            "method": method,
            "params": params,
        });
        let response = ureq::post(&self.url)
            .set("Authorization", &auth)
            .timeout(Duration::from_secs(120))
            .send_json(body)
            .map_err(|e| match e {
                ureq::Error::Status(code, resp) => {
                    let body = resp.into_string().unwrap_or_default();
                    RpcError::Http(format!("http {code}: {body}"))
                }
                other => RpcError::Http(format!("{other}")),
            })?;

        let value: Value = response
            .into_json()
            .map_err(|e| RpcError::Malformed(format!("bad json: {e}")))?;
        if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
            return Err(RpcError::Rpc {
                code: error.get("code").and_then(Value::as_i64).unwrap_or(-1),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown rpc error")
                    .to_string(),
            });
        }
        Ok(value.get("result").cloned().unwrap_or(Value::Null))
    }

    /// All mempool txids (display-order hex strings) — the mempool
    /// preview's entry list (B4 leftovers).
    pub fn mempool_txids(&self) -> Result<Vec<String>, RpcError> {
        let value = self.call("getrawmempool", json!([]))?;
        value
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(str::to_string)
                    .collect()
            })
            .ok_or_else(|| RpcError::Malformed("getrawmempool: expected an array".into()))
    }

    /// One raw transaction as hex (`getrawtransaction <txid> 0`; works
    /// for mempool txs). Used by the mempool preview.
    pub fn raw_tx_hex(&self, txid: &str) -> Result<String, RpcError> {
        let value = self.call("getrawtransaction", json!([txid, false]))?;
        value
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| RpcError::Malformed("getrawtransaction: expected hex".into()))
    }

    /// `estimatesmartfee <target>` → BTC/kB, or `None` when bitcoind
    /// has no data for that target yet (missing/zero/negative feerate
    /// — older nodes answer `-1`). Used by `/v1/fees` (W2).
    pub fn estimate_smart_fee(&self, target: u32) -> Result<Option<f64>, RpcError> {
        let value = self.call("estimatesmartfee", json!([target]))?;
        Ok(value
            .get("feerate")
            .and_then(Value::as_f64)
            .filter(|f| f.is_finite() && *f > 0.0))
    }

    /// The current best block hash (internal byte order).
    pub fn best_hash(&self) -> Result<[u8; 32], RpcError> {
        let hex = self
            .call("getbestblockhash", json!([]))?
            .as_str()
            .ok_or_else(|| RpcError::Malformed("getbestblockhash: not a string".into()))?
            .to_string();
        self.display_to_internal(&hex)
    }

    /// A block's header by hash (internal byte order).
    pub fn block_header(&self, hash: [u8; 32]) -> Result<ChainHeader, RpcError> {
        let display = internal_to_display(hash);
        let v = self.call("getblockheader", json!([display]))?;
        let height = v
            .get("height")
            .and_then(Value::as_u64)
            .ok_or_else(|| RpcError::Malformed("getblockheader: no height".into()))?
            as u32;
        let hash_back = self.display_to_internal(
            v.get("hash")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::Malformed("getblockheader: no hash".into()))?,
        )?;
        let prev = match v.get("previousblockhash").and_then(Value::as_str) {
            Some(hex) => Some(self.display_to_internal(hex)?),
            None => None,
        };
        Ok(ChainHeader {
            hash: hash_back,
            height,
            prev,
        })
    }

    /// A full block by hash (internal byte order), converted into the
    /// human-friendly ingest DTO (display-order hex, sats, OP_RETURN
    /// push payloads) — identical to what `POST /v1/admin/block` accepts.
    pub fn fetch_block(&self, hash: [u8; 32]) -> Result<crate::wire::IngestBlock, RpcError> {
        let display = internal_to_display(hash);
        let v = self.call("getblock", json!([display, 2]))?;
        let height = v
            .get("height")
            .and_then(Value::as_u64)
            .ok_or_else(|| RpcError::Malformed("getblock: no height".into()))?
            as u32;

        let tx_values = v
            .get("tx")
            .and_then(Value::as_array)
            .ok_or_else(|| RpcError::Malformed("getblock: no tx list".into()))?;
        let mut txs = Vec::with_capacity(tx_values.len());
        for tx in tx_values {
            let txid = tx
                .get("txid")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::Malformed("tx: no txid".into()))?
                .to_string();

            let mut inputs = Vec::new();
            // ord envelope counter across the tx's inputs in order —
            // ord numbers inscription ids `{txid}i{counter}` this way.
            let mut inscription_index = 0u32;
            let vins = tx
                .get("vin")
                .and_then(Value::as_array)
                .ok_or_else(|| RpcError::Malformed("tx: no vin".into()))?;
            for vin in vins {
                // Coinbase is not modeled by the core (see NOTES.md);
                // like the block feeder, it is passed through with a
                // null prevout and zero value.
                let Some(vin_txid) = vin.get("txid").and_then(Value::as_str) else {
                    inputs.push(crate::wire::IngestInput {
                        txid: "00".repeat(32),
                        vout: u32::MAX,
                        value: 0,
                        inscription: None,
                    });
                    continue;
                };
                let vout = vin
                    .get("vout")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| RpcError::Malformed("vin: no vout".into()))?
                    as u32;
                let value = match vin
                    .get("prevout")
                    .and_then(|p| p.get("value"))
                    .and_then(Value::as_f64)
                {
                    Some(btc) => btc_to_sats(btc),
                    None => {
                        // Older Core without prevout in vin: look the
                        // spent output up directly.
                        let prev = self.call("getrawtransaction", json!([vin_txid, 1]))?;
                        prev.get("vout")
                            .and_then(Value::as_array)
                            .and_then(|vouts| vouts.get(vout as usize))
                            .and_then(|o| o.get("value"))
                            .and_then(Value::as_f64)
                            .map(btc_to_sats)
                            .ok_or_else(|| {
                                RpcError::Malformed(format!(
                                    "prevout value not found for {vin_txid}:{vout}"
                                ))
                            })?
                    }
                };
                inputs.push(crate::wire::IngestInput {
                    txid: vin_txid.to_string(),
                    vout,
                    value,
                    inscription: decode_input_inscription(&txid, vin, &mut inscription_index),
                });
            }

            let mut outputs = Vec::new();
            let vouts = tx
                .get("vout")
                .and_then(Value::as_array)
                .ok_or_else(|| RpcError::Malformed("tx: no vout".into()))?;
            for vout in vouts {
                let value = btc_to_sats(
                    vout.get("value")
                        .and_then(Value::as_f64)
                        .ok_or_else(|| RpcError::Malformed("vout: no value".into()))?,
                );
                let script = vout
                    .get("scriptPubKey")
                    .and_then(|s| s.get("hex"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                outputs.push(crate::wire::IngestOutput {
                    value,
                    op_return: push_payload(script),
                });
            }
            txs.push(crate::wire::IngestTx {
                txid,
                inputs,
                outputs,
            });
        }

        Ok(crate::wire::IngestBlock {
            hash: display,
            height,
            txs,
        })
    }

    /// Display-order hex → internal byte order (shared convention with
    /// `wire::hex32`).
    fn display_to_internal(&self, hex: &str) -> Result<[u8; 32], RpcError> {
        crate::wire::parse_hash(hex)
            .map_err(|e| RpcError::Malformed(format!("bad hash {hex:?}: {}", e.message())))
    }
}

/// Internal byte order → display-order hex (bitcoin-cli print order).
fn internal_to_display(hash: [u8; 32]) -> String {
    crate::dto::hex_display(&hash)
}

/// The live chain source: bitcoind over JSON-RPC. `sync_to_tip` walks
/// this exactly like it walks the test fakes.
impl crate::sync::BlockSource for BitcoinRpc {
    fn best_hash(&mut self) -> Result<[u8; 32], crate::sync::SyncError> {
        BitcoinRpc::best_hash(self).map_err(|e| crate::sync::SyncError::Source(e.to_string()))
    }
    fn header(
        &mut self,
        hash: [u8; 32],
    ) -> Result<crate::rpc::ChainHeader, crate::sync::SyncError> {
        BitcoinRpc::block_header(self, hash)
            .map_err(|e| crate::sync::SyncError::Source(e.to_string()))
    }
    fn block(
        &mut self,
        hash: [u8; 32],
    ) -> Result<hopper_indexer::types::Block, crate::sync::SyncError> {
        let dto = BitcoinRpc::fetch_block(self, hash)
            .map_err(|e| crate::sync::SyncError::Source(e.to_string()))?;
        crate::wire::to_block(dto).map_err(|e| crate::sync::SyncError::Source(e.message().into()))
    }
}

/// BTC (float) → sats, matching the block feeder's `round(v * 1e8)`.
fn btc_to_sats(btc: f64) -> u64 {
    (btc * 1e8).round() as u64
}

/// Extract the raw OP_RETURN push payload from a script hex string, as
/// hex — or `None` if the script is not a plain OP_RETURN push. Port of
/// the live-regtest feeder's `push_payload` (direct pushes and
/// PUSHDATA1/2/4; truncated pushes yield None).
pub fn push_payload(script_hex: &str) -> Option<String> {
    let script = crate::wire::hex_decode(script_hex)?;
    let payload = push_payload_bytes(&script)?;
    Some(hex_encode(payload))
}

pub(crate) fn push_payload_bytes(script: &[u8]) -> Option<&[u8]> {
    if script.first() != Some(&0x6A) {
        return None;
    }
    let mut i = 1;
    let op = *script.get(i)?;
    i += 1;
    let len = match op {
        1..=0x4B => op as usize,
        0x4C => {
            let n = *script.get(i)? as usize;
            i += 1;
            n
        }
        0x4D => {
            let b = script.get(i..i + 2)?;
            i += 2;
            u16::from_le_bytes([b[0], b[1]]) as usize
        }
        0x4E => {
            let b = script.get(i..i + 4)?;
            i += 4;
            u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize
        }
        _ => return None,
    };
    // `get` returns None on truncation — a partial push is no push.
    script.get(i..i + len)
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Change B: decode an input's inscription reveal from a verbose
/// `getrawtransaction` `vin` entry.
///
/// Mirrors ord 0.22.2: the tapscript of a taproot script-path spend is
/// `witness[n-2]` (control block last); envelopes are enumerated across
/// the tx's inputs in order, so inscription ids are
/// `{txid}i{running_index}`. Only the input's FIRST inscription is
/// surfaced to the pure core (per-input `Option`); a mint needs exactly
/// one reveal on input 0, which the state machine enforces.
fn decode_input_inscription(
    txid_display: &str,
    vin: &Value,
    running_index: &mut u32,
) -> Option<crate::wire::IngestInscription> {
    let witness = vin.get("txinwitness")?.as_array()?;
    if witness.len() < 2 {
        return None; // not a script-path spend
    }
    let tapscript_hex = witness.get(witness.len() - 2)?.as_str()?;
    let script = crate::wire::hex_decode(tapscript_hex)?;
    let inscriptions = hopper_core::parse_inscriptions(&script);
    let first = inscriptions.first()?;
    let inscription_id = hopper_core::inscription_id(txid_display, *running_index);
    *running_index += inscriptions.len() as u32;
    let body = first.body.as_deref().unwrap_or(&[]);
    use bitcoin::hashes::{sha256, Hash};
    let digest = sha256::Hash::hash(body);
    let pointer = first.pointer.as_ref().and_then(|p| {
        if p.len() > 8 { return None; }
        let mut buf = [0u8; 8];
        buf[..p.len()].copy_from_slice(p);
        Some(u64::from_le_bytes(buf))
    });
    let count = inscriptions.len().max(1) as u32;
    let valid = !first.duplicate_field && !first.incomplete_field
        && !first.pushnum && !first.stutter;
    Some(crate::wire::IngestInscription {
        content_type: String::from_utf8_lossy(&first.content_type.clone().unwrap_or_default())
            .to_string(),
        body_hash: hex_encode(&digest.to_byte_array()),
        inscription_id,
        // V3: the raw body is the CROSS authority; parents are ord tag 3;
        // the tapscript + control block let the indexer verify the ticket
        // shape (NUMS internal key, one leaf, one envelope).
        body: Some(hex_encode(body)),
        parents: first.parents.iter().map(|p| hex_encode(p)).collect(),
        tapscript: Some(tapscript_hex.to_string()),
        control_block: witness.last().and_then(|c| c.as_str()).map(str::to_string),
        pointer,
        inscription_count: count,
        valid,
    })
}

/// Minimal standard base64 (Basic auth headers only).
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn push_payload_direct_and_pushdata() {
        // OP_RETURN <push 4> 46 10 52 47 ("FRG"-ish payload)
        assert_eq!(push_payload("6a0446105247"), Some("46105247".to_string()));
        // PUSHDATA1
        assert_eq!(push_payload("6a4c0446105247"), Some("46105247".to_string()));
        // PUSHDATA2 (little-endian length)
        assert_eq!(
            push_payload("6a4d040046105247"),
            Some("46105247".to_string())
        );
        // PUSHDATA4
        assert_eq!(
            push_payload("6a4e0400000046105247"),
            Some("46105247".to_string())
        );
    }

    #[test]
    fn push_payload_rejects_non_opreturn_and_truncated() {
        assert_eq!(push_payload("76a91400"), None); // P2PKH prefix
        assert_eq!(push_payload("6a"), None); // opcode only
        assert_eq!(push_payload("6a054610"), None); // truncated push
        assert_eq!(push_payload(""), None);
        // Not a push after OP_RETURN (e.g. OP_RESERVED 0x50).
        assert_eq!(push_payload("6a50"), None);
    }

    #[test]
    fn btc_to_sats_rounding() {
        assert_eq!(btc_to_sats(50.0), 5_000_000_000); // regtest subsidy
        assert_eq!(btc_to_sats(0.00000001), 1);
        assert_eq!(btc_to_sats(1.23456789), 123_456_789);
    }
}
