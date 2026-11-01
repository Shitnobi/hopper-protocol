// Ord is the wallet's sat-range oracle when the HOPPER indexer cannot
// name a coin (notably a fresh coinbase-descended funding coin). The
// indexer is still authoritative for frogs/road/events.

import assert from 'node:assert/strict';

import {
  BLOCKSTREAM_ESPLORA, EsploraClient, MEMPOOL_ESPLORA, OrdClient, LiveBackend,
  effectiveEsploraUrl, effectiveOrdUrl, normalizeEsploraUrl, ORDINALS_COM,
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
eq('none disables the public ord default', effectiveOrdUrl({ ordUrl: 'none' }, 'mainnet'), '');
eq('off disables a custom ord endpoint', effectiveOrdUrl({ ordUrl: 'OFF' }, 'mainnet'), '');

eq('mainnet defaults to Blockstream Esplora', effectiveEsploraUrl({}, 'mainnet'), BLOCKSTREAM_ESPLORA);
eq('regtest has no public Esplora default', effectiveEsploraUrl({}, 'regtest'), '');
eq('testnet has no public Esplora default', effectiveEsploraUrl({}, 'testnet'), '');
eq('an explicit Esplora URL wins', effectiveEsploraUrl({ esploraUrl: 'http://127.0.0.1:3002/' }, 'mainnet'), 'http://127.0.0.1:3002/');
eq('whitespace is still empty', effectiveEsploraUrl({ esploraUrl: '   ' }, 'mainnet'), BLOCKSTREAM_ESPLORA);
eq('Electrum suppresses the Blockstream default', effectiveEsploraUrl({ electrumUrl: 'ws://127.0.0.1:50032' }, 'mainnet'), '');
eq('an explicit Esplora still wins over Electrum', effectiveEsploraUrl({ esploraUrl: 'http://127.0.0.1:3002', electrumUrl: 'ws://127.0.0.1:50032' }, 'mainnet'), 'http://127.0.0.1:3002');
eq('default settings leave the Esplora field blank', DEFAULT_SETTINGS.esploraUrl, '');
eq('default settings start live on mainnet defaults', DEFAULT_SETTINGS.mode, 'live');
eq('default settings leave the Indexer blank', DEFAULT_SETTINGS.indexerUrl, '');
eq('default settings leave the Ord field blank', DEFAULT_SETTINGS.ordUrl, '');
eq('mempool.space is a first-class Esplora endpoint',
  effectiveEsploraUrl({ esploraUrl: MEMPOOL_ESPLORA }, 'mainnet'), MEMPOOL_ESPLORA);
eq('a pasted mempool.space root gains /api', normalizeEsploraUrl('https://mempool.space'), MEMPOOL_ESPLORA);
eq('a bare mempool.space host gains https and /api', normalizeEsploraUrl('mempool.space'), MEMPOOL_ESPLORA);
eq('a pasted Blockstream root gains /api', normalizeEsploraUrl('https://blockstream.info'), BLOCKSTREAM_ESPLORA);
eq('an explicit Esplora path is left alone', normalizeEsploraUrl('https://mempool.space/api/v1'), 'https://mempool.space/api/v1');
eq('another host is left alone', normalizeEsploraUrl('http://127.0.0.1:3002'), 'http://127.0.0.1:3002');
eq('unconfirmed spending is on by default', DEFAULT_SETTINGS.spendUnconfirmed, true);
const liveDefault = new LiveBackend({ esploraUrl: effectiveEsploraUrl({}, 'mainnet') });
eq('LiveBackend is built on Blockstream by default', liveDefault.esplora.base, BLOCKSTREAM_ESPLORA);
const mainnetDefaults = new LiveBackend({
  esploraUrl: effectiveEsploraUrl(DEFAULT_SETTINGS, 'mainnet'),
  indexerUrl: DEFAULT_SETTINGS.indexerUrl,
  ordUrl: effectiveOrdUrl(DEFAULT_SETTINGS, 'mainnet'),
});
eq('default backends include no local indexer', mainnetDefaults.indexer, null);
eq('default backends point ord at ordinals.com', mainnetDefaults.ord.base, ORDINALS_COM);

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
eq('ord half-open ranges stay half-open at the adapter boundary', direct.ranges, [[5000, 5500], [7000, 7500]]);
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
eq('ord fills an empty indexer answer', filled.ranges, [[5000, 6000]]);
eq('ord keeps the indexer frog metadata', filled.frogs, [123]);
eq('the indexer was asked first', asked.length, 1);

let indexerCalls = 0;
let ordCalls = 0;
const exact = { value: 1000, ranges: [[1, 1000]], exact: true, frogs: [] };
const backend2 = new LiveBackend({ electrumUrl: 'ws://127.0.0.1:50032' });
backend2.indexer = { utxo: async () => { indexerCalls++; return exact; } };
backend2.ord = { output: async () => { ordCalls++; return null; } };
eq('an exact indexer answer is used as-is', await backend2.utxo(TXID, 0), exact);
eq('ord is cross-checked even when the indexer is exact', ordCalls, 1);
eq('one indexer call', indexerCalls, 1);

const backend2b = new LiveBackend({ electrumUrl: 'ws://127.0.0.1:50032' });
backend2b.indexer = { utxo: async () => ({ ...exact, value: 999 }) };
backend2b.ord = { output: async () => ({ value: 1000, ranges: [[0, 1000]], exact: true, frogs: [] }) };
await assert.rejects(() => backend2b.utxo(TXID, 0), /disagree on .*value/);
checks += 1;

const backend2c = new LiveBackend({ electrumUrl: 'ws://127.0.0.1:50032' });
backend2c.indexer = { utxo: async () => exact };
backend2c.ord = { output: async () => ({ value: 1000, ranges: [[2, 1002]], exact: true, frogs: [] }) };
await assert.rejects(() => backend2c.utxo(TXID, 0), /disagree on .*ranges/);
checks += 1;

const backend3 = new LiveBackend({ electrumUrl: 'ws://127.0.0.1:50032' });
backend3.indexer = { utxo: async () => { throw new Error('404'); } };
backend3.ord = { output: async () => null };
eq('an unknown coin can remain unknown', await backend3.utxo(TXID, 0), null);


// --- mempool.space-compatible transport ----------------------------------
{
  let calls = 0;
  let getOpts = null;
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls += 1;
    getOpts = opts;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return new Response('973911', { status: 200 });
  };
  const client = new EsploraClient(MEMPOOL_ESPLORA, { metered: true });
  client.minIntervalMs = 0;
  const tip = await (await client.req('/blocks/tip/height')).text();
  eq('a public Esplora network failure is retried once', calls, 2);
  eq('the retry returns the tip', tip, '973911');
  eq('a GET does not add a content-type header', getOpts.headers?.['content-type'], undefined);

  calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('nope', { status: 503 }); };
  const failing = new EsploraClient(MEMPOOL_ESPLORA, { metered: true });
  failing.minIntervalMs = 0;
  await assert.rejects(() => failing.req('/blocks/tip/height'), /esplora .*: 503 nope/);
  eq('a 5xx is retried before it is reported', calls, 2);

  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const blocked = new EsploraClient(MEMPOOL_ESPLORA, { metered: true });
  blocked.minIntervalMs = 0;
  await assert.rejects(() => blocked.req('/blocks/tip/height'), /CORS/);

  let seen = null;
  globalThis.fetch = async (url, opts) => { seen = opts; return new Response('txid', { status: 200 }); };
  await new EsploraClient(MEMPOOL_ESPLORA).broadcast('00');
  eq('broadcast sends raw text/plain like mempool.space expects', seen.headers['content-type'], 'text/plain');

  globalThis.fetch = saved;
  checks += 1;
}


// --- F-10: Esplora history is paginated, not one 50-row page -------------
{
  const tx = (id, height) => ({
    txid: id, status: { confirmed: true, block_height: height },
    vout: [{ value: 1, scriptpubkey: '51' }],
  });
  const a = '11'.repeat(32), b = '22'.repeat(32);
  stubFetch((url) => {
    if (url.endsWith('/address/addr/txs')) {
      return new Response(JSON.stringify([tx(a, 1)]), { status: 200 });
    }
    if (url.endsWith('/address/addr/txs/chain')) {
      return new Response(JSON.stringify([tx(a, 1), tx(b, 2)]), { status: 200 });
    }
    if (url.endsWith(`/address/addr/txs/chain/${b}`)) {
      return new Response('[]', { status: 200 });
    }
    return new Response('[]', { status: 200 });
  });
  const hist = await new EsploraClient('http://esplora.test').addressHistory('addr');
  eq('history follows the cursor and dedupes', hist.map((h) => h.txid), [a, b]);
  eq('history keeps the confirmed height', hist[1].height, 2);
}

globalThis.fetch = realFetch;
console.log(`ord: ${checks} checks passed`);
