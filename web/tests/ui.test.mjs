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

console.log(`ui: ${checks} checks passed`);
