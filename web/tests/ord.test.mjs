// Ord is the wallet's sat-range oracle when the HOPPER indexer cannot
// name a coin (notably a fresh coinbase-descended funding coin). The
// indexer is still authoritative for frogs/road/events.

import assert from 'node:assert/strict';

import {
  BLOCKSTREAM_ESPLORA, OrdClient, LiveBackend,
  effectiveEsploraUrl, effectiveOrdUrl, ORDINALS_COM,
} from '../js/wallet/backend.js';
import { DEFAULT_SETTINGS } from '../js/wallet/wallet.js';

let checks = 0;
function eq(what, got, want) {
  assert.deepEqual(got, want, `${what}\n got: ${JSON.stringify(got)}\nwant: ${JSON.stringify(want)}`);
  checks++;
}

// --- choosing the endpoints -----------------------------------------------
eq('mainnet defaults to the public ord', effectiveOrdUrl({}, 'mainnet'), ORDINALS_COM);
eq('regtest has no public ord default', effectiveOrdUrl({}, 'regtest'), '');
eq('an explicit ord endpoint wins', effectiveOrdUrl({ ordUrl: 'http://127.0.0.1:8080/' }, 'mainnet'), 'http://127.0.0.1:8080/');
eq('an explicit regtest ord wins', effectiveOrdUrl({ ordUrl: 'http://127.0.0.1:8082' }, 'regtest'), 'http://127.0.0.1:8082');

eq('mainnet defaults to Blockstream Esplora', effectiveEsploraUrl({}, 'mainnet'), BLOCKSTREAM_ESPLORA);
eq('regtest has no public Esplora default', effectiveEsploraUrl({}, 'regtest'), '');
eq('testnet has no public Esplora default', effectiveEsploraUrl({}, 'testnet'), '');
eq('an explicit Esplora URL wins', effectiveEsploraUrl({ esploraUrl: 'http://127.0.0.1:3002/' }, 'mainnet'), 'http://127.0.0.1:3002/');
eq('whitespace is still empty', effectiveEsploraUrl({ esploraUrl: '   ' }, 'mainnet'), BLOCKSTREAM_ESPLORA);
eq('Electrum suppresses the Blockstream default', effectiveEsploraUrl({ electrumUrl: 'ws://127.0.0.1:50032' }, 'mainnet'), '');
eq('an explicit Esplora still wins over Electrum', effectiveEsploraUrl({ esploraUrl: 'http://127.0.0.1:3002', electrumUrl: 'ws://127.0.0.1:50032' }, 'mainnet'), 'http://127.0.0.1:3002');
eq('default settings leave the field blank', DEFAULT_SETTINGS.esploraUrl, '');
const liveDefault = new LiveBackend({ esploraUrl: effectiveEsploraUrl({}, 'mainnet') });
eq('LiveBackend is built on Blockstream by default', liveDefault.esplora.base, BLOCKSTREAM_ESPLORA);

const TXID = '11'.repeat(32);
const realFetch = globalThis.fetch;
let asked = [];
function stubFetch(handler) {
  asked = [];
  globalThis.fetch = async (url, opts) => {
    asked.push(String(url));
    return handler(String(url), opts);
  };
}

// --- ord response ---------------------------------------------------------
stubFetch(() => new Response(JSON.stringify({
  value: 1000,
  sat_ranges: [[5000, 5500], [7000, 7500]],
}), { status: 200, headers: { 'content-type': 'application/json' } }));
const direct = await new OrdClient('http://ord.test/').output(TXID, 0);
eq('ord half-open ranges become inclusive', direct.ranges, [[5000, 5499], [7000, 7499]]);
eq('ord carries the output value', direct.value, 1000);
eq('ord output is exact', direct.exact, true);
eq('ord asks the recursive UTXO endpoint', asked, [`http://ord.test/r/utxo/${TXID}:0`]);

stubFetch(() => new Response('', { status: 404 }));
eq('ord does not know an unconfirmed outpoint', await new OrdClient('http://ord.test').output(TXID, 0), null);

stubFetch(() => new Response(JSON.stringify({
  value: 999,
  sat_ranges: [[0, 1000]],
}), { status: 200 }));
await assert.rejects(
  () => new OrdClient('http://ord.test').output(TXID, 0),
  /do not sum/,
);
checks++;

// --- LiveBackend selection -----------------------------------------------
stubFetch(() => new Response(JSON.stringify({
  value: 1000,
  sat_ranges: [[5000, 6000]],
}), { status: 200 }));

const shadow = { value: 1000, ranges: [], exact: false, frogs: [123] };
const backend = new LiveBackend({ electrumUrl: 'ws://127.0.0.1:50032' });
backend.indexer = { utxo: async () => shadow };
backend.ord = new OrdClient('http://ord.test');
const filled = await backend.utxo(TXID, 0);
eq('ord fills an empty indexer answer', filled.ranges, [[5000, 5999]]);
eq('ord keeps the indexer frog metadata', filled.frogs, [123]);
eq('the indexer was asked first', asked.length, 1);

let indexerCalls = 0;
let ordCalls = 0;
const exact = { value: 1000, ranges: [[1, 1000]], exact: true, frogs: [] };
const backend2 = new LiveBackend({ electrumUrl: 'ws://127.0.0.1:50032' });
backend2.indexer = { utxo: async () => { indexerCalls++; return exact; } };
backend2.ord = { output: async () => { ordCalls++; return null; } };
eq('an exact indexer answer is used as-is', await backend2.utxo(TXID, 0), exact);
eq('no ord call when the indexer is exact', ordCalls, 0);
eq('one indexer call', indexerCalls, 1);

const backend3 = new LiveBackend({ electrumUrl: 'ws://127.0.0.1:50032' });
backend3.indexer = { utxo: async () => { throw new Error('404'); } };
backend3.ord = { output: async () => null };
eq('an unknown coin can remain unknown', await backend3.utxo(TXID, 0), null);

globalThis.fetch = realFetch;
console.log(`ord: ${checks} checks passed`);
