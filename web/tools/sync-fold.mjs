// Regenerate js/core/fold_source.js from the current v8 fold in hopper-core.
// Run: node tools/sync-fold.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../rust/crates/hopper-core/src/live_v8.js'), 'utf8');
writeFileSync(
  join(here, '../js/core/fold_source.js'),
  '// Auto-generated from rust/crates/hopper-core/src/live_v8.js — the current v8 fold.\n'
  + '// Regenerate with web/tools/sync-fold.mjs after editing that file.\n'
  + `export const FOLD_JS = ${JSON.stringify(src)};\n`,
);
console.log('synced fold source');
