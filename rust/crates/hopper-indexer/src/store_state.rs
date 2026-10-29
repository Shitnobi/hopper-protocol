//! A consensus state backed by the durable store.
//!
//! [`StoreState`] keeps one block's worth of writes in an overlay and reads
//! through to [`RedbStore`]. Applying a block therefore never materialises
//! the whole state in memory: at most the keys the block touched are live,
//! and once the block commits the overlay is empty again. The in-memory
//! [`crate::state_machine::IndexState`] stays the oracle every test and the
//! wallet use.
//!
//! Reads inside a block see the overlay first, so read-after-write is
//! exact; reads outside a block see the store. Nothing here is I/O-free —
//! this module is the store-backed side of the seam.

use std::collections::BTreeMap;
use std::sync::Arc;

use hopper_core::satmath::SatRange;

use crate::consensus::ConsensusState;
use crate::sat_track::CoinView;
use crate::state_machine::IndexerConfig;
use crate::store::redb_store::RedbStore;
use crate::store::{BlockEffects, BlockWrite, StateView, StoreError};
use crate::types::{FroggerRecord, OutPoint, UtxoEntry};

/// One ascending page of store rows, used by [`StoreState::merge`].
type StorePage<K, T> = fn(&RedbStore, Option<&K>, usize) -> Result<Vec<(K, T)>, StoreError>;

/// A consensus state that lives in the store, with a block-sized overlay.
pub struct StoreState {
    config: IndexerConfig,
    store: Arc<RedbStore>,
    frogs: BTreeMap<u64, Option<FroggerRecord>>,
    coins: BTreeMap<OutPoint, Option<UtxoEntry>>,
    tip: (Option<u32>, Option<[u8; 32]>),
    journal: Option<BlockEffects>,
    /// True when the overlay holds an uncommitted block.
    pending: bool,
    /// Seed coins awaiting a write (batched: one transaction for many).
    pending_seeds: Option<BlockWrite>,
}

impl std::fmt::Debug for StoreState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreState")
            .field("frogs", &self.frogs.len())
            .field("coins", &self.coins.len())
            .field("tip", &self.tip)
            .field("pending", &self.pending)
            .finish()
    }
}

impl StoreState {
    /// Wrap `store`. The tip is read from the store.
    pub fn new(config: IndexerConfig, store: Arc<RedbStore>) -> Result<Self, StoreError> {
        // V3 §8.6: a store belongs to exactly one road. Binding happens on
        // first use; from then on a different `ProtocolParams` is refused.
        let configured = hopper_core::params::params_hash(&config.params);
        match store.params_hash_opt()? {
            Some(stored) if stored != configured => {
                return Err(StoreError::ParamsMismatch { stored, configured })
            }
            Some(_) => {}
            None => store.set_params_hash(&configured)?,
        }
        let tip = store.tip()?;
        Ok(Self {
            config,
            store,
            frogs: BTreeMap::new(),
            coins: BTreeMap::new(),
            tip,
            journal: None,
            pending: false,
            pending_seeds: None,
        })
    }

    /// The backing store.
    pub fn store(&self) -> &Arc<RedbStore> {
        &self.store
    }

    /// A clone of the backing store handle (the API's read path shares it).
    pub fn store_handle(&self) -> Arc<RedbStore> {
        Arc::clone(&self.store)
    }

    /// True when the overlay holds an uncommitted block.
    pub fn is_pending(&self) -> bool {
        self.pending
    }

    /// Commit the overlay: apply this block's forward batch and undo row
    /// atomically, then drop every overlay entry (the store now has them).
    ///
    /// A no-op when there is nothing pending.
    pub fn commit(&mut self, write: &BlockWrite, effects: &BlockEffects) -> Result<(), StoreError> {
        // Bootstrap seeds are operator ground truth: write them before any
        // block delta that spends them, even when this call carries no
        // journal. A seed left in the overlay would vanish on the next
        // `clear` (the latent bug the v3 differential test caught).
        self.flush_seeds()?;
        if !self.pending {
            return Ok(());
        }
        self.store.commit_block_with_undo(write, effects)?;
        self.frogs.clear();
        self.coins.clear();
        self.tip = self.store.tip()?;
        self.pending = false;
        Ok(())
    }

    /// Write pending bootstrap seeds to the store in one transaction.
    pub fn flush_seeds(&mut self) -> Result<(), StoreError> {
        let Some(write) = self.pending_seeds.take() else {
            return Ok(());
        };
        if write.is_empty() {
            return Ok(());
        }
        self.store.apply_write(&write, None)
    }

    fn coin_of(&self, outpoint: &OutPoint) -> Result<Option<UtxoEntry>, StoreError> {
        if let Some(slot) = self.coins.get(outpoint) {
            return Ok(slot.clone());
        }
        self.store.coin(outpoint)
    }

    fn frog_of(&self, sat: u64) -> Result<Option<FroggerRecord>, StoreError> {
        if let Some(slot) = self.frogs.get(&sat) {
            return Ok(slot.clone());
        }
        self.store.frog(sat)
    }

    /// Merge an overlay map into the store's ascending page stream.
    ///
    /// The cursor always advances by *store* keys, so the loop terminates
    /// even when the overlay deletes rows; a short page means the store is
    /// exhausted.
    fn merge<K: Ord + Clone, T: Clone>(
        &self,
        store_page: StorePage<K, T>,
        overlay: &BTreeMap<K, Option<T>>,
        after: Option<&K>,
        limit: usize,
    ) -> Result<Vec<(K, T)>, StoreError> {
        let mut merged: BTreeMap<K, T> = BTreeMap::new();
        let mut cursor = after.cloned();
        let want = limit.saturating_add(overlay.len()).saturating_add(1);
        loop {
            let page = store_page(&self.store, cursor.as_ref(), want)?;
            let short = page.len() < want;
            if let Some((last, _)) = page.last() {
                cursor = Some(last.clone());
            }
            for (key, value) in page {
                merged.insert(key, value);
            }
            if short || merged.len() >= want {
                break;
            }
        }
        for (key, slot) in overlay {
            if let Some(after) = after {
                if key <= after {
                    continue;
                }
            }
            match slot {
                Some(value) => {
                    merged.insert(key.clone(), value.clone());
                }
                None => {
                    merged.remove(key);
                }
            }
        }
        Ok(merged.into_iter().take(limit).collect())
    }
}

impl CoinView for StoreState {
    fn with_coin(&self, outpoint: &OutPoint, f: &mut dyn FnMut(Option<&UtxoEntry>)) {
        match self.coin_of(outpoint) {
            Ok(entry) => f(entry.as_ref()),
            Err(_) => f(None),
        }
    }

    fn update_coin(&mut self, outpoint: OutPoint, f: &mut dyn FnMut(&mut Option<UtxoEntry>)) {
        let current = self.coin_of(&outpoint).unwrap_or(None);
        let mut slot = current;
        f(&mut slot);
        self.coins.insert(outpoint, slot);
    }

    fn register_frog(&mut self, sat: u64, outpoint: OutPoint) {
        self.update_coin(outpoint, &mut |slot| {
            if let Some(entry) = slot.as_mut() {
                if let Err(pos) = entry.frogs.binary_search(&sat) {
                    entry.frogs.insert(pos, sat);
                }
            }
        });
    }

    fn frogs_at(&self, outpoint: &OutPoint) -> Vec<u64> {
        self.coin_of(outpoint)
            .ok()
            .flatten()
            .map(|entry| entry.frogs.to_vec())
            .unwrap_or_default()
    }

    fn coin_count(&self) -> usize {
        self.store.coin_count().unwrap_or(0)
    }
}

impl ConsensusState for StoreState {
    fn config(&self) -> &IndexerConfig {
        &self.config
    }

    fn tip(&self) -> (Option<u32>, Option<[u8; 32]>) {
        self.tip
    }

    fn set_tip(&mut self, height: Option<u32>, hash: Option<[u8; 32]>) {
        self.tip = (height, hash);
    }

    fn frog(&self, sat: u64) -> Option<FroggerRecord> {
        self.frog_of(sat).unwrap_or(None)
    }

    fn for_each_frog(
        &self,
        f: &mut dyn FnMut(&FroggerRecord),
    ) -> Result<(), crate::store::StoreError> {
        // Store pages, then the overlay (which already shadows any store
        // row it touched). Ascending sat within each half, matching every
        // other scan; callers must not depend on a global order.
        let mut after = None;
        loop {
            let page = self.store.frogs_after(after, 1024)?;
            if page.is_empty() {
                break;
            }
            for (sat, record) in &page {
                if !self.frogs.contains_key(sat) {
                    f(record);
                }
            }
            after = page.last().map(|(sat, _)| *sat);
        }
        for record in self.frogs.values().flatten() {
            f(record);
        }
        Ok(())
    }

    fn with_frog(&mut self, sat: u64, f: &mut dyn FnMut(&mut Option<FroggerRecord>)) {
        let mut slot = self.frog_of(sat).unwrap_or(None);
        f(&mut slot);
        self.frogs.insert(sat, slot);
    }

    fn put_frog(&mut self, record: FroggerRecord) {
        let sat = record.sat;
        let mut record = Some(record);
        self.with_frog(sat, &mut |slot| *slot = record.take());
    }

    fn frog_count(&self) -> usize {
        self.store.frog_count().unwrap_or(0)
    }

    fn seed_utxo(&mut self, outpoint: OutPoint, ranges: Vec<SatRange>) {
        let value: u64 = ranges.iter().map(|r| r.len()).sum();
        let entry = UtxoEntry {
            value,
            ranges,
            frogs: Default::default(),
        };
        // Visible to the rest of the block immediately, and written with
        // the other pending seeds (one transaction for a whole seed file).
        self.coins.insert(outpoint, Some(entry.clone()));
        self.pending_seeds
            .get_or_insert_with(|| BlockWrite::new(0))
            .put_coin(outpoint, Some(entry));
    }

    fn journal_begin(&mut self, height: u32) {
        let mut effects = BlockEffects::new(height);
        effects.before_tip = self.tip;
        self.journal = Some(effects);
        self.pending = true;
    }

    fn journal_take(&mut self) -> Option<BlockEffects> {
        self.journal.take()
    }

    fn journal_frog(&mut self, sat: u64) {
        if self.journal.is_none() {
            return;
        }
        let before = self.frog_of(sat).unwrap_or(None);
        // Seed the overlay with the before-image: the rule that follows is
        // about to read the same key, and this is now its current value.
        self.frogs.entry(sat).or_insert(before.clone());
        if let Some(journal) = &mut self.journal {
            journal.record_frog(sat, before.as_ref());
        }
    }

    fn journal_coin(&mut self, outpoint: OutPoint) {
        if self.journal.is_none() {
            return;
        }
        let before = self.coin_of(&outpoint).unwrap_or(None);
        self.coins.entry(outpoint).or_insert(before.clone());
        if let Some(journal) = &mut self.journal {
            journal.record_coin(outpoint, before.as_ref());
        }
    }

    fn undo(&mut self, effects: &BlockEffects) -> Result<(), StoreError> {
        if !self.pending {
            // Nothing buffered: undo the committed rows with the inverse
            // batch (the journal holds every before-image this block
            // touched), in one transaction.
            self.store.apply_inverse(effects)?;
            self.tip = self.store.tip()?;
            return Ok(());
        }
        // Undo inside the overlay so the block can be re-applied without
        // touching the store.
        for (sat, before) in effects.frogs() {
            self.frogs.insert(*sat, before.clone());
        }
        for (outpoint, before) in effects.coins() {
            self.coins.insert(*outpoint, before.clone());
        }
        self.tip = effects.before_tip;
        self.pending = false;
        Ok(())
    }
}

impl StateView for StoreState {
    fn params_hash(&self) -> Result<[u8; 32], StoreError> {
        Ok(hopper_core::params::params_hash(&self.config.params))
    }

    fn frog(&self, sat: u64) -> Result<Option<FroggerRecord>, StoreError> {
        self.frog_of(sat)
    }

    fn frogs_after(
        &self,
        after: Option<u64>,
        limit: usize,
    ) -> Result<Vec<(u64, FroggerRecord)>, StoreError> {
        self.merge(
            |store, from, want| store.frogs_after(from.copied(), want),
            &self.frogs,
            after.as_ref(),
            limit,
        )
    }

    fn coin(&self, outpoint: &OutPoint) -> Result<Option<UtxoEntry>, StoreError> {
        self.coin_of(outpoint)
    }

    fn coins_after(
        &self,
        after: Option<&OutPoint>,
        limit: usize,
    ) -> Result<Vec<(OutPoint, UtxoEntry)>, StoreError> {
        self.merge(
            |store, from, want| store.coins_after(from, want),
            &self.coins,
            after,
            limit,
        )
    }

    fn frog_count(&self) -> Result<usize, StoreError> {
        let base = self.store.frog_count()?;
        let added = self.frogs.values().filter(|slot| slot.is_some()).count();
        Ok(base + added)
    }

    fn coin_count(&self) -> Result<usize, StoreError> {
        let base = self.store.coin_count()?;
        let added = self.coins.values().filter(|slot| slot.is_some()).count();
        Ok(base + added)
    }

    fn tip(&self) -> Result<(Option<u32>, Option<[u8; 32]>), StoreError> {
        Ok(self.tip)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::redb_store::RedbStore;
    use hopper_core::params::ProtocolParams;
    use std::sync::Arc;

    #[cfg(feature = "redb")]
    #[test]
    fn a_store_bound_to_other_parameters_is_refused() {
        let dir = std::env::temp_dir().join(format!("frogger-params-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Arc::new(RedbStore::create(&dir.join("p.redb")).unwrap());

        let fixture = IndexerConfig {
            params: ProtocolParams::fixture_fast(),
            ..Default::default()
        };
        StoreState::new(fixture.clone(), Arc::clone(&store)).expect("first use binds the store");

        // A node running the production road must not adopt it...
        let err = StoreState::new(IndexerConfig::default(), Arc::clone(&store))
            .expect_err("different parameters are refused");
        assert!(matches!(err, StoreError::ParamsMismatch { .. }));

        // ...while the same road keeps working.
        StoreState::new(fixture, store).expect("same parameters reopen");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
