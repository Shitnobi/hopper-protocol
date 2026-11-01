//! Mempool preview (B4 leftovers): what is queued in bitcoind's mempool
//! *right now*, before confirmation.
//!
//! The indexer is confirm-first by design (state is a pure function of
//! the confirmed chain; anchors and windows are block-height facts).
//! But wallets want feedback between broadcast and confirmation —
//! "is my COMMIT_F visible to the indexer yet?" This module fetches
//! raw mempool txs over bitcoind RPC, decodes each one, extracts FRG
//! envelopes, and reports which tracked UTXOs the tx spends.
//!
//! Contract rules (documented, not enforced pre-confirmation):
//! * a tx carrying **more than one** FRG envelope is ignored in full
//!   at confirm time (SPEC §8.1 table) — the preview reports
//!   `frg_push_count` (the raw FRG-magic push count the indexer's rule
//!   fires on, malformed/unknown-version pushes included) plus the
//!   decoded envelopes, so the wallet can warn the user *before* the
//!   tx confirms into oblivion;
//! * envelope validity (mint spends a seeded UTXO, CROSS commits the
//!   frog's live anchor, …) is only checked at confirm time against
//!   the then-current chain — the preview is a hint, not a verdict.
//!
//! Structure: [`preview_raw_tx`] is a pure function (decode +
//! classify against a `tracked` closure) — unit-testable with a
//! locally-built `bitcoin::Transaction`; the RPC side
//! ([`crate::rpc::BitcoinRpc::mempool_txids`] / `raw_tx_hex`) is a
//! thin loop validated against the live regtest stack.
//!
//! Byte-order convention: `bitcoin`-crate hashes serialize in display
//! order; `Txid::to_byte_array` returns the **internal** byte order,
//! which is exactly what the indexer's `OutPoint`/`utxo_ranges` expect.

use bitcoin::consensus::Decodable;
use bitcoin::hashes::Hash;
use bitcoin::Transaction;
use serde::Serialize;

/// One decoded FRG envelope in a mempool tx.
#[derive(Debug, Serialize, PartialEq)]
pub struct EnvelopeDto {
    /// `mint` | `cross` | `car` | `reveal`
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frogger_sat: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commitment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
}

/// One mempool transaction, summarized for the preview.
#[derive(Debug, Serialize, PartialEq)]
pub struct MempoolEntryDto {
    /// Txid in display order (as bitcoind prints it).
    pub txid: String,
    /// All FRG envelopes decoded from this tx's OP_RETURN outputs.
    /// Usually 0 or 1; >1 means the tx will be IGNORED at confirm time
    /// (SPEC §8.1) — surfaced so the wallet can warn.
    pub envelopes: Vec<EnvelopeDto>,
    /// FRG-magic OP_RETURN pushes in this tx (`len >= 3 && magic`,
    /// exactly the indexer's scan predicate). This is the count the
    /// confirm-time multiple-envelope rule fires on: >1 ⇒ the tx is
    /// ignored in full. May exceed `envelopes.len()` when a push
    /// carries FRG magic but fails to decode (malformed payload or
    /// unknown wire version).
    pub frg_push_count: usize,
    /// Ord inscription reveals decoded from this tx's inputs (Change
    /// B): a two-phase mint preview shows its art + id here.
    pub inscriptions: Vec<InscriptionDto>,
    /// Tracked UTXOs (display txid + vout) spent by this tx — a hint
    /// that it moves frogs or their funding.
    pub spends_tracked: Vec<SpentOutpointDto>,
    /// True if any input spends a tracked UTXO.
    pub tracked: bool,
    /// V3: the first CROSS body in the tx, with the indexer's reading of
    /// it at `tip + 1`. Never mutates state (§8.8).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cross: Option<CrossPreviewDto>,
}

/// A CROSS decoded from a mempool ticket inscription.
#[derive(Debug, Serialize, PartialEq)]
pub struct CrossBodyDto {
    pub sat: u64,
    /// Display order, as explorers print it.
    pub mint_txid: String,
    pub mint_index: u32,
    /// The direction the body commits to (0 left, 1 straight, 2 right).
    pub dir: u8,
}

/// What the indexer would make of this CROSS if it confirmed next block.
#[derive(Debug, Serialize, PartialEq)]
pub struct CrossPreviewDto {
    pub sat: u64,
    pub mint_txid: String,
    pub mint_index: u32,
    /// The frog's state now, if the indexer tracks it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<&'static str>,
    /// `required_hops(tip + 1)` — the target that would freeze at T.
    pub target_hops: u32,
    /// `T + cross_finality`, the height the outcome settles at.
    pub settle_height: u32,
    /// Always true: nothing is decided before confirmation.
    pub provisional: bool,
    /// Why the indexer would reject it, when it already knows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection: Option<String>,
}

/// One decoded ord inscription reveal (Change B).
#[derive(Debug, Serialize, PartialEq)]
pub struct InscriptionDto {
    /// Input index carrying the reveal.
    pub input: usize,
    /// Content-type string (e.g. `image/png`).
    pub content_type: String,
    /// 64-hex SHA-256 of the inscription body.
    pub body_hash: String,
    /// Ord inscription id (`{txid}i{index}`).
    pub inscription_id: String,
    /// V3: the CROSS body, when the body carries the CROSS magic.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cross: Option<CrossBodyDto>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SpentOutpointDto {
    pub txid: String,
    pub vout: u32,
}

/// The whole preview (wrapper keeps room for metadata later).
#[derive(Debug, Serialize)]
pub struct MempoolPreviewDto {
    pub entries: Vec<MempoolEntryDto>,
}

/// Decode one raw mempool tx and classify it. `tracked` is called per
/// input with (internal-order txid, vout) and answers whether the
/// indexer tracks that UTXO. Txid is the caller's (display order,
/// from `getrawmempool`).
pub fn preview_raw_tx(
    txid_display: &str,
    raw: &[u8],
    tracked: impl Fn([u8; 32], u32) -> bool,
) -> MempoolEntryDto {
    let tx = Transaction::consensus_decode(&mut &raw[..]).ok();
    let mut envelopes = Vec::new();
    let mut frg_push_count = 0usize;
    let mut spends_tracked = Vec::new();
    let mut inscriptions = Vec::new();

    if let Some(tx) = tx {
        // Envelope scan: the SAME extractor as live ingest
        // (`rpc::push_payload_bytes` — direct pushes and
        // PUSHDATA1/2/4 alike) and the SAME predicate as the state
        // machine (FRG-magic count, `len >= 3`). `frg_push_count` is
        // what the indexer's multiple-envelope rule will fire on at
        // confirm time; the decoded `envelopes` list can be shorter
        // (malformed or unknown-version pushes count but do not
        // decode).
        for out in &tx.output {
            if let Some(push) = crate::rpc::push_payload_bytes(out.script_pubkey.as_bytes()) {
                if push.len() >= 3 && push[..3] == hopper_core::envelope::MAGIC {
                    frg_push_count += 1;
                    if let Ok(msg) = hopper_core::envelope::decode(push) {
                        envelopes.push(envelope_dto(&msg));
                    }
                }
            }
        }
        // Tracked-UTXO scan over the inputs.
        for input in &tx.input {
            let prev = input.previous_output;
            let txid_internal = prev.txid.to_byte_array();
            if tracked(txid_internal, prev.vout) {
                spends_tracked.push(SpentOutpointDto {
                    txid: prev.txid.to_string(),
                    vout: prev.vout,
                });
            }
        }
        // Change B: inscription reveal scan over the inputs (same
        // tapscript rule ord uses: witness[n-2] of a script-path
        // spend; envelope ids numbered across inputs in order).
        let mut running_index = 0u32;
        for (i, input) in tx.input.iter().enumerate() {
            let witness: Vec<&[u8]> = input.witness.iter().collect();
            if witness.len() < 2 {
                continue;
            }
            let tapscript = witness[witness.len() - 2];
            let decoded = hopper_core::parse_inscriptions(tapscript);
            for ins in &decoded {
                let body = ins.body.as_deref().unwrap_or(&[]);
                use bitcoin::hashes::{sha256, Hash};
                let digest = sha256::Hash::hash(body);
                inscriptions.push(InscriptionDto {
                    input: i,
                    content_type: String::from_utf8_lossy(
                        &ins.content_type.clone().unwrap_or_default(),
                    )
                    .to_string(),
                    body_hash: {
                        let mut out = String::with_capacity(64);
                        for byte in digest.to_byte_array() {
                            out.push_str(&format!("{byte:02x}"));
                        }
                        out
                    },
                    inscription_id: hopper_core::inscription_id(txid_display, running_index),
                    cross: hopper_core::decode_state_body(body)
                        .ok()
                        .map(|c| CrossBodyDto {
                            sat: c.sat,
                            mint_txid: hopper_core::mint_id_string(&c.mint_txid, c.mint_index)
                                .split('i')
                                .next()
                                .unwrap_or_default()
                                .to_string(),
                            mint_index: c.mint_index,
                            dir: c.dir,
                        }),
                });
                running_index += 1;
            }
        }
    }

    let tracked_flag = !spends_tracked.is_empty();
    MempoolEntryDto {
        txid: txid_display.to_string(),
        envelopes,
        frg_push_count,
        inscriptions,
        spends_tracked,
        tracked: tracked_flag,
        cross: None,
    }
}

fn envelope_dto(msg: &hopper_core::envelope::Message) -> EnvelopeDto {
    use hopper_core::envelope::Message;
    match msg {
        Message::Mint { seed, name, .. } => EnvelopeDto {
            kind: "mint",
            seed: Some(*seed),
            name: Some(name.clone()),
            frogger_sat: None,
            commitment: None,
            nonce: None,
        },
    }
}

#[cfg(test)]
fn hex32(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::absolute::LockTime;
    use bitcoin::script::PushBytesBuf;
    use bitcoin::transaction::Version;
    use bitcoin::{Amount, OutPoint, ScriptBuf, Sequence, TxIn, TxOut, Txid, Witness};

    /// Encode a tx with the given outputs and one input spending
    /// `[7;32]:0` (the fixture "anchor" outpoint).
    fn raw_tx(outputs: Vec<TxOut>) -> Vec<u8> {
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_byte_array([7u8; 32]),
                    vout: 0,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: outputs,
        };
        let mut buf = Vec::new();
        bitcoin::consensus::Encodable::consensus_encode(&tx, &mut buf).unwrap();
        buf
    }

    /// An OP_RETURN output carrying `payload` (handles direct pushes
    /// and PUSHDATA1 alike — `new_op_return` picks the opcode).
    fn op_return_out(payload: &[u8]) -> TxOut {
        let push: PushBytesBuf = payload.to_vec().try_into().unwrap();
        TxOut {
            value: Amount::from_sat(0),
            script_pubkey: ScriptBuf::new_op_return(&push),
        }
    }

    fn plain_out(value: u64) -> TxOut {
        TxOut {
            value: Amount::from_sat(value),
            script_pubkey: ScriptBuf::new(),
        }
    }

    #[test]
    fn decodes_mint_envelope() {
        let payload = hopper_core::envelope(
            hopper_core::Action::Mint,
            &hopper_core::encode_mint(0xABCD, "Preview"),
        );
        let raw = raw_tx(vec![plain_out(1000), op_return_out(&payload)]);
        let entry = preview_raw_tx("deadbeef", &raw, |_, _| false);
        assert_eq!(entry.txid, "deadbeef");
        assert_eq!(entry.envelopes.len(), 1);
        assert_eq!(entry.envelopes[0].kind, "mint");
        assert_eq!(entry.envelopes[0].seed, Some(0xABCD));
        assert_eq!(entry.envelopes[0].name.as_deref(), Some("Preview"));
        assert!(!entry.tracked);
    }

    #[test]
    fn plain_tx_has_no_envelopes() {
        let raw = raw_tx(vec![op_return_out(b"not FRG")]);
        let entry = preview_raw_tx("aa", &raw, |_, _| false);
        assert!(entry.envelopes.is_empty());
        assert!(!entry.tracked);
    }

    /// Hand-built `OP_RETURN OP_PUSHDATA2 <le16 len> <payload>` script.
    /// Non-minimal but consensus-legal (and standard under Bitcoin
    /// Core's 83-byte null-data relay rule) — `new_op_return` never
    /// produces it, so it must be assembled byte-wise.
    fn op_return_pushdata2_out(payload: &[u8]) -> TxOut {
        let mut bytes = vec![0x6a, 0x4d];
        bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        bytes.extend_from_slice(payload);
        TxOut {
            value: Amount::from_sat(0),
            script_pubkey: ScriptBuf::from(bytes),
        }
    }

    #[test]
    fn pushdata2_carried_envelope_is_detected() {
        // Extraction parity with live ingest: `rpc::push_payload_bytes`
        // (the consensus path) extracts PUSHDATA2/4-carried pushes, so
        // the indexer WILL index such an envelope at confirm time. The
        // preview's former local extractor only handled direct pushes
        // and PUSHDATA1 — it silently missed them.
        let payload = hopper_core::envelope(
            hopper_core::Action::Mint,
            &hopper_core::encode_mint(0xBEEF, "PD2"),
        );
        let raw = raw_tx(vec![plain_out(1000), op_return_pushdata2_out(&payload)]);
        let entry = preview_raw_tx("pd2", &raw, |_, _| false);
        assert_eq!(entry.frg_push_count, 1);
        assert_eq!(entry.envelopes.len(), 1);
        assert_eq!(entry.envelopes[0].kind, "mint");
        assert_eq!(entry.envelopes[0].seed, Some(0xBEEF));
    }

    #[test]
    fn frg_push_count_matches_the_indexer_rule() {
        // `frg_push_count` mirrors the state machine's scan predicate
        // exactly (`len >= 3 && magic`, no version check): it is the
        // count the confirm-time ignore-in-full rule fires on, which
        // can exceed the decoded envelope list.
        let mint =
            hopper_core::envelope(hopper_core::Action::Mint, &hopper_core::encode_mint(1, "A"));
        // Valid envelope + 3-byte FRG fragment: two FRG pushes, one
        // decodes — the tx will be ignored in full at confirm time.
        let raw = raw_tx(vec![op_return_out(&mint), op_return_out(b"FRG")]);
        let entry = preview_raw_tx("frag", &raw, |_, _| false);
        assert_eq!(entry.frg_push_count, 2);
        assert_eq!(entry.envelopes.len(), 1);

        // Unknown wire version: counts, never decodes (inert).
        let raw = raw_tx(vec![op_return_out(b"FRG\x09\x01\x00\x00\x00\x00\x00")]);
        let entry = preview_raw_tx("unk", &raw, |_, _| false);
        assert_eq!(entry.frg_push_count, 1);
        assert!(entry.envelopes.is_empty());

        // A non-FRG annotation alongside a valid envelope: one FRG
        // push — does NOT disqualify (the rule counts FRG pushes only).
        let raw = raw_tx(vec![
            op_return_out(&mint),
            op_return_out(b"not an FRG envelope"),
        ]);
        let entry = preview_raw_tx("decoy", &raw, |_, _| false);
        assert_eq!(entry.frg_push_count, 1);
        assert_eq!(entry.envelopes.len(), 1);
    }

    #[test]
    fn garbage_bytes_decode_to_empty_entry() {
        let entry = preview_raw_tx("ff", &[0xff; 10], |_, _| false);
        assert!(entry.envelopes.is_empty());
        assert!(entry.spends_tracked.is_empty());
    }

    #[test]
    fn two_envelopes_are_surfaced_not_hidden() {
        // SPEC §8.1: >1 envelope per tx → ignored at confirm time. The
        // preview must show both so the wallet can warn.
        let p1 =
            hopper_core::envelope(hopper_core::Action::Mint, &hopper_core::encode_mint(1, "A"));
        let p2 =
            hopper_core::envelope(hopper_core::Action::Mint, &hopper_core::encode_mint(2, "B"));
        let raw = raw_tx(vec![op_return_out(&p1), op_return_out(&p2)]);
        let entry = preview_raw_tx("dd", &raw, |_, _| false);
        assert_eq!(entry.envelopes.len(), 2);
        assert_eq!(entry.envelopes[0].kind, "mint");
        assert_eq!(entry.envelopes[1].kind, "mint");
    }

    /// Raw OP_RETURN script from explicit bytes (for non-canonical
    /// shapes the script builder would refuse to produce).
    fn raw_op_return(bytes: &[u8]) -> TxOut {
        let mut b = vec![0x6a];
        b.extend_from_slice(bytes);
        TxOut {
            value: Amount::from_sat(0),
            script_pubkey: ScriptBuf::from(b),
        }
    }

    #[test]
    fn preview_matches_indexer_on_odd_op_return_shapes() {
        // The preview must extract exactly what live ingest extracts
        // (one shared `push_payload_bytes`): the FIRST push after
        // OP_RETURN, trailing bytes ignored, no scanning past a
        // non-push or a truncated push.
        let mint = hopper_core::envelope(
            hopper_core::Action::Mint,
            &hopper_core::encode_mint(9, "shapes"),
        );

        // Trailing junk after the envelope push: still counted.
        let mut bytes = vec![mint.len() as u8];
        bytes.extend_from_slice(&mint);
        bytes.extend_from_slice(&[0x51, 0x52]);
        let entry = preview_raw_tx("trail", &raw_tx(vec![raw_op_return(&bytes)]), |_, _| false);
        assert_eq!(entry.frg_push_count, 1);
        assert_eq!(entry.envelopes.len(), 1);

        // Empty first push (OP_0) before the envelope: not looked past.
        let mut bytes = vec![0x00, mint.len() as u8];
        bytes.extend_from_slice(&mint);
        let entry = preview_raw_tx("empty", &raw_tx(vec![raw_op_return(&bytes)]), |_, _| false);
        assert_eq!(entry.frg_push_count, 0);
        assert!(entry.envelopes.is_empty());

        // Non-push opcode first: not a data carrier.
        let mut bytes = vec![0x51, mint.len() as u8];
        bytes.extend_from_slice(&mint);
        let entry = preview_raw_tx("opcode", &raw_tx(vec![raw_op_return(&bytes)]), |_, _| false);
        assert_eq!(entry.frg_push_count, 0);

        // Truncated PUSHDATA2: a partial push is no push.
        let mut bytes = vec![0x4d, 0xff, 0xff];
        bytes.extend_from_slice(&mint);
        let entry = preview_raw_tx("trunc", &raw_tx(vec![raw_op_return(&bytes)]), |_, _| false);
        assert_eq!(entry.frg_push_count, 0);
        assert!(entry.envelopes.is_empty());

        // PUSHDATA2-carried envelope with trailing junk.
        let mut bytes = vec![0x4d];
        bytes.extend_from_slice(&(mint.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&mint);
        bytes.push(0x51);
        let entry = preview_raw_tx("pd2junk", &raw_tx(vec![raw_op_return(&bytes)]), |_, _| {
            false
        });
        assert_eq!(entry.frg_push_count, 1);
        assert_eq!(entry.envelopes.len(), 1);
    }

    #[test]
    fn op_return_push_handles_pushdata1() {
        // 79-byte push > 75-byte direct push budget → OP_PUSHDATA1.
        let payload = {
            let mut p = hopper_core::envelope::MAGIC.to_vec();
            p.push(hopper_core::envelope::VERSION);
            p.push(0x7f); // unknown action byte — decode fails, but push parsing must succeed
            p.extend_from_slice(&[0x41u8; 74]);
            p
        };
        assert_eq!(payload.len(), 79);
        let script = op_return_out(&payload).script_pubkey;
        assert_eq!(script.as_bytes().get(1), Some(&0x4c), "expected PUSHDATA1");
        // The shared extractor (same one live ingest uses).
        let got = crate::rpc::push_payload_bytes(script.as_bytes()).unwrap();
        assert_eq!(got, payload.as_slice());
    }

    /// Encode a tx with one script-path taproot input: witness =
    /// [tapscript, control block] — the two-phase mint reveal shape.
    fn reveal_tx(tapscript: Vec<u8>, second: Option<Vec<u8>>) -> Vec<u8> {
        let mut witness = Witness::new();
        witness.push(tapscript);
        if let Some(b) = second {
            witness.push(b);
        } else {
            witness.push(vec![0xaa; 33]); // control-block stand-in
        }
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_byte_array([7u8; 32]),
                    vout: 0,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness,
            }],
            output: vec![plain_out(1000)],
        };
        let mut buf = Vec::new();
        bitcoin::consensus::Encodable::consensus_encode(&tx, &mut buf).unwrap();
        buf
    }

    /// The reveal tapleaf the wallet will build (B.4): OP_TRUE prefix
    /// (BIP342 clean-stack) + the golden-pinned envelope script.
    fn frog_reveal_tapscript(seed: u32) -> Vec<u8> {
        let mut bytes = vec![0x51]; // OP_TRUE
        bytes.extend_from_slice(&hopper_core::build_frog_mint_script(seed, 1_000, "Victim", 1));
        bytes
    }

    #[test]
    fn decodes_inscription_reveal_from_witness() {
        let seed = 0xABCD;
        let raw = reveal_tx(frog_reveal_tapscript(seed), None);
        let entry = preview_raw_tx("cafebabe", &raw, |_, _| false);
        assert_eq!(entry.inscriptions.len(), 1);
        let ins = &entry.inscriptions[0];
        assert_eq!(ins.input, 0);
        assert_eq!(ins.content_type, hopper_core::V8_CONTENT_TYPE);
        assert_eq!(
            ins.body_hash,
            hex32(&hopper_core::live_v8_html_digest(seed, 1_000, "Victim", 1))
        );
        assert_eq!(ins.inscription_id, "cafebabei0");
    }

    #[test]
    fn a_state_body_is_decoded_for_the_preview() {
        let body = hopper_core::StateBody {
            sat: 1_000,
            mint_txid: [2u8; 32],
            mint_index: 5,
            dir: 2,
        };
        let leaf = hopper_core::state_leaf_script(&[0x11; 32], &body);
        let raw = reveal_tx(leaf, None);
        let entry = preview_raw_tx("aa", &raw, |_, _| false);
        assert_eq!(entry.inscriptions.len(), 1);
        let cross = entry.inscriptions[0].cross.as_ref().expect("state body");
        assert_eq!(cross.sat, 1_000);
        assert_eq!(cross.mint_index, 5);
        assert_eq!(cross.dir, 2);
        // Display order of an all-0x02 txid is still all 02s.
        assert_eq!(cross.mint_txid, "02".repeat(32));
        // The route fills the verdict; the pure preview leaves it empty.
        assert!(entry.cross.is_none());
    }

    #[test]
    fn two_inscriptions_across_inputs_get_running_ids() {
        // ord numbers envelope ids across the tx's inputs in order.
        let raw = {
            let mut txs_in = Vec::new();
            for seed in [0x1111u32, 0x2222] {
                let mut witness = Witness::new();
                witness.push(frog_reveal_tapscript(seed));
                witness.push(vec![0xaa; 33]);
                txs_in.push(TxIn {
                    previous_output: OutPoint {
                        txid: Txid::from_byte_array([7u8; 32]),
                        vout: 0,
                    },
                    script_sig: ScriptBuf::new(),
                    sequence: Sequence::MAX,
                    witness,
                });
            }
            let tx = Transaction {
                version: Version::TWO,
                lock_time: LockTime::ZERO,
                input: txs_in,
                output: vec![plain_out(1000)],
            };
            let mut buf = Vec::new();
            bitcoin::consensus::Encodable::consensus_encode(&tx, &mut buf).unwrap();
            buf
        };
        let entry = preview_raw_tx("feed", &raw, |_, _| false);
        assert_eq!(entry.inscriptions.len(), 2);
        assert_eq!(entry.inscriptions[0].inscription_id, "feedi0");
        assert_eq!(entry.inscriptions[1].inscription_id, "feedi1");
        assert_eq!(entry.inscriptions[0].input, 0);
        assert_eq!(entry.inscriptions[1].input, 1);
    }

    #[test]
    fn keypath_witness_yields_no_inscriptions() {
        // Single-element (key-path) witness: not a script-path spend,
        // nothing to scan.
        let mut witness = Witness::new();
        witness.push(vec![0x64; 64]);
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_byte_array([7u8; 32]),
                    vout: 0,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness,
            }],
            output: vec![plain_out(1000)],
        };
        let mut buf = Vec::new();
        bitcoin::consensus::Encodable::consensus_encode(&tx, &mut buf).unwrap();
        let entry = preview_raw_tx("bead", &buf, |_, _| false);
        assert!(entry.inscriptions.is_empty());
    }
}
