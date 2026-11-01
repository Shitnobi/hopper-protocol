# HOPPER bug log

## 2026-11-01 — Emergency export used the current tree for a legacy Hopper

**Found during:** the whitepaper/SPEC/PWA conformance audit.

**Build:** fixed in `hopper-v8-0-7`.

### Root causes

1. `_emergencyEntry()` always rebuilt the state tree with the current BIP86
   owner and v8 leaves. A legacy-path Hopper needs its released owner and,
   for a v7-wire Hopper, its `FRG7CROSS` leaves; its emergency descriptor
   would not match the on-chain state output.
2. The export did not compare the rebuilt output key with the scanned state
   scriptPubKey before displaying it. The SPEC required that check, but the
   PWA relied on the caller/test to do it.
3. Esplora address rows carry no script, so scanned state UTXOs could lose
   the watched script even though the wallet knows it from the derivation.

### Fix

- `web/js/wallet/wallet.js`
  - `_emergencyEntry()` now uses `_frogOwner(f)` and
    `stateScripts(..., { legacy: _frogLegacyWire(f) })`, so legacy owners
    and leaves are exported correctly.
  - when the scanned UTXO has a scriptPubKey, the rebuilt output key must
    match it or that frog is omitted from the export.
  - every scanned UTXO keeps `u.script || w.script`, so an Esplora row
    without a script still retains the watched script.
- `web/tests/emergency.test.mjs`: a script mismatch is not exported; a
  legacy-path Hopper exports the legacy owner.
- `web/sw.js`, `web/js/build-guard.js`: `hopper-v8-0-7`.

### Verification

- `npm test`: core 142, game ok, emergency **105**, params 12, media 48,
  scan 104, ord 50, ui 106, fees 19, preview 119, localmint 40, chainfrog 47,
  history 134, rbf 125; v8 fold sync/parity/boot pass.
- `cargo test --workspace`: pass.

## 2026-11-01 — UI scan lag and the ROAD LOG's premature HOME

**Reported:** after a mined block the Road/Pond could stay on the previous
snapshot until **RESCAN FROM CHAIN**, and every successful ROAD LOG row said
“came home”, even when the hop only advanced one pad.

**Build:** fixed in `hopper-v8-0-6`.

### Root causes

1. **The tip gate could permanently skip a lagging index.** `/blocks/tip/height`
   and `/blocks/tip/hash` can publish a block before the address index has its
   transactions. The first pass at the new height read the old UTXO set, then
   recorded that height/hash as fully scanned. Every later pass at the same
   tip hit the gate and asked no addresses, so the view stayed stale until the
   next block or a forced RESCAN.
2. **A scan repaint could be dropped while the UI was busy.** `hopper:refresh`
   returned early with `defer`; if that landed while a foreground action held
   the busy overlay, the pending repaint was forgotten.
3. **ROAD LOG equated “not dead” with HOME.** Every settled `crossed` row was
   rendered as “came home”; it never checked whether that hop reached the
   frozen target.

### Fix

- `web/js/wallet/wallet.js`
  - after an automatic pass that sees a new tip, owes **two short full passes**
    at `TIP_RECHECK_MS = 1200`; those passes bypass the tip gate, then the gate
    closes again. This picks up an index that was behind the tip endpoint.
  - no extra passes on an unchanged tip or on the initial cold pass.
- `web/js/main.js`
  - `hopper:refresh` during a busy action is queued, not dropped; `run()`
    flushes it after releasing the overlay.
- `web/js/ui/screens.js`
  - ROAD LOG says **survived** for a successful non-final hop and **came home**
    only when `immortal_height` equals that row's crossing height
    (`settle height − cross_finality`). The icon is HOME only for that row.
- `web/sw.js`, `web/js/build-guard.js`: `hopper-v8-0-6`.
- Tests
  - `scan.test.mjs`: new tip owes two gate-bypassing passes; the third
    unchanged-tip pass is gated again.
  - `ui.test.mjs`: survived vs came-home ROAD LOG rows.
  - `e2e.mjs`: a one-hop settle at genesis renders “survived”, not “came home”.

### Verification

- `npm test`: core 142, game ok, emergency 103, params 12, media 48,
  scan **104**, ord 50, ui **106**, fees 19, preview 119, localmint 40,
  chainfrog 47, history 134, rbf 125; v8 fold sync/parity/boot pass.
- Local headless PWA E2E, build `hopper-v8-0-6`: **pass**; the settle rendered
  “Test Hopper survived”, `console errors: none`, `e2e: ok`.
- No protocol, wire-version, or consensus change.

### Deployment

- Commit: `f480d0b` — “Fix the scan lag and road-log HOME wording”.
- Fast-forwarded `master` and `last_change`; Pages run `41269976196` succeeded.
- Live build `hopper-v8-0-6`; fresh-profile live E2E passed, including the
  one-hop settle rendering “survived”, with `console errors: none`.

## 2026-11-01 — v8 regtest E2E found three proof/anchor defects

**Reported:** Full end-to-end run of the v8 consensus patches on regtest: mint, PREPARE, survive/death/HOME, SEND ALL, RBF bump, TRANSFER, recipient recovery, reorg, indexer restart, and the on-chain fold viewer.

**Build:** fixed in `hopper-v8-0-5`.

### Root causes

1. **The v8 fold fetched no child body from ord 0.22.2.** `/r/content/{id}` answers `200` with an **empty body** for cursed reinscriptions, not `404`. `contentBytes()` only fell back to `/content` on a non-OK response, so every state child parsed as zero bytes and the card stayed `unverified`.
2. **The fold treated `/r/tx/{txid}` as bare hex.** ord serves that endpoint as `application/json`, i.e. a quoted JSON string (`"0200…"`). `parseTx` read the leading quote as hex, produced `version: 8192` with zero inputs, and every proof check failed. The unit fixture had supplied bare hex, hiding the mismatch.
3. **The wallet sorted ordinal ranges instead of preserving FIFO order.** `anchorOffsetOf()` and `assertAnchorFirst()` sorted ranges by start sat. When a Hopper sat (787B-era) shared a state output with a numerically lower coinbase sat (5B-era), the valid anchor was reported at a nonzero offset and PREPARE/HOP refused it as “not the first sat of the coin”. Range order from ord/indexer is the output's FIFO order and is load-bearing.

### Fix

- `rust/crates/hopper-core/src/live_v8.js`
  - `contentBytes()` now falls back to `/content/{id}` when the recursive body is empty as well as on a non-OK response.
  - `verifyChildProof()` accepts both bare hex and ord's quoted JSON-string response. A missing/unparseable raw tx still fails closed (`unverified`).
- `web/js/core/fold_source.js`
  - regenerated with `web/tools/sync-fold.mjs`.
- `web/js/wallet/actions.js`
  - `anchorOffsetOf()` and `assertAnchorFirst()` preserve FIFO range order.
- Tests
  - `v7_doc_boot.mjs`: empty `/r/content`, quoted `/r/tx`, and missing `/r/tx` (must be `unverified`).
  - `preview.test.mjs`: FIFO range-order regression for both anchor helpers.
  - Golden v8 body digests and `web/tests/rust-vectors.json` regenerated.
- `web/sw.js`, `web/js/build-guard.js`: `hopper-v8-0-5`.

### Verification

- Full `npm test`: core 142, game ok, emergency 103, params 12, media 48, scan 98, ord 50, ui 104, fees 19, preview **119**, localmint 40, chainfrog 47, history 134, rbf 125; v8 fold sync/parity/boot pass.
- `cargo test --workspace` and `cargo test --workspace --features redb`: pass.
- `indexer-e2e` against the current binary at activation height `974034`: pass.
- Real regtest: five v8 mint/hop journeys, HOME, death, reorg rollback, snapshot restart, SEND ALL (state excluded), RBF, TRANSFER, recipient PREPARE/CROSS, and the **on-chain v8 fold viewer rendered `Fold Valid 🛣 5 HOME`** with no console errors.
- `SEND ALL` on chain: one output, recipient `total − actual fee`; the home Hopper state output was not spent.
- The fold now reports `unverified` when `/r/tx` is unavailable instead of claiming HOME.

### Deployment

- Commit: `0df8fad` — “Fix the v8 fold proof path and FIFO anchor checks”.
- Fast-forwarded `master` and `last_change`; Pages run `41266804251` succeeded.
- Live build `hopper-v8-0-5`; fresh-profile live E2E passed with SEND ALL and no console errors.

### Residual observations

- The automatic chain scan sometimes left the Road/Pond on the previous snapshot until **RESCAN FROM CHAIN**; the test harness forced a rescan after each mined block. This is a pre-existing UI refresh delay, not a consensus failure.
- The ROAD LOG still labels every non-dead settlement “came home”; it should say “survived” unless `dist >= target`.
- The real regtest chain was at height 227, below the frozen `974034` activation. Enforced v8 mint validation was exercised through the indexer admin seam, which starts its first block at `974034`; the on-chain runs exercised v8 crossings, which are not height-gated.
- The grandfathered v7 sat was not reproducible on regtest; it is covered by the Rust/JS golden and params tests.

## 2026-10-31 — iOS 15 Safari: music on, volume 55%, no sound

**Reported:** On Safari for iOS 15 everything worked except the soundtrack. SOUND was ON and VOLUME read 55%, but no music played.

**Build:** `hopper-v7-3-19`, commit `ab4bbb7` (initial unlock fix in `51f6cb2`).

### Root causes

iOS applies much stricter Web Audio gesture rules than desktop Safari/Chrome. Several code paths could leave a valid player silent:

1. **The context was created on `touchstart`/`pointerdown`.** iOS reliably unlocks audio only from a completed tap. The boot splash also hides on `pointerdown`, so the first tap could create the context on `touchstart` and then produce no `click` on the removed splash.
2. **No source was started inside the gesture.** Some iOS versions mark the context running but keep the audio session silent until a buffer source actually starts within a user gesture.
3. **A refused resume poisoned the context.** `_resume()` swallowed `NotAllowedError` and every later gesture only retried the same blocked context. It was never rebuilt.
4. **`resume()` was skipped when Safari reported `running`.** After a call, lock, or audio-session interruption iOS can report `running` while output is inactive. The old code resumed only for `suspended`/`interrupted`.
5. The iOS back/forward cache did not always fire `visibilitychange`, so a restored page had no resume attempt.

### Fix

- `web/js/sound.js`
  - `arm()` now counts completed gestures, force-resumes every time, and starts a **silent buffer source directly to `destination`** inside the gesture (bypassing mute/fader) to unlock the audio session.
  - A context whose `resume()` was refused, or that is `closed`, is discarded and rebuilt on the next completed gesture. Replacing a context also clears the old transport and resets the score clock.
  - Graph construction is guarded; failures leave an inert player, not an app exception.
  - `visibilitychange` and `pageshow` resume and restart the transport; hidden pages clear the unlock and suspend.
  - `status()` now reports `unlocked`, `gestures`, `rate` and `resumeError` alongside the existing state.
- `web/js/main.js`
  - Audio arms on **`touchend`, `pointerup`, `click` and `keydown`**, not `touchstart`/`pointerdown`. Mouse only keeps the early `pointerdown` path.
- `web/tests/media.test.mjs`
  - Fake AudioContext coverage for resume + silent source, refused-resume rebuilding, and the mute floor.
- `web/tests/e2e.mjs`
  - A real CDP touch on the first screen must produce a running 48 kHz context, an unlock, 7,635 loaded notes and a live transport.
- `README.md`
  - Documents the completed-tap rule and the iOS Ring/Silent switch.

### Verification

- Full `npm test`: media **48** checks; core 136, game ok, emergency 103, params 7, scan 94, ord 46, ui 102, fees 19, preview 87, localmint 40, chainfrog 45, history 134, rbf 125; v7 fold sync/parity/doc boot pass.
- Browser E2E with a real touch: `sound at boot: { armed: true, unlocked: true, state: 'running', rate: 48000, notes: 7635, timer: true, resumeError: '' }`; `console errors: none`; `e2e: ok`.
- Not reproduced on iOS hardware in this environment. The changes cover the iOS Web Audio gesture and poisoned-context failure modes.

### If it is still silent

If Settings/drawer says `♪ PLAYING · 7635 NOTES` after this update, the player is running. iOS also mutes WebAudio with the hardware **Ring/Silent switch**; check that switch and the hardware volume. If the line says `SUSPENDED` or shows a `resumeError`, report that exact line.

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


## 2026-10-31 — A settled HOP still occupied The Road

**Reported:** Satoshi Hoppamoto still showed `ON THE ROAD` with no HOP button after the crossing had more than six confirmations.

**Build:** `hopper-v7-3-12`.

### On-chain check

At tip `973992`, the state address contained three transactions:

- TRAVEL `dba210eb…efe710`, height `973900`.
- First HOP `544c2178…253510`, height `973933`, STRAIGHT, settled `973939`.
- Second HOP `5c9fb798…484130`, height `973982`, RIGHT, settled `973988`.

Block `973983` (for the second HOP) wrapped `0`, so RIGHT survived. The correct state at tip `973992` is `idle`, `dist = 2`, `in_flight = null`.

### Root cause

The state-address replay was correct, but the local road projection was not. `WalletSession._localRoadEntries()` treated **every** local `kind: 'cross'` action within 144 blocks as an in-flight crossing whenever the frog record was `idle`. The replay had already advanced the frog to `idle`/`dist 2` and cleared `in_flight`, so the frog was eligible for the picker, but the stale local action re-added a synthetic road row with `height: null`. Both `WalletSession.road()` and `screens.road()` call this projection, and `screens.road()` excludes every sat that appears on the road from `Choose a direction`. The settled Hopper therefore stayed labelled `ON THE ROAD` / `in mempool`, and the direction picker—with the HOP action—stayed hidden. The indexer/envelope was not involved.

### Fix

- `web/js/wallet/chainfrog.js`
  - Each replayed `cross` action now carries `settled`, `settle_height`, `outcome` and `mempool`.
  - A crossing is `settled: true` only once `T+6 <= tip`; an in-flight confirmed HOP is `settled: false`; a mempool HOP is `settled: false, mempool: true`.
- `web/js/wallet/wallet.js`
  - A locally broadcast HOP starts as `settled: false`.
  - `_upsertChainActions()` copies the settled/mempool fields onto an existing local action instead of duplicating it.
  - `_localRoadEntries()` skips `settled: true`. The settled HOP remains in History and the road log, but no longer occupies the in-flight grid or hides the picker.
  - In demo mode, where there is no state-address replay, a local HOP is released once its deterministic `T+6` height is reached.
- `web/tests/chainfrog.test.mjs` now 45 checks:
  - settled HOP is marked with `settle_height = T+6`;
  - in-flight and mempool HOPs are not settled;
  - a wallet replay produces an empty `_localRoadEntries()`;
  - an unsettled action still produces a road row.
- `web/tests/ui.test.mjs` now 66 checks:
  - settled action produces no local row;
  - `screens.road()` restores `Choose a direction` and the frog card, without `ON THE ROAD`.

### Verification

- Actual mainnet replay at tip `973992`: `state idle`, `dist 2`, `in_flight null`; `_localRoadEntries()` `[]`; `road()` `[]`.
- Full `npm test` passes, including chainfrog 45 and ui 66.
- Fresh-profile browser E2E passes; cache `hopper-v7-3-12`; no console errors.
  - After demo settlement, The Road shows `Choose a direction` and `Test Hopper` with `🚦 HOP`, not an in-flight row.
  - Log: `~/AI/regtest-last-change/logs/e2e-v7-3-12.log`.

### Deploy

- Commit `55f85b2` — “Release a settled Hopper from The Road”.
- Fast-forwarded `master` and `last_change`; pushed both.
- GitHub Pages run `41216753240` completed successfully.
- Live check: build `hopper-v7-3-12`, service-worker controlled, only cache `hopper-v7-3-12`, params intact, no console errors.
- Reload once to activate the new service-worker cache.

### Known limitation

Live mode hides a local road row only after the state-address replay has marked it settled. If the backend is unreachable, the wallet keeps the last projected row rather than claiming a settlement it cannot verify. Demo mode uses its deterministic six-block settlement.

## 2026-10-31 — The boot splash restarted in a short reload loop

**Reported:** The loading screen crashed and looped a few times before the app loaded.

**Build:** fixed in `1f0a973`, cache/build `hopper-v7-3-14`.

### Root causes

1. **A fresh load reloaded itself even though it was already current.** `build-guard` treated a missing cache as a reason to reload, and its check only asked whether the cache **key** existed. `caches.open(VERSION)` creates that key at the start of the install, before a single shell file is cached, so the guard could reload halfway through its own precache.
2. **Two independent reload paths ran on the same update.** `main.js` reloaded on every `controllerchange`, while `build-guard` could also call `location.replace`. A new worker taking control and the guard's own reload could both navigate the tab.
3. **Each navigation restarted the 2.8-second boot intro.** The splash has no idea why the page loaded, so a reload caused by an update looked exactly like the splash crashing and starting over.
4. **Reload suppression was not authoritative.** The one-shot flag was checked after the cache check in one path, so a stale page with a complete new cache could reload again on every navigation. The flag also lived only in `sessionStorage`, which private mode can deny.
5. **An intro canvas error could leave the splash permanently visible.** `drawIntro` ran inside the animation frame without a `try/catch`; if it threw, no further frame was scheduled and `#intro` was never hidden.

### Fix

- `web/js/build-guard.js`
  - Reads the deployed `sw.js` version **and** its complete `SHELL` list.
  - `cacheComplete()` verifies every shell file with `cache.match()`, instead of trusting the cache key.
  - If the running `BUILD` equals the deployed version, it only registers the worker to fill the cache in the background. It never reloads a current page.
  - If the running build is stale, it waits for the complete cache, then reloads **once**. The one-shot flag is checked before the cache check, so a stale page plus a complete cache cannot spin.
  - The reload URL carries `guard=1` as well as `build=<version>`. That attempt marker survives the navigation even when `sessionStorage` is unavailable.
  - The automatic reload records `hopper.introSkip` before navigating.
  - `HOPPER_REPAIR` uses the same guard marker.
- `web/js/main.js`
  - Removed the `controllerchange` reload. `build-guard` owns shell updates; a worker taking control no longer restarts the app.
  - `consumeIntroSkip()` honours the guard marker or a stale `?build=` query, removes `build`, `guard` and `repair` from the URL, and skips the splash.
  - `beginBootIntro()` renders the app directly when the load came from an update.
- `web/js/ui/tour.js`
  - A `drawIntro` exception now logs and calls `finish(false)`, so a canvas failure cannot leave the splash covering the app.
- `web/tests/e2e.mjs`
  - Records main-frame navigations and asserts a fresh boot performs exactly one.
  - Loads `?build=hopper-v7-3-0`, then asserts the splash is hidden, the query is cleaned, and no extra navigation occurred.

### Verification

- Fresh local profile, first load: exactly one `Page.frameNavigated`, `HOPPER_BUILD = hopper-v7-3-14`, controller present, cache 54 files, no build-guard flag.
- Same-profile reload: exactly one navigation; cache remains `hopper-v7-3-14`.
- Deliberately stale `build-guard` with a complete `hopper-v7-3-14` cache and `BUILD = hopper-v7-3-13`: exactly initial load + one guarded reload, then it stops. The `guard=1` query prevented a third navigation.
- Fresh-profile browser E2E passed:
  - `boot navigations: [ 'http://127.0.0.1:8130/' ]`
  - `stale build boot: { introHidden: true, search: '', build: 'hopper-v7-3-14', rules: true }`
  - `console errors: none`, `e2e: ok`.
- Full `npm test` passed: core 136, game ok, emergency 103, params 7, media 40, scan 94, ord 46, ui 66, fees 19, preview 87, localmint 40, chainfrog 45, history 134, rbf 125; v7 fold sync/parity/doc boot pass.
- Live after deployment:
  - First load and one manual reload each performed exactly one navigation.
  - Build `hopper-v7-3-14`, service-worker controlled, only cache `hopper-v7-3-14`, 54 cached files, no guard flag.
  - Params, mempool default, Settings download/spend controls and rules text verified.
  - No console errors.

### Deploy

- Commit `1f0a973` — “Stop a shell update from replaying the boot screen”.
- Fast-forwarded `master` and `last_change`; pushed both.
- GitHub Pages run `41218968278` completed successfully.
- Live build `hopper-v7-3-14`.
- Reload once to activate the new service-worker cache. The update itself no longer replays the splash or loops.

### Known limitation

If a CDN edge or the browser's HTTP cache keeps serving an old `build-guard.js` after a deploy, the new guard refuses a second automatic reload in that tab instead of spinning. The old page keeps working; the next navigation (or **RELOAD THE APP** / DevTools → Service Workers → Unregister) picks up the new shell. A genuinely unreachable cache cannot be updated offline.

## 2026-10-31 — A chain scan updated the ledger but not every live screen

**Reported:** check that nothing the wallet learns from a chain scan is left
un-rendered.

**Build:** fixed in `7f16a57`, cache/build `hopper-v7-3-15`.

### What was wrong

`WalletSession.refresh()` correctly dispatched `hopper:refresh` after a pass,
but the UI listener used a hand-written view allowlist and each view decided
for itself when to fetch remote rows.

1. **BIO was not in the repaint allowlist.** A scan that added a HOP or a
   settlement updated History, the pond and the wallet, but an open BIO view
   kept its old timeline until the user navigated away and back.
2. **MINT was not in the allowlist.** A scan that discovered a funding coin
   left `MINT!` disabled and the “no tracked coin” notice on screen. A scan
   that spent it left the button enabled. The target/next-rise schedule also
   stayed at the old tip. A full re-render was not acceptable because it would
   wipe the name and focus the user was editing.
3. **SETTINGS refreshed only its scan panel.** The AUTO RECOVERY PACKS summary
   is written by the same scan, so it could stay stale for the whole visit.
4. **THE ROAD used `app.road` from when the view opened.** A scan can rebuild
   an in-flight crossing from state-address history (`frog.in_flight`), but
   `screens.road()` merged only `app.road` and local actions. A restored
   crossing could therefore disappear from the Road until the next navigation
   refetched it.
5. **LEADERBOARD rows were rendered but never refetched.** A newly owned Hopper
   could remain without its YOU marker.
6. **A send sheet and the graveyard were static overlays.** The send sheet’s
   spendable line and the graveyard list could stay stale while the underlying
   wallet updated.
7. **A missed public-record fetch blanked a visible frog.** The scan-triggered
   `ensureFrogRecord()` assigned `app.frogRecord = null` on a miss, replacing a
   record that was already on screen.
8. **BIO could use the wrong `frogRecord`.** Its fallback did not check the
   record’s sat, so a record left over from another frog could appear at a new
   URL. The `bio`/`detail` handlers had the same issue.
9. **The ON ROAD refusal text never cleared.** After the crossing settled, the
   wallet/pond kept warning that sending would retreat a crossing that no
   longer existed.
10. **The graveyard overlay stayed over the route it opened.** Choosing a dead
    Hopper navigated to BIO underneath, but the overlay was left covering the
    page.

### Fix

- Added `screens.scanRefreshMode()` as the single repaint policy:
  - `render`: WALLET, THE POND, HISTORY
  - `data`: THE ROAD, LEADERBOARD, Hopper detail, BIO — render, then refetch
  - `mint`: targeted in-place MINT update
  - `settings`: targeted scan/recovery update
  - `defer`: a foreground `run()` is active and will render in its `finally`
  - `none`: no wallet behind the lock screen
- BIO is now repainted and its record refreshed.
- `mintLive()` / `refreshMintLive()` update the funding coin, MINT button,
  no-coin notice, next target and next rise without rebuilding the form, so
  the seed/name and focus survive.
- SETTINGS updates `scanPanel` and `recoverySummaryText()` in place.
- THE ROAD now merges `w.frogs[].in_flight` even when `app.road` is empty or
  older; the view then refetches the remote rows after the render.
- LEADERBOARD refetches its remote rows after a scan; the YOU marker follows
  the current frog set.
- The send sheet’s spendable line updates in place. An open graveyard overlay
  is rebuilt from the current frog list. Signed previews and exported
  emergency/recovery documents remain frozen snapshots by design.
- `ensureFrogRecord()` keeps the existing record when a public fetch misses.
- `screens.bio()` and the `bio`/`detail` handlers ignore a `frogRecord` whose
  sat does not match the route.
- `render()` clears a stale `frogRefusal` once no frog is crossing, and
  `openFrog`/`bio`/`detail` dismiss the overlay before navigating.

### Verification

- Full `npm test` passed: core 136, game ok, emergency 103, params 7,
  media 40, scan 94, ord 46, ui 91 (was 66), fees 19, preview 87, localmint 40,
  chainfrog 45, history 134, rbf 125; v7 fold sync/parity/doc boot pass.
- New UI checks cover the refresh policy, live MINT funding/schedule, a
  chain-replayed crossing reaching THE ROAD with an empty `app.road`, the
  recovery line, the send-sheet marker, the graveyard marker, and a
  wrong-sat BIO fallback.
- Fresh-profile E2E passed at 800×600 with `console errors: none` and
  `e2e: ok`. New assertions:
  - `scan repaint: bio repainted`
  - `scan repaint: settings recovery 1 saved pack · …`
  - `scan repaint: mint { probe: 'keep', name: 'SCAN DRAFT', focused: true, disabled: false }`
  - `scan repaint: send sheet Spendable: 3,166,208 sats…`
  - `scan repaint: graveyard refreshed`
  - graveyard → BIO closes the overlay before showing the route.
  - A fresh boot still performs exactly one navigation; the stale `?build=`
    boot still skips the splash and cleans the query.
- Live after deployment (`hopper-v7-3-15`):
  - first load and one manual reload each performed exactly one navigation;
  - only cache `hopper-v7-3-15`, 54 cached files, no build-guard flag;
  - params hash `d466f8db…cf72f`, genesis 974,034, mempool.space default,
    Settings controls and THE TOLL text intact; no console errors.

### Deploy

- Commit `7f16a57` — “Repaint every live view after a chain scan”.
- Fast-forwarded `master` and `last_change`; pushed both.
- GitHub Pages run `41225116541` completed successfully.
- Live build `hopper-v7-3-15`. Reload once to replace the v14 shell cache.

### Known limits

- A signed transaction preview, HOP review, emergency document and recovery
  export are intentionally immutable snapshots. Approving a transaction
  revalidates its inputs and HOP leaf before broadcast; it does not silently
  rewrite bytes under the user.
- THE ROAD and LEADERBOARD still need their remote fetch to succeed for remote
  rows. When it does not, the wallet’s own chain-replayed crossings, local
  actions, pond and balance still render; the stale remote row is retried on
  the next scan.
- Background scans are paused in a hidden tab; returning to the foreground
  wakes one and then repaints through the same path.

## 2026-10-31 — security audit remediation and v8 cutover

### Scope

Implemented the findings in `SECURITY_AUDIT_FEEDBACK.md` on `master`, with
the audit's `MODEL:`/`DECISION:` notes applied. The protocol is now v8
(`0x08`); exactly one released v7 Hopper is grandfathered by the global
`GRANDFATHERED_SAT` value, now set to `1_965_983_893_977_665`.

### Fixes

- **F-01 / F-02:** every action requires complete, value-matched ordinal
  ranges; builders compute the FIFO destination of the Hopper sat and every
  protected sat and refuse a transfer/SEND that would pay it to fees or a
  non-recipient output. Unknown-ranged mempool coins are no longer SEND
  funding. Approval repeats the proof against the exact signed bytes.
- **F-03:** `taprootTweakedKey` now performs BIP86 even-Y normalization. The
  released odd-Y path is retained for recovery (`legacyOrd`,
  `legacyFrogAddress`) and an explicit `migrateLegacyFrog` transfer; new
  outputs never use it.
- **F-04:** the signed commit/reveal package is persisted before the commit
  is broadcast, marked accepted/ rejected, and exposed through
  `pendingMintPackages()`, `retryPendingMint()`, and `refundPendingMint()`
  (key-path refund without revealing the mint leaf).
- **F-05:** v8 crossing envelopes are proof-checked by the fold. The fold
  reads `/r/tx/{txid}`, requires the canonical input-0 leaf/control path,
  one envelope/no pointer, P2TR output 0, finality spacing, unique
  transaction ids, and `meta.sat == frog.sat`. A missing/failed proof
  renders `unverified`, never a count or HOME. The v7 card's embedded fold
  remains frozen for the one grandfather; the v8 app/indexer is the
  authoritative view.
- **F-06:** `frogTxRole` only accepts input 0 with one canonical leaf and the
  expected parent; `replayFrogChain` requires the crossing to spend a known
  prior state outpoint, enforces finality spacing, and refuses incomplete
  histories. Output-only deposits and body-only funding inputs are not
  crossings.
- **F-07:** state-script discovery no longer invents `[[sat, sat]]`; it asks
  for complete ranges, checks value/sat containment, and leaves the coin
  unspendable/unverified otherwise. `parseLocalMint` verifies the claimed
  sat is the first sat of the value-matched reveal output.
- **F-08:** HOP/PREPARE/TRANSFER/SEND/MINT all revalidate funding coins and
  repeat the FIFO proof at approval; HOP is no longer exempt.
- **F-09:** activation is frozen at `974_034`; an unset/modified
  `HOPPER_ACTIVATION_HEIGHT` or `HOPPER_INSCRIPTION_ACTIVATION_HEIGHT`
  refuses to boot. RPC ingest preserves ord pointer, envelope count and
  validity flags; mints/crossings reject pointers, multiple envelopes, and
  invalid envelopes.
- **F-10:** Esplora history paginates through `/txs/chain/:after_txid` to
  exhaustion; local mint history is no longer capped at 50; deep indexer
  discovery walks every page instead of the first 300 frogs.
- **F-11:** vault creation writes, reads back, and verifies the ciphertext;
  storage denial is an error. Refresh summaries no longer include private
  keys.
- **F-12:** scan gates and outcome-hash caches are keyed by tip hash as well
  as height; a same-height reorg forces a fresh pass, and the tip hash is
  persisted with the scan gate.
- **F-13:** ord/indexer UTXO answers must agree on value and ranges; ord is
  canonical. A configured indexer that does not answer the params gate, or
  reports another network, blocks signing.
- **F-14:** public reads have a per-caller fixed-window rate limit (default
  300/min); no state lock is held across the ord lookup.

### Verification

- `npm test`: core 142, game ok, emergency 103, params 9, media 48, scan 98,
  ord 50, ui 102, fees 19, preview 100, localmint 40, chainfrog 47,
  history 134, rbf 125; v8 fold sync/parity/doc boot pass.
- `cargo test --workspace`: all workspace tests pass, including the new
  pointer/multiplicity rejection and v8 golden/vector tests.
- The new v8 boot fixture builds a real canonical state leaf/control block
  and raw transaction; the fold's proof path accepts it and refuses the
  duplicate/incomplete cases.

### Known limits

- The one grandfathered Hopper's **inscribed v7 card art** cannot be
  rewritten; it predates the proof-checking fold. Custody/play and the
  app/indexer view are grandfathered; the old card is not an authoritative
  art oracle.
- Funding-input Hopper mixing still cannot be fully proven from raw tx
  alone without a sat-range oracle; the indexer remains the leaderboard
  authority.
- The BIP84 receive script remains fixed at `…/0/0` in v8 by deliberate
  design; address rotation is a future wallet feature, not a consensus rule.

### Deploy

- Commit `8ab84eb` — “Harden the protocol for v8 and implement the security audit fixes”.
- Fast-forwarded and pushed `master` and `last_change`.
- GitHub Pages run `41256158186` completed successfully.
- Live `hopper-v8-0-0` E2E passed: no console errors, account/recovery/history
  routes intact, and the stale-build boot reported `hopper-v8-0-0`.

### Grandfathered sat set

- `GRANDFATHERED_SAT` is now `1_965_983_893_977_665` in both
  `rust/crates/hopper-core/src/params.rs` and `web/js/core/params.js`.
- New v8 mint documents embed `grandfatheredSat:1965983893977665,`.
- Cache/build bumped to `hopper-v8-0-1` so installed shells pick it up.
- Commit `e70f131`; GitHub Pages run `41257267210` succeeded.
- Live E2E on `hopper-v8-0-1`: one boot navigation, no console errors.
