// Prints the play-script lines that fly a round: a greedy bot over the
// unchanged rules (js/rules.js) that flaps whenever the bird has sunk below
// the centre of the next gap (or of the sky, with no gate ahead) and is
// falling, as Space presses with the waits between them. The round clock is
// the runtime's fixed steps, one tick a frame in a render check, and the
// rules wait in "ready" until the first flap, so only the frames between
// presses matter: a press acts at the start of its first frame, and each
// `key Space 2` takes two frames. The planned score is the one the run gets,
// so a script can expect it.
//   node tools/plan.mjs <content id> [--flaps N] [--crash-after GATES]
// --flaps N stops after N flaps (a lesson's flap goal); --crash-after GATES
// stops flapping once that many gates are passed (the bird falls into the sea).
import { createSession, applyCommand, step, gateGapY } from '../js/rules.js';
import { JOURNEY, LESSONS, CHALLENGES, PRACTICE_PRESETS } from '../js/content.js';

const args = process.argv.slice(2);
const id = args[0] || 'learn-1';
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : null; };
const maxFlaps = opt('--flaps');
const crashAfter = opt('--crash-after');
const all = [...JOURNEY, ...LESSONS, ...CHALLENGES, ...PRACTICE_PRESETS];
const cfg = all.find((c) => c.id === id);
if (!cfg) { console.error(`no content ${id}`); process.exit(1); }

let s = createSession(cfg);
const lines = [];
let flaps = 0;
let last = null;
const flapNow = () => {
  const r = applyCommand(s, { id: `p${flaps + 1}`, tick: s.tick, type: 'flap' });
  s = r.state;
  flaps++;
  lines.push(last == null ? 'key Space 2' : `frames ${s.tick - last - 2}\nkey Space 2`);
  last = s.tick;
};
flapNow();
for (let guard = 0; s.phase !== 'terminal' && guard < 60 * 600; guard++) {
  const ahead = s.gates.find((g) => !g.passed && g.x > -1.2);
  const target = ahead && ahead.x < 10 ? gateGapY(s.config, ahead, s.tick) : 0;
  const stop = (maxFlaps != null && flaps >= maxFlaps) || (crashAfter != null && s.gatesPassed >= crashAfter);
  // a press needs two frames; never two presses closer than 3 ticks
  if (!stop && s.bird.y < target - 0.7 && s.bird.vy <= 0 && s.tick - last >= 3) flapNow();
  const r = step(s);
  s = r.state;
}
console.log(`# ${id}: ${s.terminal ? s.terminal.reason : 'running'} at tick ${s.tick}, ${flaps} flaps, ${s.gatesPassed} gates, score ${s.score.total}`);
console.log(lines.join('\n'));
