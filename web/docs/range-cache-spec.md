# Range-cache query logic — specification

Status: **proposal** (client-side only; no protocol change).
Target: `web/js/wallet/wallet.js` pass loop + ledger persistence; `OrdClient` unchanged.
Author: session 2026-11-19.

## 1. Problem

The chain is asked one question per pass: *what are the sat ranges of this
outpoint?* (`/r/utxo/:txid:vout` on `ord`). That answer is re-requested every
pass, for every unspent output, forever — and a new block triggers three
passes (initial + two index rechecks), so the cost is `3 × U` ord requests
per block for `U` coins.

That is wasteful, because the answer is **immutable for a fixed outpoint**.

## 2. The invariant this rests on

> For a given `(txid, vout)`, the set of sats that output holds is a pure
> function of the transaction's inputs, and the txid commits to those inputs.
> Therefore `sat_ranges(txid:vout)` never changes — not on confirmation, not
> on reorg, not on re-mining. It changes only if the outpoint ceases to exist
> (spent / never mined), in which case it is dropped from the live UTXO set.

Consequences:

* A cached range answer is valid for the *lifetime of the outpoint*, across
  passes, reloads, reorgs and app restarts.
* The only invalidation event is **spend** (or a conflicting transaction
  replacing the tx, which destroys the outpoint, not its content).
* "Hasn't moved" ⇔ the same outpoint is still returned by the address query.

Footnote: keys are txids of non-coinbase transactions at heights that enforce
BIP34 (all mainnet/regtest heights HOPPER can see). Pre-BIP30 duplicate
coinbase txids are out of scope, as they are for every modern wallet.

## 3. Data model

A cache entry, keyed `"<txid>:<vout>"` (txid lower-case hex):

| field | meaning |
|---|---|
| `v` | output value in sats (must equal the explorer's value) |
| `r` | normalized **inclusive** `[[start, end], …]`, ordered, non-overlapping, sum `= v` |
| `a` | address the output was seen at (diagnostics + partial-pass pruning) |
| `t` | last-used wall clock (LRU) |
| `m` | consecutive misses (ord 404 / non-exact answers), for the retry ladder |

Entry states:

* **known** — entry above; usable without any network call.
* **unknown** — absent; must be asked once.
* **missed** — explorer says the outpoint is live, ord has no ranges yet
  (index lag); retried on a bounded ladder, never silently cached.
* **cooldown** — ord returned 429/403/5xx; **no** asks at all (existing
  `OrdClient` behaviour), and **no** cache writes.

Only *exact, verified* answers are stored: `sum(ranges) === value`, value
agrees with the explorer, ranges ordered. Carry-forward answers (a previous
pass's value copied because an ask failed) are explicitly **not** cacheable.

## 4. Pass algorithm

Per pass, after the Esplora `addressUtxos` answer for one watched address:

```
live  = [(txid, vout, value)]            // from the explorer, this pass
for u in live:
    e = cache.get(u.txid, u.vout)
    if e && e.v === u.value:  use e.r            // cache hit, 0 ord requests
    elif e && e.v != u.value: cache.drop(...);   // conflict → treat as unknown
                              queue(u)
    else:                     queue(u)           // unknown → ask once

spent = cached entries for this address not in live
if address query succeeded (pass not partial): drop(spent)
else: keep (absence is not evidence)              // existing rule, reused
```

Then drain `queue` through the ask budget (§6), each ask being the existing
`backend.utxo(txid, vout)` call with its 429 retry/cooldown semantics.

Pass-level summary, exposed for the SCAN panel and tests:

```
rangeCache: { live: U, hits: h, asked: k, queued: q, misses: m }
```

If `h === U` the pass makes **zero** ord requests — this is the normal steady
state, including both recheck passes at a new tip.

### 4.1 Set-diff correctness rules

1. **Never drop on a partial pass.** If `addressUtxos` threw for an address,
   or the pass was aborted/paused, keep every cached entry for that address.
   (Reuse `queriedOk` / `watchFailed` / `pausedMidPass`.)
2. **Drop on a complete pass.** An outpoint the explorer no longer lists is
   spent or replaced; its ranges can never be needed again. Dropping loses
   nothing: a reorg that re-mines the same tx re-creates the same outpoint,
   which is simply asked once more (cheap, rare).
3. **Value mismatch is a hard invalidation** (should be impossible for the
   same txid:vout; if an explorer is broken, re-ask rather than trust).
4. **Address changes need no special case.** Entries are global by outpoint;
   a new state script's outputs are simply unknown and asked once.
5. **Mempool outputs** are asked once and cached; if the tx is RBF'd away the
   outpoint disappears and the entry dies by rule 2. The replacement's
   outputs are new outpoints.

## 5. Cold start, reload, RESCAN

| event | ord requests |
|---|---|
| first ever pass (no cache) | `U` asks, throttled by §6 |
| reload / new session | `0` (`rangeCache` is in the vault ledger) |
| new block, settled wallet | `0` |
| new block with a mint reveal | `1` (the new reveal outpoint) |
| send / hop (change + recipient) | `1–2` (new change outpoint; recipient output isn't ours) |
| **RESCAN FROM CHAIN** | cache cleared → `U` asks, throttled |

RESCAN clears the cache by design: it is the user's "rebuild from chain"
escape hatch, and it is the only way to recover from local ledger corruption.
`settings.rangeCache === false` disables reads/writes entirely (rollback flag,
default on).

## 6. Ask budget (the part that guarantees conservatism)

Do not drain an unbounded queue in one pass. A token bucket per session,
public source only:

```
capacity   = 24 asks
refill     = 24 asks / 60 s
burst use  = min(queue.length, tokens)
scheduling = if queue remains after a pass, next pass in 10 s
             else normal cadence (idle 10 min / busy 30 s)
```

* Local node / indexer: no cap (your own infrastructure).
* Sustained ord asks are therefore **≤ 24/min = 0.4/s**, even for a wallet
  that suddenly holds 500 UTXOs (≈ 21 min to fill, in 24-ask tranches).
* Tokens are spent **only on real requests**: a cooldown-blocked ask, a
  cache hit or a 404 does not consume a token. A pass that begins during a
  cooldown makes zero ord calls and leaves the queue for later.
* Jitter the inter-ask delay ±25 % so 24 asks never leave as a burst.

Resulting worst-case ord profile: **0.4 requests/s sustained, 2 concurrent
(`mapLimit 2`), decaying to 0** once the backlog is filled. Idle remains 0.

## 7. Persistence

Added to the existing per-wallet ledger (`_saveLedger` / `_loadLedger`):

```json
"rangeCache": {
  "version": 1,
  "entries": { "ab12…:0": { "v": 1500, "r": [[1000, 2499]], "a": "bc1p…", "t": 1763000000000 } }
}
```

* Cap **4096 entries**, LRU by `t`; eviction is harmless (re-asked once).
* Loader ignores unknown fields and malformed entries; `version` mismatch
  clears the cache (fail-safe: clearing only costs asks).
* Cleared on: wallet wipe, network change in Settings, vault import of a
  different wallet, RESCAN.
* Size: ~90–120 B/entry → ≤ ~480 KB in localStorage. Consider a 2048 cap if
  that pressure matters; 4096 is the ceiling, not the target.
* Trust: the ledger is already the local source of truth for history, frogs
  and staged state. A tampered cache can only cause the wallet to *believe*
  a coin is range-exact; RESCAN rebuilds it, and coin selection re-verifies
  value + sum on every use. No remote attack surface is added.

## 8. Interaction with existing machinery

* **Tip gate / rechecks**: unchanged. Rechecks still re-ask Esplora (that is
  their purpose: a lagging address index); they now ask ord **nothing** for
  known outpoints — the `3 × U` → `0` win.
* **Cooldown ladder** (`OrdClient`): unchanged and still authoritative. Cache
  is a *read* optimisation; it cannot make the client ask during cooldown.
* **Carry-forward**: still exists, now only for genuinely new outpoints whose
  ask failed; it must never write to the cache.
* **`_txCache.clear()` per pass**: leave for now. The same immutability
  argument applies to `getTx`/`getTxHex` for confirmed txs, but status fields
  change, so it is a separate change (§11).
* **UI**: no new state. "Sats without ranges" still appears when a coin is
  unknown and the budget is exhausted or ord is cooling down — the same
  first-class display as today.

## 9. Request budget before / after

Per 10-minute block interval, public source, `U` coins, no new coins:

| | today | with range cache |
|---|---|---|
| ord `/r/utxo` | `3U` (3 passes × U) | **0** |
| Esplora | `3 × (2 + A)` | `3 × (2 + A)` (unchanged) |
| idle, no block | 2 | 2 |

`A` = watched addresses (ord, receive #0, change #0, + one per staged Hopper).
Cold start with `U = 100`: today `300` in ~3 s; with the cache `100` in
≈ 4.2 min at 24/min, then 0 forever.

## 10. Test matrix (all in `web/tests/scan.test.mjs`, FakeBackend counts asks)

1. Two passes, same live set → second pass: `asked === 0`, `hits === U`.
2. New outpoint appears → exactly 1 ask.
3. Outpoint spent on a complete pass → evicted; if it reappears → 1 ask.
4. Partial pass (`watchFailed`) with an absent outpoint → **not** evicted.
5. Explorer value ≠ cached value → evicted and re-asked.
6. 429 on a new outpoint → no cache write, existing cooldown, 0 further asks.
7. `ord 404` → no cache write; retried on the miss ladder; not re-asked
   during the same pass.
8. Save → reload session → 0 asks for live coins (persistence).
9. RESCAN → cache cleared → `U` asks (throttled).
10. Budget: 100 unknown coins → ≤ 24 asks in the first pass, remainder
    queued, next pass scheduled in 10 s; tokens refill over 60 s.
11. Rechecks at a new tip ask 0 ord calls for a settled wallet.
12. Cap/LRU: 4097 inserts → 4096 entries, oldest evicted; reload still parses.
13. `rangeCache: false` → behaves exactly like today (regression).
14. Mempool spend of a cached outpoint → evicted; replacement outputs asked.

## 11. Non-goals / follow-ups

* **Tx-hex cache**: `_txCache.clear()` each pass forces re-fetching history
  hex on cold/replay passes (measured: ~1 hex per history row per replay).
  Fix by caching immutable tx bodies keyed by txid with an LRU, separating
  status (`confirmed`, `block_height`) from content. Separate change.
* **Shared cache across wallets** on the same network: safe by the invariant,
  but unnecessary; per-wallet keeps wipes simple.
* **Server-side ord range index**: the indexer already returns ranges in its
  UTXO DTO; when an indexer is configured the cache is a no-op optimisation.

## 12. Rollout

1. Implement behind `settings.rangeCache` (default **on**), instrumented with
   the §4 counters surfaced in Settings → SCAN.
2. Run the 14 tests plus the existing 14 suites; run the regtest rig harness
   (`web/tests/rig/query-logic-e2e.mjs`) with a 20-coin wallet and assert
   `ord` requests per block stay at 0 after the first fill.
3. Ship; rollback is the flag or `git revert` — no protocol, storage-schema
   or UI-contract change.
