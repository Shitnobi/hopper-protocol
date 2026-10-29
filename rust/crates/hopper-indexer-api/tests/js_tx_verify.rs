//! Verify the JavaScript wallet's Bitcoin signatures with rust-bitcoin.
//!
//! `web/tests/game.test.mjs` exports every signed demo transaction together
//! with its prevouts (`web/tests/js-txs.json`). This test recomputes the
//! BIP-143/BIP-341 sighashes using `rust-bitcoin` and verifies the ECDSA and
//! Schnorr signatures. The indexer itself is witness-free, so without this
//! seam an invalid signature could still pass every consensus test.

use std::path::PathBuf;

use bitcoin::consensus::encode::deserialize;
use bitcoin::hashes::Hash;
use bitcoin::script::ScriptBuf;
use bitcoin::secp256k1::{Message, Secp256k1, XOnlyPublicKey};
use bitcoin::sighash::{EcdsaSighashType, Prevouts, SighashCache, TapSighashType};
use bitcoin::taproot::{LeafVersion, TapLeafHash};
use bitcoin::{Amount, PublicKey, Transaction, TxOut};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Case {
    label: String,
    hex: String,
    prevouts: Vec<PrevoutJson>,
}

#[derive(Debug, Deserialize)]
struct PrevoutJson {
    value: u64,
    script: String,
}

fn hex_bytes(s: &str) -> Vec<u8> {
    assert!(s.len() % 2 == 0, "odd hex length");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

fn cases() -> Vec<Case> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../web/tests/js-txs.json");
    let json =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&json).expect("js-txs.json")
}

/// The x-only key is the first `OP_PUSHBYTES_32 <key> OP_CHECKSIG` in every
/// HOPPER leaf (state/send/mint commit).
fn leaf_key(leaf: &[u8]) -> XOnlyPublicKey {
    assert!(leaf.len() >= 34, "leaf too short");
    assert_eq!(leaf[0], 0x20, "expected a 32-byte push");
    assert!(
        leaf[33] == 0xac || leaf[33] == 0xad,
        "expected OP_CHECKSIG[VERIFY]"
    );
    XOnlyPublicKey::from_slice(&leaf[1..33]).expect("x-only key")
}

fn verify(case: &Case) {
    let raw = hex_bytes(&case.hex);
    let tx: Transaction = deserialize(&raw).expect("transaction");
    assert_eq!(
        tx.input.len(),
        case.prevouts.len(),
        "{}: input count",
        case.label
    );
    let prevouts: Vec<TxOut> = case
        .prevouts
        .iter()
        .map(|p| TxOut {
            value: Amount::from_sat(p.value),
            script_pubkey: ScriptBuf::from_bytes(hex_bytes(&p.script)),
        })
        .collect();
    let all = Prevouts::All(&prevouts);
    let secp = Secp256k1::verification_only();
    let mut cache = SighashCache::new(&tx);

    for (index, input) in tx.input.iter().enumerate() {
        let prev = &prevouts[index];
        let witness = &input.witness;
        let spk = prev.script_pubkey.as_bytes();

        if spk.len() == 22 && spk[0] == 0x00 && spk[1] == 0x14 {
            // P2WPKH: witness = <DER+hashtype> <pubkey>.
            assert_eq!(witness.len(), 2, "{}:{index}: p2wpkh witness", case.label);
            let sig = bitcoin::ecdsa::Signature::from_slice(witness.nth(0).expect("witness item"))
                .expect("ecdsa signature");
            assert_eq!(sig.sighash_type, EcdsaSighashType::All);
            let pk = PublicKey::from_slice(witness.nth(1).expect("witness item")).expect("pubkey");
            let hash = pk.pubkey_hash();
            assert_eq!(
                &spk[2..22],
                hash.as_byte_array(),
                "{}:{index}: pubkey hash",
                case.label
            );
            let sighash = cache
                .p2wpkh_signature_hash(index, &prev.script_pubkey, prev.value, sig.sighash_type)
                .expect("p2wpkh sighash");
            let msg = Message::from(sighash);
            secp.verify_ecdsa(&msg, &sig.signature, &pk.inner)
                .unwrap_or_else(|e| panic!("{}:{index}: ecdsa {e}", case.label));
        } else if spk.len() == 34 && spk[0] == 0x51 && spk[1] == 0x20 {
            // P2TR: key path (one sig item) or script path (sig, leaf, control).
            let output_key = XOnlyPublicKey::from_slice(&spk[2..34]).expect("output key");
            if witness.len() == 1 {
                let sig =
                    bitcoin::taproot::Signature::from_slice(witness.nth(0).expect("witness item"))
                        .expect("taproot key signature");
                assert_eq!(sig.sighash_type, TapSighashType::All);
                let sighash = cache
                    .taproot_key_spend_signature_hash(index, &all, sig.sighash_type)
                    .expect("taproot key sighash");
                secp.verify_schnorr(&sig.signature, &Message::from(sighash), &output_key)
                    .unwrap_or_else(|e| panic!("{}:{index}: schnorr key {e}", case.label));
            } else {
                assert!(
                    witness.len() >= 3,
                    "{}:{index}: tapscript witness",
                    case.label
                );
                let leaf_bytes = witness.nth(witness.len() - 2).expect("leaf").to_vec();
                let control = witness.nth(witness.len() - 1).expect("control");
                // The control block must name a valid internal key and have
                // a legal length for its merkle path.
                let cb = bitcoin::taproot::ControlBlock::decode(control).expect("control block");
                let leaf_hash = TapLeafHash::from_script(
                    &ScriptBuf::from_bytes(leaf_bytes.clone()),
                    LeafVersion::TapScript,
                );
                let sig =
                    bitcoin::taproot::Signature::from_slice(witness.nth(0).expect("witness item"))
                        .expect("taproot script signature");
                assert_eq!(sig.sighash_type, TapSighashType::All);
                let sighash = cache
                    .taproot_script_spend_signature_hash(index, &all, leaf_hash, sig.sighash_type)
                    .expect("taproot script sighash");
                let key = leaf_key(&leaf_bytes);
                secp.verify_schnorr(&sig.signature, &Message::from(sighash), &key)
                    .unwrap_or_else(|e| panic!("{}:{index}: schnorr script {e}", case.label));
                // The internal key is the NUMS point for custody leaves in
                // this fixture only where the caller used it; just sanity
                // check the control block's structure here.
                assert_eq!(cb.leaf_version, LeafVersion::TapScript);
            }
        } else {
            panic!(
                "{}:{index}: unexpected prevout script {}",
                case.label, prev.script_pubkey
            );
        }
    }
}

#[test]
fn javascript_wallet_signatures_are_valid() {
    let cases = cases();
    assert!(cases.len() >= 7, "expected the full lifecycle fixture");
    for case in &cases {
        verify(case);
    }
    let labels: Vec<&str> = cases.iter().map(|c| c.label.as_str()).collect();
    for want in [
        "mint-commit",
        "mint-reveal",
        "prepare",
        "cross",
        "transfer",
        "send",
        "burn",
    ] {
        assert!(labels.contains(&want), "fixture missing {want}");
    }
}
