// mempool.space fee recommendations are parsed without inventing values.
import assert from 'node:assert/strict';
import {
  FEE_API, feeRateLabel, feeRecommendations, fetchFeeQuote,
  normalizeFeeQuote, usableFeeRate,
} from '../js/wallet/fees.js';

let checks = 0;
const ok = (cond, message) => {
  checks += 1;
  assert.ok(cond, message);
};
const eq = (what, got, want) => {
  assert.deepEqual(got, want, `${what}\n got: ${JSON.stringify(got)}\nwant: ${JSON.stringify(want)}`);
  checks += 1;
};

const sample = {
  fastestFee: 2.716, halfHourFee: 1.859, hourFee: 0.868, economyFee: 0.2, minimumFee: 0.1,
};
const quote = normalizeFeeQuote(sample);
eq('fastestFee is kept', quote.fastestFee, 2.716);
eq('halfHourFee is kept', quote.halfHourFee, 1.859);
eq('economyFee is kept', quote.economyFee, 0.2);
eq('the source is named', quote.source, 'mempool.space');
ok(Number.isFinite(quote.fetchedAt), 'the quote carries a fetch timestamp');
eq('recommendation labels are Fast/Medium/Slow', feeRecommendations(quote).map((r) => r.label), ['FAST', 'MEDIUM', 'SLOW']);
eq('recommendation keys are the API names', feeRecommendations(quote).map((r) => r.key), ['fastestFee', 'halfHourFee', 'economyFee']);
eq('wallet floor raises sub-1 sat/vB values', usableFeeRate(0.2), 1);
eq('wallet floor leaves usable rates alone', usableFeeRate(1.859), 1.859);
eq('rate formatting drops trailing zeros', feeRateLabel(2), '2 sat/vB');
eq('rate formatting keeps decimals', feeRateLabel(1.859), '1.86 sat/vB');
eq('the requested endpoint is the precise fee API', FEE_API, 'https://mempool.space/api/v1/fees/precise');

{
  let seen = null;
  const fetched = await fetchFeeQuote({
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return { ok: true, status: 200, json: async () => sample };
    },
  });
  eq('fetch uses the precise endpoint', seen.url, FEE_API);
  eq('fetch asks for JSON', seen.opts.headers.Accept, 'application/json');
  eq('fetch returns the normalized fastest fee', fetched.fastestFee, 2.716);
  eq('fetch returns the normalized economy fee', fetched.economyFee, 0.2);
}

await assert.rejects(
  () => fetchFeeQuote({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }),
  /HTTP 503/,
);
checks += 1;
await assert.rejects(
  () => fetchFeeQuote({ fetchImpl: async () => ({ ok: true, json: async () => ({ fastestFee: 1 }) }) }),
  /halfHourFee/,
);
checks += 1;
await assert.rejects(
  () => fetchFeeQuote({ fetchImpl: async () => ({ ok: true, json: async () => ({ fastestFee: 1, halfHourFee: 1, economyFee: 0 }) }) }),
  /economyFee/,
);
checks += 1;

console.log(`fees: ${checks} checks passed`);
