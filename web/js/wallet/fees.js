// mempool.space's precise fee estimates, reduced to the three choices the
// transaction sheets show. This module never signs or touches wallet state;
// the caller decides how a recommendation is used.

export const FEE_API = 'https://mempool.space/api/v1/fees/precise';
export const FEE_CACHE_MS = 60_000;
export const FEE_SOURCE = 'mempool.space';

const RECOMMENDATIONS = [
  ['fastestFee', 'FAST', 'next block'],
  ['halfHourFee', 'MEDIUM', '~30 min'],
  ['economyFee', 'SLOW', 'economy'],
];

function finiteRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Keep the API's decimals: feeFor() rounds the absolute satoshi fee up. */
export function normalizeFeeQuote(data) {
  if (!data || typeof data !== 'object') throw new Error('fee source returned no data');
  const out = {};
  for (const [key] of RECOMMENDATIONS) {
    const n = finiteRate(data[key]);
    if (n == null) throw new Error(`fee source has no ${key}`);
    out[key] = Math.min(1000, n);
  }
  return {
    fastestFee: out.fastestFee,
    halfHourFee: out.halfHourFee,
    economyFee: out.economyFee,
    source: FEE_SOURCE,
    fetchedAt: Date.now(),
  };
}

export function feeRecommendations(quote) {
  return RECOMMENDATIONS.map(([key, label, hint]) => ({
    key, label, hint, rate: finiteRate(quote?.[key]),
  }));
}

/** Wallet relay floor. The API can quote below 1 sat/vB; this wallet cannot
 *  reliably relay that, so a choice fills the field with at least 1. */
export function usableFeeRate(value) {
  const n = finiteRate(value);
  return n == null ? null : Math.max(1, Math.min(1000, n));
}

export function feeRateLabel(value, { floor = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const shown = floor ? usableFeeRate(n) : n;
  return `${Number(shown).toFixed(2).replace(/\.?0+$/, '')} sat/vB`;
}

export async function fetchFeeQuote({
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 8_000))
    : null;
  try {
    const res = await fetchImpl(FEE_API, {
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
    if (!res || !res.ok) throw new Error(`fee source HTTP ${res?.status ?? 'error'}`);
    const data = await res.json();
    return normalizeFeeQuote(data);
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('fee source timed out');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
