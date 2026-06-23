// Regression test for the three bugs found in code review (2026-06-23):
//  1. "Manager-Approved Below Floor" was written 'Y' at log time, before any approval.
//  2. Turn-downs were keyed off outcome==='Disinterested' summing a field that's always
//     blank for non-signed rows, so turnDownRevenue was always 0.
//  3. Gross revenue only summed Contract Amount, dropping gutters/siding/added-work $.
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

t('sub-floor deal does not mark Manager-Approved Below Floor at log time', () => {
  const d = { outcome: 'Contract Signed', contractAmount: 10000, costPerSquare: 579, date: '2026-06-23' };
  const calc = sandbox.commission_(d);
  const row = sandbox.rowFromData_('D1', 'Chris Jones', d, calc, new Date(0));
  assert.strictEqual(row[26], 'N');
  assert.strictEqual(row[24], ''); // Commission Rate stays blank until approved
});

t('manager override clears pendingApproval on commission_', () => {
  const d = { outcome: 'Contract Signed', contractAmount: 10000, costPerSquare: 579, overrideRate: 0.05, date: '2026-06-23' };
  const calc = sandbox.commission_(d);
  assert.strictEqual(calc.pendingApproval, false);
  assert.strictEqual(calc.roofCommission, 500);
});

t('rollup_ counts gutters/siding/added-work in gross revenue, and financing denials as turn-downs', () => {
  const signed = { outcome: 'Contract Signed', contractAmount: 20000, costPerSquare: 630, guttersIncluded: true, gutterLf: 50, gutterPricePerLf: 8, date: '2026-06-23' };
  const rowSigned = sandbox.rowFromData_('D1', 'Chris Jones', signed, sandbox.commission_(signed), new Date(0));
  const denied = { outcome: 'Follow-up Needed', financingResult: 'Denied', deniedAmount: 15000, date: '2026-06-23' };
  const rowDenied = sandbox.rowFromData_('D2', 'Chris Jones', denied, sandbox.commission_(denied), new Date(0));

  sandbox.sheet_ = (name) => ({
    getDataRange: () => ({ getValues: () => ({ Dispositions: [[], rowSigned, rowDenied], DoorsKnocked: [[]] }[name]) }),
  });

  const totals = sandbox.rollup_('2026-06-23', '2026-06-23', '');
  assert.strictEqual(totals.grossRevenue, 20400); // 20000 contract + 50*8 gutters
  assert.strictEqual(totals.turnDownCount, 1);
  assert.strictEqual(totals.turnDownRevenue, 15000);
});

if (process.exitCode) console.error('\nFAILURES ABOVE');
else console.log('\nall rollup regression tests passed');
