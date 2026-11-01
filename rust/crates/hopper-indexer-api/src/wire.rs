//! Human-friendly wire format for `POST /v1/admin/block`.
//!
//! The pure indexer's `Block` serializes `[u8; 32]` as JSON arrays (it is
//! a frozen core type); this DTO accepts hex strings in **display
//! order** (the order bitcoin-cli and every explorer print — internal
//! byte order reversed) so operators can push blocks with curl during
//! the signet game week (B5). Converted into the core `Block` (internal
//! byte order) before hitting the state machine.

use hopper_indexer::types::{Block, InscriptionReveal, OutPoint, Tx, TxInput, TxOut};
use serde::Deserialize;

use crate::ApiError;

/// Parse a 32-byte hex string; accepts either byte order (we cannot
/// always know which side the caller meant, so we accept both: a
/// self-consistent txid round-trips as long as the SAME string is used
/// for prevouts and txids).
pub fn parse_hash(s: &str) -> Result<[u8; 32], ApiError> {
    hex32(s)
}
/// Parse a 32-byte hash in **display order** (as printed by bitcoin-cli
/// and explorers) into internal byte order — i.e. reverse the hex
/// bytes. This is the inverse of `crate::dto::hex_display`, so a
/// txid fed in display order comes back out in display order (the
/// live-regtest round-trip caught the pair being asymmetric: outputs
/// were emitted in internal order, which no caller could parse).
fn hex32(s: &str) -> Result<[u8; 32], ApiError> {
    let s = s.trim();
    let bytes = hex_decode(s)
        .ok_or_else(|| ApiError::BadRequest(format!("not a 32-byte hex string: {s:?}")))?;
    if bytes.len() != 32 {
        return Err(ApiError::BadRequest(format!(
            "hash must be 32 bytes (64 hex chars), got {} bytes",
            bytes.len()
        )));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    out.reverse();
    Ok(out)
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    use bitcoin::hashes::{sha256, Hash};
    sha256::Hash::hash(bytes).to_byte_array()
}

pub(crate) fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok())
        .collect()
}

#[derive(Deserialize)]
pub struct IngestBlock {
    pub hash: String,
    pub height: u32,
    #[serde(default)]
    pub txs: Vec<IngestTx>,
}

#[derive(Deserialize)]
pub struct IngestTx {
    pub txid: String,
    #[serde(default)]
    pub inputs: Vec<IngestInput>,
    #[serde(default)]
    pub outputs: Vec<IngestOutput>,
}

#[derive(Deserialize)]
pub struct IngestInput {
    pub txid: String,
    pub vout: u32,
    pub value: u64,
    /// Change B: inscription revealed by this input's taproot
    /// script-path witness (decoded summary; the pure core is
    /// witness-free).
    #[serde(default)]
    pub inscription: Option<IngestInscription>,
}

/// Hex-friendly inscription reveal DTO (Change B). `body_hash` is the
/// 64-hex SHA-256 of the inscription body.
#[derive(Deserialize)]
pub struct IngestInscription {
    /// Content-type string, e.g. `"image/png"`.
    pub content_type: String,
    /// 64-hex SHA-256 of the inscription body. Ignored when `body` is
    /// supplied: the indexer recomputes it (V3 §8.2).
    pub body_hash: String,
    /// Ord inscription id (`{reveal_txid}i{index}`).
    pub inscription_id: String,
    /// Raw body, hex (V3 §6.2 — the CROSS authority).
    #[serde(default)]
    pub body: Option<String>,
    /// Raw tag-3 parent values, hex, in ord payload order (V3 §6.3).
    #[serde(default)]
    pub parents: Vec<String>,
    /// The tapscript that revealed the envelope, hex (V3 §6.4).
    #[serde(default)]
    pub tapscript: Option<String>,
    /// The control block of that script-path spend, hex.
    #[serde(default)]
    pub control_block: Option<String>,
    /// ord pointer, decimal.
    #[serde(default)]
    pub pointer: Option<u64>,
    /// Number of inscriptions in this input.
    #[serde(default = "one_inscription")]
    pub inscription_count: u32,
    /// False for duplicate/incomplete/pushnum/stutter envelopes.
    #[serde(default = "true_value")]
    pub valid: bool,
}

fn one_inscription() -> u32 { 1 }
fn true_value() -> bool { true }

#[derive(Deserialize)]
pub struct IngestOutput {
    pub value: u64,
    /// Hex of the raw OP_RETURN push payload (bytes after the opcode),
    /// or null. Build it with the wallet / `hopper-core` encoders.
    #[serde(default)]
    pub op_return: Option<String>,
}

/// Convert to the core `Block`. All hex is display order (reversed into
/// internal byte order here); identifiers are opaque to the state machine.
pub fn to_block(dto: IngestBlock) -> Result<Block, ApiError> {
    let hash = hex32(&dto.hash)?;
    let mut txs = Vec::with_capacity(dto.txs.len());
    for tx in dto.txs {
        let txid = hex32(&tx.txid)?;
        let mut inputs = Vec::with_capacity(tx.inputs.len());
        for input in tx.inputs {
            let inscription = match input.inscription {
                None => None,
                Some(ins) => {
                    let hash_bytes = hex_decode(&ins.body_hash).ok_or_else(|| {
                        ApiError::BadRequest(format!(
                            "inscription body_hash not valid hex: {:?}",
                            ins.body_hash
                        ))
                    })?;
                    if hash_bytes.len() != 32 {
                        return Err(ApiError::BadRequest(format!(
                            "inscription body_hash must be 32 bytes (64 hex chars), got {} bytes",
                            hash_bytes.len()
                        )));
                    }
                    let mut body_hash = [0u8; 32];
                    body_hash.copy_from_slice(&hash_bytes);
                    let body = match ins.body.as_deref() {
                        None => None,
                        Some(hex) => {
                            let bytes = hex_decode(hex).ok_or_else(|| {
                                ApiError::BadRequest("inscription body is not valid hex".into())
                            })?;
                            // The body is the authority: never trust the
                            // wire hash (V3 §8.2 rule 1).
                            body_hash = sha256(&bytes);
                            Some(bytes)
                        }
                    };
                    let mut parents = Vec::with_capacity(ins.parents.len());
                    for parent in &ins.parents {
                        parents.push(hex_decode(parent).ok_or_else(|| {
                            ApiError::BadRequest("inscription parent is not valid hex".into())
                        })?);
                    }
                    let hex_field = |value: Option<String>, what: &str| {
                        value
                            .map(|hex| {
                                hex_decode(&hex).ok_or_else(|| {
                                    ApiError::BadRequest(format!(
                                        "inscription {what} is not valid hex"
                                    ))
                                })
                            })
                            .transpose()
                    };
                    Some(InscriptionReveal {
                        content_type: ins.content_type,
                        body_hash,
                        inscription_id: ins.inscription_id,
                        body,
                        parents,
                        tapscript: hex_field(ins.tapscript, "tapscript")?,
                        control_block: hex_field(ins.control_block, "control_block")?,
                        pointer: ins.pointer,
                        inscription_count: ins.inscription_count.max(1),
                        valid: ins.valid,
                    })
                }
            };
            inputs.push(TxInput {
                prevout: OutPoint {
                    txid: hex32(&input.txid)?,
                    vout: input.vout,
                },
                value: input.value,
                inscription,
            });
        }
        let mut outputs = Vec::with_capacity(tx.outputs.len());
        for out in tx.outputs {
            outputs.push(TxOut {
                value: out.value,
                op_return: match out.op_return {
                    None => None,
                    Some(hex) => Some(hex_decode(&hex).ok_or_else(|| {
                        ApiError::BadRequest(format!("op_return not valid hex: {hex:?}"))
                    })?),
                },
            });
        }
        txs.push(Tx {
            txid,
            inputs,
            outputs,
        });
    }
    Ok(Block {
        hash,
        height: dto.height,
        txs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_block() {
        let json = r#"{
            "hash": "aa010000000000000000000000000000000000000000000000000000000002bb",
            "height": 42,
            "txs": [{
                "txid": "cd030000000000000000000000000000000000000000000000000000000004ef",
                "inputs": [{"txid": "ff00000000000000000000000000000000000000000000000000000000000011", "vout": 3, "value": 1000}],
                "outputs": [
                    {"value": 1000, "op_return": null},
                    {"value": 0, "op_return": "46105247"}
                ]
            }]
        }"#;
        let dto: IngestBlock = serde_json::from_str(json).unwrap();
        let block = to_block(dto).unwrap();
        assert_eq!(block.height, 42);
        assert_eq!(block.txs.len(), 1);
        assert_eq!(block.txs[0].inputs[0].prevout.vout, 3);
        // "FRG" in hex.
        assert_eq!(
            block.txs[0].outputs[1].op_return.as_deref(),
            Some(&[0x46u8, 0x10, 0x52, 0x47][..])
        );
    }

    #[test]
    fn rejects_short_hashes() {
        let dto: IngestBlock = serde_json::from_value(serde_json::json!({
            "hash": "abcd", "height": 1, "txs": []
        }))
        .unwrap();
        assert!(to_block(dto).is_err());
    }

    #[test]
    fn rejects_odd_hex() {
        let dto: IngestBlock = serde_json::from_value(serde_json::json!({
            "hash": "zz", "height": 1, "txs": []
        }))
        .unwrap();
        assert!(to_block(dto).is_err());
    }

    #[test]
    fn hash_parse_and_display_round_trip() {
        // A display-order hex (bitcoin-cli style) fed through the wire
        // parser must come back out in the SAME display order via
        // `dto::hex_display` — the live-regtest stack caught the pair
        // being asymmetric (outputs emitted internal order).
        let display = "1e413e22afd568959a3487be99b586532df324fac4d25411c3c02161c2361f41";
        let internal = hex32(display).unwrap();
        assert_eq!(crate::dto::hex_display(&internal), display);
    }

    fn inscribed_block(body_hash: &str) -> Result<Block, ApiError> {
        let dto: IngestBlock = serde_json::from_value(serde_json::json!({
            "hash": "aa010000000000000000000000000000000000000000000000000000000002bb",
            "height": 42,
            "txs": [{
                "txid": "cd030000000000000000000000000000000000000000000000000000000004ef",
                "inputs": [{
                    "txid": "ff00000000000000000000000000000000000000000000000000000000000011",
                    "vout": 0, "value": 1000,
                    "inscription": {
                        "content_type": "image/png",
                        "body_hash": body_hash,
                        "inscription_id": "cd03…i0"
                    }
                }],
                "outputs": [{"value": 1000, "op_return": null}]
            }]
        }))
        .unwrap();
        to_block(dto)
    }

    #[test]
    fn inscription_body_hash_round_trips() {
        let hash_hex = "a1b2c3d4".repeat(8);
        let block = inscribed_block(&hash_hex).unwrap();
        let ins = block.txs[0].inputs[0]
            .inscription
            .as_ref()
            .expect("inscription survives conversion");
        assert_eq!(ins.content_type, "image/png");
        assert_eq!(ins.body_hash.len(), 32);
        assert_eq!(
            ins.body_hash
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            hash_hex
        );
        assert_eq!(ins.inscription_id, "cd03…i0");
    }

    #[test]
    fn inscription_without_field_is_defaulted() {
        // `inscription` is #[serde(default)]: legacy pushes (no
        // inscription key) must still parse.
        let block = inscribed_block_innerless().unwrap();
        assert!(block.txs[0].inputs[0].inscription.is_none());
    }

    fn inscribed_block_innerless() -> Result<Block, ApiError> {
        let dto: IngestBlock = serde_json::from_value(serde_json::json!({
            "hash": "aa010000000000000000000000000000000000000000000000000000000002bb",
            "height": 42,
            "txs": [{
                "txid": "cd030000000000000000000000000000000000000000000000000000000004ef",
                "inputs": [{
                    "txid": "ff00000000000000000000000000000000000000000000000000000000000011",
                    "vout": 0, "value": 1000
                }],
                "outputs": [{"value": 1000, "op_return": null}]
            }]
        }))
        .unwrap();
        to_block(dto)
    }

    #[test]
    fn inscription_rejects_bad_hex_and_wrong_length() {
        assert!(inscribed_block("not-hex!").is_err());
        // 31 bytes: too short.
        assert!(inscribed_block(&"ab".repeat(31)).is_err());
        // 33 bytes: too long.
        assert!(inscribed_block(&"ab".repeat(33)).is_err());
    }
}
