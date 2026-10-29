// Ordinal range arithmetic (FIFO over inputs in order).
// Ranges are inclusive [start, end] pairs of ordinal numbers (Number,
// exact up to 2^53; total supply is 2.1e15).

export function rangeLen(r) {
  return r[1] - r[0] + 1;
}

export function rangesValue(ranges) {
  let n = 0;
  for (const r of ranges) n += rangeLen(r);
  return n;
}

export function firstSat(ranges) {
  return ranges.length ? ranges[0][0] : null;
}

export function containsSat(ranges, sat) {
  for (const [a, b] of ranges) if (sat >= a && sat <= b) return true;
  return false;
}

// Assign output values over the concatenated input ranges.
// `inputRanges`: array (per input, in tx order) of sorted [start,end] lists.
// `outputValues`: array of sat amounts.
// Returns {outputs: [[range...]...], feeRanges: [...]} or null when the
// inputs cannot cover the outputs.
export function assignRanges(inputRanges, outputValues) {
  const queue = [];
  for (const ranges of inputRanges) for (const r of ranges) queue.push([r[0], r[1]]);
  let cursor = 0;
  const outputs = [];
  for (const value of outputValues) {
    let left = value;
    const out = [];
    while (left > 0) {
      if (cursor >= queue.length) return null;
      const [start, end] = queue[cursor];
      const take = Math.min(left, end - start + 1);
      out.push([start, start + take - 1]);
      if (take === end - start + 1) cursor++;
      else queue[cursor] = [start + take, end];
      left -= take;
    }
    outputs.push(out);
  }
  return { outputs, feeRanges: queue.slice(cursor) };
}

// Slice the first `value` sats from a range list (used to size a coin).
export function sliceRanges(ranges, value) {
  const out = [];
  let left = value;
  for (const [start, end] of ranges) {
    if (left <= 0) break;
    const take = Math.min(left, end - start + 1);
    out.push([start, start + take - 1]);
    left -= take;
  }
  return left > 0 ? null : out;
}

export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}
