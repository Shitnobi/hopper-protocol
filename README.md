# HOPPER — the pond on Bitcoin

A reference implementation of **HOPPER v6** ([`SPEC.md`](SPEC.md)):

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
assignment, mint validation, prepare/cross state scripts, the T+1 death
decree, T+6 settlement, transfers, fee sweeps, NPC residents and a faucet.
It persists to `localStorage`. Every broadcast mines one demo block, so
`MINE 6` settles a crossing.

> The demo chain is **not** Bitcoin.

## Layout

```
SPEC.md                    normative v6 rules (wire 0x06)
rust/
  crates/hopper-core       params, envelope, v6 leaves, sat math, settlement,
                           inscription bodies/PNG, fold (the live viewer)
  crates/hopper-indexer    sat tracking, consensus state machine, rules,
                           snapshots, reorg replay
  crates/hopper-indexer-api REST + SSE server, admin ingest, metrics
web/
  index.html, manifest, sw.js
  icons/                   pixel HOPPER tab mark + generated PWA icons
  fonts/                   Pixelify Sans (SIL OFL) for text; Silkscreen (SIL OFL) for digits
  css/app.css              mobile-first dark lily-pad UI
  js/core/                 hex, params, settles, envelopes, inscriptions,
                           v6 leaves, fold replay, art, PNG, mint document
  js/wallet/               keys, addresses, tx sign/serialize, actions,
                           tx parser, backends, vault, storage, session,
                           mint worker + client
  js/mock/chain.js         in-browser v6 demo chain
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

- **Wire** `0x06`, magic `FRG`, mint envelope `FRG | 06 | 01 | u32 seed |
  u8 len | name` (≤ 38 UTF-8 bytes), opcode `OP_RETURN`.
- **Params hash**
  `86f35aa96824d2b0f80edf553dd25d2ca3304df89be3183fdb2b5cc37badd458`.
- **Genesis** `973263`; schedule anchors `974543`, `978143`, `1078943`;
  required hops start at 5, rise by 64/144/2016 to a ceiling of 100.
- **Card** 25,000 sats; **anchor output** 1,000 sats; **finality** 6 blocks.
- **Mint**: commit → reveal. The commit output is P2TR whose single tapleaf
  holds the ~14 KiB live document and the owner key. The reveal spends it,
  pays 1,000 sats to the frog address, writes the FRG mint envelope, and the
  anchor sat is the first sat of the commit input.
- **Custody**: a 25,000-sat output with internal key **NUMS** (no key path).
  Leaf 0 signs a crossing and commits to the 54-byte
  `FRG6CROSS` state body; leaf 1 is an ordinary owner signature. The control
  block names the NUMS key.
- **Crossing**: spend the state output, one inscription in input 0, the
  anchor sat at offset 0 of output 0. `target = required(T)`.
- **Outcome**: at `T+1`, `H = block_hash(T+1)`;
  `dead iff u32LE(SHA256("FRG3-CROSS" || sat || H)) * 10000 <
  death_bps(target) * 2^32`. No floats. Settlement at `T+6`: survive →
  `dist++`, `home` at `dist >= target`; otherwise `dead`.
- **Transfer**: an ordinary spend; it publishes no envelope and changes no
  state. **Fee-swept sats**: spending the frog's sat to fees sets
  `location = burned` (an idle frog becomes `burned`; a dead frog stays
  dead; an in-flight crossing settles `burned`).

The wallet has no BURN action. There is no button, no `buildBurn`, and no
session method that pays a Hopper's anchor sat to fees; `TRANSFER` moves
the sat to a recipient, while TRAVEL TO ROAD and CROSS keep it at offset 0
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
use BACK and NEXT).

The crossing pips are a real progress display: one dot for every hop in
the current target (5 at genesis, rising to 100), filled to the Hopper's
completed crossings, with `×completed / target` beside them. An idle
Hopper follows the next block's requirement, so empty dots appear as the
road raises its toll; an in-flight Hopper keeps its frozen target.

RECEIVE is the egui bottom window, not an address list: a tab for
**BITCOIN** (the rotating BIP84 receive branch, with NEW ADDRESS and USED
ADDRESSES) and a tab for **HOPPERS** (the fixed BIP86 frog address), each
with the warning band the tab demands ("DON'T SEND HOPPERS HERE" /
"🐸 ONLY SEND HOPPERS HERE"), a scannable QR with the spec's quiet zone,
the selectable address, COPY and FULL QR. The window is height-stable:
both tabs use the same fixed QR, address, note and action rows, so
flipping BITCOIN/HOPPERS never moves or resizes it.

The music is the egui app's `music.mid` played through WebAudio with the
same tempo map, voice and master fader; the mute and volume still live in
the wallet settings. It is the app's soundtrack, not a wallet-only effect:
like FROGGER, it starts on the first gesture on any screen — onboarding,
the lock, or the wallet — and survives locking. The drawer (and Settings)
shows a live line such as `♪ PLAYING · 7635 NOTES`, or names the reason it
is silent (`MUTED`, `VOLUME 0%`, `SUSPENDED — TAP TO RETRY`, a load
error). `hopperSound.status()` reports the same state in the console.

Browsers require one gesture before audio may start, so the first
tap/click/key starts the score (later gestures retry if the browser
suspended it). A stale service worker is the other common cause: scripts
are cache-first, so an old worker can keep serving the old player. Each
shell now checks for its own cache on load and, if it is missing,
unregisters the old worker and reloads once (`js/shell-reset.js`); after
an update without that file, use DevTools → Application → Service
Workers → Unregister once.

The Rust implementation is normative for this repository. The JS core is
pinned to it by machine-generated vectors (`web/tests/rust-vectors.json`):
params hash, schedule, settlement digests, state/send leaves, parent tags,
mint envelopes, and the exact 14,356-byte mint document with its SHA-256.

## Building and running the Rust indexer

```sh
cd rust
cargo build --release -p hopper-indexer-api
cargo test --workspace
```

Run it against a bitcoind with ZMQ (`zmqpubhashblock`) and RPC:

```sh
HOPPER_API_ADDR=127.0.0.1:9770 \
HOPPER_ACTIVATION_HEIGHT=973263 \
HOPPER_INSCRIPTION_ACTIVATION_HEIGHT=973263 \
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
| `HOPPER_ACTIVATION_HEIGHT` | schedule genesis; the compiled v6 params are frozen |
| `HOPPER_INSCRIPTION_ACTIVATION_HEIGHT` | from this height MINTs must carry the ord reveal; unset = legacy mints accepted |
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
  change) plus ordinals key `m/84'/coin'/2/0`. P2WPKH and P2TR
  (BIP-341/BIP-86) addresses, tapleaf/branch/control-block construction.
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
  removes the vault and local ledger.
- **Discovery**: the scan policy is ported from FROGGER. A cold boot (or
  RESCAN / EXTEND) walks the 20-address gap on receive and change in waves
  of eight; the change branch is skipped on a brand-new wallet. Every later
  pass watches only the ordinals address, the next unused index per branch
  plus one guard (`next - 1` too), and the indices that held coins last
  pass. A tip gate means an unchanged block asks the chain **nothing**.
  Public sources get one tip probe every ten minutes while idle, and a 15 s
  cadence only while one of our transactions is confirming; failures back
  off 5→300 s. RESCAN takes two taps, walks the gap slowly (400 ms
  per wave on a public source), reports progress and can be stopped;
  EXTEND grows the persisted window by 20. An address answer already says
  whether an output is confirmed; mempool outputs are kept as faded History
  rows labelled IN MEMPOOL and counted in the wallet's pending total — no
  extra request is made to find them. A frog is owned when its sat is in a
  coin whose script this wallet can spend; the indexer is never trusted for
  ownership. Live deep scan is **off by default**; demo mode always scans so
  the simulator has something to show.
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
  static page without a same-origin proxy.

### Tests

```sh
cd web
node tests/core.test.mjs        # 64 checks against Rust vectors
node tests/game.test.mjs        # mint → prepare → cross → settle → transfer (and no burn path)
node tests/media.test.mjs       # score, QR, pixel marks, crossing-pip layout
node tests/scan.test.mjs        # FROGGER scan policy: cold/warm plan, tip gate, mempool rows, rescan
node tests/ord.test.mjs         # public Esplora/ord defaults, ord ranges, indexer→ord fallback
node tests/ui.test.mjs          # no sound-test button; demo chain controls are demo-only
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
`HOPPER_INSCRIPTION_ACTIVATION_HEIGHT=0`, seeds the demo faucet coins via
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
warning, crosses, mines six blocks, reloads without and with "keep this
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
  It validates the v6 state machine and byte encodings, not Bitcoin.
- Live mode refreshes on a block-driven schedule: an Electrum source pushes
  new headers, an Esplora source polls the tip every ten minutes while idle.
  There is no second index or full-gap sweep on a warm pass. Deep discovery
  of state outputs is bounded to 300 public frogs and can be expensive on a
  large pond; it is off by default and can be enabled in Settings if you
  need to recover custody outputs from a fresh device.
- RBF is limited to ordinary plain sends; no CPFP, hardware wallet, multisig, or coinbase maturity handling.
- Snapshot/event retention and ZMQ ingest are operator concerns; see the
  module docs and `rust/crates/hopper-indexer/src/NOTES.md`.

## License

Rust crates declare MIT in `rust/Cargo.toml`. The web code follows the same
license. The specification is in `SPEC.md`.
