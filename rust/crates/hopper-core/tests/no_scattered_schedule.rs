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

/// The genesis-0 anchors of the default schedule (`base 5`, `step1 64`,
/// `until1 25`, `step2 144`, `until2 50`, `step3 2016`, ceiling 100).
const ANCHORS: [&str; 3] = ["1280", "4880", "105680"];

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
                    for anchor in ANCHORS {
                        if code.contains(anchor) {
                            offenders.push(format!(
                                "{}:{}: `{anchor}` in `{}`",
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
        "the hop schedule must be derived from hopper_core::hops, not restated:\n{}",
        offenders.join("\n")
    );
}
