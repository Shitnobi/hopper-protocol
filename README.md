# HOPPER — the pond on Bitcoin

A reference implementation of **HOPPER v6** ([`SPEC.md`](SPEC.md)):

- **`rust/`** — the consensus core, a standalone Bitcoin indexer and its
  REST/SSE API.
- **`web/`** — a non-custodial browser wallet, game client and installable
  PWA that builds real consensus transactions and can run against either a
  local demo chain or the live indexer.

HOPPER does not mint a token. A frog **is** an ordinal satoshi. Its state is
the chain's answer to "which UTXO currently holds this sat", and a crossing
is an inscription whose outcome is fixed by a future block hash.

---

## Quick start (demo, no node, no indexer)

The demo chain runs entirely in the browser: FIFO sat assignment, mint
validation, prepare/cross state scripts, the T+1 death decree, T+6
settlement, transfers, burns, NPC residents and a faucet. It persists to
`localStorage`.

```sh
cd web
python3 -m http.server 8130
# open http://127.0.0.1:8130/
```

Create a wallet, keep the 12 words, and use the faucet. Every broadcast
mines one demo block, so `MINE 6` settles a crossing. The service worker
makes the app shell and demo work offline after the first load (localhost is
a secure context; a plain-HTTP LAN address is not).

> The demo chain is **not** Bitcoin. Switch to live mode only when you have
> an indexer and a chain port.

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
  index.html, manifest, sw.js, icons/
  css/app.css              mobile-first dark lily-pad UI
  js/core/                 hex, params, settles, envelopes, inscriptions,
                           v6 leaves, fold replay, art, PNG, mint document
  js/wallet/               keys, addresses, tx sign/serialize, actions,
                           tx parser, backends, vault, storage, session,
                           mint worker + client
  js/mock/chain.js         in-browser v6 demo chain
  js/ui/                   screens, DOM helpers
  js/main.js               boot, onboarding/lock, routing, action wiring
  js/sound.js              WebAudio chip loop and SFX (gesture-gated)
  js/vendor/               pinned noble/scure bundle (generated)
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
  state. **Burn**: spending the frog's sat to fees sets `location = burned`
  (an idle frog becomes `burned`; a dead frog stays dead; an in-flight
  crossing settles `burned`).

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
  `buildTransfer`, `buildSend`, `buildBurn`, all fee-sized from the actual
  scripts. The session runs `buildMint` in a module worker so hashing and
  signing the 14 KiB mint document cannot make the page unresponsive; if a
  browser cannot start the worker it falls back to the main thread.
- **Vault**: AES-256-GCM under a PBKDF2-SHA-256 (210,000 rounds)
  non-extractable WebCrypto KEK. The KEK is cached in IndexedDB **only**
  when "keep this device unlocked" is checked; locking deletes it. Wiping
  removes the vault and local ledger.
- **Discovery**: watch receive/change addresses (configurable gap) and the
  ordinals address; ask the indexer for UTXO ranges; optionally enumerate
  public frogs to find state outputs that live at no derivation path.
  A frog is owned when its sat is in a coin whose script this wallet can
  spend; the indexer is never trusted for ownership.
- **Demo vs live**: `DemoBackend` implements the same interface as
  `EsploraClient`/`ElectrumClient` + `IndexerClient`. Apply URLs in Settings.
  Live mode requires a secure context for WebCrypto; Electrum needs a
  WebSocket endpoint.

### Tests

```sh
cd web
node tests/core.test.mjs        # 64 checks against Rust vectors
node tests/game.test.mjs        # mint → prepare → cross → settle → transfer → burn
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
asserts the Rust state machine reaches the same mint, crossing, settlement
and burn.

Headless UI test (Chromium):

```sh
python3 -m http.server 8130 &
chromium --headless=new --no-sandbox --remote-debugging-port=9222 \
  --user-data-dir=/tmp/hopper-profile about:blank &
node tests/e2e.mjs http://127.0.0.1:8130
```

It creates a wallet, checks every screen fits a phone width, verifies the
PWA manifest/service worker, mints through the worker, prepares, crosses,
mines six blocks, reloads without and with "keep this device unlocked", and
fails on console errors or horizontal overflow. Screenshots land in
`.shots/` (ignored).

Rebuild the vendored crypto bundle and the protocol vectors:

```sh
cd web/vendor-src && npm ci && npm run build   # → js/vendor/bitcoin-lib.js
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
- Demo mode is a simulator: no PoW, no mempool policy, no script execution.
  It validates the v6 state machine and byte encodings, not Bitcoin.
- Live mode currently refreshes on demand; there is no background block
  subscription in the PWA. Deep discovery of state outputs is bounded to
  300 public frogs and can be expensive on a large pond; turn it off in
  Settings if you know your frogs.
- No RBF/CPFP, hardware wallet, multisig, or coinbase maturity handling.
- Snapshot/event retention and ZMQ ingest are operator concerns; see the
  module docs and `rust/crates/hopper-indexer/src/NOTES.md`.

## License

Rust crates declare MIT in `rust/Cargo.toml`. The web code follows the same
license. The specification is in `SPEC.md`.
