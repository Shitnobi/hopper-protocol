//! Append-only segmented event log (P1.4).
//!
//! The indexer's in-memory event log is a *tail window*: the API appends
//! every new event here, then trims the core log so memory no longer
//! grows with chain history. Segments are small files (a fixed number of
//! records) named by their first height, with a versioned header:
//!
//! ```text
//! "EVG1" | u32 version | u32 first_height | [u32 len | bincode event]*
//! ```
//!
//! A reorg truncates the suffix above the new tip: later segments are
//! deleted and the boundary segment is rewritten (it is small, so the
//! rewrite is cheap). The checkpoint remains the state commit point; on
//! startup the log is reconciled to the snapshot tip.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use hopper_indexer::types::ChainEvent;

const MAGIC: &[u8; 4] = b"EVG1";
const VERSION: u32 = 1;
const HEADER_LEN: u64 = 12;
const MAX_RECORD: u32 = 1 << 20;

#[derive(Debug, Clone)]
struct Segment {
    path: PathBuf,
    first_height: u32,
    seq: u32,
}

/// A directory of event segments. Not thread-safe: the API holds it
/// behind a mutex.
#[derive(Debug)]
pub struct EventStore {
    dir: PathBuf,
    per_segment: usize,
    segments: Vec<Segment>,
    /// Records currently in the last segment (or 0 when there is none).
    current_count: usize,
    last_height: Option<u32>,
    next_seq: u32,
    /// Bytes dropped from a torn tail record when this store was opened.
    recovered_bytes: u64,
}

impl EventStore {
    /// Open (or create) the store. `per_segment` bounds each file; 0 is
    /// treated as 1.
    pub fn open(dir: PathBuf, per_segment: usize) -> io::Result<Self> {
        fs::create_dir_all(&dir)?;
        let mut segments = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.ends_with(".seg") {
                continue;
            }
            let (first_height, seq) = parse_name(name).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("bad segment name {name}"),
                )
            })?;
            let (header_height, _) = read_header(&path)?;
            if header_height != first_height {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("segment {name}: header height {header_height} != name"),
                ));
            }
            segments.push(Segment {
                path,
                first_height,
                seq,
            });
        }
        segments.sort_by_key(|s| (s.first_height, s.seq));
        let mut store = Self {
            dir,
            per_segment: per_segment.max(1),
            segments,
            current_count: 0,
            last_height: None,
            next_seq: 0,
            recovered_bytes: 0,
        };
        // A power loss can leave a partially written last record (`append`
        // fsyncs per call, but the segment is written record by record).
        // That record is above the checkpoint, so dropping it is safe:
        // truncate the file back to the last complete record. Any earlier
        // segment with a short tail is real corruption, not a torn write.
        store.recovered_bytes = store.repair_tail()?;
        store.refresh_tail()?;
        Ok(store)
    }

    /// Append events in order. Each call flushes and fsyncs (events are
    /// committed only after the checkpoint, so durability is cheap here).
    pub fn append(&mut self, events: &[ChainEvent]) -> io::Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let mut i = 0;
        while i < events.len() {
            let need_new = self.segments.is_empty() || self.current_count >= self.per_segment;
            if need_new {
                let first = events[i].height;
                let seq = self.next_seq;
                self.next_seq += 1;
                let name = format!("ev-{first:010}-{seq:06}.seg");
                let path = self.dir.join(name);
                let mut file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&path)?;
                write_header(&mut file, first)?;
                self.segments.push(Segment {
                    path,
                    first_height: first,
                    seq,
                });
                self.current_count = 0;
            }
            let take = (self.per_segment - self.current_count).min(events.len() - i);
            let path = self.segments.last().expect("segment exists").path.clone();
            let mut file = OpenOptions::new().append(true).open(&path)?;
            for event in &events[i..i + take] {
                write_record(&mut file, event)?;
                self.last_height = Some(event.height);
            }
            file.sync_data()?;
            self.current_count += take;
            i += take;
        }
        Ok(())
    }

    /// Keep at most `keep` segments (the newest), deleting older ones.
    /// Returns how many were deleted. At least the active segment is always
    /// kept, so `keep = 0` means "current tail only". Pruned events stay
    /// re-derivable from chain; this bounds disk usage, not correctness.
    pub fn prune_to_segments(&mut self, keep: usize) -> io::Result<usize> {
        let keep = keep.max(1);
        if self.segments.len() <= keep {
            return Ok(0);
        }
        let drop_n = self.segments.len() - keep;
        let doomed: Vec<PathBuf> = self.segments.drain(..drop_n).map(|s| s.path).collect();
        for path in &doomed {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(doomed.len())
    }

    /// Delete every event above `height` (reorg). Returns how many
    /// segments were removed/rewritten (diagnostics only).
    pub fn truncate_above(&mut self, height: u32) -> io::Result<usize> {
        let keep = self
            .segments
            .iter()
            .position(|s| s.first_height > height)
            .unwrap_or(self.segments.len());
        let mut changed = 0;
        for seg in self.segments.drain(keep..) {
            fs::remove_file(seg.path)?;
            changed += 1;
        }
        if let Some(last) = self.segments.last() {
            let events = read_segment(&last.path)?;
            if events.iter().any(|e| e.height > height) {
                let kept: Vec<_> = events.into_iter().filter(|e| e.height <= height).collect();
                changed += 1;
                if kept.is_empty() {
                    fs::remove_file(&last.path)?;
                    self.segments.pop();
                } else {
                    rewrite_segment(&last.path, &kept)?;
                }
            }
        }
        self.refresh_tail()?;
        Ok(changed)
    }

    /// The last `n` events, oldest first.
    pub fn tail(&self, n: usize) -> io::Result<Vec<ChainEvent>> {
        let mut out: Vec<ChainEvent> = Vec::new();
        for seg in self.segments.iter().rev() {
            let mut events = read_segment(&seg.path)?;
            events.extend(out);
            out = events;
            if out.len() >= n {
                break;
            }
        }
        let drop = out.len().saturating_sub(n);
        out.drain(..drop);
        Ok(out)
    }

    /// All events (tests/diagnostics; do not call on a large log).
    pub fn all(&self) -> io::Result<Vec<ChainEvent>> {
        let mut out = Vec::new();
        for seg in &self.segments {
            out.extend(read_segment(&seg.path)?);
        }
        Ok(out)
    }

    /// Height of the newest stored event, if any.
    pub fn last_height(&self) -> Option<u32> {
        self.last_height
    }

    /// Remove the whole log (fresh start with no snapshot).
    pub fn clear(&mut self) -> io::Result<()> {
        for seg in self.segments.drain(..) {
            let _ = fs::remove_file(seg.path);
        }
        self.current_count = 0;
        self.last_height = None;
        self.next_seq = 0;
        Ok(())
    }

    /// Truncate a torn final record. Returns the number of bytes dropped.
    fn repair_tail(&self) -> io::Result<u64> {
        let Some(last) = self.segments.last() else {
            return Ok(0);
        };
        let size = fs::metadata(&last.path)?.len();
        let (_, good) = read_segment_upto(&last.path)?;
        if good >= size {
            return Ok(0);
        }
        OpenOptions::new()
            .write(true)
            .open(&last.path)?
            .set_len(good)?;
        Ok(size - good)
    }

    /// Bytes dropped while repairing a torn tail record at open time.
    pub fn recovered_bytes(&self) -> u64 {
        self.recovered_bytes
    }

    fn refresh_tail(&mut self) -> io::Result<()> {
        self.current_count = 0;
        self.last_height = None;
        self.next_seq = self.segments.last().map(|s| s.seq + 1).unwrap_or(0);
        if let Some(last) = self.segments.last() {
            let events = read_segment(&last.path)?;
            self.current_count = events.len();
            self.last_height = events.last().map(|e| e.height);
        }
        Ok(())
    }
}

fn parse_name(name: &str) -> Option<(u32, u32)> {
    let stem = name.strip_suffix(".seg")?;
    let rest = stem.strip_prefix("ev-")?;
    let (height, seq) = rest.split_once('-')?;
    Some((height.parse().ok()?, seq.parse().ok()?))
}

fn write_header(file: &mut File, first_height: u32) -> io::Result<()> {
    file.write_all(MAGIC)?;
    file.write_all(&VERSION.to_le_bytes())?;
    file.write_all(&first_height.to_le_bytes())?;
    Ok(())
}

fn read_header(path: &Path) -> io::Result<(u32, u32)> {
    let mut file = File::open(path)?;
    let mut header = [0u8; HEADER_LEN as usize];
    file.read_exact(&mut header)?;
    if &header[..4] != MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{path:?}: bad event segment magic"),
        ));
    }
    let version = u32::from_le_bytes(header[4..8].try_into().unwrap());
    if version != VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{path:?}: unsupported event segment version {version}"),
        ));
    }
    let height = u32::from_le_bytes(header[8..12].try_into().unwrap());
    Ok((height, version))
}

fn write_record(file: &mut File, event: &ChainEvent) -> io::Result<()> {
    let body =
        bincode::serialize(event).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let len = u32::try_from(body.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "event too large"))?;
    file.write_all(&len.to_le_bytes())?;
    file.write_all(&body)?;
    Ok(())
}

/// Read a segment, returning the events and the byte offset just past the
/// last **complete** record. A short length prefix or body at the end is a
/// torn write: it stops the scan instead of failing.
fn read_segment_upto(path: &Path) -> io::Result<(Vec<ChainEvent>, u64)> {
    let mut file = BufReader::new(File::open(path)?);
    let mut header = [0u8; HEADER_LEN as usize];
    file.read_exact(&mut header)?;
    if &header[..4] != MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{path:?}: bad event segment magic"),
        ));
    }
    let mut out = Vec::new();
    let mut good = HEADER_LEN;
    loop {
        let mut len = [0u8; 4];
        match file.read_exact(&mut len) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e),
        }
        let len = u32::from_le_bytes(len);
        if len > MAX_RECORD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{path:?}: event record length {len} exceeds maximum"),
            ));
        }
        let mut body = vec![0u8; len as usize];
        match file.read_exact(&mut body) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e),
        }
        let event: ChainEvent = bincode::deserialize(&body)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        out.push(event);
        good += 4 + len as u64;
    }
    Ok((out, good))
}

fn read_segment(path: &Path) -> io::Result<Vec<ChainEvent>> {
    read_segment_upto(path).map(|(events, _)| events)
}

fn rewrite_segment(path: &Path, events: &[ChainEvent]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    let (first_height, _) = read_header(path)?;
    {
        let mut file = BufWriter::new(File::create(&tmp)?);
        file.write_all(MAGIC)?;
        file.write_all(&VERSION.to_le_bytes())?;
        file.write_all(&first_height.to_le_bytes())?;
        for event in events {
            let body = bincode::serialize(event)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            let len = u32::try_from(body.len())
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "event too large"))?;
            file.write_all(&len.to_le_bytes())?;
            file.write_all(&body)?;
        }
        file.flush()?;
        file.get_ref().sync_data()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hopper_indexer::types::EventAction;

    fn dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("frogger-eventlog-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn ev(height: u32) -> ChainEvent {
        ChainEvent {
            block_hash: [height as u8; 32],
            height,
            txid: None,
            action: EventAction::Burn {
                frogger_sat: height as u64,
            },
        }
    }

    #[test]
    fn open_repairs_a_torn_tail_record() {
        let dir = dir("torn");
        let mut store = EventStore::open(dir.clone(), 4).unwrap();
        store.append(&[ev(1), ev(2), ev(3)]).unwrap();
        drop(store);
        let path = fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();

        // Torn body: cut three bytes off the last record.
        let full = fs::metadata(&path).unwrap().len();
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(full - 3)
            .unwrap();
        let mut store = EventStore::open(dir.clone(), 4).unwrap();
        assert!(store.recovered_bytes() > 0);
        assert_eq!(store.all().unwrap(), vec![ev(1), ev(2)]);

        // Appends continue at the repaired offset.
        store.append(&[ev(4)]).unwrap();
        assert_eq!(store.tail(2).unwrap(), vec![ev(2), ev(4)]);

        // Torn length prefix: cut two bytes into the last record's length.
        drop(store);
        let full = fs::metadata(&path).unwrap().len();
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(full - 2)
            .unwrap();
        let store = EventStore::open(dir.clone(), 4).unwrap();
        assert!(store.recovered_bytes() > 0);
        assert_eq!(store.all().unwrap(), vec![ev(1), ev(2)]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_the_newest_segments() {
        let dir = dir("prune");
        let mut store = EventStore::open(dir.clone(), 2).unwrap();
        let events: Vec<_> = (1..=5).map(ev).collect();
        store.append(&events).unwrap();
        assert_eq!(store.segments.len(), 3);

        assert_eq!(store.prune_to_segments(2).unwrap(), 1);
        assert_eq!(store.segments.len(), 2);
        assert_eq!(store.tail(99).unwrap(), events[2..]);

        // keep = 0 still retains the active segment.
        assert_eq!(store.prune_to_segments(0).unwrap(), 1);
        assert_eq!(store.all().unwrap(), events[4..]);

        // Reopen sees exactly the retained files; appending continues.
        drop(store);
        let mut store = EventStore::open(dir.clone(), 2).unwrap();
        assert_eq!(store.all().unwrap(), events[4..]);
        store.append(&[ev(6)]).unwrap();
        assert_eq!(store.tail(1).unwrap(), vec![ev(6)]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_rotates_and_tail_reads_across_segments() {
        let dir = dir("tail");
        let mut store = EventStore::open(dir.clone(), 2).unwrap();
        let events: Vec<_> = (1..=5).map(ev).collect();
        store.append(&events).unwrap();
        assert_eq!(store.segments.len(), 3);
        assert_eq!(store.last_height(), Some(5));
        assert_eq!(store.tail(3).unwrap(), events[2..]);
        assert_eq!(store.tail(99).unwrap(), events);
        assert_eq!(store.all().unwrap(), events);

        // Reopen: names + headers reconstruct order and counts.
        drop(store);
        let store = EventStore::open(dir.clone(), 2).unwrap();
        assert_eq!(store.all().unwrap(), events);
        assert_eq!(store.last_height(), Some(5));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncate_above_rewrites_the_boundary_segment() {
        let dir = dir("truncate");
        let mut store = EventStore::open(dir.clone(), 2).unwrap();
        // Heights 1..=6, so the boundary is inside a segment.
        store.append(&(1..=6).map(ev).collect::<Vec<_>>()).unwrap();
        assert!(store.truncate_above(3).unwrap() > 0);
        assert_eq!(store.all().unwrap(), (1..=3).map(ev).collect::<Vec<_>>());
        assert_eq!(store.last_height(), Some(3));

        // Appending after a truncate continues from the new tail.
        store.append(&[ev(4)]).unwrap();
        assert_eq!(store.tail(2).unwrap(), vec![ev(3), ev(4)]);

        // Truncating below everything empties the store.
        store.truncate_above(0).unwrap();
        assert!(store.all().unwrap().is_empty());
        assert_eq!(store.last_height(), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_removes_every_segment() {
        let dir = dir("clear");
        let mut store = EventStore::open(dir.clone(), 2).unwrap();
        store.append(&[ev(1), ev(2), ev(3)]).unwrap();
        store.clear().unwrap();
        assert!(store.all().unwrap().is_empty());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
