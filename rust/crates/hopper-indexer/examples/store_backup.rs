//! Copy a durable indexer store and verify the copy.
//!
//! ```text
//! cargo run --release -p hopper-indexer --features redb --example store_backup -- \
//!     --from indexer.redb --to backup.redb
//! cargo run --release -p hopper-indexer --features redb --example store_backup -- --demo --check
//! ```
//!
//! The source may be live: every read is an MVCC snapshot, and `copy_to`
//! takes state, undo journals and the retained hash window from the same
//! store. Verification recomputes the canonical state root on both sides;
//! `--check` makes a mismatch (or any missing row) exit non-zero.
//!
//! redb is single-writer: run this against a stopped indexer, or accept that
//! the backup corresponds to some committed block at or before the copy.

use std::path::{Path, PathBuf};

use hopper_indexer::state_machine::IndexState;
use hopper_indexer::store::redb_store::RedbStore;
use hopper_indexer::store::{state_root, StateStore, StateView};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn arg(name: &str) -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
}

fn fail(message: impl std::fmt::Display) -> ! {
    eprintln!("error: {message}");
    std::process::exit(1)
}

fn demo_store(path: &Path) {
    let mut state = IndexState::default();
    StateStore::set_tip(&mut state, Some(3), Some([3u8; 32])).unwrap_or_else(|e| fail(e));
    let store = RedbStore::create(path).unwrap_or_else(|e| fail(e));
    store.save_state(&state).unwrap_or_else(|e| fail(e));
    store
        .save_retained_heights(&[(3, [3u8; 32])])
        .unwrap_or_else(|e| fail(e));
}

fn describe(store: &RedbStore, label: &str) -> [u8; 32] {
    let (height, hash) = StateView::tip(store).unwrap_or_else(|e| fail(e));
    let root = state_root(store).unwrap_or_else(|e| fail(e));
    println!(
        "ok: {label} tip {} ({}) frogs {} coins {} undo {:?} retained {}",
        height.map_or("-".to_string(), |h| h.to_string()),
        hash.map_or("-".to_string(), |h| hex(&h)),
        store.frog_count().unwrap_or_else(|e| fail(e)),
        store.coin_count().unwrap_or_else(|e| fail(e)),
        store.undo_range().unwrap_or_else(|e| fail(e)),
        store
            .load_retained_heights()
            .unwrap_or_else(|e| fail(e))
            .len(),
    );
    root
}

fn main() {
    let check = std::env::args().any(|a| a == "--check");
    let demo = std::env::args().any(|a| a == "--demo");
    let (from, to) = if demo {
        let dir = std::env::temp_dir().join(format!("frogger-backup-demo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap_or_else(|e| fail(e));
        let from = dir.join("source.redb");
        demo_store(&from);
        (from, dir.join("backup.redb"))
    } else {
        let from = arg("--from").unwrap_or_else(|| {
            fail("usage: store_backup --from <src.redb> --to <dst.redb> [--check]  |  --demo")
        });
        let to = arg("--to").unwrap_or_else(|| fail("missing --to <dst.redb>"));
        (from, to)
    };

    let src =
        RedbStore::create(&from).unwrap_or_else(|e| fail(format!("open {}: {e}", from.display())));
    let src_root = describe(&src, "source");
    src.copy_to(&to)
        .unwrap_or_else(|e| fail(format!("copy to {}: {e}", to.display())));

    let dst =
        RedbStore::create(&to).unwrap_or_else(|e| fail(format!("reopen {}: {e}", to.display())));
    let dst_root = describe(&dst, "backup");
    let bytes = std::fs::metadata(&to).map(|m| m.len()).unwrap_or(0);
    println!("ok: backup written to {} ({} bytes)", to.display(), bytes);
    if src_root != dst_root {
        fail(format!(
            "state root mismatch: source {} backup {}",
            hex(&src_root),
            hex(&dst_root)
        ));
    }
    println!("ok: state root {} (source == backup)", hex(&src_root));
    if check {
        println!("ok: store backup check passed");
    }
    if demo {
        let _ = std::fs::remove_dir_all(to.parent().unwrap_or(Path::new(".")));
    }
}
