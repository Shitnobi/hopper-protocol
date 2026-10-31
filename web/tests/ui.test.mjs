// Screen policy that is easy to regress: no sound-test affordance belongs in
// the UI, and the demo chain's block-production controls are demo-only.
import * as screens from '../js/ui/screens.js';
import { GENESIS } from '../js/core/params.js';
import { Sound } from '../js/sound.js';
import { volumeFromRange } from '../js/ui/volume.js';

let checks = 0;
const ok = (cond, message) => {
  checks += 1;
  if (!cond) throw new Error(message);
};

const settings = (mode) => ({
  mode,
  addressBook: [],
  feeRate: 2,
  deepScan: false,
  volume: 0.5,
  mute: false,
});
const scanState = () => ({
  gapLimit: 20, gapExtra: 0, publicSource: true, lastPass: 0, lastTip: 0,
  nextAt: 0, auto: false, fails: 0, pending: 0, rescan: null, note: '',
});
const wallet = (mode) => ({ network: 'mainnet', settings: settings(mode), scanState });

const player = new Sound({ volume: 0.4, mute: false });
ok(typeof player.testTone === 'undefined', 'the sound player has no test-tone entry point');

// The settings fader is 0–100; the wallet gain is 0–1.
ok(volumeFromRange('55', '100') === 0.55, 'settings volume 55% is gain 0.55');
ok(volumeFromRange('0', '100') === 0, 'settings volume 0% is silence');
ok(volumeFromRange('100', '100') === 1, 'settings volume 100% is full gain');
ok(volumeFromRange('1', '100') === 0.01, 'settings volume 1% is not full gain');
ok(volumeFromRange('0.5', '1') === 0.5, 'a 0–1 fader keeps its gain');
ok(volumeFromRange('nope', '100') === null, 'invalid volume is refused');

const demo = wallet('demo');
const demoDrawer = screens.drawer({ w: demo, settings: demo.settings });
ok(!demoDrawer.includes('test-sound') && !demoDrawer.includes('TEST SOUND'), 'the drawer has no TEST SOUND button');
ok(demoDrawer.includes('data-sound-line') && demoDrawer.includes('menu-mute'), 'the drawer still shows sound state and mute');

const live = wallet('live');
const liveSettings = screens.settings({ w: live, settings: live.settings, scanArmed: false });
ok(!liveSettings.includes('test-sound'), 'settings has no TEST SOUND button');
ok(!liveSettings.includes('FAUCET') && !liveSettings.includes('data-action="mine"') && !liveSettings.includes('RESET DEMO'),
  'live settings hide the demo chain controls');
ok(liveSettings.includes('data-sound-line'), 'settings still shows the soundtrack state');
ok(!liveSettings.includes('data-input="fee-rate"') && !/Fee rate/.test(liveSettings),
  'the global fee-rate setting is gone; fee choice lives in each action');
ok(liveSettings.includes('AUTO RECOVERY PACKS') && liveSettings.includes('data-action="export-recovery"'),
  'settings offers the automatic recovery packs');

const demoSettings = screens.settings({ w: demo, settings: demo.settings, scanArmed: false });
ok(demoSettings.includes('FAUCET') && demoSettings.includes('MINE 1') && demoSettings.includes('MINE 6')
  && demoSettings.includes('RESET DEMO'), 'demo settings keep the demo chain controls');

const liveRoad = screens.road({ w: live, settings: live.settings, road: [] });
ok(!liveRoad.includes('data-action="mine"') && !liveRoad.includes('MINE 1'), 'live road has no block-production buttons');
const demoRoad = screens.road({ w: demo, settings: demo.settings, road: [] });
ok(demoRoad.includes('data-action="mine"') && demoRoad.includes('MINE 1') && demoRoad.includes('MINE 6'),
  'demo road keeps the block-production buttons');

// ---- fee picker and two-step send preview -----------------------------
const quoteApp = {
  w: { ...demo, balance: { spendable: 1_000_000 } },
  settings: { ...demo.settings, feeRate: 2 },
  feeQuote: {
    status: 'ready', fastestFee: 2.716, halfHourFee: 1.859, economyFee: 0.2,
    fetchedAt: Date.now(),
  },
};
const sendHtml = screens.sendSheet(quoteApp);
ok(sendHtml.includes('PREVIEW TRANSACTION') && !sendHtml.includes('data-action="do-send"'),
  'send offers PREVIEW TRANSACTION, not a direct SEND');
ok(sendHtml.includes('data-input="send-fee"'), 'send has an editable fee rate');
ok(['FAST', 'MEDIUM', 'SLOW'].every((x) => sendHtml.includes(`>${x}<`)), 'send shows Fast/Medium/Slow');
ok(sendHtml.includes('2.72 sat/vB') && sendHtml.includes('1.86 sat/vB') && sendHtml.includes('0.2 sat/vB'),
  'send displays fastestFee, halfHourFee and economyFee');
ok(sendHtml.includes('data-action="fee-choice" data-target="send-fee"'), 'fee choices fill the send field');

const transferHtml = screens.transferSheet(quoteApp, { sat: 7000000, name: 'Hopkinson', state: 'idle' });
ok(transferHtml.includes('PREVIEW TRANSACTION') && transferHtml.includes('data-action="preview-transfer"'),
  'Hopper transfer offers PREVIEW TRANSACTION');
ok(!transferHtml.includes('data-action="do-transfer"') && transferHtml.includes('data-input="transfer-fee"'),
  'Hopper transfer has no direct broadcast and has an editable fee rate');

const previewHtml = screens.txPreviewSheet(quoteApp, {
  kind: 'send', to: 'bcrt1qdestination', destinationAmount: 10000n,
  changeAddress: 'bcrt1qchange', changeAmount: 1234n,
  feeRate: 2, effectiveFeeRate: 2, fee: 282,
  built: { vsize: 141 },
});
ok(['Destination address', 'Destination amount', 'Change address', 'Change amount', 'Fee rate', 'Actual fee']
  .every((x) => previewHtml.includes(x)), 'preview names every transaction field');
ok(previewHtml.includes('10,000 sats') && previewHtml.includes('1,234 sats') && previewHtml.includes('282 sats'),
  'preview shows destination, change and actual fee amounts');
ok(previewHtml.includes('data-action="abort-preview"') && previewHtml.includes('data-action="do-approve-tx"'),
  'preview has cancel and approve actions');

const hopperPreview = screens.txPreviewSheet(quoteApp, {
  kind: 'transfer', to: 'bcrt1qhopperdest', destinationAmount: 6999718n,
  changeAddress: null, changeAmount: 0n, feeRate: 2, effectiveFeeRate: 2, fee: 282,
  built: { vsize: 141 },
});
ok(hopperPreview.includes('SEND HOPPER') && hopperPreview.includes('one output'),
  'Hopper preview explains that a transfer has no change output');

// ---- v7 road: three directions, fixed at approval ---------------------
const hopApp = { w: { ...demo, tipHeight: GENESIS }, settings: demo.settings };
const hopSheet = screens.crossSheet(hopApp, {
  sat: 7000000, name: 'Hopkinson', dist: 2, gen: 1, state: 'idle',
});
for (const [dir, label] of [[0, 'LEFT'], [1, 'STRAIGHT'], [2, 'RIGHT']]) {
  ok(hopSheet.includes(`data-dir="${dir}"`), `hop sheet offers ${label}`);
}
ok(hopSheet.includes('one direction for') && hopSheet.includes('dies'),
  'the sheet states the block-wide rule');
ok(hopSheet.includes('33.33%') && hopSheet.includes('one of three'),
  'the sheet states the one-in-three hop risk');
ok(hopSheet.includes('review the destination, change and fee'), 'the chooser says what the signed preview will show');
ok(!hopSheet.includes('Death at target'), 'the v6 death table is gone');

const settingsHtml = screens.settings({ w: live, settings: live.settings, scanArmed: false });
ok(settingsHtml.includes('HOPPER v7') && settingsHtml.includes('WIRE 0x07'), 'the footer names v7');
ok(settingsHtml.includes('data-input="spendUnconfirmed"'), 'settings offers the unconfirmed-spend control');
ok(settingsHtml.includes('DOWNLOAD HISTORY TXT'), 'settings hosts the history download');
ok(settingsHtml.includes('USE MEMPOOL.SPACE') && settingsHtml.includes('data-url="https://mempool.space/api"'),
  'settings offers the mempool.space preset');
ok(!settingsHtml.includes('data-action="copy-history-debug"'),
  'the old history copy action is gone');

// The rules are player-facing copy: keep the road's wording exact.
const rulesText = screens.RULES.flatMap((page) => page.lines).join('\n');
ok(rulesText.includes('You cannot take a hop back.'), 'rules page 3 says hop, not Hopper');
ok(!rulesText.includes('You cannot take a Hopper back.'), 'rules no longer tell players they cannot take a Hopper back');
ok(rulesText.includes('nothing on the blockchain can kill it after that.'), 'rules page 4 names the blockchain');
ok(rulesText.includes('The next block picks which direction the cars drive in:'), 'rules page 6 uses the car direction');
ok(rulesText.includes('Every hop is in one of three directions that cars could drive in'), 'rules page 7 uses the car direction');
ok(!rulesText.includes('picks one direction for the whole block') && !rulesText.includes('against a block that picks one'),
  'the old block-wide direction wording is gone');

const emergencySettings = screens.settings({ w: demo, settings: demo.settings, scanArmed: false });
ok(emergencySettings.includes('EXPORT EMERGENCY DESCRIPTORS')
  && emergencySettings.includes('data-action="export-emergency"'),
  'settings offers the emergency descriptor export');
const warn = screens.emergencyWarning();
ok(warn.includes('Never contains') && warn.includes('seed') && warn.includes('SHOW THE EXPORT'),
  'the export sits behind a confirmation that names what it never contains');
const exported = screens.emergencySheet({ w: demo }, {
  type: 'hopper-v7-emergency', version: 1, network: 'regtest',
  fingerprint: 'deadbeef', owner_path: "m/84'/1'/0'/2/0",
  descriptor: null, generated_at: '2026-10-30T00:00:00Z', tip_height: 100,
  frogs: [{
    sat: 1, gen: 1, dist: 0, state: 'idle', name: 'A', mint_id: 'aai0',
    state_outpoint: 'aa:0', state_value: 25000, owner_xonly: '11'.repeat(32),
    internal_key: '22'.repeat(32), output_key: '33'.repeat(32),
    leaves: [], send_leaf: {}, descriptor: 'tr(22,{raw(00),raw(01),raw(02),raw(03)})#89f8spxm',
  }],
});
ok(exported.includes('data-emergency-json') && exported.includes('COPY JSON'),
  'the export sheet shows the JSON and a copy button');
ok(exported.includes('Snapshot only'), 'the sheet warns that a spent outpoint is stale');

// The signed HOP review is the only thing a player can approve; it shows
// the destination, change and actual fee that the old choose-only sheet
// could not (SPEC §3.6).
const hopReview = screens.hopReviewSheet(
  { w: { ...demo, tipHeight: GENESIS } },
  {
    kind: 'hop', dir: 1, gen: 2, dist: 3, leafHex: 'ab'.repeat(161),
    to: 'bcrt1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp8x0kz',
    destinationAmount: 25000n, changeAddress: 'bcrt1qchange0000000000000000000000000000',
    changeAmount: 4321n, feeRate: 2, fee: 456n, vsize: 320,
  },
);
ok(hopReview.includes('HOP STRAIGHT') && hopReview.includes('Destination address'),
  'the review names the direction and the destination');
ok(hopReview.includes('Leaf spent') && hopReview.includes('dir 1'), 'the review names the leaf and the direction byte');
ok(hopReview.includes('Actual fee') && hopReview.includes('Change amount'),
  'the review shows the actual fee and the change');
ok(hopReview.includes('APPROVING BROADCASTS THIS EXACT SIGNED TRANSACTION'),
  'the review warns that approval broadcasts these bytes');
ok(hopReview.includes('data-action="do-approve-tx"') && !hopReview.includes('do-cross'),
  'the signed review approves the built transaction, not a fresh build');

console.log(`ui: ${checks} checks passed (fee/preview/road/emergency/hop)`);
