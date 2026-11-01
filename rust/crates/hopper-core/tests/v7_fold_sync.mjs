#!/usr/bin/env node
/* web/js/core/fold_source.js must be byte-identical to the canonical
 * fold embedded in the Rust mint body.
 *
 * Run: node crates/hopper-core/tests/v7_fold_sync.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const canonical = readFileSync(join(here, '..', 'src', 'live_v8.js'), 'utf8');
const generated = readFileSync(join(here, '..', '..', '..', '..', 'web', 'js', 'core', 'fold_source.js'), 'utf8');
const marker = 'export const FOLD_JS = ';
const at = generated.indexOf(marker);
if (at < 0) throw new Error('fold_source.js does not export FOLD_JS');
const text = JSON.parse(generated.slice(at + marker.length).replace(/;\s*$/, ''));
if (text !== canonical) {
  throw new Error('fold_source.js is stale: run web/tools/sync-fold.mjs');
}
console.log('v8 fold sync: ok');
