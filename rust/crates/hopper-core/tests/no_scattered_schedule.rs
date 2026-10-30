//! §12.8: the hop schedule has exactly one home.
//!
//! Every rule that consumes a "how many hops" number must call
//! `hopper_core::hops` / `params`, never re-derive it. The anchors are
//! the cheapest checkable part of that: their values are distinctive
//! enough that a literal anywhere else is a copy, not a coincidence.
//!
//! This is a workspace lint, not a consensus rule: it fails the build
//! (test) when a second implementation appears.

use std::path::{Path, PathBuf};

/// Markers of retired wire versions and re-derived schedules. They belong
/// to no live code path outside `hopper-core`; seeing one elsewhere means a
/// second implementation survived the v7 cutover.
const FORBIDDEN: [&str; 4] = ["FRG6CROSS", "death_bps", "dies_v3", "success_floor_bps"];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn schedule_anchor_literals_live_only_in_hopper_core() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates dir");
    let mut offenders = Vec::new();
    for entry in std::fs::read_dir(crates).expect("read crates").flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // hopper-core owns the constants.
        if name == "hopper-core" {
            continue;
        }
        for target in ["src", "tests", "examples"] {
            let mut files = Vec::new();
            rust_files(&entry.path().join(target), &mut files);
            for file in files {
                let Ok(text) = std::fs::read_to_string(&file) else {
                    continue;
                };
                for (lineno, line) in text.lines().enumerate() {
                    // Comments may explain the schedule; code may not
                    // restate it. A trailing comment is excluded too.
                    let code = line.split("//").next().unwrap_or("");
                    for marker in FORBIDDEN {
                        if code.contains(marker) {
                            offenders.push(format!(
                                "{}:{}: `{marker}` in `{}`",
                                file.display(),
                                lineno + 1,
                                code.trim()
                            ));
                        }
                    }
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "retired v6/derived-schedule code must not survive outside hopper-core:\n{}",
        offenders.join("\n")
    );
}
