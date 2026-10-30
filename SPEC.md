# HOPPER v6 — specification

**Status:** 1.0 (wire version `0x06`)
**Purpose:** a complete, self-contained statement of (1) the inscription
envelope and its program, (2) the game logic, including the tapscript tree
that plays it, and (3) the standalone indexer. This document is normative
for the Rust indexer and the JavaScript wallet/PWA in this repository.

The game is called **HOPPER** in the interface. The consensus bytes keep
the historical spelling (`FRG`, `FRG3-CROSS`, `frog`/`frogger` in JSON keys)
because those bytes are already on Bitcoin and cannot be renamed.

---

## 0. Overview

A Hopper is a **satoshi** (an ordinal number) whose life is a sequence of
Bitcoin transactions.

```
MINT      one inscription (the fold document) puts the Hopper on a sat
PREPARE   optional one-time move from the mint output into custody
CROSS     one transaction, one new inscription on the same sat
SETTLE    six blocks after the crossing, H(T+1) decides alive or roadkill
HOME      a frog that reaches its frozen target becomes immortal
TRANSFER  plain movement: no inscription, no state change
```

There is no server on the art's trust path. Any stock `ord` viewer can draw
a Hopper from the inscriptions alone. The indexer is the wallet's chain
reader and the public API; it is not the art's authority.

The one unavoidable extra transaction is the first state output. A state
leaf names the **mint inscription id**, which is created by the mint reveal
transaction itself. An output created by that transaction cannot contain
its own txid, so the first state output is created by either the first
transfer or a one-time PREPARE transaction.

---

## 1. Constants

```
wire version             0x06
mint magic               "FRG"
mint action              0x01
state magic              "FRG6CROSS"
state body length        54 bytes
settlement domain        "FRG3-CROSS"
cross_finality           6 blocks
card_value               25_000 sats
anchor output value      1_000 sats
dust (P2WPKH)            546 sats
dust (P2TR)              330 sats
NUMS internal key        50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0
```

### 1.1 Hop schedule

`genesis` is the only deployment value. Everything else is frozen.

```
base    = 5
step1   = 64      until1 = 25
step2   = 144     until2 = 50
step3   = 2016    ceiling = 100
genesis = 973_263
```

Anchors:

```
A1 = G + (until1 - base) * step1       = G + 1_280
A2 = A1 + (until2 - until1) * step2    = G + 4_880
A3 = A2 + (ceiling - until2) * step3   = G + 105_680
```

```
required(h) =
  base                                              if h <= G
  base + floor((h - G) / step1)                     if h < A1
  until1 + floor((h - A1) / step2)                  if h < A2
  until2 + floor((h - A2) / step3)                  if h < A3
  ceiling
```

`required` is monotonically non-decreasing and hard-capped at 100. This is
load-bearing consensus: do not simplify it. The target used by a crossing is
`required(T)`, where `T` is the crossing's confirmation height. It is frozen
when the crossing confirms.

### 1.2 Death table

`death_bps[target]`, 101 entries, indexed by the frozen target. Values above
100 clamp to index 100.

```
2500,2500,2500,2500,2500,2500,2153,1896,1697,1539,1410,1304,1214,1137,1071,1013,
962,917,877,840,808,778,751,726,703,682,663,645,628,612,597,584,571,559,547,537,
526,517,508,499,491,483,475,468,461,455,448,442,437,431,426,421,416,411,407,402,
398,394,390,386,382,379,375,372,369,366,363,360,357,354,351,349,346,344,341,339,
337,334,332,330,328,326,324,322,320,318,317,315,313,311,310,308,307,305,304,302,
301,299,298,296,295
```

At the genesis target (5) the death probability is 25%; at the cap it is
2.95%, which keeps a 100-hop run at ≥ 5% completion.

### 1.3 Parameter commitment

```
canonical_le(ProtocolParams) =
  u32 LE genesis, base, step1, until1, step2, until2, step3, ceiling
  u8    death_model_tag            (0 = flat_25, 1 = hybrid_floor)
  u16 LE success_floor_bps         (500)
  u32 LE cross_finality            (6)
  u64 LE card_value                (25_000)
params_hash = SHA256(canonical_le || death_table_hash)
death_table_hash = SHA256(LE u16 each of the 101 DEATH_BPS entries)
```

For this deployment `death_model_tag = 1`. A wallet refuses to mint or cross
when the indexer's published `params_hash` differs from its own.

### 1.4 Settlement digest

```
digest = SHA256("FRG3-CROSS" || u64LE(sat) || H(T+1)_internal)
x      = u32LE(digest[0..4])
dead   = x * 10_000 < death_bps(target) * 2^32
```

`H(T+1)_internal` is the 32-byte block hash in internal byte order — the
reverse of the hex an explorer/ord returns. The comparison is exact integer
math; no floats, no modulo.

---

## 2. The inscription envelope

### 2.1 MINT envelope (OP_RETURN, 0x06)

The mint transaction carries one OP_RETURN output whose push is:

```
offset len  field
0      3    "FRG"
3      1    0x06
4      1    0x01  (MINT)
5      4    seed        u32 LE
9      1    name_len    0..=38
10     n    name        UTF-8
```

Total ≤ 80 bytes. Exactly one `FRG` envelope is allowed per transaction. A
malformed or duplicated envelope invalidates the protocol message (the
transaction still moves sats; it just is not a mint).

The same seed and name also appear in the **mint inscription** reveal. The
indexer validates both; the inscription is the part a stock ord viewer can
read without us.

### 2.2 Ord inscription envelope

The reveal's tapleaf contains ord's standard envelope, preceded by our
authorization:

```
OP_FALSE OP_IF
  "ord"                                   (3-byte push)
  0x01 "text/html;charset=utf-8"          (tag 1: content type)
  0x00                                    (empty push: body tag)
  <body, chunked at 520 bytes>
OP_ENDIF
```

For a crossing, the envelope is:

```
OP_FALSE OP_IF
  "ord"
  0x01 "application/octet-stream"
  0x03 <mint_txid:32 || minimal-LE mint_index>   (tag 3: parent)
  0x00 <54-byte body>
OP_ENDIF
```

Parent encoding: index 0 is the bare 32-byte txid; a non-zero index appends
the minimal little-endian integer (ord's rule: a 1–3 byte index whose last
byte is `0x00` is non-minimal and rejected). The parent is mandatory on a
crossing; it is what makes `/r/children` work.

### 2.3 The mint body: a self-contained fold document

`live_v6_html(seed, sat)` returns `text/html;charset=utf-8` with:

* no external URL of any kind (`http://`, `https://`, a bare host, a
  protocol-relative URL are all forbidden; grep-enforced);
* two inline `data:image/png;base64,…` 16×16 sprites: idle and dead;
* a static caption `STATE FROM THE CHAIN`;
* an embedded parameter block `V6={sat:…, p:{g,b,s1,u1,s2,u2,s3,cap,fin,bps}}`;
* the canonical fold source (`live_v6.js`), which reads only relative
  `/r/…` and `/content/…` endpoints on the viewer's own ord node.

The static card is the honest fallback: with JS off or every fetch refused,
it says state is unavailable and never claims the frog is alive.

The PNG encoder is canonical and deterministic:

* signature, IHDR (8-bit RGBA, no interlace), one IDAT, IEND;
* zlib stream `78 01` + **stored** deflate blocks (≤ 65,535 bytes, BFINAL on
  the last) + Adler-32;
* filter byte 0 on every scanline;
* hand-rolled CRC-32 per chunk.

The indexer accepts **two** mint body digests for every `(seed, sat)`:

1. the current `live_v6_html(seed, sat)`;
2. the frozen pre-fix `live_v6_html_v1(seed, sat)`.

The second exists because the v6.0 fold declared `var V6` in the same scope
as the document's `V6={sat,p}`, hoisting it and clobbering the values. Every
frog minted before the fix carries those bytes forever; a mined block cannot
be rewritten. A new wallet can only produce the first.

### 2.4 The crossing body (54 bytes)

```
offset len  field
0      9    "FRG6CROSS"
9      1    0x06
10     8    sat          u64 LE
18     32   mint_txid    internal byte order
50     4    mint_index   u32 LE
```

The body is immutable for the frog's life. The mint inscription id
(`{reversed_mint_txid}i{mint_index}`) is the ordinal parent.

### 2.5 The fold renderer (canonical algorithm)

Inputs: `sat`, the document's own inscription id, `/r/blockheight`, and the
embedded parameters.

```
id       = own inscription id from location.pathname
mint     = id
tip      = GET /r/blockheight
last     = GET /r/inscription/{id}          (anchor satpoint)
children = GET /r/children/{id}             (follow {"ids":[…],"more":bool,"page":n})
for c in children:
  d = GET /r/inscription/{c}
  keep c iff d.satpoint == last.satpoint and d.height is set
sort by (height, sequence_number)
bodyOk(c) = GET /r/content/{c} (fallback /content/{c}) is exactly
            FRG6CROSS||0x06||sat||mint, and content type is octet-stream

state = idle; dist = 0
for c in kept:
  T = c.height
  if T + finality > tip: return crossing(dist)
  target = required(T)
  if dies(sat, GET /r/blockhash/{T+1}, target): return dead(dist)
  dist += 1
  if dist >= target: return home(dist)
return idle(dist, target = required(tip + 1))
```

The fold is stateless over heights, so reorgs are handled by asking again.
Two crossings in flight on one sat is not legal; the second is rejected by
consensus and should not be counted. A transfer carries no envelope and is
therefore invisible to the fold by construction.

---

## 3. Custody: the tapscript tree that plays the game

### 3.1 The state output

```
internal key : NUMS_XONLY (50929b74…3ac0) — no key path, ever
leaf 0 cross : <owner_xonly:32> OP_CHECKSIGVERIFY
               OP_FALSE OP_IF <ord crossing envelope> OP_ENDIF
               OP_TRUE
leaf 1 send  : <owner_xonly:32> OP_CHECKSIG
```

Both leaves are siblings at depth 1. The output key is
`taproot_output_key(NUMS, merkle_root(hash(cross_leaf), hash(send_leaf)))`.
Each leaf's control block is 65 bytes:

```
[parity | 0xc0] || NUMS_XONLY || sibling_leaf_hash
```

`owner_xonly` is the 32-byte witness program of a BIP86 P2TR address derived
at `m/84'/coin'/0'/2/0` (the ordinals branch). The same key is used for the
wallet's frog receive address. The sender parses the recipient's P2TR address
to obtain the key; a non-P2TR destination is refused.

### 3.2 Exact cross leaf bytes

```
20 <owner:32>          ; PUSH32 owner
ad                     ; OP_CHECKSIGVERIFY
00                     ; OP_FALSE
63                     ; OP_IF
4c 03 "ord"            ; PUSHDATA1 3 "ord"   (or 03 "ord")
01 01                  ; push tag 1
4c 1f <content-type>   ; PUSHDATA1 31 "application/octet-stream"
01 03                  ; push tag 3
20 <parent:32>         ; PUSH32 mint txid (index 0)
00                     ; empty body tag
36 <body:54>           ; PUSH 54 bytes
68                     ; OP_ENDIF
51                     ; OP_TRUE
```

(The encoder uses minimal pushes; a 54-byte body is a direct `0x36` push, a
32-byte parent is `0x20`, 31-byte content type is `0x4c 0x1f`.)

### 3.3 Exact send leaf bytes

```
20 <owner:32> ac
```

### 3.4 Spend witnesses

Crossing:

```
witness[0] = 64-byte BIP-340 signature || 0x01   (SIGHASH_ALL)
witness[1] = cross leaf script
witness[2] = 65-byte control block
```

Transfer from custody:

```
witness[0] = 64-byte signature || 0x01
witness[1] = send leaf script
witness[2] = 65-byte control block
```

The signature uses the **tweaked** owner key (`internal_key.tap_tweak(None)`)
over the BIP-342 tapscript sighash of the leaf and the whole transaction's
prevouts/outputs.

### 3.5 The two-phase mint

The mint is a commit/reveal pair because ord needs an input to engrave.

Commit output:

```
internal key = owner_xonly (untweaked ordinals key)
one leaf     = <owner:32> OP_CHECKSIG OP_FALSE OP_IF <mint envelope> OP_ENDIF
address      = p2tr(owner, merkle_root(leaf))
value        = 1_000 + reveal_fee_budget(feerates)
```

The leaf demands our signature. SIGHASH_DEFAULT commits every prevout and
every output, so a copied witness cannot redirect the frog. (A legacy
keyless commit, `NUMS` internal key + `OP_TRUE || envelope`, remains
revealable forever, but no new commit may use it.)

Reveal transaction:

```
input 0 : the commit output, script path [sig, leaf, control block]
output 0: 1_000 sats to the wallet's frog (P2TR key-path) address
output 1: OP_RETURN MINT envelope (FRG 0x06 0x01 seed name)
output 2: change to m/84'/coin'/0'/1/index (optional, if ≥ dust)
sequence: 0xFFFFFFFF on every input (RBF off)
```

The anchor sat is the first sat of the commit output, which is the first sat
of the first funding input. Since the leaf embeds the anchor sat, the commit
address is derived after a probe coin-selection pass.

### 3.6 Action transactions (v6)

**PREPARE** (only for a frog still in its mint/frog-address output):

```
input 0 : the frog output (P2TR key path, tweaked frog key)
output 0: the state output for (sat, mint id, owner)
outputs 1..: funding change
```

**CROSS** (from custody, one transaction):

```
input 0 : the state output, cross leaf
output 0: the next state output (same owner, or a new P2TR owner)
outputs 1..: funding change
```

Exactly one inscription in the transaction, in input 0. The anchor sat must
land in output 0 at offset 0. No funding input may carry a frog, and no
FRG envelope may appear in the crossing.

**TRANSFER**:

```
input 0 : state output via send leaf, or mint output via key path
output 0: the recipient's ordinary address (any script, P2WPKH included)
```

A transfer publishes no inscription and changes no state. It deliberately
pays the recipient's ordinary address, not their state output: the state
script commits to the mint id, which the recipient cannot know until it has
discovered the frog. The recipient re-enters custody with PREPARE on its next
action.

All HOPPER action inputs use sequence `0xFFFFFFFF`; lock time zero; version 2.
They are intentionally not replaceable: MINT, PREPARE, CROSS and TRANSFER may
move an inscription or a state card, and shaving an output to raise a fee can
burn the anchor sat.

An ordinary wallet **SEND** is separate from these actions. Its inputs use
sequence `0xFFFFFFFD` (BIP125 opt-in), and the wallet may replace an
unconfirmed send only under this narrower policy:

* the original is a wallet-created plain BIP84 send, still unconfirmed, and
  the backend returns exactly the recorded serialization;
* every original input is a plain, range-known, non-Hopper BIP84 coin, and
  the current wallet view still contains no Hopper at any of those outpoints
  or sats;
* every original output keeps its exact script and value; the replacement
  appends confirmed plain BIP84 funding and one new change output;
* the replacement pays a strictly higher absolute fee and feerate, including
  BIP125's incremental-relay margin.

The wallet never replaces a HOPPER action. The transaction builder recomputes
the FIFO sat ranges and refuses a replacement if a known Hopper sat would land
in its fee.

### 3.7 Sat assignment invariant

Ordinals move FIFO over inputs in order. Therefore:

* the anchor sat is the first sat of input 0 (for a mint, the first sat of
  the commit output);
* after a spend, that sat is at offset 0 of output 0 iff output 0 receives
  value and no earlier output claims sats first;
* fee is taken from the tail of the frog's range or from funding, never from
  the anchor's position.

The wallet and indexer both verify this with ordinal range arithmetic.

### 3.8 Address and discovery rules

* The mint pays the wallet's **frog address** (BIP86 P2TR at `…/2/0`), never
  a BIP-84 receive address. Coins there are never funding candidates.
* The state output's script is per `(sat, mint id, owner)`; it matches no
  derivation path. A wallet finds it by deriving the script from the frog
  record, and by watching its frog address.
* A frog sent by a peer arrives at the ordinary address and is discovered
  by the wallet's address scan plus the indexer/ord. It is imported by
  reading its mint inscription and replaying its history from the mint
  outpoint.

---

## 4. Game logic (consensus state machine)

### 4.1 Frog record

```
sat, seed, name
state          idle | crossing | home | dead | burned | retired
dist           completed crossings
crossings_entered
mint_height, mint_txid, mint_index, inscription_id
location       tracked(outpoint) | burned
in_flight      {txid, height T, target_hops = required(T)}
outcome_block_hash, provisional_dead
last_target_hops
immortal_height, death_height, burn_height, burn_txid
```

`home`, `dead`, `burned`, `retired` are absorbing.

### 4.2 MINT

Accepted iff:

1. the block is at/after inscription activation (if enforcement is enabled);
2. exactly one inscription reveal exists in the transaction and it is on
   input 0;
3. content type is `text/html;charset=utf-8`;
4. the body's SHA-256 equals one of `mint_body_digests(seed, sat)`;
5. output 0's first sat exists and is not a shadow (the tracker has seen its
   inputs);
6. that sat carries no frog, live or dead.

A valid mint creates `idle`, `dist = 0`, `location = tracked(mint txid, 0)`.
The mint output is **not** a state output.

### 4.3 CROSS

Accepted iff:

1. the transaction contains exactly one inscription, in input 0;
2. the body decodes as 54-byte `FRG6CROSS` and its `(sat, mint_txid,
   mint_index)` equals the frog;
3. the tag-3 parent equals `(mint_txid, mint_index)`;
4. the tapscript/control block match the state template: 0x20 owner,
   OP_CHECKSIGVERIFY, envelope, OP_TRUE; 65-byte control block with the
   NUMS internal key and `0xc0/0xc1` parity;
5. input 0 spends the frog's current outpoint;
6. the anchor sat lands in output 0 at offset 0;
7. no funding input carries a frog and no FRG envelope appears;
8. the frog is `idle` (not crossing/home/dead/burned/retired).

On acceptance: `state = crossing`, `in_flight = {txid, T, required(T)}`,
`crossings_entered += 1`, `last_target_hops = required(T)`, and
`outcome_block_hash/provisional_dead` are cleared.

### 4.4 The timers (run before a block's transactions)

At block `B = T+1`, for every frog with `in_flight.height + 1 == B`:

```
outcome_block_hash = H(B)
provisional_dead   = dies(sat, H(B), in_flight.target_hops)
```

At block `T + 6`, for every due crossing:

```
if location is burned or provisional_dead:  state = (burned ? burned : dead)
                                            deaths += 1, death_height = T
else: dist += 1
      state = dist >= target ? home : idle
      if home: immortal_height = T
crossings_settled += 1
in_flight = None; provisional_dead = None
emit Settle event
```

### 4.5 TRANSFER and BURN

A spend of the frog's outpoint without a valid crossing envelope is a
transfer: update `location`; state unchanged. A spend that sends the anchor
sat to fees is a burn. A wallet SHOULD NOT build, offer, or expose BURN as a
feature or operation intentionally. The indexer still classifies such a
spend, built elsewhere, and marks `location = burned`, sets
`burn_height/burn_txid`, and:

* an idle frog becomes `burned` immediately (nothing else will observe it);
* an in-flight crossing keeps its timer and settles as `burned` at finality.

`burned` and the `burn` event remain valid indexer/API states, not as a
wallet action.

### 4.6 Events

The indexer publishes a re-derivable log keyed by
`(block_hash, height, txid, action)`:

```
mint    { frogger_sat, seed, name }
transfer{ frogger_sat }
settle  { frogger_sat, outcome: dead|crossed }
burn    { frogger_sat }   # indexer state; wallets SHOULD NOT expose a burn action
```

### 4.7 Reorgs

The indexer keeps a retained window of block headers and undo journals. A
rollback replays the chain to the fork point. Timers are pure functions of
height and hash, so a reorg that replaces `T+1` freezes a new outcome; a
reorg that removes `T` reopens the frog as `idle` and restores its card.

---

## 5. The wallet and the PWA

### 5.1 Keys and vault

* 12-word BIP-39 mnemonic; the entropy is sealed in the vault.
* v2 derivation: full 64-byte BIP-39 seed → BIP-32 → `m/84'/coin'/0'`.
  Coin type 0 on mainnet, 1 elsewhere.
* Receive `…/0/i` and change `…/1/i` are P2WPKH.
* Ordinals/frog branch `…/2/0`: untweaked key is the mint commit owner and
  the leaf's `owner`; its BIP86 taproot output is the frog receive address.
* The vault is AES-256-GCM under a non-extractable WebCrypto KEK in
  IndexedDB. The public ledger (addresses, UTXOs, frogs, history) is stored
  separately and is re-derivable from the chain. The 12 words are the only
  backup.

### 5.2 Chain access

Two HTTP ports, chosen by URL:

* **Esplora** (`https://…`) — `/blocks/tip/height`, `/address/{a}/utxo`,
  `/address/{a}/txs`, `/tx/{txid}/hex`, `/blocks/tip/hash`,
  `/block-height/{h}`, `/fee-estimates`, `POST /tx`.
* **Electrum over WebSocket** (`ws://`, `wss://`) — a JSON-RPC 1.1 client
  using `blockchain.scripthash.*`, `blockchain.transaction.get`,
  `blockchain.block.header(s)`, `blockchain.estimatefee`,
  `blockchain.transaction.broadcast`. A relay (`frogger-relay`) can bridge
  raw TCP.

Discovery comes from the indexer (`/v1/froggers`, `/v1/frogger/{sat}`,
`/v1/utxo/…`) or, without an indexer, from stock ord (`/r/utxo/…`,
`/content/{id}`, `/r/blockheight`). Ranges are mandatory before a coin may
be spent; an unattributable coin still counts in the balance and is shown as
unspendable.

### 5.3 Screens

`Wallet` · `History` · `The Pond` · `The Road` · `Mint` · `Leaderboard` ·
frog `Detail` · `Bio`; plus onboarding, the intro, the 8-page rules
walkthrough, the ☰ drawer, send/receive sheets, address book, backup words,
QR scanner, dead-frog page, and settings.

The visual language is fixed: dark lily-pad green `#18241a`, card
`#223226`, accent `#f0c83c`, 8-bit monospace, square corners, bark-framed
buttons, lily-pad-bordered floating windows, 16×16 deterministic frog
sprites.

### 5.4 The music

One MIDI score (`music.mid`) played by `sound.js`: parse once, map ticks to
seconds through the tempo map, schedule with a 400 ms lookahead, loop at the
score's length. One periodic-wave voice per note (harmonic stack falling as
`1/k^1.15`, 4 ms attack, pitch-dependent decay), 45 Hz highpass → +2.5 dB
shelf at 1.5 kHz → compressor (-16 dB, 3.5:1) → master gain. Gain is
`0.5 · volume²`; mute wins over volume. Nothing sounds before a gesture.

---

## 6. The standalone indexer

### 6.1 Crates

```
hopper-core          pure protocol: envelope, v6 body, scripts, params,
                     hops, settle, sat math, art, PNG, fold document
hopper-indexer       pure state machine: sat tracker, rules, timers,
                     events, snapshots, optional redb store
hopper-indexer-api   axum HTTP API + block ingest (ZMQ/RPC or admin POST)
```

`hopper-core` depends only on `sha2` (plus optional serde) and must stay
pure. `hopper-indexer` performs no I/O. `hopper-indexer-api` owns the network.

### 6.2 Ingest

The indexer always ingests from block 0: a later start cannot name coins
created earlier, which would make owned frogs look sent away.

Two wires, same block decoder and same write lock:

* `POST /v1/admin/block` — operator/debug JSON block (admin token required
  off loopback);
* bitcoind ZMQ `hashblock` + RPC — production. On a new hash, fetch blocks
  from the tip to that hash; on a reorg, roll back to the fork and replay.

The ingest layer converts a Bitcoin transaction into:

```
Tx { txid, inputs[{prevout, value, inscription?}], outputs[{value, op_return?}] }
Block { hash, height, txs }
```

It parses the tapscript witness (`witness[n-2]`) with the ord envelope
decoder, extracts the control block (`witness[n-1]`), content type, body,
and tag-3 parents. The state machine never touches witnesses.

### 6.3 State and persistence

State is `(config, seeds, chain) → derived IndexState + event log`. A
canonical state root hashes the ordered frog records, coin ranges and tip;
two indexers that agree on consensus must agree on the root.

Persistence:

* binary snapshot (`HOPPER_SNAPSHOT_PATH`, default
  `hopper-indexer.snapshot.bin`), with `params_hash` checked on load — a
  mismatch is a hard error, never a migration;
* append-only event segments next to it;
* optional redb durable store (`--features redb`, `HOPPER_DB`) holding the
  full state plus undo journals.

### 6.4 HTTP API (read-only unless admin)

```
GET  /v1/status                 tip, height, active crossings, wire version
GET  /v1/params                 full parameter block + params_hash + chain id
GET  /v1/froggers?limit&offset&after_sat&to_sat
GET  /v1/frogger/{sat}
GET  /v1/road                   in-flight crossings (T, target, settle height)
GET  /v1/leaderboard?limit
GET  /v1/state/root
GET  /v1/events?limit
GET  /v1/events/stream          SSE
GET  /v1/mempool                mempool preview (needs RPC)
GET  /v1/fees                   bitcoind fee estimate (never invented)
GET  /v1/utxo/{txid}/{vout}     value + ordinal ranges + frogs + exact
GET  /healthz, /readyz, /metrics
POST /v1/admin/block|seed|rollback   Bearer token, never exposed by the PWA
```

CORS is a browser read policy (`HOPPER_CORS_ORIGINS`); it is not access
control.

### 6.5 Seeding

Ordinal ranges ultimately come from the chain. A fresh indexer ingests from
genesis, but a deployment that starts from a snapshot or a UTXO it never saw
move can be given explicit ranges:

```
POST /v1/admin/seed
{ "utxos": [ { "txid": "<display hex>", "vout": 0,
               "ranges": [[start, end]] } ] }
```

A coin whose ranges were never observed is a "shadow" sat; a mint on one is
rejected as `MintAnchorUntracked`. Seeding is the operator's bring-up step.

### 6.6 Configuration

```
HOPPER_API_ADDR               default 127.0.0.1:9770
HOPPER_INSCRIPTION_ACTIVATION_HEIGHT   optional; unset = lenient mints
HOPPER_SNAPSHOT_PATH          default hopper-indexer.snapshot.bin
HOPPER_SNAPSHOT_EVERY         default 10 blocks
HOPPER_RETAIN_BLOCKS          default 288
HOPPER_SEEDS_FILE             bootstrap seed JSON for fresh starts
HOPPER_ZMQ_ADDR               e.g. tcp://127.0.0.1:28332
HOPPER_RPC_URL                default http://127.0.0.1:18443
HOPPER_RPC_COOKIE / USER / PASS
HOPPER_NETWORK / HOPPER_GENESIS_HASH  published chain identity
HOPPER_ADMIN_TOKEN            required for non-loopback binds
HOPPER_DB                     optional redb path
HOPPER_ENGINE=store           keep only a block-sized overlay in memory
HOPPER_REINDEX=1              discard the durable store
```

Legacy `FROGGER_*` names are accepted as fallbacks so an existing deployment
can migrate without editing its service file.

### 6.7 Rejections

No malformed input is chain-invalidating. Rejections leave state unchanged
while sat movement still applies. The closed set is in
`hopper-indexer/src/types.rs` (`RejectionReason`): mint anchor issues,
inscription content/digest issues, cross body/parent/leaf/outpoint/output,
cross-on-non-idle, funding-carrying-frog, mixed envelope, params mismatch.

---

## 7. Test obligations

1. **Golden vectors** — JS and Rust produce identical `required`, death,
   settlement digest, envelope, state body, parent tag, and mint-body
   digests for pinned fixtures.
2. **Wire bytes** — cross leaf, send leaf, commit leaf, control blocks,
   witnesses byte-exact; parse back with the ord decoder.
3. **Fold parity** — the embedded fold and the indexer answer the same
   `(state, dist)` for the same crossing set.
4. **Consensus** — every acceptance/rejection in §4, reorgs, snapshots,
   params hash.
5. **Renderers** — static card with JS off, fold with a mocked `/r/` server,
   no external host in the body.
6. **App** — onboarding, keys, addresses, mint, prepare, cross, transfer,
   history, display of unattributable coins, sound mute/volume persistence.

---

## 8. Red-team notes (normative)

* A child inscription is genuine only if its body is canonical **and** its
  satpoint equals the mint's satpoint. A parent tag alone is never trusted.
* The crossing outcome is `f(sat, H(T+1), target)`, never declared by the
  inscription author. An owner can choose *when* to cross, not *what*
  happens.
* A transfer publishes nothing; therefore a frog can never be killed
  without publishing the crossing.
* A state output is a UTXO, spent once; the body binds sat + mint, so a
  witness cannot be replayed against another frog.
* The mint reveal must be signed: a copied witness cannot redirect the
  frog. Legacy keyless commits are revealable forever and are never created
  again.
* The art document contains no external origin. A viewer with different
  recursion semantics shows the static card rather than a lie.
* Nonsensical destinations (non-P2TR for custody) are refused by the
  wallet. An unattributable coin is never spent blindly.
