//! Crash consistency: kill the server after the store commit and before any
//! in-memory bookkeeping, then restart and check the committed block is
//! there exactly once, its undo journal is durable, and ingest continues.
//!
//! `HOPPER_TEST_ABORT_AFTER_COMMIT` is a debug-build failpoint in
//! `ApiState::commit_block`; it aborts the process right after the redb
//! transaction commits.

#![cfg(feature = "redb")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use hopper_indexer::state_machine::{Indexer, IndexerConfig};
use hopper_indexer::types::Block;

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

fn http(
    addr: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> std::io::Result<(u16, String)> {
    let mut stream = TcpStream::connect(addr)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let body = body.unwrap_or("");
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw)?;
    let status = raw
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let body = raw.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Ok((status, body))
}

fn start(dir: &Path, port: u16, abort_after_commit: bool) -> Child {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_hopper-indexer-api"));
    cmd.env("HOPPER_DB", dir.join("index.redb"))
        .env("HOPPER_SNAPSHOT_PATH", dir.join("snap.bin"))
        .env("HOPPER_SNAPSHOT_EVERY", "1000")
        .env("HOPPER_API_ADDR", format!("127.0.0.1:{port}"))
        .env_remove("HOPPER_ZMQ_ADDR")
        .env_remove("HOPPER_RPC_URL")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if abort_after_commit {
        cmd.env("HOPPER_TEST_ABORT_AFTER_COMMIT", "1");
    }
    cmd.spawn().expect("spawn the indexer binary")
}

fn wait_ready(addr: &str, child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Ok((200, _)) = http(addr, "GET", "/v1/status", None) {
            return;
        }
        if child.try_wait().ok().flatten().is_some() {
            panic!("server exited before becoming ready");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("server did not become ready");
}

fn block_json(height: u32) -> String {
    let hash = hex(&[(height as u8).wrapping_add(0xA0); 32]);
    format!(r#"{{"hash":"{hash}","height":{height},"txs":[]}}"#)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn block(height: u32) -> Block {
    Block {
        hash: [(height as u8).wrapping_add(0xA0); 32],
        height,
        txs: vec![],
    }
}

#[test]
fn crash_after_store_commit_recovers_the_block_exactly_once() {
    let dir = std::env::temp_dir().join(format!("frogger-crash-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let port = free_port();
    let addr = format!("127.0.0.1:{port}");

    // 1. Ingest one block and die inside the request, after the commit.
    let mut child = start(&dir, port, true);
    wait_ready(&addr, &mut child);
    let _ = http(&addr, "POST", "/v1/admin/block", Some(&block_json(100)));
    let status = child.wait().expect("child exit");
    assert!(!status.success(), "failpoint should abort, got {status:?}");

    // 2. Restart: the committed block is the tip, and its state is exactly
    //    one application of it.
    let mut child = start(&dir, port, false);
    wait_ready(&addr, &mut child);
    let (code, body) = http(&addr, "GET", "/v1/status", None).unwrap();
    assert_eq!(code, 200, "{body}");
    let status: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(status["tip_height"], 100, "{body}");
    assert_eq!(status["froggers"], 0, "{body}");

    let mut expected = Indexer::new(IndexerConfig::default());
    expected.apply_block(block(100)).unwrap();
    let (code, body) = http(&addr, "GET", "/v1/state/root", None).unwrap();
    assert_eq!(code, 200, "{body}");
    let root: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(root["height"], 100, "{body}");
    assert_eq!(
        root["root"].as_str().unwrap(),
        hex(&expected.state_root()),
        "{body}"
    );

    // 3. Inspect the store the crash left behind (single writer): the image
    //    matches the replay and holds no extra rows.
    let _ = child.kill();
    let _ = child.wait();
    {
        use hopper_indexer::store::{redb_store::RedbStore, StateView};
        let store = RedbStore::create(&dir.join("index.redb")).unwrap();
        assert_eq!(
            hopper_indexer::store::state_root(&store).unwrap(),
            expected.state_root()
        );
        assert_eq!(StateView::tip(&store).unwrap().0, Some(100));
        assert!(StateView::coins_after(&store, None, 10).unwrap().is_empty());
        assert!(StateView::frogs_after(&store, None, 10).unwrap().is_empty());
    }

    // 4. Ingest continues from the recovered tip.
    let mut child = start(&dir, port, false);
    wait_ready(&addr, &mut child);
    let (code, body) = http(&addr, "POST", "/v1/admin/block", Some(&block_json(101))).unwrap();
    assert_eq!(code, 200, "{body}");
    let (_, body) = http(&addr, "GET", "/v1/status", None).unwrap();
    let status: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(status["tip_height"], 101, "{body}");

    // 5. Both journals were committed atomically with their blocks: rolling
    //    back two returns to an empty index.
    let (code, body) = http(&addr, "POST", "/v1/admin/rollback", Some(r#"{"n":2}"#)).unwrap();
    assert_eq!(code, 200, "{body}");
    let (_, body) = http(&addr, "GET", "/v1/status", None).unwrap();
    let status: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(status["tip_height"].is_null(), "{body}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);
}
