#!/usr/bin/env node
/* The v6 boot regression: a minted frog must render ALIVE, not quantum.
 *
 * The document embeds, in one <script>:
 *     var V6={sat:…,p:{…}};      <- the document's data
 *     <live_v6.js>               <- the fold
 *
 * The fold used to declare `var V6 = {sat:0, p:null}` right there. `var`
 * is hoisted into the same scope, so it OVERWROTE the document's values:
 * `p` became null, `requiredAt(tip+1, null)` threw inside boot()'s try,
 * the catch swallowed it, and the card stayed in the quantum alive/dead
 * animation — on every ord explorer, forever, for every frog minted with
 * that body.
 *
 * This test simulates exactly that wiring (document data handed in as
 * `V6`, then the fold source) with stubbed DOM/fetch, runs boot(), and
 * demands `data-frogger=idle` — i.e. the frog is on the bank, alive.
 *
 * Run: node frogger/crates/hopper-core/tests/v6_doc_boot.mjs
 */
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "live_v6.js"), "utf8");

const SAT = 1_622_677_699_379_588;
const TIP = 973_337;
const ID = "0007cb6b312170d034343ead441212bcda1e4fda3f06c6dc62c69f254951f120i0";
const PARAMS = {
  g: 973_263,
  b: 5,
  s1: 64,
  u1: 25,
  s2: 144,
  u2: 50,
  s3: 2016,
  cap: 100,
  fin: 6,
  bps: new Array(101).fill(2500),
};

/* A childless frog, exactly as ord answers it right after a mint. */
const routes = {
  "/r/blockheight": TIP,
  [`/r/inscription/${ID}`]: {
    id: ID,
    sat: SAT,
    height: TIP,
    sequence_number: 100,
    satpoint: `${ID.slice(0, 64)}:0:0`,
  },
  [`/r/children/${ID}`]: { ids: [], more: false, page: 0 },
};
const fetchStub = async (url) => {
  const path = String(url).split("?")[0];
  if (!(path in routes)) throw new Error(`unexpected fetch ${path}`);
  const body = routes[path];
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(JSON.stringify(body)),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
};
const attributes = new Map();
const band = { textContent: "STATE FROM THE CHAIN" };
const documentStub = {
  readyState: "complete",
  documentElement: {
    setAttribute: (k, v) => attributes.set(k, v),
    getAttribute: (k) => (attributes.has(k) ? attributes.get(k) : null),
  },
  getElementById: (id) => (id === "band" ? band : null),
  addEventListener: () => {},
};
const windowStub = { crypto: webcrypto };

/* Build the script body exactly as `live_v6_html` does: the document's
 * `var V6={sat,p}` line, newline, then the fold source. The values are
 * injected as a *parameter* so an assignment inside the source really
 * does overwrite them (it is the same binding, like the real hoisting). */
const script = `var V6={sat:${SAT},p:${JSON.stringify(PARAMS)}};\n${src}`;
const run = new Function(
  "V6",
  "window",
  "document",
  "location",
  "fetch",
  "crypto",
  "TextEncoder",
  `${script}\nreturn { V6: V6, boot: boot };`,
);

const V6 = PARAMS; // placeholder replaced by the script's own literal
const api = run(
  V6,
  windowStub,
  documentStub,
  { pathname: `/preview/${ID}`, href: `https://ordinals.com/preview/${ID}` },
  fetchStub,
  webcrypto,
  TextEncoder,
);

const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  process.exit(1);
};

if (api.V6.sat !== SAT) {
  fail(
    `the fold clobbered the document's V6: sat is ${api.V6.sat}, wanted ${SAT} ` +
      `(a plain 'var V6 = {...}' in live_v6.js does this — every minted frog ` +
      `then stays quantum on ordinals.com)`,
  );
}

await api.boot();

const state = attributes.get("data-frogger");
if (state !== "idle") {
  fail(`boot() painted ${JSON.stringify(state)}, wanted "idle" (${band.textContent})`);
}
if (!/^ON THE BANK — 0\/\d+$/.test(band.textContent)) {
  fail(`the caption is ${JSON.stringify(band.textContent)}, wanted "ON THE BANK — 0/N"`);
}
if (attributes.get("data-frogger-target") !== "6") {
  fail(`target is ${attributes.get("data-frogger-target")}, wanted the tip's requirement (6)`);
}

console.log("v6 document boot: a freshly minted frog renders ALIVE (ON THE BANK — 0/6)");
