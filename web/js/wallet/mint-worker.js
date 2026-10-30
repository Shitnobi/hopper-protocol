// Build a mint off the UI thread.
//
// A mint is a commit/reveal pair whose tapleaf embeds the ~14 KiB fold
// document. Generating the document (two PNGs + HTML), hashing the leaf,
// tweaking the key, and signing two transactions is the heaviest local
// operation in the wallet. On a slow phone that synchronous work is long
// enough for the browser to flag the page as unresponsive, so the wallet
// runs exactly this builder in a module worker and keeps the main thread
// free to paint the busy overlay and handle input.

import { deriveWallet } from './keys.js';
import { buildMint } from './actions.js';

self.onmessage = (event) => {
  const {
    mnemonic, network, utxos, seed, name, feeRate, changeIndex, revealFeeRate, genHint,
  } = event.data || {};
  try {
    const keys = deriveWallet(mnemonic, network);
    const built = buildMint({
      keys, utxos, seed, name, feeRate, changeIndex, revealFeeRate, genHint,
    });
    self.postMessage({ ok: true, built });
  } catch (err) {
    self.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
