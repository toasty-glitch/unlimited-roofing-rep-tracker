// Tests for the pure dashboard v2 helpers in Code.gs (no Apps Script API calls, so they run
// here under plain Node via vm, same technique as rollup.test.js): compareWindow_ (prior
// equal-length period math), delta_ (diff/pct-change/direction), goalPct_ (0-100 clamp).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

function t(name, fn) {
  try { fn(); console.log('ok -', name); }
  catch (e) { console.error('FAIL -', name, '\n  ', e.message); process.exitCode = 1; }
}

t('compareWindow_ gives the immediately-prior equal-length window for a multi-day range', () => {
  const { compareStart, compareEnd } = sandbox.compareWindow_('2026-06-10', '2026-06-23'); // 14 days
  assert.strictEqual(compareEnd, '2026-06-09');
  assert.strictEqual(compareStart, '2026-05-27'); // 14 days ending 06-09
});

t('compareWindow_ handles a single-day range', () => {
  const { compareStart, compareEnd } = sandbox.compareWindow_('2026-06-23', '2026-06-23');
  assert.strictEqual(compareEnd, '2026-06-22');
  assert.strictEqual(compareStart, '2026-06-22');
});

t('compareWindow_ crosses a month boundary correctly', () => {
  const { compareStart, compareEnd } = sandbox.compareWindow_('2026-06-01', '2026-06-05'); // 5 days
  assert.strictEqual(compareEnd, '2026-05-31');
  assert.strictEqual(compareStart, '2026-05-27');
});

t('delta_ reports direction and percent change', () => {
  // plain-field checks, not deepStrictEqual: sandbox objects come from a separate vm
  // realm so their prototype differs from objects created in this file.
  const up = sandbox.delta_(120, 100);
  assert.strictEqual(up.diff, 20); assert.strictEqual(up.pctChange, 20); assert.strictEqual(up.dir, 'up');
  const down = sandbox.delta_(80, 100);
  assert.strictEqual(down.diff, -20); assert.strictEqual(down.pctChange, -20); assert.strictEqual(down.dir, 'down');
  const flat = sandbox.delta_(100, 100);
  assert.strictEqual(flat.diff, 0); assert.strictEqual(flat.pctChange, 0); assert.strictEqual(flat.dir, 'flat');
});

t('delta_ treats a zero prior value as a 100% increase when current is nonzero, 0% when also zero', () => {
  assert.strictEqual(sandbox.delta_(50, 0).pctChange, 100);
  assert.strictEqual(sandbox.delta_(0, 0).pctChange, 0);
});

t('goalPct_ clamps to 0-100 and divides by zero safely', () => {
  assert.strictEqual(sandbox.goalPct_(2500, 5000), 50);
  assert.strictEqual(sandbox.goalPct_(6000, 5000), 100); // over-goal clamps at 100
  assert.strictEqual(sandbox.goalPct_(-10, 5000), 0); // negative clamps at 0
  assert.strictEqual(sandbox.goalPct_(100, 0), 0); // no target -> 0, not Infinity/NaN
});

if (process.exitCode) console.error('\nFAILURES ABOVE');
else console.log('\nall dashboard helper tests passed');
