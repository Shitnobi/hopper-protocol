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

- Build `hopper-v7-3-9`, deployed through GitHub Pages.
- After the deploy, load the site once to activate the new service-worker cache.

### Known limitation

The History feed remains **newest first**, so the journey reads bottom-up. The rows stay adjacent and each change names its spend; Bio gives the same journey in chronological order. If the HOP was made on another browser/device with no indexer, this browser still cannot reconstruct that crossing without walking state-address history; the local and indexer paths are the ones this fix covers.
