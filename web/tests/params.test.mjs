// SPEC §1.3: a wallet refuses to mint or hop when the indexer publishes a
// params_hash that differs from its own copy.
import assert from 'node:assert/strict';
import { WalletSession } from '../js/wallet/wallet.js';
import { paramsHashHex } from '../js/core/params.js';

let checks = 0;
const ok = (cond, msg) => { checks += 1; if (!cond) throw new Error(msg); };

function ctx(published) {
  return {
    settings: { mode: 'live', indexerUrl: 'https://indexer.example' },
    network: 'mainnet',
    backend: { params: async () => published },
  };
}

const assertParams = WalletSession.prototype._assertParams;

await assertParams.call(ctx({ params_hash: paramsHashHex(), wire_version: 8, network: 'mainnet' }));
checks += 1;

let refused = null;
try {
  await assertParams.call(ctx({ params_hash: '00'.repeat(32), wire_version: 8, network: 'mainnet' }));
} catch (err) { refused = err; }
ok(refused && refused.paramsMismatch, 'a different params_hash is refused');

// A configured indexer that cannot answer a complete identity is a
// refusal; an unconfigured or demo wallet makes no claim.
for (const bad of [null, {}, { network: 'mainnet' }]) {
  let refusedEmpty = null;
  try { await assertParams.call(ctx(bad)); } catch (e) { refusedEmpty = e; }
  ok(refusedEmpty, 'an incomplete params answer is refused');
}
await assertParams.call({ settings: { mode: 'live', indexerUrl: '' }, backend: {} });
await assertParams.call({ settings: { mode: 'demo', indexerUrl: 'x' }, backend: { params: async () => ({ params_hash: 'ff' }) } });
checks += 2;

let networkRefused = null;
try {
  await assertParams.call({
    settings: { mode: 'live', indexerUrl: 'https://indexer.example' },
    network: 'mainnet',
    backend: { params: async () => { throw new Error('offline'); } },
  });
} catch (err) { networkRefused = err; }
ok(networkRefused && /did not answer/.test(networkRefused.message), 'an offline indexer is refused');
checks += 1;

console.log(`params: ${checks} checks passed`);
