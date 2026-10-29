//! Lazy sat-range seeding from an ord server.
//!
//! The HOPPER indexer models every coin it has seen, but it deliberately
//! does not model the coinbase subsidy (`hopper-indexer/src/NOTES.md`).
//! A fresh chain therefore starts with shadow ranges: a wallet can see a
//! coin, but the indexer cannot name its sats and MINT would reject it
//! with `MintAnchorUntracked`.
//!
//! `HOPPER_ORD_URL` points at an ord server (a local one, or a remote
//! third party). When `/v1/utxo` is asked about an untracked or shadow
//! coin, the indexer asks ord for the outpoint's real ranges and seeds
//! them before answering. That makes the wallet's ordinary refresh the
//! bootstrap step: no operator seed is required, and the next block's
//! MINT validation sees the same ranges the wallet used to build it.
//!
//! ord is trusted for ranges. This is the documented external oracle
//! dependency, not a consensus shortcut: the indexer verifies the ranges
//! are well-formed and sum to ord's own output value, but it cannot
//! independently prove a sat assignment.

use std::time::Duration;

use hopper_core::satmath::SatRange;
use serde_json::Value;

/// A coin with more ranges than this is almost certainly not a real
/// output; refuse it rather than allocate unbounded memory on a hostile
/// or misconfigured ord server.
const MAX_RANGES: usize = 100_000;

/// A small blocking ord client. `/output/:outpoint` is the JSON view
/// (`Accept: application/json`); ord 0.22+ also serves `/r/utxo`, but
/// that shape omits the value and is not the public API.
#[derive(Clone)]
pub struct OrdClient {
    base: String,
    agent: ureq::Agent,
}

impl OrdClient {
    pub fn new(base: impl Into<String>) -> Self {
        let base = base.into().trim().trim_end_matches('/').to_string();
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(20))
            .build();
        Self { base, agent }
    }

    /// Fetch one outpoint. `Ok(None)` means ord does not index it (or
    /// has `sat_ranges: null`); an error means the server failed us.
    pub fn output(
        &self,
        txid: [u8; 32],
        vout: u32,
    ) -> Result<Option<(u64, Vec<SatRange>)>, String> {
        let outpoint = format!("{}:{vout}", crate::dto::hex_display(&txid));
        let url = format!("{}/output/{outpoint}", self.base);
        let answer = self
            .agent
            .get(&url)
            .set("Accept", "application/json")
            .call();
        match answer {
            Ok(response) => {
                let value: Value = response
                    .into_json()
                    .map_err(|e| format!("ord {url}: {e}"))?;
                parse_output(&value).map_err(|e| format!("ord {url}: {e}"))
            }
            Err(ureq::Error::Status(404, _)) => Ok(None),
            Err(e) => Err(format!("ord {url}: {e}")),
        }
    }
}

/// Parse ord's `/output` JSON. Half-open `[start, end)` ranges become
/// [`SatRange`]s; the wallet-facing API subtracts one from `end` later.
fn parse_output(value: &Value) -> Result<Option<(u64, Vec<SatRange>)>, String> {
    let Some(ranges) = value.get("sat_ranges") else {
        return Err("missing sat_ranges".into());
    };
    if ranges.is_null() {
        // ord knows the outpoint but has not indexed its sats.
        return Ok(None);
    }
    let ranges = ranges.as_array().ok_or("sat_ranges is not an array")?;
    if ranges.is_empty() {
        return Ok(None);
    }
    if ranges.len() > MAX_RANGES {
        return Err(format!("{} sat ranges (limit {MAX_RANGES})", ranges.len()));
    }
    let coin_value = value
        .get("value")
        .and_then(Value::as_u64)
        .ok_or("missing output value")?;

    let mut out = Vec::with_capacity(ranges.len());
    let mut sum = 0u64;
    for pair in ranges {
        let pair = pair
            .as_array()
            .filter(|p| p.len() == 2)
            .ok_or("sat range is not a [start, end] pair")?;
        let start = pair[0].as_u64().ok_or("sat range start is not a u64")?;
        let end = pair[1].as_u64().ok_or("sat range end is not a u64")?;
        if start >= end {
            return Err(format!("empty sat range [{start}, {end})"));
        }
        if hopper_indexer::is_shadow(start) {
            return Err(format!("sat range starts in the shadow space: {start}"));
        }
        sum = sum
            .checked_add(end - start)
            .ok_or("sat range sum overflow")?;
        out.push(SatRange::new(start, end));
    }
    if sum != coin_value {
        return Err(format!(
            "sat ranges sum to {sum}, ord says the output is {coin_value}"
        ));
    }
    Ok(Some((coin_value, out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_half_open_ranges() {
        let value = json!({
            "value": 1000,
            "sat_ranges": [[5000, 5500], [7000, 7500]],
        });
        let (v, ranges) = parse_output(&value).unwrap().unwrap();
        assert_eq!(v, 1000);
        assert_eq!(
            ranges,
            vec![SatRange::new(5000, 5500), SatRange::new(7000, 7500)]
        );
    }

    #[test]
    fn null_ranges_mean_not_indexed() {
        assert_eq!(
            parse_output(&json!({ "value": 10, "sat_ranges": null })).unwrap(),
            None
        );
        assert_eq!(
            parse_output(&json!({ "value": 10, "sat_ranges": [] })).unwrap(),
            None
        );
    }

    #[test]
    fn rejects_shapes_that_could_poison_the_tracker() {
        // The sum must match the coin value ord reported.
        assert!(parse_output(&json!({ "value": 999, "sat_ranges": [[0, 1000]] })).is_err());
        // Empty/inverted ranges are not coins.
        assert!(parse_output(&json!({ "value": 0, "sat_ranges": [[9, 9]] })).is_err());
        // Synthetic ordinals must never enter the real sat space.
        let shadow = hopper_indexer::SHADOW_BASE;
        assert!(parse_output(&json!({
            "value": 1,
            "sat_ranges": [[shadow, shadow + 1]],
        }))
        .is_err());
    }
}
