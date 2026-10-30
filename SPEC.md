# HOPPER v7 — specification

**Status:** 2.0 (wire version `0x07`)
**Purpose:** a complete, self-contained statement of (1) the inscription
envelope and its program, (2) the game logic, including the tapscript tree
that plays it, and (3) the standalone indexer. This document is normative
for the Rust indexer and the JavaScript wallet/PWA in this repository.

The game is called **HOPPER** in the interface. The consensus bytes keep
the historical spelling (`FRG`, `FRG7CROSS`, `frog`/`frogger` in JSON keys)
because those bytes are already on Bitcoin and cannot be renamed. The
crossing action is called **HOP** in the interface and `cross` on the wire.

---

## 0. Overview

A Hopper is a **satoshi** (an ordinal number) whose life is a sequence of
Bitcoin transactions.

```
MINT      one inscription (the fold document) puts the Hopper on a sat
PREPARE   optional one-time move from the mint output into custody
HOP       one transaction, one new inscription on the same sat, in one of
          three directions: left, straight or right
SETTLE    six blocks after the crossing, H(T+1) picks the road's direction
          for the whole block; every Hopper in it that hopped that way dies
HOME      a frog that reaches its frozen target becomes immortal
TRANSFER  plain movement: no inscription, no state change
```

There is no server on the art's trust path. Any stock `ord` viewer can draw
a Hopper from the inscriptions alone. The indexer is the wallet's chain
reader and the public API; it is not the art's authority.

Three rules are new in v7 and shape everything below:

* the road asks a question, not a die roll. The player picks left,
  straight or right; the next block's hash picks one direction for the
  whole block; a Hopper that picked that direction dies (§1.2);
* custody has three crossing leaves, one per direction, plus a send leaf
  (§3.1);
* the road's difficulty runs in **generations** of 28,080 blocks: 5 hops at
  the start, +1 every 144 blocks up to 100, then 14,400 blocks at 100, then
  a reset to 5 (§1.1). Each generation stamps its frogs `G1`, `G2`, … and
  the art shows the label, the name and the crossing count (§2.3).

The one unavoidable extra transaction is the first state output. A state
leaf names the **mint inscription id**, which is created by the mint reveal
transaction itself. An output created by that transaction cannot contain
its own txid, so the first state output is created by either the first
transfer or a one-time PREPARE transaction.

---

## 1. Constants

```
wire version             0x07
mint magic               "FRG"
mint action              0x01
state magic              "FRG7CROSS"
state body length        55 bytes
direction encoding       left = 0, straight = 1, right = 2
wrap function            u32LE(H(B)[0..4]) mod 3
crossing leaves          3 (one per direction) + 1 send
cross_finality           6 blocks
card_value               25_000 sats
anchor output value      1_000 sats
dust (P2WPKH)            546 sats
dust (P2TR)              330 sats
NUMS internal key        50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0
```

### 1.1 Generations and the road's difficulty

`genesis` is the only deployment value. Everything else is frozen.

```
base            = 5        crossings required on the first block of a generation
growth_interval = 144      blocks per extra required crossing
ceiling         = 100      the hardest the road ever gets
hold            = 14_400   blocks spent at the ceiling before the reset
generation_len  = (ceiling - base) * growth_interval + hold = 28_080
genesis         = 973_263
```

Generation `k` (1-based) starts at `S(k) = genesis + (k - 1) * generation_len`
and owns `[S(k), S(k+1))`.

```
generation(h) = 1 + floor((h - genesis) / generation_len)     (h >= genesis; 1 below)
required(h)   = min(base + floor((h - S(generation(h))) / growth_interval),
                    ceiling)
              = base                                        for h < genesis
```

A generation therefore starts at 5 required crossings, adds one every 144
blocks, reaches 100 at `S(k) + 13_680`, holds 100 for 14_400 blocks, and
restarts at 5. `generation_len` must equal
`(ceiling - base) * growth_interval + hold`; the indexer rejects a published
parameter block where it does not.

`required` is a **sawtooth**, not monotonic. The reset at a generation
boundary is deliberate and load-bearing: do not "smooth" it.

The target used by a crossing is `required(T)`, where `T` is the crossing's
confirmation height. It is frozen when the crossing confirms and does not
follow a later reset.

A Hopper's **generation** is the generation of its mint confirmation height,
`gen = generation(mint_height)`. It is immutable for the frog's life and is
what the art renders as `G1`, `G2`, … A frog born in G1 can still hop in G3;
only its label is fixed, never its target.

### 1.2 The road's wrap

There is no per-Hopper death table and no per-Hopper randomness. Each block
has exactly one direction, and every crossing that confirmed in the previous
block is judged against it:

```
wrap(B) = u32LE(H(B)_internal[0..4]) mod 3
outcome = (in_flight.dir == wrap(T + 1))          => dead
```

`H(B)_internal` is the 32-byte block hash in internal byte order — the
reverse of the hex an explorer or ord returns. `dir` is the direction the
player chose, carried in the crossing body (§2.4). Direction 0 is left, 1 is
straight, 2 is right.

Normative consequences:

* the wrap is **global**. Every Hopper whose crossing confirmed in block `T`
  is judged against the same `wrap(T+1)`. If the block wraps right, every
  frog in that block that hopped right dies and every other frog in that
  block survives;
* the wrap is a function of the block hash alone — not of the sat, the
  owner, the name, the target or the number of frogs in the block — so a
  Hopper cannot influence or predict its own outcome;
* `2^32 = 3 * 1_431_655_765 + 1`, so `mod 3` is biased by one part in
  `2^32` toward left. That bias is accepted. An implementation must use this
  exact integer; it must not substitute a wider word, a rejection scheme or
  a hash of the hash.

### 1.3 Parameter commitment

```
canonical_le(ProtocolParams) =
  u32 LE genesis, base, growth_interval, ceiling, hold, generation_len
  u32 LE cross_finality            (6)
  u64 LE card_value                (25_000)
params_hash = SHA256(canonical_le)
```

A wallet refuses to mint or hop when the indexer's published `params_hash`
differs from its own.

### 1.4 Outcome timing

`wrap(T+1)` is learned when block `T+1` is mined; the outcome is applied at
`T + cross_finality` (6 blocks). Nothing about a Hopper's state changes in
between, and a reorg that replaces `T+1` replaces the wrap.

---

## 2. The inscription envelope

### 2.1 MINT envelope (OP_RETURN, 0x07)

The mint transaction carries one OP_RETURN output whose push is:

```
offset len  field
0      3    "FRG"
3      1    0x07
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
  0x00 <55-byte body>
OP_ENDIF
```

Parent encoding: index 0 is the bare 32-byte txid; a non-zero index appends
the minimal little-endian integer (ord's rule: a 1–3 byte index whose last
byte is `0x00` is non-minimal and rejected). The parent is mandatory on a
crossing; it is what makes `/r/children` work.

### 2.3 The mint body: a self-contained fold document

`live_v7_html(seed, sat, name, gen_hint)` returns `text/html;charset=utf-8`
with:

* no external URL of any kind (`http://`, `https://`, a bare host, a
  protocol-relative URL are all forbidden; grep-enforced);
* two inline `data:image/png;base64,…` 16×16 sprites: idle and dead;
* a static **name band**: the Hopper's name, its generation badge
  (`G1`, `G2`, …) and the road mark with an unknown crossing count, e.g.
  `NAME · 🛣 —`;
* an embedded parameter block
  `V7={sat, genHint, name, p:{g,b,gi,cap,hold,gl,fin}}`, where
  `g = genesis`, `b = base`, `gi = growth_interval`, `cap = ceiling`,
  `gl = generation_len` and `fin = cross_finality`;
* the canonical fold source (`live_v7.js`), which reads only relative
  `/r/…` and `/content/…` endpoints on the viewer's own ord node.

There is no `STATE FROM THE CHAIN` caption in v7. The static band states
only what the mint transaction itself can prove: the name (from the mint
envelope), the generation hint (from the intended mint height), and that
the crossing count is unknown. It must never print a number there.

The live band, drawn by the fold, is authoritative:

```
alive :  NAME                 🛣 12
dead  :  RIP NAME             🛣 12
home  :  NAME                 🛣 100  HOME
```

The count is `dist`, the number of completed crossings, and it is shown for
the dead as well. `RIP ` (with its trailing space) is prepended to the name
only when the fold has settled the frog as `dead`. The road glyph is
illustrative; the canonical text form is `NAME 🛣 N`, and that is what tests
compare.

`gen_hint` is the generation of the height the wallet expects the mint to
confirm at. It is a display hint, never consensus: the indexer derives `gen`
from the confirmed `mint_height` and ignores `gen_hint`. The live fold shows
the authoritative `G` when it can read the mint inscription's height and
falls back to the hint when it cannot.

The PNG encoder is canonical and deterministic:

* signature, IHDR (8-bit RGBA, no interlace), one IDAT, IEND;
* zlib stream `78 01` + **stored** deflate blocks (≤ 65,535 bytes, BFINAL on
  the last) + Adler-32;
* filter byte 0 on every scanline;
* hand-rolled CRC-32 per chunk.

The indexer accepts exactly one mint body digest per
`(seed, sat, name, gen_hint)`: SHA-256 of `live_v7_html(...)`. v6 bodies
(`0x06`, the `STATE FROM THE CHAIN` caption) are **not** accepted by a v7
indexer. v7 is a new deployment: the envelope version, the body length and
the art all changed, so a v6 frog is not a v7 frog. An operator who must
carry v6 frogs runs a v6 indexer beside this one.

The fold source must not declare `var V7` in the same scope as the
document's `V7={…}`. The v6.0 hoisting bug is the reason the document
assigns the object first and the fold only reads it, never re-declares it.

### 2.4 The crossing body (55 bytes)

```
offset len  field
0      9    "FRG7CROSS"
9      1    0x07
10     8    sat          u64 LE
18     32   mint_txid    internal byte order
50     4    mint_index   u32 LE
54     1    dir          0 = left, 1 = straight, 2 = right
```

`(sat, mint_txid, mint_index)` identify the frog and are immutable for its
life. `dir` is per crossing: it names the direction the player committed to
and therefore the leaf that was spent (§3.1). A body with `dir > 2` is
malformed and rejected.

The mint inscription id (`{reversed_mint_txid}i{mint_index}`) is the ordinal
parent of every crossing inscription.

### 2.5 The fold renderer (canonical algorithm)

Inputs: `sat`, the document's own inscription id, `/r/blockheight`, and the
embedded parameters.

```
id       = own inscription id from location.pathname
mint     = parent of id (the mint document is its own mint)
tip      = GET /r/blockheight
last     = GET /r/inscription/{id}          (anchor satpoint)
children = GET /r/children/{id}             (follow {"ids":[…],"more":bool,"page":n})
for c in children:
  d = GET /r/inscription/{c}
  keep c iff d.satpoint == last.satpoint and d.height is set
sort by (height, sequence_number)
bodyOk(c) = GET /r/content/{c} (fallback /content/{c}) is exactly 55 bytes,
            starts FRG7CROSS||0x07||sat||mint_txid||mint_index, has
            dir <= 2, and the content type is octet-stream

state = idle; dist = 0
for c in kept:
  if not bodyOk(c): continue
  T = c.height
  if T + finality > tip: return crossing(dist, dir = body(c).dir)
  if body(c).dir == wrap(T + 1): return dead(dist)
  dist += 1
  if dist >= required(T): return home(dist)
mintH = GET /r/inscription/{mint}.height      (fallback: gen_hint from V7)
return idle(dist, gen = generation(mintH or gen_hint), target = required(tip + 1))
```

`wrap(T+1) = u32LE(H(T+1)_internal[0..4]) mod 3`, the same integer the
indexer uses (§1.2). The fold never asks the indexer what happened: it
recomputes the outcome from the block hash and the direction each crossing
body carries.

The fold is stateless over heights, so reorgs are handled by asking again.
Two crossings in flight on one sat is not legal; the second is rejected by
consensus and must not be counted. A transfer carries no envelope and is
therefore invisible to the fold by construction.

Rendering follows §2.3: `dist` goes in the band beside the road mark, `RIP `
is prefixed to the name iff `state == dead`, and the generation badge comes
from `mintH` when it can be read.

---

## 3. Custody: the tapscript tree that plays the game

### 3.1 The state output

```
internal key : NUMS_XONLY (50929b74…3ac0) — no key path, ever
leaf L cross : dir 0 (left)      <owner_xonly:32> OP_CHECKSIGVERIFY
                                 OP_FALSE OP_IF <ord crossing envelope> OP_ENDIF
                                 OP_TRUE
leaf S cross : dir 1 (straight)  same script, body byte 54 = 0x01
leaf R cross : dir 2 (right)     same script, body byte 54 = 0x02
leaf X send  :                   <owner_xonly:32> OP_CHECKSIG
```

Four leaves, balanced at depth 2:

```
hL = leaf_hash(L)   hS = leaf_hash(S)   hR = leaf_hash(R)   hX = leaf_hash(X)
hLS = branch(hL, hS)       hRX = branch(hR, hX)
root = branch(hLS, hRX)
output_key = taproot_output_key(NUMS, root)
```

`branch(a, b) = tagged_hash("TapBranch", min(a,b) || max(a,b))` and
`leaf_hash(s) = tagged_hash("TapLeaf", 0xc0 || compact_size(len(s)) || s)`.
Every control block is 97 bytes:

```
[parity | 0xc0] || NUMS_XONLY || <sibling leaf hash> || <sibling subtree hash>
```

| spent leaf | first sibling | second sibling |
|------------|---------------|----------------|
| L          | hS            | hRX            |
| S          | hL            | hRX            |
| R          | hX            | hLS            |
| X          | hR            | hLS            |

The three crossing leaves differ only in the direction byte of the body
they push (§3.2), so each leaf hash is fixed when the state output is
created. Choosing a direction selects a leaf; it cannot change the leaf's
bytes.

`owner_xonly` is the 32-byte witness program of a BIP86 P2TR address derived
at `m/84'/coin'/0'/2/0` (the ordinals branch). The same key is used for the
wallet's frog receive address. The sender parses the recipient's P2TR address
to obtain the key; a non-P2TR destination is refused.

### 3.2 Exact cross leaf bytes

All three crossing leaves are the same script; only the last byte of the
pushed body (the direction) differs:

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
37 <body:55>           ; PUSH 55 bytes, last byte = dir
68                     ; OP_ENDIF
51                     ; OP_TRUE
```

(The encoder uses minimal pushes; a 55-byte body is a direct `0x37` push, a
32-byte parent is `0x20`, a 31-byte content type is `0x4c 0x1f`.) The script
is 170 bytes for every direction.

### 3.3 Exact send leaf bytes

```
20 <owner:32> ac
```

### 3.4 Spend witnesses

Crossing (the leaf is the one the player chose):

```
witness[0] = 64-byte BIP-340 signature || 0x01   (SIGHASH_ALL)
witness[1] = the dir leaf script (L, S or R)
witness[2] = 97-byte control block from the table in §3.1
```

Transfer from custody:

```
witness[0] = 64-byte signature || 0x01
witness[1] = send leaf script
witness[2] = 97-byte control block (X row)
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
output 1: OP_RETURN MINT envelope (FRG 0x07 0x01 seed name)
output 2: change to m/84'/coin'/0'/1/index (optional, if ≥ dust)
sequence: 0xFFFFFFFF on every input (RBF off)
```

The anchor sat is the first sat of the commit output, which is the first sat
of the first funding input. Since the leaf embeds the anchor sat, the commit
address is derived after a probe coin-selection pass.

### 3.6 Action transactions (v7)

**PREPARE** (only for a frog still in its mint/frog-address output):

```
input 0 : the frog output (P2TR key path, tweaked frog key)
output 0: the state output for (sat, mint id, owner)
outputs 1..: funding change
```

**HOP** (from custody, one transaction):

```
input 0 : the state output, the leaf for the chosen direction
output 0: the next state output (same owner, or a new P2TR owner)
outputs 1..: funding change
```

The player chooses `dir ∈ {left, straight, right}` before signing; the
transaction spends the matching leaf, so the body it inscribes carries that
`dir` (§2.4). Choosing a direction is the whole of the choice: the leaf's
bytes are fixed by the state output, and the outcome is decided by the block
(§1.2), not by the player. The wallet must show the chosen direction in the
preview and must not let it change after the preview is approved.

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
They are intentionally not replaceable: MINT, PREPARE, HOP and TRANSFER may
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

A browser **SEND**, Hopper **HOP**, **TRANSFER** or **MINT** is previewed
before broadcast. SEND and TRANSFER display **PREVIEW TRANSACTION**; MINT
keeps its **MINT!** button and opens the same review window; a HOP is
previewed with its direction spelled out (`HOP LEFT`, `HOP STRAIGHT` or
`HOP RIGHT`) and the leaf it will spend. The preview shows the destination
address and amount, change address and amount (or "one output" for a
transfer), chosen fee rate and actual fee in sats. A mint shows the commit
and reveal txids, both change outputs, both fees and the total size.
CANCEL performs no broadcast, persists no action and spends nothing.
Approval re-scans and refuses the preview if any input moved, an anchor's
ordinal ranges changed, or a coin gained a Hopper, then broadcasts the exact
previewed bytes. A mint approval broadcasts the commit and then the reveal
that spends it; if the reveal is rejected after the commit was accepted, the
error names the accepted commit and no mint action is recorded. A mint never
has an RBF path. Fee recommendations come from mempool.space
`/api/v1/fees/precise` (`fastestFee`, `halfHourFee`, `economyFee`); the
chosen rate remains manually editable, and values below the 1 sat/vB wallet
relay floor are raised to it.

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
* A BIP-84 receive address retires once the wallet sees any history on it,
  including an unconfirmed payment. The next unused index becomes current;
  an open receive window repaints with it. A paid address is never handed
  out again.
* The state output's script is per `(sat, mint id, owner)`; it matches no
  derivation path. A wallet finds it by deriving the script from the frog
  record, and by watching its frog address.
* A frog sent by a peer arrives at the ordinary address and is discovered
  by the wallet's address scan plus the indexer/ord. It is imported by
  reading its mint inscription and replaying its history from the mint
  outpoint.
* History is wallet-scoped, not a raw indexer feed. It merges local actions,
  events whose Hopper sat belongs to this wallet, settled outputs observed
  on its watched scripts, internal change, and mempool rows. A confirmed
  ordinary deposit or a Hopper output is retained as a `receive` row, so it
  stays visible after the coin is spent. Change from our own transactions is
  retained separately as a `CHANGE` row; it is never presented as an incoming
  `RECEIVE`. Events for unrelated public/NPC Hoppers are filtered out.
* A MINT row does not depend only on the browser that broadcast it. When the
  owned mint output is still at its mint outpoint, the wallet persists a
  chain-derived mint row. A restored seed therefore shows the same MINT and
  HOPPER ARRIVED rows without a local action ledger. A Hopper received from a
  peer is not at its mint outpoint and does not create a MINT row.
* Rows for one txid share its best-known height and sort as a group. The
  feed is newest first, so inside a group the newest row is on top:
  `HOPPER ARRIVED` → `CHANGE` → `MINT`, and `CHANGE` → `SEND`. A mint's
  commit change is grouped with the reveal's HOPPER ARRIVED row by the
  minted sat (and by both commit and reveal txids), so one mint stays
  `HOPPER ARRIVED` → `CHANGE` → `MINT` even when heights are unknown or the
  commit confirmed in an earlier block. Older actions with no stored sat
  recover it from the arrival's frog/reveal record; a missing commit is read
  once from input 0 of the reveal and persisted, so its change output joins
  the same group. A missing sat is never treated as sat 0. Grouping is
  ultimately by reveal/commit txid cluster, so it works even when no row
  stores a sat.
* History shortened txids and addresses are copy buttons. The visible text is
  abbreviated, but the copied text is the complete txid or address; the
  confirmation names which value was copied.
* The first completed refresh after the history-ledger upgrade performs two
  one-time, versioned address-history backfills: receive addresses the wallet
  handed out, and change addresses it has used. The receive pass recovers
  deposits whose coins were spent before the receive ledger existed and skips
  outgoing action/commit txids. The change pass recovers spent internal change
  and migrates older ledgers that had stored it as a `RECEIVE`. RESCAN clears
  both markers so recovery can be forced.

---

## 4. Game logic (consensus state machine)

### 4.1 Frog record

```
sat, seed, name
gen            generation(mint_height), immutable, 1-based
state          idle | crossing | home | dead | burned | retired
dist           completed crossings
crossings_entered
mint_height, mint_txid, mint_index, inscription_id
location       tracked(outpoint) | burned
in_flight      {txid, height T, dir, target_hops = required(T)}
outcome_block_hash, outcome_wrap, provisional_dead
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
4. the body's SHA-256 equals `mint_body_digests(seed, sat, name, gen_hint)`
   (exactly one digest, §2.3);
5. output 0's first sat exists and is not a shadow (the tracker has seen its
   inputs);
6. that sat carries no frog, live or dead.

A valid mint creates `idle`, `dist = 0`, `location = tracked(mint txid, 0)`
and `gen = generation(mint_height)`. The `gen_hint` embedded in the document
is ignored. The mint output is **not** a state output.

### 4.3 HOP (cross)

Accepted iff:

1. the transaction contains exactly one inscription, in input 0;
2. the body decodes as 55-byte `FRG7CROSS` with `dir <= 2`, and its
   `(sat, mint_txid, mint_index)` equals the frog;
3. the tag-3 parent equals `(mint_txid, mint_index)`;
4. the spent leaf is the `dir` leaf of the state output's tree: the script
   is the 170-byte template of §3.2 whose body's last byte is `dir`, its
   hash is the matching leaf hash, and the 97-byte control block commits
   the output key of §3.1 (NUMS internal key, `0xc0/0xc1` parity, both
   siblings in the order of the §3.1 table);
5. input 0 spends the frog's current outpoint;
6. the anchor sat lands in output 0 at offset 0;
7. no funding input carries a frog and no FRG envelope appears;
8. the frog is `idle` (not crossing/home/dead/burned/retired).

On acceptance: `state = crossing`, `in_flight = {txid, T, dir, required(T)}`,
`crossings_entered += 1`, `last_target_hops = required(T)`, and
`outcome_block_hash/outcome_wrap/provisional_dead` are cleared.

### 4.4 The timers (run before a block's transactions)

At block `B = T+1`, for every frog with `in_flight.height + 1 == B`:

```
w                  = u32LE(H(B)_internal[0..4]) mod 3
outcome_block_hash = H(B)
outcome_wrap       = w
provisional_dead   = (in_flight.dir == w)
```

`w` is computed once per block and applied to every frog in it: the road
picks one direction for the block, not one per Hopper (§1.2).

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
mint    { frogger_sat, seed, name, gen }
transfer{ frogger_sat }
settle  { frogger_sat, outcome: dead|crossed, dir, wrap }
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
  backup of the keys; §5.5 exports the spending layout of staged outputs for
  the case where this wallet is gone.

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

A mint reveal is also self-describing: its tapscript witness contains the
canonical v7 body, and output 0 pays the wallet's ordinals address. A wallet
MAY recover an idle mint record from that witness when neither an indexer
nor ord answers, verifying the seed, sat and full body before trusting it.
This recovers mints paid directly to the wallet's ordinals address. It does
not recover a frog transferred in later, whose new output carries no mint
body; that discovery requires the indexer (or a working ord range view and
a record source).

### 5.3 Screens

`Wallet` · `History` · `The Pond` · `The Road` · `Mint` · `Leaderboard` ·
frog `Detail` · `Bio`; plus onboarding, the intro, the 8-page rules
walkthrough, the ☰ drawer, send/receive sheets, address book, backup words,
QR scanner, dead-frog page, and settings.

The visual language is fixed: dark lily-pad green `#18241a`, card
`#223226`, accent `#f0c83c`, 8-bit monospace, square corners, bark-framed
buttons, lily-pad-bordered floating windows, 16×16 deterministic frog
sprites.

The road screen asks one question: **LEFT**, **STRAIGHT** or **RIGHT**. The
chosen button is the direction committed in the crossing body and the leaf
spent; the preview names it, and it cannot change after approval. The screen
states the rule in one line: the next block picks one direction, and a
Hopper that picked it dies. A frog's card shows its generation badge
(`G1`, `G2`, …), its crossing count beside the road mark, and `RIP` before
the name once it is dead.

Settings carries **EXPORT EMERGENCY DESCRIPTORS** (§5.5).

### 5.4 The music

One MIDI score (`music.mid`) played by `sound.js`: parse once, map ticks to
seconds through the tempo map, schedule with a 400 ms lookahead, loop at the
score's length. One periodic-wave voice per note (harmonic stack falling as
`1/k^1.15`, 4 ms attack, pitch-dependent decay), 45 Hz highpass → +2.5 dB
shelf at 1.5 kHz → compressor (-16 dB, 3.5:1) → master gain. Gain is
`0.5 · volume²`; mute wins over volume. Nothing sounds before a gesture.

### 5.5 Emergency descriptor export

The seed words are the only backup, but they do not describe how a custody
output is built. The wallet therefore offers **EXPORT EMERGENCY
DESCRIPTORS** in settings: one plain-text JSON document (also delivered as a
QR) that is enough for another taproot-capable tool to spend every staged
address without this wallet.

A **staged address** is the P2TR state output of a frog (§3.1). Per frog the
export carries:

```
sat, gen, dist, state, name
mint_id            "<txid>i<index>"
state_outpoint     "<txid>:<vout>"      (when known)
state_value        sats
owner_xonly        32-byte hex
internal_key       50929b74…3ac0
output_key         32-byte x-only output key of the staged address
leaves[]           { dir, script_hex, leaf_hash, control_block }
send_leaf          { script_hex, leaf_hash, control_block }
```

and once for the wallet:

```
type               "hopper-v7-emergency"
version            1
network            mainnet | testnet | signet | regtest
fingerprint        BIP-32 master fingerprint (8 hex)
owner_path         m/84'/<coin>'/0'/2/0
descriptor         tr(<internal>,{raw(<L>),raw(<S>),raw(<R>),raw(<X>)})#checksum
generated_at       ISO-8601 UTC
tip_height         the height the export was built at
```

The `descriptor` line uses the BIP-380 checksum and the miniscript `raw()`
fragment for the four leaves. Many signers cannot parse raw leaves, so the
`leaves[]` hex and control blocks are the authoritative form; the descriptor
is a convenience for tools that can.

Rules:

* no seed words, no private keys, no xprv. The export is a **layout**
  backup, not a key backup: whoever holds it still needs the seeds;
* the signing key is the BIP-32 key at `owner_path`, tweaked once with
  `TapTweak(P)` and an empty merkle root (the BIP86 tweak); the leaf's
  `owner_xonly` is the resulting output key. Spending uses leaf version
  `0xc0` and SIGHASH_ALL (`0x01`), with the script and control block from
  `leaves[]`;
* a receiving tool MUST verify the export before trusting it: rebuild each
  leaf hash, each branch, the root, the output key and every control block
  from the export's own bytes, and compare the result with the on-chain
  scriptPubKey of `state_outpoint`. The wallet runs the same check before
  it displays the export;
* the export is public data about the wallet's holdings. It is shown behind
  a confirmation and is never logged, uploaded, or put in a URL;
* the export is a snapshot, and every HOP, PREPARE or TRANSFER changes a
  state outpoint. The wallet stamps `tip_height` and regenerates the export
  after every action; a tool that sees a state outpoint already spent must
  discard the entry rather than guess.

---

## 6. The standalone indexer

### 6.1 Crates

```
hopper-core          pure protocol: envelope, v7 body, scripts, params,
                     generations, wrap, sat math, art, PNG, fold document
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
GET  /v1/generation/{height}    generation index, start, end, required(h)
GET  /v1/wrap/{height}          the block's wrap (0|1|2); 404 until ingested
GET  /v1/froggers?limit&offset&after_sat&to_sat
GET  /v1/frogger/{sat}          record + gen + in_flight.dir + outcome.wrap
GET  /v1/road                   in-flight crossings (T, dir, target, wrap, settle height)
GET  /v1/leaderboard?limit      ranked by generation, then dist
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
control. The API never publishes a wrap for a height it has not ingested:
the outcome of a future block is not predictable from the indexer either.

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
inscription content/digest issues, crossing body/parent/leaf/outpoint/output,
the direction set (`dir > 2`, leaf not the `dir` leaf, control block not the
matching row of the §3.1 table), cross-on-non-idle, funding-carrying-frog,
mixed envelope, params mismatch.

---

## 7. Test obligations

1. **Golden vectors** — JS and Rust produce identical `required` across a
   generation boundary (5, 6, 100 for the whole hold, then 5 again), the
   wrap `u32LE(H)[0..4] mod 3`, the 55-byte body, the envelope, the parent
   tag, and the mint-body digests for pinned fixtures.
2. **Wire bytes** — the three 170-byte crossing leaves, the send leaf, the
   97-byte control block for each of the four leaves, the commit leaf and
   the witnesses byte-exact; parse back with the ord decoder; verify every
   control block against the output key.
3. **Fold parity** — the embedded fold and the indexer answer the same
   `(state, dist, gen)` for the same crossing set, including a block where
   every frog that hopped the wrap dies and every other frog survives.
4. **Consensus** — every acceptance/rejection in §4, reorgs, snapshots,
   params hash, a `generation_len` that does not match its formula.
5. **Renderers** — static card with JS off shows the name and the `G` badge
   but never a number; the live fold shows `NAME 🛣 N`, `RIP NAME` and
   `HOME` against a mocked `/r/` server; no external host in the body; the
   fold derives the outcome from the block hash without asking the indexer.
6. **Emergency export** — rebuild every leaf, control block and the output
   key from the exported JSON alone and compare with the staged
   scriptPubKey; the export contains no seed, xprv or private key; a stale
   `tip_height` is detected.
7. **App** — onboarding, keys, addresses, mint, prepare, the three hop
   choices, transfer, history, the generation badge, display of
   unattributable coins, sound mute/volume persistence.

---

## 8. Red-team notes (normative)

* A child inscription is genuine only if its body is canonical **and** its
  satpoint equals the mint's satpoint. A parent tag alone is never trusted.
* The crossing outcome is `wrap(H(T+1)) == dir`, never declared by the
  inscription author. An owner chooses *when* to hop and *which way*; the
  block chooses whether that way was right. The wrap comes from a hash that
  does not exist when the crossing is signed, so the choice cannot be
  back-dated.
* The direction is bound into the leaf's own bytes, so a witness cannot be
  replayed with a different direction, and a body whose last byte disagrees
  with the spent leaf is not a valid crossing.
* The wrap is global: every frog in a block faces the same direction, and
  one frog's death says nothing about another frog's sat.
* The emergency export is public layout data. It never contains a seed, an
  xprv or a private key, and a tool that trusts it without rebuilding the
  output key is broken.
* The static art never prints a crossing count it cannot know. Only the
  fold may render a number, and only a settled frog gets `RIP`.
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
