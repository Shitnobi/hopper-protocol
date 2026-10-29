# frogger-indexer — B1+B2 design notes

Status: **pure core complete** (Workstream B phases B1+B2 as scoped for
this build). Network ingest (ZMQ), Postgres persistence, REST/WS API,
mempool preview, and art endpoints are later phases (B3/B4) and are
deliberately absent — this crate must build with only `frogger-core` and
`serde`.

## Architecture

```
Indexer
├── config: IndexerConfig { activation_height: H₀ }        (SPEC §2, §8.2.7)
├── seeds: Vec<(OutPoint, Vec<SatRange>)>                   chain-layer bootstrap
├── chain: Vec<Block>                                       retained best chain
├── state: IndexState                                       derived, never patched
│   ├── frogs: BTreeMap<sat, FroggerRecord>
│   ├── crossings: BTreeMap<sat, Crossing>                  active (phases 0–3)
│   ├── history: Vec<FinishedCrossing>                      terminal crossings
│   └── tracker: SatTracker                                 UTXO set + locations
└── event_log: Vec<ChainEvent>                              flattened, published
```

`IndexState` is **only ever constructed by replaying blocks**. That is the
load-bearing design decision: it makes the SPEC §8.1.4 re-derivation
invariant trivially true and makes reorg handling exact.

## Key design decisions

1. **Reorg rollback = truncate + full replay** (SPEC §8.1.4, §11).
   `rollback(n)` truncates the retained chain and rebuilds state by
   replaying from genesis (seeds re-applied first). O(chain) per rollback
   is unacceptable for mainnet; the DB layer (B1-later) will add
   checkpoint/snapshot restore. Correctness first, then speed.

2. **Shadow sats for untracked inputs** (`sat_track::SHADOW_BASE`).
   An indexer started at H₀ cannot know pre-activation UTXOs, but a
   frogger's anchor UTXO is routinely spent *with* untracked fee-funding
   inputs (sticky-UTXO wallets, SPEC §9.4), and FIFO positioning depends
   on those inputs' *values*. Each untracked input is represented by a
   synthetic range at ordinals ≥ 2^60 (real sats are < 2^52), so tracked
   sats land in the right outputs while never being confusable with real
   ordinals. Consequence: a MINT whose output 0 is funded entirely by
   untracked inputs is rejected (`MintAnchorUntracked`) because the
   frogger ID would be unknowable. Tracking from genesis is not enough
   on its own because the coinbase subsidy is deliberately unmodelled
   (decision 3); the API can seed a coin from ord on the wallet's first
   `/v1/utxo` question (`HOPPER_ORD_URL`), or an operator can supply a
   `HOPPER_SEEDS_FILE` / `/v1/admin/seed` entry.

3. **Fee-paid anchor sats are "Burned", not coinbase-tracked.** `ord`
   assigns fee sats into the block's coinbase outputs; modeling that
   exactly requires subsidy math plus a coinbase-exception in the block
   model, and nothing in the protocol depends on it. A frog whose anchor
   sat flows to fees keeps its protocol state (crossings settle on
   schedule) but its location becomes untracked. Known gap; revisit if
   the art/API layer needs to locate burned frogs.

4. **"Spender = current owner" is enforced by Bitcoin itself** (SPEC
   §8.1.2 CROSS row). Spending the anchor-sat UTXO requires the key that
   controls it, so the indexer only checks that the CROSS tx spends that
   UTXO — no address indexing needed. Same-tx rule: a tx that spends the
   anchor UTXO and carries the valid CROSS envelope *is* the crossing
   (phase 0); any other spend is a §6 movement.

5. **Intra-block ordering = tx order, movement before envelope.** Per
   SPEC §6's ordering edge, CARs and movements are resolved by tx index.
   Within a single tx, the (inherent) input spending is applied first, so
   a tx that both moves a pre-CAR frog and carries its CAR is a retreat
   with an ignored CAR. A tx with >1 FRG envelope has its *envelopes*
   ignored in full (§8.2.5) — its movements still apply, because
   movements derive from the chain, not from envelopes.

6. **Phase bookkeeping** (SPEC §5): `CommitF` exists only during the
   CROSS block and flips to `CarWindow` at end-of-block (a same-block CAR
   is rejected `CarOutsideWindow`, which is correct — CARs are valid only
   at T+1…T+6). The anchor block B = U+1 is recorded when that block is
   applied; reveals are then valid at B+1…B+6 strictly (§8.2.1). A
   crossing in `Anchor` phase where the winning CAR moved the frog is a
   *pending-gamble transfer* (§6.2) — the crossing continues with the new
   holder, and the original committer may still reveal (REVEAL touches no
   frogger UTXO).

7. **Settlement applies immediately; finality is bookkeeping.** When both
   parties are resolved (both revealed — settles early — or the reveal
   window expired), the frog's state updates at once (Dead / dist+1 →
   Idle-or-Home / Void → Idle) and the finished crossing is kept in
   history with `end_height`. `FinishedCrossing::final_at(h)` marks
   provisional-until-`FINALITY_DEPTH` (§8.1.4). Since reorgs re-derive by
   replay, pre-finality outcomes change automatically if the chain does.
   `FINALITY_DEPTH` is defined here (6) because frozen `frogger-core`
   does not export it.

8. **Settlement math is 100% delegated to frozen `frogger-core`**
   (`settle_crossing`, `reveal_matches`, `decode`, `satmath`), satisfying
   §8.2.2/§8.2.3 by construction — this crate never reimplements
   commitment, substitution, threshold, or sat-flow logic.

9. **Serde boundary.** The published event log (`ChainEvent`) and chain
   model are serde-serializable. Core enums (`Outcome`, `RevealRole`)
   carry no serde derives (frozen crate), so `SettleOutcome` /
   `RevealedRole` mirror them with `From` conversions. Internal state
   types are not serialized (DB layer will define its own schema).

10. **Rejections are data, not errors.** Hostile/malformed input never
    panics and never fails `apply_block`; it produces `Rejection` entries
    (useful for tests, metrics, and the future API). `IndexerError` is
    reserved for API misuse (non-contiguous heights, too-deep rollback).

## Invariants (all tested)

- State is a pure function of `(config, seeds, chain)`: identical inputs
  ⇒ identical frogs/crossings/history/event log, including after
  rollback-and-replay.
- DEAD and HOME are absorbing; `dist ≤ HOME_DIST` (clamped); sats are
  never re-mintable (frogs map is append-only keyed by sat).
- At most one active crossing per frog; at most one reveal per role per
  crossing; settlement happens exactly once per crossing.
- Reveal window strictly `> height(B)` (rejected pre-anchor, in the CAR
  block, and in the anchor block itself).
- Both-stall ⇒ VOID; a single stall settles via core substitution.
- CAR validity is heights T+1…T+6, first-in-block-order wins; no CAR by
  end of T+6 ⇒ unopposed `dist += 1`.
- Every envelope rejection in the SPEC §8.1.2 table has a corresponding
  `RejectionReason` and a unit test.
- No arithmetic panics anywhere in the block/tip height space: window
  checks use saturating adds, the next-block height uses `checked_add`
  (`IndexerError::HeightOverflow`), and end-of-block anchor recording
  uses `checked_add` so a CAR confirming in the block at `u32::MAX`
  simply never anchors (tested).

## Known gaps / deferred work

- **Mempool preview** (B4): unconfirmed envelopes never happened (SPEC
  §11); a preview layer would sit *beside* this core, never inside it.
- **Persistence** (B1-DB): everything is in memory; the event log is the
  artifact to persist, keyed `(block_hash, txid, action)` per §8.1.4.
- **Coinbase / subsidy / ord-exact fee assignment** — see decision 3.
- **Retention and snapshots are O(chain), unbounded.** `Indexer` keeps
  every retained `Block` (with all inputs/outputs) for exact reorg
  replay, `event_log` keeps every event, and `SnapshotStore` serializes
  the whole chain as JSON every N blocks. Measured with
  `examples/ingest_bench` (100-tx blocks): ~26–43 KiB JSON per block
  (≈0.3–0.4 KiB per tx), and ~125 KiB RSS per block including derived
  state. At mainnet block sizes that is hundreds of GB of JSON and RAM
  for a full activation→tip history, and each snapshot write costs
  O(chain) (cumulative O(chain²/N)). **Recommended next step:** persist
  derived state (frogs/crossings/history/tracker UTXOs/locations) plus
  a bounded recent-block window for reorg replay, or per-block undo
  logs; keep the replay-based snapshot only for small deployments.
- **Rollback is a full replay.** `Indexer::rollback(n)` rebuilds state
  from the seeds through the entire retained chain regardless of `n`
  (measured ~74 ms for 220 blocks at 10k froggers; ≈100 s at 300k
  blocks). Same fix as above (checkpoints/undo data); correctness is
  pinned by tests, and `sync_to_tip` already returns DeepFork rather
  than guessing when a fork is below the retained chain.

- **Block model**: requires input prevout *values* (for shadow
  positioning); the ingest layer must supply them (`getrawtransaction`
  prevouts / ZMQ rawtx + UTXO lookup). No script/address validation.
- **No wallet-facing query API / art endpoints** (B3): the accessors on
  `Indexer` are the seam.

### Performance (audited, CP 59)

`examples/ingest_bench` (20k noise txs; per-tx steady-state cost):

| froggers | before | after |
|---------:|-------:|------:|
| 100      | 0.9 µs | ~1.0 µs |
| 1,000    | 5.3 µs | ~1.2 µs |
| 10,000   | 50.5 µs| ~1.9 µs |

The old cost was a per-transaction scan of every frogger location
(`SatTracker::locations`) to find anchors the tx spends — quadratic in
chain size. Fixed with a reverse index (`utxos → frogger sats`), which
also made mint-heavy blocks 5–10× faster and replay cheaper (10k
froggers: 1254 ms → ~74 ms for a 220-block replay). The per-tx sat
assignment (`assign`) is now computed once; `locate_sat`/`anchor_sat`
recomputed it per frogger per tx. Envelope scanning no longer allocates
a Vec per transaction, `finished_crossings(sat)` is indexed instead of
scanning history (the API lists pages of froggers), and `Indexer` keeps
a block hash → height map so fork detection does not rebuild a set of
every retained hash on each sync. BTreeMaps everywhere: deterministic,
not fastest possible — but the asymptotic fix matters more than the
constant factor.

### Worst case: every block full of frog transactions (CP 60)

A frog tx (1 P2TR keypath input, a 46–47-byte OP_RETURN envelope, one
P2TR change output) weighs ~700 WU, so a 4M-WU block holds at most
**~5,714** of them (REVEAL/MINT envelopes are shorter: ~6,300). Same
protocol cap on envelopes (≤1 per tx) as everywhere else.
`examples/full_block_projection` runs 6,000/block (≈5% conservative),
all MINTs after the first cycle (crossings cannot re-cross before
settlement; mints are the unbounded state-growth path):

| metric | per block | per day | per month | per year |
|---|---:|---:|---:|---:|
| index CPU (apply_block) | 9.8 ms | 1.4 s | 42 s | 8.5 min |
| retained RAM (blocks + derived state) | 7.9 MiB | 1.1 GiB | 33 GiB | 406 GiB |
| snapshot JSON (linear in history) | 2.5 MiB | 360 MiB | 11 GiB | 128 GiB |
| event log entries | 6k | 0.86 M | 26 M | 315 M |
| txs indexed | 6k | 0.86 M | 26 M | 315 M |

**CPU is a non-issue**: ~10 ms per 600 s block (<0.2% of one core),
1.6 µs/tx including envelope decode, sat assignment, crossing logic,
events, and the per-block crossing scan. A full year of full blocks
replays in ~8.5 minutes; a fresh indexer would keep up trivially.

**Retention is the wall** (see the section above — this is why the
fixes matter):
- `snapshot()` + `serde_json::to_vec` hold **three** copies at once
  (live chain, `to_vec` clone, JSON buffer) ≈ 18.3 MiB/block, so a host
  runs out of memory after **~6 days (16 GiB), ~12 days (32 GiB),
  ~25 days (64 GiB)** of full blocks.
- Snapshotting every block rewrites the whole history each time:
  ~**3.3 PiB** written in year 1 (and the final write is ~128 GiB every
  10 minutes, needing that much RAM for `to_vec` alone).
- `rollback(n)` / `restore` replay the whole chain: one reorg costs
  ~42 s after a month, **~8.5 min after a year** (and restore must parse
  the snapshot first).
- Even with chain retention removed, derived state (frogs, UTXOs, sat
  locations, events, finished crossings) is ~0.45 KiB/tx → ~390 MiB/day
  (~140 GiB/year) unless the event log is bounded.

Conclusion: at full-frog-block density, the replay-snapshot design caps
deployment lifetime at days-to-weeks regardless of CPU. The
state-checkpoint / bounded-window redesign noted above is a
prerequisite for scaling, not an optimization.

## Open questions for reviewers

1. `MintAnchorUntracked`: should a chain layer that tracks full history
   make this rejection impossible in practice, or should we define a
   canonical "tracker genesis" so all indexers agree on which mints are
   valid? (Divergence here = indexer disagreement, which SPEC §9.3 says
   wallets must tolerate via self-verification.)
2. Burn semantics: is keeping protocol state (settlements still resolve)
   for fee-burned frogs the right call, or should burns freeze the frog?
   SPEC is silent; current choice preserves "no punishment for user
   error" (§1.4).
3. `ChainEvent.txid` is `Option` (None for block-level events: anchor
   recording, window expiry, expiry settlements). Is that acceptable for
   the published log format, or should block-level events key on the
   coinbase txid / zero hash for a uniform 3-tuple?
4. Should unopposed crossings count `dist` at end of block T+6 (current)
   or lazily at first query? Current choice keeps state a pure function
   of the chain with no time dependence.
5. `shadow_range` uses slot stride 2^52 and silently degrades on u64
   overflow (>~3800 untracked inputs in one tx). Acceptable?
