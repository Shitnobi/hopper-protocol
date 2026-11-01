# Conformance audit — HOPPER whitepaper vs. SPEC.md

**Normative source:** `hopper-protocol/SPEC.md` (status 3.0, wire `0x08`;
released v7 grandfathered for one sat)
**Source SHA-256:** `1d0498b107242415d67b561df23e9f09512a1dee2b4bd7932351afe71673f8d4` (1,282 lines)
**Whitepaper:** `hopper-whitepaper.pdf` (43 pages)
**Audit result:** every normative section of `SPEC.md` is represented, and
every consensus value, wire byte, acceptance condition, API route and
configuration key in the whitepaper matches the specification.

This revision was diffed against the previous audit point:
`0dca970` / `c716daf3…ac81b` (SPEC status 2.0, v7). The diff is
`241 insertions, 81 deletions` in `SPEC.md`; the substantive changes are the
v8 wire cut, the proof-checking fold, the one grandfathered v7 sat, the fixed
BIP-84 receive script, the tip catch-up and scan-repaint rules, the road-log
meaning of **survived** versus **came home**, and the wallet safety
invariants. All are reflected below. The current pass also reconciles the
BIP86 owner key, JSON-RPC 2.0, SEND ALL, the indexer state root, admin-token
scope, and the operational configuration keys with the implementation.

The whitepaper source and built PDF live in `hopper-protocol/whitepaper`.
`SPEC.md` remains the normative source; the paper is an exposition.

---

## 1. Section coverage

| SPEC.md | Topic | Whitepaper |
|---|---|---|
| §0 | Overview, six actions, trust path, extra transaction | §1, §9.4 |
| §1 | Constants, v8 and legacy values | §3.1, Tab. 3 |
| §1.1 | Generations, `generation(h)`, `required(h)` | §3.2, Fig. 1, App. A |
| §1.2 | The road's wrap, global outcome, miner influence, bias | §3.3, §5.4 |
| §1.3 | Parameter commitment, params gate, network identity | §3.4 |
| §1.4 | Outcome timing | §3.5 |
| §2.1 | MINT envelope (`0x08`, legacy `0x07`) | §4.1, Tab. 4 |
| §2.2 | ord envelope, parent encoding | §4.2, Listings 1–2 |
| §2.3 | v8 fold document, PNG, one digest, legacy digest | §4.3 |
| §2.4 | 55-byte crossing body (`FRG8CROSS`, legacy `FRG7CROSS`) | §4.4, Tab. 5 |
| §2.5 | Canonical proof-checking fold, unverified state | §4.5, Alg. 1 |
| §2.6 | The one grandfathered v7 Hopper | §4.6 |
| §3.1 | State output, NUMS key, four leaves, 97-byte blocks | §6.1, Fig. 3, Tab. 8 |
| §3.2 | Cross leaf bytes | §6.2, Listing 5 |
| §3.3 | Send leaf bytes | §6.2, Listing 6 |
| §3.4 | Witnesses and signing | §6.3, Tab. 9 |
| §3.5 | Two-phase mint | §6.4, Listing 7, Tab. 10 |
| §3.6 | PREPARE / HOP / TRANSFER, previews, SEND, SEND ALL | §6.5, Tab. 11, §6.6 |
| §3.7 | Sat-assignment invariant | §6.7 |
| §3.8 | Address, discovery and history rules | §6.8 |
| §4.1 | Frog record, `wire_version`, absorbing states | §5.1, Tab. 6 |
| §4.2 | MINT acceptance, frozen activation, grandfather | §5.2 |
| §4.3 | HOP acceptance, v8 and legacy body | §5.3 |
| §4.4 | Settlement timers | §5.4, Listing 4 |
| §4.5 | TRANSFER and BURN | §5.5 |
| §4.6 | Events, `outcome: crossed` versus HOME | §5.6, Tab. 7 |
| §4.7 | Reorgs | §5.7 |
| §5.1 | Keys and vault, BIP86 even-Y, legacy recovery, durability | §8.1, Tab. 15 |
| §5.2 | Chain access, pagination, tip catch-up, scan repaint | §8.2 |
| §5.3 | Screens, road log survived/came home | §8.3, Fig. 5 |
| §5.4 | Music | §8.4 |
| §5.5 | Emergency descriptor export (`hopper-v8-emergency`) | §8.5, Listings 10–11 |
| §5.6 | Wallet safety invariants (nine) | §8.6 |
| §6.1 | Crates, v8 and legacy body | §7.1, Tab. 12 |
| §6.2 | Ingest | §7.2, Listing 8 |
| §6.3 | State, snapshots, params+tip state root | §7.3 |
| §6.4 | HTTP API, admin-token gate | §7.4, Tab. 13 |
| §6.5 | Seeding | §7.6, Listing 9 |
| §6.6 | Configuration, activation, rate limit, CORS, event/ord/redb keys | §7.5, Tab. 14 |
| §6.7 | Rejections, params gate | §7.7 |
| §7 | Test obligations | §10, Tab. 17 |
| §8 | Red-team notes | §9, Tab. 16 |

---

## 2. Automated value checks

| Check | Result |
|---|---|
| `wire version` | `0x08`; legacy `0x07` for one sat only |
| `state magic` / length | `FRG8CROSS` / 55; legacy `FRG7CROSS` |
| mint envelope version | `0x08`; legacy `0x07` only for the grandfather |
| `grandfathered sat` | `1,965,983,893,977,665` (`0` = none) |
| `activation height` | `974,034`, frozen; no lenient mode |
| direction encoding | `0` left, `1` straight, `2` right |
| wrap function | `u32LE(H(B)_internal[0..4]) mod 3` |
| crossing leaves | 3 directions + 1 send |
| `cross_finality` | 6 |
| `card_value` / anchor | 25,000 / 1,000 |
| dust (P2WPKH / P2TR) | 546 / 330 |
| NUMS key | exact 32-byte hex |
| `genesis` | 974,034 |
| generation params | `b=5`, `gi=144`, `c=25`, `hold=3600`, `len=6480` |
| parameter hash | `d466f8db…bcf72f` |
| state leaf length | 161 at index 0 (up to 165) |
| send leaf / control block | 34 / 97 |
| v8 mint digest vectors | `6ed060bc…a7ecf`, `1a3ba825…0aa5` |
| v7 grandfather digest | `18c566cc…7dca` (Hopkinson fixture) |
| public API routes | all 20 present |
| JSON-RPC transport | Electrum over WebSocket uses JSON-RPC 2.0 |
| owner key | BIP86 even-Y output key Q owns commit/state leaves and signs; P only derives Q |
| SEND ALL | one recipient output, no change, `totalIn - actualFee`, dust/empty refusal |
| configuration keys | all SPEC keys plus `CORS_ORIGINS`, `EVENT_SEGMENT`, `EVENT_RETAIN_SEGMENTS`, `INGEST_START_HEIGHT`, `ORD_URL`, `DB_CACHE_MIB` |
| screen names | all 8 present |
| visual colours | `#18241a`, `#223226`, `#f0c83c` |
| sound parameters | 400 ms, 45 Hz, 1.5 kHz, +2.5 dB, −16 dB, 3.5:1, `0.5·v²` |

The PDF builds with no overfull boxes and no missing glyphs:

```sh
cd hopper-protocol/whitepaper
tectonic --keep-logs hopper-whitepaper.tex
pdfinfo hopper-whitepaper.pdf | grep Pages   # 43
grep -E 'Overfull|Missing character|Error' hopper-whitepaper.log   # no matches
```

---

## 3. Manual checks

The following were read line-by-line against `SPEC.md`, not just
keyword-matched.

- **MINT** — frozen activation `974,034`; exactly one reveal on input 0,
  no pointer, valid envelope, `inscription_count == 1`; HTML content type;
  canonical `live_v8_html` digest; v7 document/digest only for
  `GRANDFATHERED_SAT`; output-0 first sat tracked and non-shadow; sat carries
  no frog. Creates `idle`, `dist = 0`, `tracked(mint txid, 0)`,
  `gen = generation(mint_height)`; `gen_hint` ignored.
- **HOP** — exactly one inscription on input 0, no pointer,
  `inscription_count == 1`; 55-byte `FRG8CROSS`/`0x08` with `dir <= 2` and
  matching `(sat, mint_txid, mint_index)`; legacy `FRG7CROSS`/`0x07` only
  for the grandfathered sat with recorded `wire_version = 0x07`; tag-3
  parent; canonical `dir` leaf and control block; input 0 spends the current
  outpoint; anchor sat in output 0 at offset 0; no funding frog or envelope;
  frog idle; frozen `required(T)`; cleared provisional outcome.
- **Timers** — `w = u32LE(H(B)_internal[0..4]) mod 3` computed once per block;
  `outcome_block_hash`, `outcome_wrap`, `provisional_dead`; `T+κ` settles to
  `home`, `idle`, `dead` or `burned`; `deaths`, `death_height`,
  `crossings_settled`, `in_flight` cleared, Settle event emitted.
- **Fold** — `id`, parent-as-mint, `tip`, `last`, paginated children,
  `d.sat == sat`, satpoint match, height set, canonical 55-byte body,
  raw-transaction proof (`version 2`, locktime 0, sequences `ff…ff`, one
  envelope in input 0, no pointer or extra envelope, output 0 value > 0,
  canonical 161-byte `dir` leaf, NUMS control block with canonical sibling
  path); body-invalid children ignored; body-valid children with missing or
  false proof, duplicate txid, pre-finality spacing, or incomplete
  pagination yield `unverified`; sort by `(height, sequence_number)`;
  crossing early return; dead only when `dir == wrap(T+1)`; increment; home
  check; final `idle(dist, required(tip+1))`; rendering of `unverified` as
  `NAME · 🛣 —` with no count or HOME.
- **Custody** — NUMS internal key, no key path, four depth-2 leaves,
  `h_LS`/`h_RX`/root, 97-byte control blocks, exact 161-byte cross leaf with
  24-byte content type and 55-byte body, 34-byte send leaf, witness order,
  `SIGHASH_ALL`, tweaked owner key, BIP-342 sighash over all prevouts/outputs.
  Current tree uses `FRG8CROSS`/`0x08`; a grandfathered state output may use
  `FRG7CROSS`/`0x07`; versions are never mixed.
- **Mint pair** — commit leaf with owner `CHECKSIG`, `p2tr(owner, root)`,
  `1000 + reveal_fee_budget(feerates)`, signed reveal, output 0 key-path,
  output 1 OP_RETURN `FRG 0x08 0x01` (legacy `0x07` only for the
  grandfather), optional change, sequence `0xFFFFFFFF`.
- **Actions** — PREPARE from mint output, HOP through the chosen direction
  leaf, TRANSFER through send leaf to an ordinary address; version 2, lock
  time 0; the direction is shown in the preview and cannot change.
- **Previews and SEND** — preview texts, re-scan and exact-bytes broadcast,
  mint commit/reveal sequencing, no RBF for a mint, fee source and relay
  floor, BIP125 policy for plain BIP84 sends only, no HOPPER replacement.
- **SEND ALL** — every eligible plain BIP84 coin, no Hopper/state/protected
  sat, one recipient output, no change, `totalIn - actualFee`, P2WPKH dust
  refusal, ordinary SEND approval rechecks, `SEND ALL BITCOIN` preview.
- **Sat assignment** — anchor is first sat of input 0; output 0 offset 0;
  fee from tail/funding.
- **Address, discovery and history** — frog address, fixed BIP-84 receive
  script `…/0/0`, state-script discovery, peer transfer import,
  wallet-scoped ledger, `receive`/`CHANGE` separation, chain-derived MINT
  row, row grouping, missing-sat rule, two versioned backfills, RESCAN.
- **Wallet** — BIP-39/32/84 paths, fixed receive script, coin types, BIP86
  even-Y normalized frog branch plus legacy raw-point recovery and explicit
  `migrateLegacyFrog`; AES-256-GCM vault with write/read-back verification;
  Esplora pagination and JSON-RPC 2.0 Electrum ports; tip catch-up (`TIP_RECHECK_MS`,
  two gate-bypassing passes) and scan repaint; screens; the LEFT / STRAIGHT /
  RIGHT question; generation badge and RIP; road-log **survived** versus
  **came home** from `immortal_height`; colours; MIDI chain; nine safety
  invariants.
- **Emergency export** — per-frog and wallet-level fields, type
  `hopper-v8-emergency`, per-frog BIP-380 descriptor, wallet-level descriptor
  only for one staged tree (`null` for several), legacy-path owner/leaves,
  state-scriptPubKey verification before display, no seed/xprv, BIP86 tweak,
  SIGHASH_ALL, verification from the export's own bytes, public-data
  handling, snapshot and `tip_height`.
- **Indexer** — pure core / pure engine / API split, v8 and legacy body,
  ingest from block 0, admin + ZMQ/RPC, witness indexes, snapshot params
  hash, event segments, redb, params+tip state root, generation and wrap
  routes, seeding, rejection families, activation keys, rate limit, CORS,
  admin-token scope, ord seeding, params gate.
- **Red-team** — every bullet in SPEC §8 appears as a threat or invariant,
  including the new fabricated-child proof case and miner influence on the
  wrap.

---

## 4. Clarifications (no protocol change)

### 4.1 `mint` operand in the fold (SPEC §2.5)

The pseudocode writes `mint = parent of id (the mint document is its own
mint)`. The reference fold uses `parent = me.parents[0] || me.parent` and
`mint = parent || id`: a crossing document's parent is the mint, while the
mint document has no parent and is its own mint.

**Whitepaper treatment:** Algorithm 1 states “parent of `id` (the mint
document is its own mint)”, matching the code. No consensus value changes.

### 4.2 Owner key wording (SPEC §3.1 / §3.5 / §3.4 / §5.1)

The ordinals branch point at `m/84'/coin'/0'/2/0` is normalized to even Y and
tweaked once with an empty merkle root (BIP86). The resulting output key Q is
`owner_xonly`: it is the owner in the mint commit leaf, the commit output's
internal key, the owner in every state leaf, the signing key, and the wallet's
frog receive address. The untweaked branch point P only derives Q; it is not
itself an owner. The released implementation tweaked P without normalizing;
that legacy address is watched for recovery only.

**Whitepaper treatment:** §8.1 and §6.4 state that Q owns the commit and state
leaves and is the commit internal key, that P only derives Q, that the legacy
raw-point address is recovery-only, and that migration is an explicit
`migrateLegacyFrog` transfer. §6.1 repeats the custody consequence.

### 4.3 Non-zero mint index in a cross leaf (SPEC §1 / §3.2)

SPEC gives the state leaf as 161 bytes at index 0 and up to 165 bytes with a
nonzero mint index. Only a mint carrying its single envelope on input 0 is
reachable, so the reference encoder always emits the 161-byte form, but the
parser must accept the larger parent encoding.

**Whitepaper treatment:** §6.2 states both lengths and the parent encoding
rule. No byte value changes.

### 4.4 `retired` state (SPEC §4.1)

SPEC lists `retired` as an absorbing state but defines no v8 transition into
it.

**Whitepaper treatment:** §5.1 calls it a reserved absorbing state and states
that the transitions described in the paper do not create it. No transition
is invented.

### 4.5 Road glyph in the live band (SPEC §2.3)

The canonical text form uses the road emoji U+1F6E3 between the name and the
count. The paper's text font has no emoji glyph.

**Whitepaper treatment:** §4.3 draws a small road mark in place of the emoji
and states that the implementation uses U+1F6E3. The canonical string
(`NAME <road> N`) is otherwise unchanged.

### 4.6 `card_value` versus anchor value (SPEC §1)

`card_value = 25,000 sats` is a committed protocol constant; the frog-bearing
output itself carries 1,000 sats.

**Whitepaper treatment:** both are listed separately in Table 3 and never
conflated.

### 4.7 Proof-checking fold and `unverified` (SPEC §2.5)

The v8 fold is stricter than v7. A child whose body is valid but whose raw
transaction proof is missing or false is a **hard stop**: the fold renders
`NAME · 🛣 —` and claims no count and no HOME. A child whose body is invalid
(wrong magic, sat, mint or direction) is ignored. Duplicate txids,
crossings inside finality, and incomplete pagination are also `unverified`,
not a lower-bound count.

**Whitepaper treatment:** §4.5 states this distinction explicitly; Algorithm
1 follows the SPEC order and returns `unverified` rather than continuing.

### 4.8 The one grandfathered v7 Hopper (SPEC §2.6)

For `GRANDFATHERED_SAT` only, the released v7 mint envelope (`0x07`), the
released document digest and `V7` body remain valid, as do the v7
`FRG7CROSS`/`0x07` state body and the v7 161-byte leaf/control path. Every
other sat must use v8. The released v7 card's embedded fold is immutable and
predates the proof check; it is grandfathered for custody and play, not as an
authoritative art oracle.

**Whitepaper treatment:** §4.6, §5.2, §5.3 and §9.5 state the exception
narrowly and repeatedly, including the “not a precedent” sentence. The
whitepaper does not present the v7 card as a proof-checked oracle.

### 4.9 Non-grandfathered v7 crossings and fold wording (SPEC §2.5 / §2.6)

SPEC §2.6 says a v7 crossing for a non-grandfathered sat is “rejected by the
indexer and rendered `unverified` by the fold.” SPEC §2.5 defines `bodyOk` as
`FRG8CROSS` only and says a body-invalid child is ignored. These are two
descriptions of the same outcome: the crossing is never counted. The paper's
§4.6 says the indexer rejects it and the app/indexer reports `unverified`,
while §4.5's bare fold ignores a body-invalid child. No consensus value
changes.

### 4.10 Frozen activation and no lenient mode (SPEC §4.2 / §6.6)

SPEC replaces the old optional `HOPPER_INSCRIPTION_ACTIVATION_HEIGHT` with a
frozen `974,034` cutover and says there is no “lenient production” mode. The
configuration table publishes both `HOPPER_ACTIVATION_HEIGHT` and
`HOPPER_INSCRIPTION_ACTIVATION_HEIGHT` as default and required `974,034`.

**Whitepaper treatment:** §5.2 condition 1, Table 3 and §7.5 state the frozen
height and the absence of a lenient mode.

### 4.11 Fixed receive script (SPEC §3.8 / §5.1)

The v8 BIP-84 receive script is fixed at `…/0/0`. The watch set is fixed and
paginated to exhaustion; a restored wallet reuses the same script. Address
rotation is a future wallet feature, not a consensus rule, and the UI must
not claim retirement.

**Whitepaper treatment:** §6.8 and §8.1 state the fixed script, the recovery
reason and the explicit ban on claiming retirement. The old v7 text about
retiring a paid receive address was removed.

### 4.12 Road-log meaning (SPEC §4.6 / §5.3)

`outcome: crossed` means the Hopper survived that hop, not that it reached
HOME. A road-log row says **came home** only when the settle's
`immortal_height` equals the crossing height (`row.height − cross_finality`);
otherwise a crossed row says **survived**. A missing frog record is
conservative and also says **survived**.

**Whitepaper treatment:** §5.6 and §8.3 reproduce the distinction and the
conservative missing-record rule.

### 4.13 Tip catch-up and scan repaint (SPEC §5.2 / §5.6)

After an automatic pass observes a new tip, the wallet must run two further
gate-bypassing full passes at `TIP_RECHECK_MS` (about 1.2 s). A completed scan
is also a repaint event; if a foreground action owns the busy overlay, the
repaint is queued and applied on release, never dropped.

**Whitepaper treatment:** §8.2 states both rules and §8.6 items 8–9 repeat
them as wallet safety invariants.

### 4.14 SEND ALL (SPEC §3.6 / §5.3)

SEND ALL is a SEND variant, not a HOPPER action. It selects every coin that
passes the ordinary funding test, builds one recipient output and no change,
deducts the actual fee from the total, and refuses an empty sweep, a fee that
consumes the balance, or a recipient below the P2WPKH dust limit. State
outputs, frog-bearing coins and protected sats are never spent. Approval uses
the same exact-bytes and input rechecks as ordinary SEND.

**Whitepaper treatment:** §6.6 describes the sweep, the one-output/no-change
shape, the fee deduction, the dust refusal, the `SEND ALL BITCOIN` preview,
and the ordinary-SEND approval path.

### 4.15 JSON-RPC 2.0 (SPEC §5.2)

The reference Electrum-over-WebSocket client sends JSON-RPC 2.0
(`jsonrpc: "2.0"`), not JSON-RPC 1.1.

**Whitepaper treatment:** §8.2 names JSON-RPC 2.0. No wire or game value
changes.

### 4.16 Indexer state root, admin gate and operational keys
(SPEC §6.1 / §6.3 / §6.4 / §6.6)

The state root commits the parameter hash, the tip (height and hash), the
ordered frog records and the coin ranges. `hopper-indexer` performs no network
I/O; its optional redb feature performs local disk persistence. Admin routes
require a Bearer token when `HOPPER_ADMIN_TOKEN` is set, and a non-loopback
bind without one is refused. The operational configuration also includes
`HOPPER_CORS_ORIGINS`, `HOPPER_EVENT_SEGMENT`,
`HOPPER_EVENT_RETAIN_SEGMENTS`, `HOPPER_INGEST_START_HEIGHT`,
`HOPPER_ORD_URL` and `HOPPER_DB_CACHE_MIB`.

**Whitepaper treatment:** §7.1–§7.5 state each rule and list the keys; Table
14 stays aligned with SPEC §6.6.

### 4.17 Emergency export trees (SPEC §5.5)

Each frog carries its own BIP-380 `descriptor` because the leaf bodies embed
that frog's sat and mint id. The wallet-level `descriptor` is a convenience
only when exactly one tree is staged; otherwise it is `null`. A legacy-path
Hopper uses the released owner, and a v7-wire Hopper uses the `FRG7CROSS`
leaves. Before display, the wallet rebuilds the output key and rejects a frog
whose tree does not match the scanned state scriptPubKey. The reference tests
rebuild every leaf and control block from the export alone.

**Whitepaper treatment:** §8.5 lists the per-frog descriptor, the
single-tree wallet descriptor rule, the legacy-path rule, and the
scriptPubKey check.

---

## 5. Deliberate additions (non-normative)

The whitepaper adds context that is not in `SPEC.md` and cannot conflict with
it:

- Bitcoin/ordinal/Taproot background and BIP references.
- A trust-component table and a lifecycle diagram.
- A four-leaf diagram and a control-block table.
- A security threat table and informal properties.
- Limitations (liveness, privacy, data availability, discovery, rule
  changes, miner influence, wrap bias).
- Related-work comparison.
- Reference vectors and a deployment checklist.
- A note that SPEC.md governs if the two documents differ.

No additional consensus rule, state, message, route or configuration key is
introduced.

---

## 6. Reproduce

```sh
cd hopper-protocol/whitepaper
tectonic hopper-whitepaper.tex
sha256sum hopper-whitepaper.pdf
```

PDF SHA-256 at audit time:
`0163198ff0c65463068ca6c5be63884b252f5564544e7588c3b12cbd9cd54ff9`
(this changes if the document is edited).
