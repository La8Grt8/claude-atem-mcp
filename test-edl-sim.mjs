// Simulated switcher test for the EDL logger: node test-edl-sim.mjs
import { EventEmitter } from 'events';
import { EdlLogger, framesToTc, tcToFrames } from './dist/services/edl-logger.js';
import { promises as fs } from 'fs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const me = { programInput: 1, previewInput: 2, transitionPosition: { inTransition: false },
  transitionProperties: { style: 0 }, transitionSettings: { mix: { rate: 30 } } };
const atem = new EventEmitter();
atem.state = { settings: { videoMode: 11 }, video: { mixEffects: [me] }, inputs: {
  1: { shortName: 'CAM1', longName: 'Host Wide' }, 2: { shortName: 'CAM2', longName: 'Guest' },
  3: { shortName: 'CAM3', longName: 'Two Shot' }, 10010: { shortName: 'Blk', longName: 'Black' } } };
atem.requestTime = async () => { setTimeout(() => atem.emit('updatedTime', { hour: 14, minute: 59, second: 58, frame: 0, dropFrame: true }), 20); };
const emit = () => atem.emit('stateChanged', atem.state, ['video.mixEffects.0']);

// timecode math sanity (29.97 DF): 00:10:00;00 = 17982 frames; 00:01:00;02 is first frame after 00:00:59;29
console.assert(tcToFrames(0, 10, 0, 0, 30, true) === 17982, 'DF 10min');
console.assert(framesToTc(1800, 30, true) === '00:01:00:02', 'DF minute skip ' + framesToTc(1800, 30, true));
console.assert(framesToTc(tcToFrames(1, 23, 45, 12, 30, true), 30, true) === '01:23:45:12', 'DF roundtrip');

const log = new EdlLogger();
console.log('start ->', await log.start(atem, { title: 'Sim Podcast Ep 1', outputDir: '/tmp/edl-test' }));
await sleep(2000); me.programInput = 2; me.previewInput = 1; emit();                 // cut to CAM2
await sleep(1500); me.previewInput = 3; me.transitionPosition.inTransition = true; emit();  // start 1s mix
await sleep(1000); me.programInput = 3; me.previewInput = 2; me.transitionPosition.inTransition = false; emit();
await sleep(800);  console.log('marker ->', await log.addMarker('Great laugh | clip for social'));
await sleep(700);  me.transitionPosition.inTransition = true; emit();                // T-bar pulled then aborted
await sleep(300);  me.transitionPosition.inTransition = false; emit();
await sleep(1500); me.programInput = 1; emit();                                      // cut back to CAM1
await sleep(1000); me.programInput = 10010; emit();                                  // cut to black
await sleep(500);
console.log('status ->', log.status());
console.log('stop ->', await log.stop());
for (const f of (await fs.readdir('/tmp/edl-test')).sort()) {
  console.log(`\n===== ${f}`); if (f.endsWith('.edl')) console.log(await fs.readFile('/tmp/edl-test/' + f, 'utf8'));
}
