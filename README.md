# HOPPER — the pond on Bitcoin

A reference implementation of **HOPPER v8** ([`SPEC.md`](SPEC.md)):

- **`rust/`** — the consensus core, a standalone Bitcoin indexer and its
  REST/SSE API.
- **`web/`** — a non-custodial browser wallet, game client and installable
  PWA that builds real consensus transactions. It starts live on mainnet
  with public backends, and can be switched to the local demo chain.

HOPPER does not mint a token. A frog **is** an ordinal satoshi. Its state is
the chain's answer to "which UTXO currently holds this sat", and a crossing
is an inscription whose outcome is fixed by a future block hash.

**Live app:** <https://shitnobi.github.io/hopper-protocol/> — deployed from
`web/` by GitHub Actions. It uses the public mainnet defaults. A public
HTTPS page cannot reach loopback services, so use the published site for
mainnet tests and run locally when you need your own node or indexer.

---

## Quick start (mainnet, public defaults)

The web app starts in **live mode on mainnet**. Blank backend fields resolve
to `https://blockstream.info/api` for chain data and `https://ordinals.com`
for sat ranges. No HOPPER indexer is configured by default: coins, balances
and ordinary spends work through Esplora + ord, while frog discovery, the
public road and the leaderboard need an indexer.

```sh
cd web
python3 -m http.server 8130
# open http://127.0.0.1:8130/
```

Create a wallet and keep the 12 words. Mainnet is selected by default. The
service worker makes the app shell work offline after the first load
(localhost is a secure context; a plain-HTTP LAN address is not).

> Mainnet is real Bitcoin, and this reference implementation is not audited.
> Set your own Esplora/Ord/Indexer in Settings if you do not want to use the
> public defaults, or switch to Demo before putting value anywhere near it.

### Demo chain

Settings → **Mode** → **Demo** runs everything in the browser: FIFO sat
assignment, mint validation, the four-leaf state tree, the block-wide wrap,
T+6 settlement, transfers, fee sweeps, NPC residents and a faucet.
It persists to `localStorage`. Every broadcast mines one demo block, so
`MINE 6` settles a hop.

> The demo chain is **not** Bitcoin.

## Layout

```
SPEC.md                    normative v8 rules (wire 0x08; one grandfathered v7 sat)
whitepaper/                LaTeX source, 43-page PDF, and conformance audit
rust/
  crates/hopper-core       params, generations, wrap, v8 leaves, sat math,
                           inscription bodies/PNG, fold (the live viewer)
  crates/hopper-indexer    sat tracking, consensus state machine, rules,
                           snapshots, reorg replay
  crates/hopper-indexer-api REST + SSE server, admin ingest, metrics
web/
  index.html, manifest, sw.js
  icons/                   pixel HOPPER tab mark + generated PWA icons
  fonts/                   Pixelify Sans (SIL OFL) for text; Silkscreen (SIL OFL) for digits
  css/app.css              mobile-first dark lily-pad UI
  js/core/                 hex, params, wrap, envelopes, inscriptions,
                           v8 leaves, descriptor checksum, proof-checking fold, art, PNG, mint document
  js/wallet/               keys, addresses, tx sign/serialize, actions,
                           tx parser, backends, vault, storage, session,
                           mint worker + client
  js/mock/chain.js         in-browser v8 demo chain
  js/ui/screens.js         the screens (wallet, pond, road, mint, history,
                           leaderboard, detail, bio, settings, rules)
  js/ui/theme.js           the FROGGER egui materials: wood log-frames,
                           lily-pad window borders, pond/road/grave/sprite
                           painters, mounted on canvases after each render
  js/ui/frog-mark.js       the 16x16 HOPPER mark shared by the tab icon,
                           title bar, onboarding logo and boot splash
  js/ui/tour.js            the boot splash (a hop into the road) and the
                           eight animated rules pictures
  js/ui/qr.js              the QR widget (quiet zone, paper/ink, placeholder)
  js/ui/dom.js             formatting, sprites, toasts, overlays
  js/main.js               boot, onboarding/lock, routing, action wiring
  js/sound.js              the MIDI score player and the short SFX
  music.mid                the score (the same file as frogger-wallet-pwa)
  js/vendor/               pinned noble/scure bundle and qr.js (generated)
  tests/                   core vectors, game lifecycle, indexer seam,
                           headless browser e2e
  vendor-src/              the pinned npm project that builds the bundle
  tools/make-icons.mjs     deterministic PWA icons from the sprite
```

## The protocol in one page

- **Wire** `0x08`, magic `FRG`, mint envelope `FRG | 08 | 01 | u32 seed |
  u8 len | name` (≤ 38 UTF-8 bytes), opcode `OP_RETURN`.
- **Params hash**
  `d466f8db3efa330dc92444274675804e47ec76b62393eeae88063ef764bcf72f`.
- **Genesis** `974034`; generations are 6,480 blocks: 5 required hops,
  +1 every 144 blocks, 25 at +2,880, 3,600 blocks at 25, then reset to 5.
- **Card** 25,000 sats; **anchor output** 1,000 sats; **finality** 6 blocks.
- **Mint**: commit → reveal. The commit output is P2TR whose single tapleaf
  holds the self-contained live document and the owner key. The reveal spends it,
  pays 1,000 sats to the Hopper address, writes the FRG mint envelope, and
  the anchor sat is the first sat of the commit input. The document embeds
  the name and a generation *hint*; the indexer derives the real label from
  the confirmed height.
- **Custody**: a 25,000-sat output with internal key **NUMS** (no key path)
  and four leaves: LEFT, STRAIGHT, RIGHT and send. Each crossing leaf
  commits to the 55-byte `FRG8CROSS` body, whose last byte is the direction;
  choosing a direction selects a leaf that was fixed when the output was
  created. The control block is 97 bytes and names the NUMS key.
- **Hop**: spend the state output through the chosen direction's leaf, one
  inscription in input 0, the anchor sat at offset 0 of output 0.
  `target = required(T)`.
- **Outcome**: the road is global, not per-sat. At `T+1`,
  `wrap(T+1) = u32LE(block_hash(T+1)[0..4]) % 3`; every Hopper whose hop
  confirmed in `T` dies iff `dir == wrap(T+1)`, and every other Hopper in
  that block survives. Settlement at `T+6`: survive → `dist++`, `home` at
  `dist >= target`; otherwise `dead`.
- **Proof-checking fold**: a card renders a count only after reading each
  child's raw transaction and checking the canonical leaf, control path,
  one-envelope/input-0 shape, and finality spacing. Missing proof renders
  `NAME · 🛣 —`, never a guess.
- **Grandfather**: exactly one released v7 Hopper is accepted. The sat is
  `1_965_983_893_977_665`, set in `rust/crates/hopper-core/src/params.rs` and
  `web/js/core/params.js` (0 = none). It uses the v7 mint/body/leaf; every
  other Hopper is v8.
- **Transfer**: an ordinary spend; it publishes no envelope and changes no
  state. **Fee-swept sats**: spending the frog's sat to fees sets
  `location = burned` (an idle frog becomes `burned`; a dead frog stays
  dead; an in-flight crossing settles `burned`).

The wallet has no BURN action. There is no button, no `buildBurn`, and no
session method that pays a Hopper's anchor sat to fees; `TRANSFER` moves
the sat to a recipient, while TRAVEL TO ROAD and HOP keep it at offset 0
of the card. The indexer still recognizes a fee-swept anchor from a
transaction built elsewhere, so an externally lost Hopper can be shown
honestly instead of disappearing.

An unconfirmed ordinary **SEND** can be bumped from History with RBF.
That path is deliberately narrower than a generic replace-by-fee wallet:
it only accepts a plain BIP84 send, re-reads the original bytes from the
backend, and refuses if any original input is now a Hopper/card, contains
a known Hopper sat, or cannot be proved to be a plain range-known coin.
The replacement keeps **every original output at the same script and the
same value**, appends one or more confirmed plain BIP84 funding coins and
one new change output, and pays a strictly higher absolute fee and feerate
(BIP125, plus a 1 sat/vB incremental-relay margin). The extra fee therefore
comes only from the added coins, never from shaving an existing change or
any output that could carry an ordinal. MINT, PREPARE, CROSS and TRANSFER
are never replaceable and have no bump button. The builder repeats the
range audit on the final bytes and blocks a replacement if a known Hopper
sat would land in its fee.

Ordinary **SEND**, sending a Hopper (**TRANSFER**) and minting are two-step
in the browser UI. SEND and TRANSFER start with **PREVIEW TRANSACTION**; the
mint keeps its **MINT!** button and opens the same review screen. SEND also
offers **SEND ALL**: it sweeps every eligible plain-BTC coin into a single
recipient output, deducts the actual fee from the total, and leaves no
change. Hopper cards, state outputs and protected sats are never selected.
The preview builds and signs the exact transaction(s) without broadcasting:
destination address and amount, change address and amount, chosen fee rate,
actual fee in sats, and transaction size. A mint preview shows both the **commit** and
**reveal** txids, both change outputs, both fees and the total. **CANCEL** (or
✕, Escape and the backdrop) discards it. **APPROVE & BROADCAST** rechecks
every input against a fresh scan and broadcasts exactly once; a stale preview
is refused. For a mint, approval broadcasts the commit first and then the
reveal that spends it. A transfer has no change output, so its preview says
so explicitly.

History is wallet-scoped. It merges local actions, indexer events for this
wallet's Hoppers, settled outputs observed on our addresses, internal change,
and faded mempool rows. The same event from both ledgers is merged rather
than painted twice: a local TRAVEL TO ROAD and the indexer's `transfer` for
that tx are one row, and a local HOP and the indexer's `cross` are one row.
A local HOP row names its direction (`HOP LEFT`, `HOP STRAIGHT`,
`HOP RIGHT`) and the spent leaf (`dir 0/1/2`), so a hop is legible even when
no indexer is configured. On a cold or manual pass, and once per new tip while a local HOP is in
flight, the wallet also replays the derived state address's transaction
history: every TRAVEL and HOP spends
or creates an output at that one script, and the crossing body in input 0
names the direction. A crossing made on another device is therefore rebuilt
from the chain, not only from this browser's local actions. A still-mempool
HOP is shown as in flight and keeps the pond from offering a conflicting
second HOP. Each `CHANGE` says which spend produced it
(`change from mint`, `change from travel to road`, `change from hop right`).
History is newest first, so the journey for one Hopper reads bottom-up as
`RECEIVE` → `MINT` → `HOPPER ARRIVED` → `TRAVEL TO ROAD` → `HOP RIGHT` →
`CROSSED RIGHT`/`DIED RIGHT`. Rows for one transaction stay together and use
its best-known block height.

The Bio page is the same ledger, viewed as one Hopper's life story in
chronological order: `MINTED` → `TRAVELED TO THE ROAD` → `HOPPED
LEFT/STRAIGHT/RIGHT` → `CROSSED THE ROAD`/`DIED`, plus `TRANSFERRED` if the
Hopper left the wallet. It reads indexer `mint`, `cross` and `settle` events
when they exist, then fills any gap from the local action ledger and the
chain-mint ledger. Without an indexer it still shows the mint, TRAVEL and
each locally broadcast hop (with its direction) instead of an empty
timeline. That is how an initial deposit and a Hopper arrival appear
alongside the mint; the indexer's global mint feed is filtered so unrelated
NPC mints are not shown. A MINT row is also reconstructed from the owned mint
output when the local action ledger is absent, so restoring the same seed on
another browser shows the same mint. The same cold/manual state-address
replay fills in TRAVEL, HOP and settlement rows that happened elsewhere, so
Bio is owned by the Hopper's chain career rather than by one browser's
ledger. Internal change is a separate `CHANGE` row, never a fake incoming
`RECEIVE`.

A mint's change usually comes from its commit transaction, while HOPPER
ARRIVED comes from the reveal. Because History is newest first, the mixed
transaction group reads `HOPPER ARRIVED` → `CHANGE` → `MINT`: the arrival is
the latest row, the commit is the earliest. All three are grouped by the
minted sat as well as txid, so the order holds even when heights are missing
or the commit confirmed earlier. Older action rows without a stored sat
recover it from the arrival; if they also lack the commit txid, it is read
back once from input 0 of the reveal so the commit's change stays in the
same mint group. Even with no sat anywhere, the reveal and commit txids form
one cluster, so those rows cannot drift apart.
Settings → **HISTORY DATA** downloads a plain-text snapshot of the public
txids, sats, heights and the grouping keys History used, with no seed or
private material. Shortened txids and addresses in History are copy controls:
tapping one copies the full value, with a `txid copied` or `address copied`
confirmation.

Observed receives are persisted in the local ledger, so an initial deposit
does not disappear when its coin is later spent. A one-time address-history
pass recovers older deposits whose coins were already spent; a companion
pass recovers change outputs at the fixed change script, including change
spent by a later mint. Both passes record confirmed outputs, are versioned
in the ledger, and do not repeat. RESCAN resets both markers if a user needs
to force recovery.

Transaction fee fields show mempool.space's
`/api/v1/fees/precise` recommendations: **FAST** (`fastestFee`), **MEDIUM**
(`halfHourFee`) and **SLOW** (`economyFee`). Tapping one fills the editable
sat/vB field; typing overrides it. The API is consulted once per window and
cached for 60 seconds. Recommendations below the wallet's 1 sat/vB relay
floor remain visible, but filling the field raises them to the floor.

**Unconfirmed funds** are spendable by default. Settings → SPENDING →
**Unconfirmed funds** lets a SEND use an unconfirmed payment or change (the
transaction can only confirm after its parent). Turning it off waits for
confirmation. Mint, TRAVEL TO ROAD and HOP always need range-known funding,
so they normally wait for confirmation regardless.

Both Blockstream and **mempool.space** speak the same Esplora API: Settings
has one-tap **USE MEMPOOL.SPACE** / **USE BLOCKSTREAM** presets, and either
URL can be typed directly — a bare host gains `/api`, and an explicit
`/api` path is left alone. Public hosts get a small
client-side queue and one retry because a burst of address/UTXO requests
triggers throttling. mempool.space caps `/address/:address/utxo` at 500
outputs and is slower on busy addresses; a local node is faster. If the
browser reports `Failed to fetch` while `curl` works, allowlist the host in
NoScript (or the extension blocking cross-origin requests).

### Custom Esplora and CORS

A browser wallet can only read an Esplora API that sends
`Access-Control-Allow-Origin` for this page. **`curl` does not enforce CORS**,
so a working command line is not proof that the browser can connect. Test the
same question the browser asks:

```sh
curl -sS -D - -o /dev/null \
  -H 'Origin: https://shitnobi.github.io' \
  https://your-esplora.example/api/blocks/tip/height | grep -i access-control
```

If that header is missing, the API is fine for `curl` and unusable from the
PWA. On a self-hosted mempool/Esplora proxy, add it at the reverse proxy, for
example nginx:

```nginx
location /api/ {
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Content-Type" always;
    if ($request_method = OPTIONS) { return 204; }
    proxy_pass http://127.0.0.1:8999/;
}
```

or Caddy:

```caddy
header Access-Control-Allow-Origin "*"
```

`*` is safe here because the wallet sends no cookies or credentials; use the
exact `https://shitnobi.github.io` origin if you prefer. The wallet's GETs are
simple requests (no `Content-Type` header), and broadcast is a `text/plain`
POST, so the browser should not need a preflight; the `OPTIONS` line is
defence in depth. A static GitHub Pages app cannot bypass a missing CORS
header — a third-party CORS proxy would be a man-in-the-middle for wallet
traffic and is deliberately not used.

The browser frontend is a JavaScript reimplementation of the FROGGER
wallet's egui GUI (the app in `frogger-protocol`): the same dark lily-pad
palette, pixel text, wooden log buttons, lily-pad floating windows,
pond water, lane-dashed asphalt, crossing pips and pixel art. Numerals use
Silkscreen's block digits so 5/2/8/7/1 stay distinct at wallet sizes;
letters remain Pixelify Sans. It is not a screenshot of egui — it is DOM
text and events over canvas-painted materials, so the wallet stays
selectable, accessible and installable.
The screen map is FROGGER's: Wallet, History, The Pond, The Road, Mint,
Leaderboard, a Hopper's detail and life-story pages, Settings, plus the
boot intro and the eight-page rules walkthrough (swipe left or right, or
use BACK and NEXT). Once a Hopper is staged in its tapscript state output,
its pond slot keeps the name but paints an empty lily with no SEND or
TRAVEL TO ROAD. The Road shows that staged Hopper with SEND (the state
output's transfer leaf) and HOP (the state fork). A HOME Hopper never
returns to The Road: it stays on the pond with its crowned art and a
transfer SEND. Approving a HOP moves the Hopper out of the direction picker
into **Crossings in flight** immediately, labelled in mempool until a block
gives the indexer a real settlement height. Shell updates are handled before
the app starts: a same-build load never reloads, and a stale-build reload suppresses the
splash, so a new deploy cannot look like a boot loop. While it is out
there, the card is a small treadmill:
the lane dashes scroll left and the Hopper arcs to the right in a one-second
hop, landing with a squash and a dust puff. A `DEAD SEALED` card is a still
dead sprite, not a hopping one. `prefers-reduced-motion` gets a still frame
instead. Once the crossing settles at `T+6`, the frog returns to
the direction picker with HOP available again; the settled row stays in the
road log and History. The road log says **survived** for every successful hop
and **came home** only for the settle that reached HOME.

The crossing pips are a real progress display: one dot for every hop in
the current target (5 at genesis, rising to 25), filled to the Hopper's
completed crossings, with `×completed / target` beside them. An idle
Hopper follows the next block's requirement, so empty dots appear as the
road raises its toll; an in-flight Hopper keeps its frozen target.

RECEIVE is the egui bottom window, not an address list: a tab for
**BITCOIN** (one fixed BIP84 address at `m/84'/coin'/0'/0/0`) and a tab for
**HOPPERS** (the fixed BIP86 frog address), each with the warning band the
tab demands ("DON'T SEND HOPPERS HERE" / "🐸 ONLY SEND HOPPERS HERE"), a
scannable QR with the spec's quiet zone, the selectable address, COPY and
FULL QR. Neither address rotates: a payment does not retire or replace it.
The fixed layout is what lets the wallet watch only receive #0, change #0 and
the ordinals script instead of walking an HD gap. The window is height-stable:
both tabs use the same fixed QR, address, note and action rows, so flipping
BITCOIN/HOPPERS never moves or resizes it.

The music is the egui app's `music.mid` played through WebAudio with the
same tempo map, voice and master fader; the mute and volume still live in
the wallet settings. It is the app's soundtrack, not a wallet-only effect:
like FROGGER, it starts on the first gesture on any screen — onboarding,
the lock, or the wallet — and survives locking. The drawer (and Settings)
shows a live line such as `♪ PLAYING · 7635 NOTES`, or names the reason it
is silent (`MUTED`, `VOLUME 0%`, `SUSPENDED — TAP TO RETRY`, a load
error). `hopperSound.status()` reports the same state in the console.

Browsers require one completed gesture before audio may start, so the
first tap, click or key starts the score (later gestures retry if the
browser suspended it). The player creates/resumes the context on
`touchend`, `pointerup` or `click`, and starts a silent buffer inside that
same gesture: iOS does not reliably unlock from `touchstart`/`pointerdown`,
and the splash hides on pointerdown so the first tap may produce no click.
If Safari refuses a resume, the next tap builds a fresh context instead of
retrying the blocked one. On iPhone, WebAudio still follows the hardware
Ring/Silent switch; if Settings says `PLAYING` and you hear nothing, check
that switch and the hardware volume. A stale service worker is the other
common cause:
`js/build-guard.js` compares the running build with the deployed
`sw.js`. A page that already runs the deployed build only fills its
cache in the background. A genuinely stale page waits for every shell
file to be cached, reloads once, and skips the boot splash on that
reload. If the cache never completes, the tab keeps the working page
instead of spinning.

The Rust implementation is normative for this repository. The JS core is
pinned to it by machine-generated vectors (`web/tests/rust-vectors.json`):
params hash, schedule, settlement digests, state/send leaves, parent tags,
mint envelopes, and the exact mint document bytes with their SHA-256.

## Building and running the Rust indexer

```sh
cd rust
cargo build --release -p hopper-indexer-api
cargo test --workspace
```

Run it against a bitcoind with ZMQ (`zmqpubhashblock`) and RPC:

```sh
HOPPER_API_ADDR=127.0.0.1:9770 \
HOPPER_ACTIVATION_HEIGHT=974034 \
HOPPER_INSCRIPTION_ACTIVATION_HEIGHT=974034 \
HOPPER_SNAPSHOT_PATH=/var/lib/hopper/indexer.bin \
HOPPER_ZMQ_ADDR=tcp://127.0.0.1:28332 \
HOPPER_RPC_URL=http://127.0.0.1:8332 \
HOPPER_RPC_COOKIE=/home/bitcoin/.bitcoin/.cookie \
HOPPER_ORD_URL=https://ordinals.com \
./target/release/hopper-indexer-api
```

Important environment facts:

| Variable | Meaning |
| --- | --- |
| `HOPPER_API_ADDR` | bind address, default `127.0.0.1:9770` |
| `HOPPER_ACTIVATION_HEIGHT` | required: `974034`; a mismatch refuses to boot |
| `HOPPER_RATE_LIMIT_PER_MIN` | public-read budget per caller, default `300`; `0` disables |
| `HOPPER_INSCRIPTION_ACTIVATION_HEIGHT` | required: `974034`; MINTs must carry the ord reveal, with v7 accepted only for the grandfathered sat |
| `HOPPER_SNAPSHOT_PATH` | binary snapshot; restored on boot |
| `HOPPER_SNAPSHOT_EVERY` | snapshot cadence (blocks) |
| `HOPPER_RETAIN_BLOCKS` | reorg replay window |
| `HOPPER_ZMQ_ADDR` | enables the ingest wire; without it use admin ingest |
| `HOPPER_RPC_URL` / `_COOKIE` / `_USER`+`_PASS` | block fetch credentials |
| `HOPPER_ORD_URL` | ord server for lazy sat-range seeding; unset = disabled (point it at a local ord or `https://ordinals.com`) |
| `HOPPER_INGEST_START_HEIGHT` | must be 0/unset; genesis-only ingest is enforced |

The indexer always ingests from the chain's genesis: starting later would
make pre-start coins untracked and hide owned frogs. `HOPPER_ADMIN_TOKEN`
protects `/v1/admin/*`; without it the admin wire is only allowed on a
loopback bind.

### API

Public reads: `/healthz`, `/readyz`, `/metrics`, `/v1/status`, `/v1/params`,
`/v1/froggers`, `/v1/frogger/{sat}`, `/v1/road`, `/v1/leaderboard`,
`/v1/state/root`, `/v1/events`, `/v1/events/stream` (SSE), `/v1/mempool`,
`/v1/fees`, `/v1/utxo/{txid}/{vout}`.

`/v1/utxo` ranges are **half-open** `[start, end)`. `exact: false` means
shadow ranges (never ownership). `frogger` records include the in-flight
`outcome_block_hash`/`provisional_dead` once T+1 has sealed the outcome.

Admin writes (bearer token or loopback): `POST /v1/admin/block`,
`POST /v1/admin/seed`, `POST /v1/admin/rollback`. The block DTO takes input
values, optional reveal metadata (`content_type`, `body`, `parents`,
`tapscript`, `control_block`), and output `op_return` payloads; the wallet
tests build these straight from the JS transactions.

```sh
curl -s localhost:9770/v1/status
curl -s localhost:9770/v1/frogger/9000000000
curl -sN localhost:9770/v1/events/stream
```

## The web wallet

- **Keys**: BIP-39 → BIP-84 `m/84'/coin'/0'` (`/0/i` receive, `/1/i`
  change; the web wallet uses only index 0 for both) plus ordinals key
  `m/84'/coin'/2/0`. P2WPKH and P2TR (BIP-341/BIP-86) addresses,
  tapleaf/branch/control-block construction.
- **Transactions**: consensus serialization, txid/wtxid, vsize, BIP-143 and
  BIP-341 sighashes, SIGHASH_ALL, Schnorr/ECDSA signing. A Rust test
  (`js_tx_verify.rs`) re-derives every sighash with `rust-bitcoin` and
  verifies the JS signatures, so a witness bug cannot hide behind the
  witness-free indexer.
- **Actions**: `buildMint` (commit + reveal), `buildPrepare`, `buildCross`,
  `buildTransfer`, `buildSend`, all fee-sized from the actual scripts, and
  deliberately no burn builder. Funding selection accepts only plain BIP84
  P2WPKH coins, never the frog address or a state card. The session runs
  `buildMint` in a module worker so hashing and
  signing the 14 KiB mint document cannot make the page unresponsive; if a
  browser cannot start the worker it falls back to the main thread.
- **Travel To Road**: the UI name for `buildPrepare`. A warning explains
  that approval stages the Hopper in the tapscript state address the game
  watches, that this is not a crossing, and that normal SEND/TRANSFER still
  works from that address. Nothing is broadcast until the approval button
  is pressed. The 12-word backup is likewise behind a warning gate.
- **Mint draft**: the name starts blank and is optional. The seed is
  wallet-generated and read-only in the form; DICE rerolls it, and it is
  rotated as soon as the reveal broadcast is accepted so a finished seed
  cannot be reused.
- **Vault**: AES-256-GCM under a PBKDF2-SHA-256 (210,000 rounds)
  non-extractable WebCrypto KEK. The KEK is cached in IndexedDB **only**
  when "keep this device unlocked" is checked; locking deletes it. Wiping
  removes the vault and local ledger. Unlock decrypts and opens the wallet
  immediately; the first chain refresh runs in the background, so a cold
  pass, a slow public Esplora or an unreachable indexer cannot hold the
  lock screen. The protocol-params check still runs before mint/hop signing.
- **Discovery**: the watch set is fixed. The wallet asks only the ordinals
  address, receive #0, change #0, and one derived tapscript state script for
  each staged Hopper. There is no HD gap walk, no receive rotation, and no
  `EXTEND`. A cold boot and every later pass ask the same scripts; only the
  one-time receive/change history backfills run on a cold pass or RESCAN. A
  tip gate means an unchanged block asks the chain **nothing**. A new tip
  starts two short grace passes at a 1.2 s cadence: the tip endpoint can
  publish a block before the address index has its transactions, and without
  those passes the gate would keep the old UTXO set until the next block.
  Public
  sources get one tip probe every ten minutes while idle, and a 30 s cadence
  only while one of our transactions is confirming. A failed tip aborts a
  background pass before any address query; a failed address stops the pass
  rather than firing the rest of the set. Public failures back off 1→30 min
  (local failures 5→300 s). **STOP SCANNING** in Settings clears the timer,
  block subscription and foreground wake, persists the pause across
  reloads, and becomes **RESUME SCANNING**; REFRESH and RESCAN still work by
  hand while paused. RESCAN is one tap and re-asks the fixed scripts plus
  both history backfills. An address answer already says
  whether an output is confirmed; mempool outputs are kept as faded History
  rows labelled IN MEMPOOL and counted in the wallet's pending total — no
  extra request is made to find them. A frog is owned when its sat is in a
  coin whose script this wallet can spend; the indexer is never trusted for
  ownership. Live deep scan is **off by default**; demo mode always scans so
  the simulator has something to show. A HOPPER mint reveal carries its
  canonical v8 body in the taproot witness, so the wallet recognizes a mint
  paid to its ordinals address **without an indexer or ord**. On a cold or
  manual pass it also walks that address's transaction history: if the
  reveal was already spent into its state output, the wallet parses the old
  reveal, derives the state script from `(sat, mint outpoint, owner)`, and
  watches that address. A new device with the same words and a chain source
  can therefore recover a PREPAREd/staged Hopper with no indexer and no ord
  server. A cold/manual pass, and once per new tip while a local HOP is in flight,
  also replays that state address's history, so TRAVEL, each HOP's direction
  and each settlement are rebuilt from chain transactions without an
  indexer; a mempool HOP is reported as in flight.
  The ord address is queried before the HD gap plan, so a throttled gap
  address cannot hide a mint. A frog that was transferred in later has no
  new inscription body on its output; that discovery still needs a HOPPER
  indexer (or ord ranges plus one).
- **Demo vs live**: new wallets start in **live** mode; `DemoBackend`
  implements the same interface as `EsploraClient`/`ElectrumClient` +
  `IndexerClient` and is opt-in from Settings. Apply URLs in Settings.
  On mainnet an empty **Esplora** field uses `https://blockstream.info/api`
  unless an Electrum URL is set, and an empty **Ord** field uses
  `https://ordinals.com`; regtest/testnet/signet have no public defaults
  and need an explicit source. The **Indexer** starts empty because a
  local indexer is not a public backend; set a reachable one for frogs,
  road and leaderboard. Live mode requires a secure context for WebCrypto;
  Electrum needs a WebSocket endpoint. `electrs` itself speaks TCP, so a
  browser needs a loopback WS-to-TCP bridge (the page talks
  `ws://127.0.0.1:…`, never a raw TCP socket).
- **Sat ranges**: the indexer deliberately does not model the coinbase
  subsidy (`rust/crates/hopper-indexer/src/NOTES.md`), so a freshly mined
  coin starts with shadow/empty ranges. When a wallet asks `/v1/utxo`
  about such a coin, the indexer asks `HOPPER_ORD_URL`'s
  `/r/utxo/:outpoint` for the real `sat_ranges` and seeds the outpoint
  before answering. No manual `/v1/admin/seed` is needed. Point that
  variable at a local ord or a third-party instance; unset disables the
  oracle. The PWA also has an **Ord** field (empty =
  `https://ordinals.com` on mainnet) and uses the same recursive
  `/r/utxo` view directly when the indexer still cannot name a coin.
  That is the public, CORS-enabled ord endpoint, so it works from a
  static page without a same-origin proxy. Type `none` in the Ord field
  (or press **NO ORD**) to disable it when a host lacks CORS; local mint
  and staging recovery still uses Esplora alone.

### Tests

```sh
cd web
node tests/core.test.mjs        # 142 checks against Rust vectors
node tests/game.test.mjs        # mint → prepare → hop → settlement → transfer (and no burn path)
node tests/media.test.mjs       # 54 checks: score, QR, pixel marks, pips, road-frame and cutscene-car geometry
node tests/scan.test.mjs        # FROGGER scan policy: cold/warm plan, tip gate, mempool rows, rescan
node tests/ord.test.mjs         # public Esplora/ord defaults, ord ranges, indexer→ord fallback
node tests/localmint.test.mjs   # 40 mint-recognition and commit-checks from the reveal witness without an indexer
node tests/chainfrog.test.mjs   # 47 state-address replay checks: TRAVEL, HOP, settlement, mempool HOP, settled road release
node tests/history.test.mjs     # 134 checks: deposits, copy targets, causal journey, mempool HOP order, change labels
node tests/ui.test.mjs          # 106 checks: pond, settled/in-flight road cards, road-log wording, no demo controls in live mode
node tests/fees.test.mjs        # 19 fee-band/floor/cache checks
node tests/preview.test.mjs     # 119 send/send-all/transfer/mint preview and stale-preview checks
node tests/rbf.test.mjs         # 125 BIP125/ordinal-safety checks: plain sends only, outputs preserved
node tests/indexer-e2e.mjs http://127.0.0.1:9770   # JS tx bytes into the Rust indexer
```

`game.test.mjs` also exports every signed transaction and its prevouts to
`tests/js-txs.json`. The Rust test below verifies those ECDSA/Schnorr
signatures with `rust-bitcoin`'s BIP-143/BIP-341 sighash implementation
(this is the seam the indexer, which is witness-free, cannot check):

```sh
cd rust
cargo test -p hopper-indexer-api --test js_tx_verify
```

The indexer seam starts a fresh Rust API with
`HOPPER_INSCRIPTION_ACTIVATION_HEIGHT=974034`, seeds the demo faucet coins via
`/v1/admin/seed`, submits JS-built blocks through `/v1/admin/block`, and
asserts the Rust state machine reaches the same mint, crossing and settlement.

Headless UI test (Chromium):

```sh
python3 -m http.server 8130 &
chromium --headless=new --no-sandbox --remote-debugging-port=9222 \
  --user-data-dir=/tmp/hopper-profile about:blank &
node tests/e2e.mjs http://127.0.0.1:8130
```

It creates a wallet, checks every screen fits a phone width, verifies the
PWA manifest/service worker, opens both RECEIVE tabs (and checks the QR
gets real ink), mints through the worker, approves TRAVEL TO ROAD at its
warning, hops, mines six blocks reloads without and with "keep this
device unlocked", and fails on console errors or horizontal overflow.
Screenshots land in `.shots/` (ignored).

Rebuild the vendored crypto bundle and the protocol vectors:

```sh
cd web/vendor-src && npm ci && npm run build   # → js/vendor/bitcoin-lib.js
cd web/vendor-src && npm run build:qr           # → js/vendor/qr.js
cd rust && cargo run -p hopper-core --example vectors > ../web/tests/rust-vectors.json
cd web && node tools/make-icons.mjs            # deterministic PWA icons
```

## Security and limits

This is a reference/engineering implementation, **not audited**. Do not put
mainnet value on it without review.

- The 12 words are the only backup. The vault password is never stored, but
  a remembered KEK (if chosen) is accessible to any script running on this
  origin — that is what "keep this device unlocked" means.
- The indexer is a discovery hint and a public view. Value decisions
  (ownership, fees, signatures) are made locally from chain data.
- **Public defaults.** On mainnet, an empty Esplora field sends address
  queries to Blockstream; those addresses are not private from Blockstream.
  Set your own Esplora/Electrum to avoid that.
- **Sat ranges are an oracle.** The HOPPER indexer does not model the
  coinbase subsidy, so it seeds unknown coins from `HOPPER_ORD_URL`; the
  wallet can also fall back to its **Ord** URL. A malicious or stale ord
  can misname sats. Run your own ord (or pin a trusted instance) when
  that trust matters.
- Demo mode is a simulator: no PoW, no mempool policy, no script execution.
  It validates the v8 state machine and byte encodings, not Bitcoin.
- Live mode refreshes on a block-driven schedule: an Electrum source pushes
  new headers, an Esplora source polls the tip every ten minutes while idle.
  There is no second index or extra HD sweep on a warm pass. Deep discovery
  of state outputs is bounded to 300 public frogs and can be expensive on a
  large pond; it is off by default and can be enabled in Settings if you
  need to recover custody outputs from a fresh device.
- RBF is limited to ordinary plain sends; no CPFP, hardware wallet, multisig, or coinbase maturity handling.
- Snapshot/event retention and ZMQ ingest are operator concerns; see the
  module docs and `rust/crates/hopper-indexer/src/NOTES.md`.

## License

Rust crates declare MIT in `rust/Cargo.toml`. The web code follows the same
license. The specification is in `SPEC.md`.
