// Screen policy that is easy to regress: no sound-test affordance belongs in
// the UI, and the demo chain's block-production controls are demo-only.
import * as screens from '../js/ui/screens.js';
import { Sound } from '../js/sound.js';

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

console.log(`ui: ${checks} checks passed (fee/preview)`);
