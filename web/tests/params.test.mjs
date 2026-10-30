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
    backend: { params: async () => published },
  };
}

const assertParams = WalletSession.prototype._assertParams;

await assertParams.call(ctx({ params_hash: paramsHashHex(), wire_version: 7 }));
checks += 1;

let refused = null;
try {
  await assertParams.call(ctx({ params_hash: '00'.repeat(32), wire_version: 7 }));
} catch (err) { refused = err; }
ok(refused && refused.paramsMismatch, 'a different params_hash is refused');

// Unreachable / empty / demo make no claim.
await assertParams.call(ctx(null));
await assertParams.call({ settings: { mode: 'live', indexerUrl: '' }, backend: {} });
await assertParams.call({ settings: { mode: 'demo', indexerUrl: 'x' }, backend: { params: async () => ({ params_hash: 'ff' }) } });
checks += 3;

let networkRefused = null;
try {
  await assertParams.call({
    settings: { mode: 'live', indexerUrl: 'https://indexer.example' },
    backend: { params: async () => { throw new Error('offline'); } },
  });
} catch (err) { networkRefused = err; }
ok(networkRefused === null, 'an offline indexer is not a mismatch');
checks += 1;

console.log(`params: ${checks} checks passed`);
