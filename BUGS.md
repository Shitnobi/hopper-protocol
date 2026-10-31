# HOPPER bug log

## 2026-10-31 — HOP rows lacked direction; Bio history was empty

**Reported:** Hops were not showing properly in the History tab, and a Hopper's history on its Bio page was empty.

**Build:** fixed in `a384e3d`, cache/build `hopper-v7-3-8`.

### Root causes

1. **History HOP rows had no useful content.** A crossing was rendered as a generic `HOP` row, with `amount unknown` and no direction. The transaction was present, but the row did not say whether the Hopper went left, straight, or right.
2. **Bio depended entirely on the indexer.** `frogEvents()` read only `w.history`, which is the event feed from a configured indexer. The default configuration has `indexerUrl: ''`, and the Rust indexer does not emit a `cross` event. As a result, the Bio timeline could be empty even when the wallet had broadcast the mint and HOP locally.

### Fix

- `web/js/ui/screens.js`
  - Imported `DIR_NAMES` from `core/v7.js`.
  - Added `hopDirName()`.
  - `historyRows()` now carries `dir` from both indexer payloads and local actions.
  - `txRow()` renders crossing rows as `HOP LEFT`, `HOP STRAIGHT`, or `HOP RIGHT`, adds a `dir 0/1/2 · NAME` detail, and shows `hopped left/straight/right` instead of `amount unknown`.
  - `prepare` rows now say `moved into custody`.
  - `historyDebug()` includes `dir` in downloaded History diagnostics.
  - `frogEvents()` now merges:
    - indexer `mint`, `cross`, and `settle` events;
    - local `mint` and `cross` actions;
    - on-chain mint records from `chainMints`.
  - Events are deduplicated by `kind:txid` (settles by height plus sat) and sorted by height.
- `web/tests/history.test.mjs`
  - Added a mint → prepare → straight HOP scenario.
  - Asserts History contains `HOP STRAIGHT`, `dir 1 · STRAIGHT`, and `hopped straight`.
  - Asserts Bio renders one `MINTED`, one `HOPPED ONTO THE ROAD`, and `STRAIGHT`.
  - Simulates a missing indexer with `history: []` and verifies Bio still reconstructs the mint/hop from local actions and chain mints.
- `web/tests/e2e.mjs`
  - After the HOP, navigates to History and checks `HOP STRAIGHT`, `dir 1`, `hopped straight`, and a non-empty sat.
  - Opens the Hopper Bio and checks `MINTED`, `HOPPED ONTO THE ROAD`, and `STRAIGHT`.
  - Returns to The Road before mining the settlement blocks.
- `README.md`
  - Documents direction labels in History and the Bio local-ledger fallback.
- `web/sw.js` and `web/js/build-guard.js`
  - Bumped from `hopper-v7-3-7` to `hopper-v7-3-8`.

### Verification

- Full `npm test` passed.
- History test count increased to 118 checks.
- Fresh-profile browser E2E passed with `e2e: ok`:
  - History after HOP: `HOP STRAIGHT`, `dir 1 · STRAIGHT`, `hopped straight`.
  - Bio after HOP: `MINTED`, `HOPPED ONTO THE ROAD · STRAIGHT`.
  - No console errors.
- GitHub Pages run `41180431020` completed successfully for `a384e3d`.
- Live verification:
  - `js/build-guard.js`: `const BUILD = 'hopper-v7-3-8';`
  - `sw.js`: `const VERSION = 'hopper-v7-3-8';`
  - live `screens.js` contains `hopDirName`, `HOPPED ONTO THE ROAD`, and the local fallback code.

### Deployment

- Commit: `a384e3d` — “Show local hops in History and Bio”.
- Fast-forwarded `master` and `last_change` from `1050f39` to `a384e3d`.
- Pushed both branches.
- Deployed via GitHub Pages; users may need one reload to activate the `hopper-v7-3-8` service-worker cache.

### Known limitation

Bio now recovers hops made in **this browser** from its local action ledger, and all events that the configured indexer exposes. If a HOP was broadcast in a different browser or device, and no indexer is configured, this browser has no local record of that crossing. Recovering it from chain data alone would require reconstructing state-address history through Esplora; that is not part of this fix.

## 2026-10-31 — The mint → travel → hop journey was duplicated and Bio skipped TRAVEL

**Reported:** A coin was deposited, used to mint a Hopper, the Hopper was sent to The Road, and then hopped right. The GUI did not present those transactions as one understandable journey, and the earlier History/Bio fix was not enough.

**Build:** `hopper-v7-3-9`.

### Root causes

1. **History painted TRAVEL TO ROAD twice.** The local wallet action has kind `prepare`; the indexer reports the same transaction as kind `transfer`. Deduplication keyed on `kind + txid`, so the two kinds could never merge. The raw `TRANSFER` row also appeared after the useful local `TRAVEL TO ROAD` row, with no destination or fee.
2. **Bio ignored TRAVEL entirely.** Its local-ledger branch only handled `mint` and `cross`, so a Hopper's life story jumped from MINTED straight to HOPPED. Every hop was labelled `HOPPED ONTO THE ROAD`, even a later hop made while already on the road, and the direction was only in small detail text.
3. **History rows did not explain their dependencies.** A `CHANGE` row sat next to its transaction but did not say which spend produced it. `MINT`, `TRAVEL TO ROAD` and `SETTLE` fell through to `amount unknown`, and a settlement was a generic `SETTLE` row instead of saying whether the Hopper crossed or died and in which direction.
4. **Merging could discard local detail.** The old first-row-wins filter kept the indexer event for a `TRANSFER`, losing the local `to` address and fee; the same order-dependent problem affected other action/event pairs.

### Fix

- `web/js/ui/screens.js`
  - Replaced first-row-wins deduplication with a merge keyed by semantic transaction:
    - `receive` by txid;
    - `change` by txid, amount and address;
    - `settle` by height and sat;
    - `prepare` and `transfer` share the `move` family, because they are the same state transaction from two ledgers;
    - other actions/events merge by kind, txid and normalized sat.
  - Merge fills missing fields from both rows and prefers the local `prepare` row over the raw indexer `transfer`, while keeping the indexer's confirmed height.
  - `CHANGE` rows now carry `changeFor`, rendered as `change from mint`, `change from travel to road`, or `change from hop right`.
  - History labels now read:
    - `HOP LEFT/STRAIGHT/RIGHT`;
    - `CROSSED LEFT/STRAIGHT/RIGHT` or `DIED LEFT/STRAIGHT/RIGHT`;
    - `MINT` → `created Hopper`;
    - `TRAVEL TO ROAD` → `moved into custody`;
    - `TRANSFER` → `handed off`;
    - `SETTLE` → `survived the road` or `roadkill is forever`.
  - Bio's `frogEvents()` now merges indexer events, chain mints, local mint/TRAVEL/cross actions and local transfers.
  - Bio chronological order is `MINTED` → `TRAVELED TO THE ROAD` → `HOPPED LEFT/STRAIGHT/RIGHT` → `CROSSED THE ROAD`/`DIED`, plus `TRANSFERRED`.
  - Indexer rows contribute confirmed heights; local actions contribute direction and destination. Dedupe keys merge the two instead of dropping one.
  - History subtitle now states that a transaction's rows stay together and each change names its spend.
- `web/tests/history.test.mjs`
  - Added the exact journey: deposit → mint → TRAVEL TO ROAD → HOP RIGHT.
  - Asserts History has one row per logical transaction, no duplicate `TRANSFER`, no `amount unknown`, and the causal chain bottom-up with the newest-first feed.
  - Asserts Bio reads `MINTED → TRAVELED TO THE ROAD → HOPPED RIGHT`, with and without an indexer.
  - Asserts a settled journey adds exactly one `CROSSED RIGHT` result and Bio ends with `CROSSED THE ROAD`.
  - History tests: 131 checks.
- `web/tests/e2e.mjs`
  - The browser journey now chooses **RIGHT**, matching the reported scenario.
  - Asserts History after settle is `CROSSED RIGHT, CHANGE, HOP RIGHT, CHANGE, TRAVEL TO ROAD, HOPPER ARRIVED, CHANGE, MINT, ...`; no `TRANSFER`, no `amount unknown`; change-origin labels present.
  - Asserts Bio after HOP is `MINTED, TRAVELED TO THE ROAD, HOPPED RIGHT`.
  - Asserts Bio after settlement ends with `CROSSED THE ROAD` or `DIED`.
- `README.md` updated to document the merge, change-origin labels, and Bio journey order.
- `web/sw.js` and `web/js/build-guard.js` bumped to `hopper-v7-3-9`.

### Verification

- Full `npm test` passes:
  - core 136, game ok, emergency 103, params 7, media 36, scan 94, ord 46, ui 63, fees 19, preview 87, localmint 40, history 131, rbf 125;
  - v7 fold sync/parity and doc boot pass.
- Fresh-profile browser E2E passes with `e2e: ok`:
  - History after HOP: `HOP RIGHT`, `dir 2 · RIGHT`, `hopped right`.
  - Bio after HOP: `MINTED`, `TRAVELED TO THE ROAD`, `HOPPED RIGHT`.
  - History after settlement: `CROSSED RIGHT` or `DIED RIGHT` above `CHANGE`, `HOP RIGHT`, `CHANGE`, `TRAVEL TO ROAD`, `HOPPER ARRIVED`, `CHANGE`, `MINT`.
  - No `TRANSFER` duplicate, no `amount unknown`, no console errors.
  - Log: `~/AI/regtest-last-change/logs/e2e-v7-3-9b.log`.
- Generated `web/tests/js-txs.json` was reverted after the Rust vector test.

### Deploy

- Commit: `70b813e` — “Merge a Hopper's mint, travel and hop into one readable journey”.
- Fast-forwarded `master` and `last_change` from `a384e3d` to `70b813e`; pushed both.
- GitHub Pages run `41181766432` completed successfully.
- Live release check: build `hopper-v7-3-9`, service worker controlled, only cache `hopper-v7-3-9`, params intact, no console errors.
- Load the site once to activate the new service-worker cache.

### Known limitation

The History feed remains **newest first**, so the journey reads bottom-up. The rows stay adjacent and each change names its spend; Bio gives the same journey in chronological order. If the HOP was made on another browser/device with no indexer, this browser still cannot reconstruct that crossing without walking state-address history; the local and indexer paths are the ones this fix covers.

## 2026-10-31 — A confirmed HOP was invisible on a restored/other device

**Reported:** “I am not seeing the first cross on Satoshi Hoppamoto recognized.”

**Build:** `hopper-v7-3-10`.

### On-chain facts

- Mint: `799ed32ce7532a604906cbb91e92608b6b01db92d5532be145c001d5f178ce9f` (`i0`), height `973899`, sat `1965983893977665`, name “Satoshi Hoppamoto”, G1.
- TRAVEL TO ROAD: `dba210ebfa9490c545edadf295d2ad5f89d2cc15c8e9eb1c9363f00f86efe710`, height `973900`.
- First HOP: `544c2178be584a59d0362e801aec66e2d4948143163c34c503dd7235f3253510`, height `973933`, direction `1` (STRAIGHT).
- Outcome block `973934` hash `000000000000000000016bb394d8a6d087c8a601b80bc79b5ebb9ae8cd43d4ac`, wrap `2`. `1 != 2`, so the HOP survived; settlement at `973939`.
- The mint, TRAVEL and HOP all end at the same derived state address, so the first cross was genuinely on chain. A second HOP (`5c9fb7989b7f6773e7d890bf312a104947d38cad6284a7577e9f2283a9484130`, RIGHT) was in the mempool while this was being diagnosed.

### Root cause

The wallet only rebuilt a Hopper's road career from **local actions** and **indexer events**. It recovered the mint and staged state output without an indexer, but it never replayed the state address's transaction history. A crossing broadcast by another browser, or one whose local action ledger was lost, therefore left the restored record at `idle`, `dist = 0`, even though the chain and the inscription fold both showed the HOP and its settlement. Bio had the same hole. The first cross was not rejected by the envelope; the wallet simply never looked for it.

### Fix

- `web/js/wallet/chainfrog.js` (new)
  - `frogTxRole()` parses the tapscript witness, finds the 55-byte `FRG7CROSS` body in input 0, and requires `(sat, mint_txid, mint_index)` to match the local mint record.
  - `replayFrogChain()` orders the state-address transactions by height, treats a state-creating non-crossing as TRAVEL, and replays crossings with the same rules as the fold:
    - target `required(T)`;
    - outcome block `T + 1`, `wrap(displayHash)`;
    - death when `dir === wrap`;
    - settlement only at `T + 6`;
    - `home` when `dist >= target`.
  - A confirmed HOP still inside finality becomes `crossing` with `in_flight`.
  - A HOP in the mempool is reported as `crossing` / `in flight` but is **not** counted as settled and does not increment `dist`.
  - Missing transaction hex or a missing block hash returns `null`, so a partial backend answer never invents state.
- `web/js/wallet/wallet.js`
  - `_reconstructChainFrogs()` runs on cold/manual passes, asks each local Hopper's derived state address for its history, and applies the replay. It only runs when the wallet still has a state output at that script.
  - Transaction hex and block hashes are cached for the session.
  - Reconstructed TRAVEL/HOP/settle rows are merged into the action ledger. Existing local actions keep their fee and timestamp but receive the confirmed height/direction; synthetic rows are tagged `source: 'chain-replay'` and replaced on reorg/replay instead of accumulating.
  - `road()` now also emits a road row from a replayed `frog.in_flight`, so a restored in-flight HOP appears as `ON THE ROAD` / `in mempool`.
- `web/js/ui/screens.js`
  - Action rows with `mempool: true` render faded and `IN MEMPOOL`.
  - Bio renders local `settle` actions as `CROSSED THE ROAD` / `DIED`.
  - Bio places a height-less mempool event at the end, not at block zero; a pending HOP can no longer sort above `MINTED`.
- `web/tests/chainfrog.test.mjs` (new, 37 checks)
  - Real signed mint/TRAVEL/HOP bytes.
  - TRAVEL recognition, STRAIGHT HOP, settlement at `T+6`, dead HOP, in-flight finality, mempool HOP, pre-genesis target 5, missing-hex refusal.
  - Wallet ledger application, upgrade of a local HOP rather than duplication, and preservation of the confirmed height/direction.
- `web/tests/history.test.mjs` now 134 checks; adds the mempool HOP History/Bio ordering case.
- `README.md` documents state-address replay and the mempool HOP behavior.
- `web/sw.js` and `web/js/build-guard.js` bumped to `hopper-v7-3-10`.

### Verification

- Full `npm test` passes:
  - core 136, game ok, emergency 103, params 7, media 36, scan 94, ord 46, ui 63, fees 19, preview 87, localmint 40, chainfrog 37, history 134, rbf 125;
  - v7 fold sync/parity and doc boot pass.
- Fresh-profile browser E2E passes with `e2e: ok`; cache `hopper-v7-3-10`; no console errors.
  - Log: `~/AI/regtest-last-change/logs/e2e-v7-3-10.log`.
- Replayed the actual `Satoshi Hoppamoto` state address against `mempool.space`:
  - owner leaf from the first cross witness derived the exact state script;
  - replay produced `dist = 1`, `state = crossing` (the second HOP is in the mempool), one settled `CROSSED STRAIGHT`, one pending `HOP RIGHT`, and TRAVEL at `973900`.
  - History rendered top-down: `HOP RIGHT` (IN MEMPOOL) → `CROSSED STRAIGHT` → `HOP STRAIGHT` → `TRAVEL TO ROAD` → `MINT`.
  - Bio rendered: `MINTED` → `TRAVELED TO THE ROAD` → `HOPPED STRAIGHT` → `CROSSED THE ROAD` → `HOPPED RIGHT` (in mempool).

### Deploy

- Commit `30a1006` — “Rebuild a Hopper's road history from its state address”.
- Fast-forwarded `master` and `last_change`; pushed both.
- GitHub Pages run `41209640637` completed successfully.
- Live check: build `hopper-v7-3-10`, service-worker controlled, only cache `hopper-v7-3-10`, params intact, no console errors.
- Reload the app once to activate the new service-worker cache.

### Known limitation

State-address replay is deliberately a cold/manual-pass operation, not part of every 30-second warm poll. A crossing made on another device appears after unlock, REFRESH, or RESCAN. A confirmed HOP in the six-block finality window is shown as `HOPPING`, with `dist` unchanged until settlement, matching the indexer and the inscription fold.


### Addendum — `hopper-v7-3-11`

The initial `v7-3-10` replay ran only on a cold or manual pass. After a HOP confirmed, the restored record could stay `crossing` until REFRESH because the automatic tick had no reason to walk the history again. `v7-3-11` replays once per new tip while a local Hopper is `crossing`/`in_flight` (or a local HOP action is within 144 blocks). The confirmed `dist`/death then appears without manual intervention; the unchanged-tip path still costs no extra request. Cache/build are `hopper-v7-3-11`.

- Commit `aa4b6b7` — “Refresh an in-flight Hopper when the tip advances”.
- GitHub Pages run `41209845032` completed successfully.
- Live check: build `hopper-v7-3-11`, service-worker controlled, only cache `hopper-v7-3-11`, no console errors.
