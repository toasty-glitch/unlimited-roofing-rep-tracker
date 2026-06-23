# Roofing Rep Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone roofing-division rep tracker (PWA + Apps Script + Sheet) per `docs/superpowers/specs/2026-06-22-roofing-rep-tracker-design.md`, mirroring the architecture of the existing UHS bathroom-division `rep-tracker`.

**Architecture:** Single-paste `apps-script/Code.gs` Apps Script web app (auto-creates its Sheet on first call) behind a vanilla static PWA (`pwa/index.html` + `sw.js` + `manifest.json`, no build step) deployed to GitHub Pages. Commission math lives in pure, GAS-global-free functions so it can be unit-tested from Node without deploying.

**Tech Stack:** Google Apps Script (V8 runtime), vanilla HTML/CSS/JS PWA, Google Sheets as the datastore, Node.js (`vm`/`assert`, no deps) for the one automated test.

**Two schema additions beyond the approved spec** (both already merged into the spec doc, commit `b7e0dd4`):
- `Siding $/Sqft` — spec had `Siding Sqft` but no dollar rate; added as a rep-entered field mirroring `Gutter LF` × `Gutter $/LF`.
- `Closed On Follow-up (Y/N)` — needed to distinguish "one-call close" vs "follow-up contract" in the nightly numbers; the spec lists both as separate computed categories but had no field to tell them apart on a signed row. This task adds it now (not spec-gated) since it's a low-stakes, reversible UI/schema addition, not a financial calculation — flagging here rather than re-opening the spec for it.

Final `Dispositions` column order (38 cols, 0-based indices used throughout the code below):
```
0 Timestamp                          13 Cash Amount                  26 Gutter LF
1 Date                               14 Down Payment                 27 Gutter $/LF
2 Rep                                15 Applied Financing (Y/N)      28 Siding Included (Y/N)
3 Customer Name                      16 Financing Result             29 Siding Sqft
4 Customer Phone                     17 Financing Source             30 Siding $/Sqft
5 Lead Source                        18 Approved Amount              31 Added Work Amount
6 Appointment Outcome                19 Denied Amount                32 Closed On Follow-up (Y/N)
7 Presented Price/Products/Hour(Y/N) 20 Square Count                 33 Flat-Rate Commission $
8 Out-of-Scope Reason                21 Cost Per Square              34 Total Commission $
9 Follow-up Date                     22 Commission Rate              35 CRMX Screenshot Uploaded (Y/N)
10 Signed (Y/N/Type)                 23 Roof Commission $            36 Appointment Confirmed (Y/N)
11 No-Sign Reason                    24 Manager-Approved Below Floor 37 Qualified Sit (Y/N)
12 Contract Amount                   25 Gutters Included (Y/N)
```

`DoorsKnocked`: `Timestamp, Date, Rep, Tap Count` (one row per sync batch).
`Reps`: `Rep ID, Name, Password Hash, Role, Active, Created` (same shape as the bathroom tracker).

---

### Task 1: Commission engine — TDD, pure functions

**Files:**
- Create: `apps-script/Code.gs` (commission section only this task)
- Test: `test/commission.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/commission.test.js
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

t('rate floor blocks at $579', () => assert.strictEqual(sandbox.roofCommissionRate_(579), null));
t('rate 5% at $580', () => assert.strictEqual(sandbox.roofCommissionRate_(580), 0.05));
t('rate 5% at $599', () => assert.strictEqual(sandbox.roofCommissionRate_(599), 0.05));
t('rate 7.5% at $600', () => assert.strictEqual(sandbox.roofCommissionRate_(600), 0.075));
t('rate 7.5% at $629', () => assert.strictEqual(sandbox.roofCommissionRate_(629), 0.075));
t('rate 10% at $630', () => assert.strictEqual(sandbox.roofCommissionRate_(630), 0.10));

t('below-floor deal is pending with blank commission', () => {
  const c = sandbox.computeCommission_({contractAmount: 10000, costPerSquare: 579});
  assert.strictEqual(c.pending, true);
  assert.strictEqual(c.roofCommission, 0);
  assert.strictEqual(c.rate, '');
});

t('manager override clears pending and sets approved flag', () => {
  const c = sandbox.computeCommission_({contractAmount: 10000, costPerSquare: 579, managerOverrideRate: 0.05});
  assert.strictEqual(c.pending, false);
  assert.strictEqual(c.roofCommission, 500);
  assert.strictEqual(c.managerApprovedBelowFloor, 'Y');
});

t('flat-rate commission covers gutters + siding + added work', () => {
  const c = sandbox.computeCommission_({
    contractAmount: 0, costPerSquare: 650,
    guttersIncluded: true, gutterLF: 100, gutterRate: 8,
    sidingIncluded: true, sidingSqft: 200, sidingRate: 4,
    addedWorkAmount: 300,
  });
  assert.strictEqual(c.guttersAmt, 800);
  assert.strictEqual(c.sidingAmt, 800);
  assert.strictEqual(c.flatCommission, 190); // (800+800+300)*0.10
  assert.strictEqual(c.totalCommission, 190);
});

t('total commission sums roof + flat', () => {
  const c = sandbox.computeCommission_({
    contractAmount: 20000, costPerSquare: 630,
    guttersIncluded: true, gutterLF: 50, gutterRate: 8,
  });
  assert.strictEqual(c.roofCommission, 2000); // 20000*0.10
  assert.strictEqual(c.flatCommission, 40);   // (50*8)*0.10
  assert.strictEqual(c.totalCommission, 2040);
});

if (process.exitCode) console.error('\nFAILURES ABOVE');
else console.log('\nall commission tests passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/commission.test.js`
Expected: throws reading `apps-script/Code.gs` (file does not exist yet).

- [ ] **Step 3: Create `apps-script/Code.gs` with just the commission engine**

```js
/**
 * UHS Roofing Rep Tracker — Apps Script backend
 * Deploy: paste this whole file into a script.new project. See SETUP.md.
 * All requests: POST JSON { action, token?, ...payload } → JSON response.
 */

// ---------- commission engine (pure — no GAS globals, kept testable from Node) ----------
function roofCommissionRate_(costPerSquare) {
  if (costPerSquare < 580) return null; // blocks auto-rate; requires manager approval
  if (costPerSquare < 600) return 0.05;
  if (costPerSquare < 630) return 0.075;
  return 0.10;
}
const FLAT_RATE = 0.10; // gutters, siding, added work — always, no exceptions

function round2_(n) { return Math.round(n * 100) / 100; }

function computeCommission_(d) {
  const costPerSquare = Number(d.costPerSquare) || 0;
  const autoRate = roofCommissionRate_(costPerSquare);
  const overrideRate = d.managerOverrideRate != null ? Number(d.managerOverrideRate) : null;
  const rate = overrideRate != null ? overrideRate : autoRate;
  const pending = rate == null;
  const contractAmount = Number(d.contractAmount) || 0;
  const roofCommission = pending ? 0 : round2_(contractAmount * rate);
  const guttersAmt = d.guttersIncluded ? round2_((Number(d.gutterLF) || 0) * (Number(d.gutterRate) || 0)) : 0;
  const sidingAmt = d.sidingIncluded ? round2_((Number(d.sidingSqft) || 0) * (Number(d.sidingRate) || 0)) : 0;
  const addedWork = Number(d.addedWorkAmount) || 0;
  const flatCommission = round2_((guttersAmt + sidingAmt + addedWork) * FLAT_RATE);
  const totalCommission = round2_(roofCommission + flatCommission);
  return {
    rate: pending ? '' : rate, pending, roofCommission, guttersAmt, sidingAmt, flatCommission, totalCommission,
    managerApprovedBelowFloor: overrideRate != null ? 'Y' : '',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/commission.test.js`
Expected: all six `ok -` lines, then `all commission tests passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add apps-script/Code.gs test/commission.test.js
git commit -m "feat: roofing commission engine with floor + override logic"
```

---

### Task 2: Data model, plumbing, auth, rep seeding

**Files:**
- Modify: `apps-script/Code.gs` (append after the commission engine section)

- [ ] **Step 1: Append the data model + plumbing + auth code**

```js
const SS_PROP = 'ROOF_SPREADSHEET_ID';
const SALT_PROP = 'ROOF_SALT';
const SEED_PASSWORD = 'Roofing2026!'; // ponytail: temp password for all seeded accounts — admin must Reset Password per rep via Team tab before go-live

const TABS = {
  Dispositions: ['Timestamp','Date','Rep','Customer Name','Customer Phone','Lead Source','Appointment Outcome',
    'Presented Price/Products/Hour (Y/N)','Out-of-Scope Reason','Follow-up Date',
    'Signed (Y/N/Type)','No-Sign Reason','Contract Amount','Cash Amount','Down Payment',
    'Applied Financing (Y/N)','Financing Result','Financing Source','Approved Amount','Denied Amount',
    'Square Count','Cost Per Square','Commission Rate','Roof Commission $',
    'Manager-Approved Below Floor (Y/N)','Gutters Included (Y/N)','Gutter LF','Gutter $/LF',
    'Siding Included (Y/N)','Siding Sqft','Siding $/Sqft','Added Work Amount','Closed On Follow-up (Y/N)',
    'Flat-Rate Commission $','Total Commission $','CRMX Screenshot Uploaded (Y/N)',
    'Appointment Confirmed (Y/N)','Qualified Sit (Y/N)'],
  DoorsKnocked: ['Timestamp','Date','Rep','Tap Count'],
  Reps: ['Rep ID','Name','Password Hash','Role','Active','Created'],
};

const OUTCOMES = ['No Show','Rescheduled','Out of Scope','Disinterested','Cancelled','Follow-up Needed','Contract Signed'];
const LEAD_SOURCES = ['Company Lead','Self-Gen','Door Knock','Referral','Other'];
const SEED_REPS = [
  ['Chris Jones','rep'], ['Dave Kershaw','rep'], ['Sheldon Stimeling','rep'], ['Andrew Fielder','rep'], ['James Meadows','rep'],
  ['Stacy Clark','admin'], ['Jessica Henson','admin'], ['Ted Beedle','admin'],
];

// ---------- plumbing ----------
function ss_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(SS_PROP);
  let ss;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { id = null; } }
  if (!id) {
    ss = SpreadsheetApp.create('UHS Roofing Rep Tracker — 2026');
    props.setProperty(SS_PROP, ss.getId());
  }
  Object.keys(TABS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(TABS[name]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, TABS[name].length).setFontWeight('bold');
    }
  });
  const reps = ss.getSheetByName('Reps');
  if (reps.getLastRow() === 1) seedReps_(reps); // first run only
  const d = ss.getSheetByName('Sheet1'); if (d) ss.deleteSheet(d);
  return ss;
}

function seedReps_(sh) {
  SEED_REPS.forEach(([name, role], i) => {
    sh.appendRow(['R' + String(i + 1).padStart(3, '0'), name, hash_(SEED_PASSWORD), role, true, new Date()]);
  });
}

function salt_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty(SALT_PROP);
  if (!s) { s = Utilities.getUuid(); props.setProperty(SALT_PROP, s); }
  return s;
}
function hash_(pw) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pw + salt_());
  return raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

// ---------- sessions (CacheService, 12h) ----------
function makeToken_(repId, name, role) {
  const t = Utilities.getUuid();
  CacheService.getScriptCache().put('tok_' + t, JSON.stringify({repId, name, role}), 21600);
  return t;
}
function session_(token) {
  if (!token) return null;
  const v = CacheService.getScriptCache().get('tok_' + token);
  return v ? JSON.parse(v) : null;
}

// ---------- rep lookup ----------
function repsSheet_() { return ss_().getSheetByName('Reps'); }
function findRep_(name) {
  const rows = repsSheet_().getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]).toLowerCase() === String(name).toLowerCase() && rows[i][4] === true) {
      return { row: i + 1, repId: rows[i][0], name: rows[i][1], hash: rows[i][2], role: rows[i][3] };
    }
  }
  return null;
}
function findRepAny_(name) {
  const rows = repsSheet_().getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]).toLowerCase() === String(name).toLowerCase()) {
      return { row: i + 1, repId: rows[i][0], name: rows[i][1], hash: rows[i][2], role: rows[i][3], active: rows[i][4] };
    }
  }
  return null;
}

// ---------- utils ----------
function today_() { return Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd'); }
function fmt_(v) { return v instanceof Date ? Utilities.formatDate(v, 'America/New_York', 'yyyy-MM-dd') : String(v); }
function doGet() { return ContentService.createTextOutput('Roofing Rep Tracker API is up.'); }
```

- [ ] **Step 2: Re-run the commission test to confirm nothing broke**

Run: `node test/commission.test.js`
Expected: still all passing — this step adds no GAS calls at load time (only `const`/`function` declarations), so the `vm` sandbox load is unaffected.

- [ ] **Step 3: Commit**

```bash
git add apps-script/Code.gs
git commit -m "feat: roofing tracker data model, auth, and rep seeding"
```

---

### Task 3: doPost dispatcher, login, logAppointment

**Files:**
- Modify: `apps-script/Code.gs` (append)

- [ ] **Step 1: Append the dispatcher and the two actions**

```js
// ---------- API ----------
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ok:false, error:'bad json'}); }
  const a = req.action;
  try {
    if (a === 'login') return login_(req);
    const sess = session_(req.token);
    if (!sess) return json_({ok:false, error:'auth', authExpired:true});
    if (a === 'logAppointment')  return logAppointment_(req, sess);
    if (a === 'getToday')        return getToday_(req, sess);
    if (a === 'tapDoor')         return tapDoor_(req, sess);
    if (a === 'getHistory')      return getHistory_(req, sess);
    if (a === 'editAppointment') return editAppointment_(req, sess);
    // admin-only
    if (sess.role !== 'admin') return json_({ok:false, error:'admin only'});
    if (a === 'adminTeamRollup') return adminTeamRollup_(req);
    if (a === 'adminManageRep')  return adminManageRep_(req, sess);
    return json_({ok:false, error:'unknown action'});
  } catch (err) {
    return json_({ok:false, error: String(err)});
  }
}

function login_(req) {
  const rep = findRep_(req.name);
  if (!rep || rep.hash !== hash_(req.password)) return json_({ok:false, error:'Invalid name or password'});
  return json_({
    ok:true, token: makeToken_(rep.repId, rep.name, rep.role), me:{repId:rep.repId, name:rep.name, role:rep.role},
    outcomes: OUTCOMES, leadSources: LEAD_SOURCES,
  });
}

function rowFor_(dateStr, repName, d, signed, comm) {
  return [
    new Date(), dateStr, repName, d.customerName || '', d.customerPhone || '', d.leadSource || '', d.outcome || '',
    d.presentedPriceProductsHour ? 'Y' : 'N', d.outOfScopeReason || '', d.followUpDate || '',
    signed ? (d.signedType || 'Y') : '', d.noSignReason || '',
    signed ? (Number(d.contractAmount) || 0) : '', signed ? (Number(d.cashAmount) || 0) : '', signed ? (Number(d.downPayment) || 0) : '',
    d.appliedFinancing ? 'Y' : 'N', d.financingResult || '', d.financingSource || '',
    Number(d.approvedAmount) || 0, Number(d.deniedAmount) || 0,
    signed ? (Number(d.squareCount) || 0) : '', signed ? (Number(d.costPerSquare) || 0) : '',
    comm.rate, comm.roofCommission, comm.managerApprovedBelowFloor,
    d.guttersIncluded ? 'Y' : 'N', Number(d.gutterLF) || 0, Number(d.gutterRate) || 0,
    d.sidingIncluded ? 'Y' : 'N', Number(d.sidingSqft) || 0, Number(d.sidingRate) || 0,
    Number(d.addedWorkAmount) || 0, d.closedOnFollowup ? 'Y' : 'N',
    comm.flatCommission, comm.totalCommission,
    d.crmxUploaded ? 'Y' : 'N', d.apptConfirmed ? 'Y' : 'N', d.qualifiedSit ? 'Y' : 'N',
  ];
}

function logAppointment_(req, sess) {
  const d = req.data || {};
  const dateStr = d.date || today_();
  const signed = d.outcome === 'Contract Signed';
  const comm = signed
    ? computeCommission_(d)
    : {rate:'', pending:false, roofCommission:0, guttersAmt:0, sidingAmt:0, flatCommission:0, totalCommission:0, managerApprovedBelowFloor:''};
  ss_().getSheetByName('Dispositions').appendRow(rowFor_(dateStr, sess.name, d, signed, comm));
  return json_({ok:true, commission: comm});
}
```

- [ ] **Step 2: Manual check (no Apps Script account available locally)**

Read through `rowFor_` against the 38-column layout in the plan header and confirm each array index lines up with the column comment — this is the step that catches an off-by-one before it ever reaches a live Sheet. (Full integration testing happens after deploy, in Task 10.)

- [ ] **Step 3: Re-run the commission test, then commit**

```bash
node test/commission.test.js
git add apps-script/Code.gs
git commit -m "feat: doPost dispatcher, login, logAppointment"
```

---

### Task 4: getToday, tapDoor, getHistory, editAppointment

**Files:**
- Modify: `apps-script/Code.gs` (append)

- [ ] **Step 1: Append entry-reading and editing logic**

```js
function entriesFor_(repName, from, to) {
  const sh = ss_().getSheetByName('Dispositions');
  const rows = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const dateStr = fmt_(rows[i][1]);
    if (rows[i][2] !== repName || dateStr < from || dateStr > to) continue;
    out.push({
      row: i + 1, date: dateStr, customerName: rows[i][3], outcome: rows[i][6],
      contractAmount: rows[i][12], totalCommission: rows[i][34],
      pendingApproval: rows[i][6] === 'Contract Signed' && rows[i][22] === '' && rows[i][24] !== 'Y',
    });
  }
  return out;
}

function getToday_(req, sess) {
  const dateStr = today_();
  return json_({ok:true, date: dateStr, totals: rangeTotals_(sess.name, dateStr, dateStr), entries: entriesFor_(sess.name, dateStr, dateStr)});
}

function tapDoor_(req, sess) {
  const count = Math.max(1, Number(req.count) || 1);
  ss_().getSheetByName('DoorsKnocked').appendRow([new Date(), today_(), sess.name, count]);
  return json_({ok:true});
}

function doorsCount_(repName, from, to) {
  const rows = ss_().getSheetByName('DoorsKnocked').getDataRange().getValues();
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const dateStr = fmt_(rows[i][1]);
    if (rows[i][2] === repName && dateStr >= from && dateStr <= to) n += Number(rows[i][3]) || 0;
  }
  return n;
}

function getHistory_(req, sess) {
  const from = req.from || today_();
  const to = req.to || today_();
  const repName = (sess.role === 'admin' && req.rep) ? req.rep : sess.name;
  return json_({ok:true, entries: entriesFor_(repName, from, to)});
}

function editAppointment_(req, sess) {
  const row = Number(req.row);
  const sh = ss_().getSheetByName('Dispositions');
  if (!row || row < 2 || row > sh.getLastRow()) return json_({ok:false, error:'not found'});
  const existing = sh.getRange(row, 1, 1, 3).getValues()[0]; // Timestamp, Date, Rep
  const dateStr = fmt_(existing[1]);
  if (sess.role !== 'admin') {
    if (existing[2] !== sess.name) return json_({ok:false, error:'not your entry'});
    if (dateStr !== today_()) return json_({ok:false, error:'same-day edits only'});
  }
  const d = req.data || {};
  if (sess.role !== 'admin') delete d.managerOverrideRate; // reps cannot self-approve below-floor deals
  const signed = d.outcome === 'Contract Signed';
  const comm = signed
    ? computeCommission_(d)
    : {rate:'', pending:false, roofCommission:0, guttersAmt:0, sidingAmt:0, flatCommission:0, totalCommission:0, managerApprovedBelowFloor:''};
  const newRow = rowFor_(d.date || dateStr, existing[2], d, signed, comm);
  newRow[0] = existing[0]; // keep original Timestamp
  sh.getRange(row, 1, 1, newRow.length).setValues([newRow]);
  return json_({ok:true, commission: comm});
}
```

- [ ] **Step 2: Re-run the commission test, then commit**

```bash
node test/commission.test.js
git add apps-script/Code.gs
git commit -m "feat: getToday, tapDoor, getHistory, editAppointment"
```

---

### Task 5: rangeTotals_, adminTeamRollup, adminManageRep

**Files:**
- Modify: `apps-script/Code.gs` (append)

- [ ] **Step 1: Append range aggregation + admin actions**

```js
function rangeTotals_(repName, from, to) {
  const out = {leadsIssued:0, demos:0, noOp:0, oneCallClose:0, followUpContracts:0, roofingAgreements:0,
    grossRevenue:0, turnDownCount:0, turnDownRevenue:0, doorsKnocked:0, commission:0, pendingApprovals:0};
  const rows = ss_().getSheetByName('Dispositions').getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const dateStr = fmt_(rows[i][1]);
    if (rows[i][2] !== repName || dateStr < from || dateStr > to) continue;
    out.leadsIssued++;
    const outcome = rows[i][6];
    if (outcome !== 'No Show' && outcome !== 'Rescheduled') out.demos++;
    if (outcome === 'Disinterested') out.noOp++;
    if (outcome === 'Contract Signed') {
      out.roofingAgreements++;
      if (rows[i][32] === 'Y') out.followUpContracts++; else out.oneCallClose++;
      const contractAmt = Number(rows[i][12]) || 0;
      const guttersAmt = rows[i][25] === 'Y' ? (Number(rows[i][26]) || 0) * (Number(rows[i][27]) || 0) : 0;
      const sidingAmt = rows[i][28] === 'Y' ? (Number(rows[i][29]) || 0) * (Number(rows[i][30]) || 0) : 0;
      const addedWork = Number(rows[i][31]) || 0;
      out.grossRevenue += contractAmt + guttersAmt + sidingAmt + addedWork;
      out.commission += Number(rows[i][34]) || 0;
      if (rows[i][22] === '' && rows[i][24] !== 'Y') out.pendingApprovals++;
    }
    if (rows[i][16] === 'Denied') { out.turnDownCount++; out.turnDownRevenue += Number(rows[i][19]) || 0; }
  }
  out.doorsKnocked = doorsCount_(repName, from, to);
  return out;
}

function listReps_() {
  const rows = repsSheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) out.push({repId: rows[i][0], name: rows[i][1], role: rows[i][3], active: rows[i][4]});
  return out;
}

function adminTeamRollup_(req) {
  const from = req.from || today_();
  const to = req.to || today_();
  const reps = repsSheet_().getDataRange().getValues();
  const team = [];
  const agg = {leadsIssued:0, demos:0, noOp:0, oneCallClose:0, followUpContracts:0, roofingAgreements:0,
    grossRevenue:0, turnDownCount:0, turnDownRevenue:0, doorsKnocked:0, commission:0, pendingApprovals:0};
  const pending = [];
  for (let i = 1; i < reps.length; i++) {
    if (reps[i][3] !== 'rep') continue; // only reps count toward team production
    const t = rangeTotals_(reps[i][1], from, to);
    team.push(Object.assign({rep: reps[i][1]}, t));
    Object.keys(agg).forEach(k => agg[k] += t[k] || 0);
    entriesFor_(reps[i][1], from, to).filter(e => e.pendingApproval).forEach(e => pending.push(Object.assign({rep: reps[i][1]}, e)));
  }
  return json_({ok:true, from, to, team, totals: agg, pending, reps: listReps_()});
}

function adminManageRep_(req, sess) {
  const op = req.op;
  if (op === 'add') {
    if (findRepAny_(req.name)) return json_({ok:false, error:'exists'});
    const sh = repsSheet_();
    const id = 'R' + String(sh.getLastRow()).padStart(3, '0');
    sh.appendRow([id, req.name, hash_(req.password), req.role === 'admin' ? 'admin' : 'rep', true, new Date()]);
    return json_({ok:true, repId: id});
  }
  const rep = findRepAny_(req.name);
  if (!rep) return json_({ok:false, error:'not found'});
  if (op === 'resetPassword') {
    if (!req.password) return json_({ok:false, error:'password required'});
    repsSheet_().getRange(rep.row, 3).setValue(hash_(req.password));
    return json_({ok:true});
  }
  if (op === 'deactivate' || op === 'reactivate') {
    if (rep.name === sess.name) return json_({ok:false, error:'cannot deactivate yourself'});
    repsSheet_().getRange(rep.row, 5).setValue(op === 'reactivate');
    return json_({ok:true});
  }
  return json_({ok:false, error:'unknown op'});
}
```

- [ ] **Step 2: Re-run the commission test, then commit — backend is now complete**

```bash
node test/commission.test.js
git add apps-script/Code.gs
git commit -m "feat: team rollup and rep management — backend complete"
```

---

### Task 6: PWA shell — login, nav, Today screen

**Files:**
- Create: `pwa/index.html` (this task: head/CSS/login/nav/Today only — Log/History/Team added in Tasks 7-8)

- [ ] **Step 1: Write the file**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1B2A41">
<link rel="manifest" href="manifest.json">
<link rel="apple-touch-icon" href="icon-192.png">
<title>UHS Roofing Rep Tracker</title>
<style>
:root{--navy:#1B2A41;--ink:#1A1F36;--slate:#5B6478;--ice:#D7E3F0;--gold:#D9622B;--bg:#F5F6F8;--line:#DCE3EE;--red:#C0392B;--green:#1E8E5A}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink);padding-bottom:84px}
header{background:var(--navy);color:#fff;padding:14px 16px;position:sticky;top:0;z-index:10;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:17px;font-weight:700}
header .who{font-size:12px;color:var(--ice)}
main{padding:14px;max-width:560px;margin:0 auto}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 2px 8px rgba(26,31,54,.06)}
.card h2{font-size:15px;margin-bottom:12px;color:var(--navy)}
label{display:block;font-size:12px;font-weight:600;color:var(--slate);margin:10px 0 4px}
input,select,textarea{width:100%;padding:11px;border:1px solid var(--line);border-radius:8px;font-size:16px;background:#fff}
textarea{min-height:64px}
.row{display:flex;gap:10px}.row>*{flex:1}
button{width:100%;padding:13px;border:0;border-radius:9px;background:var(--navy);color:#fff;font-size:16px;font-weight:700;margin-top:14px}
button.gold{background:var(--gold);color:#fff}
button.ghost{background:#fff;color:var(--navy);border:1.5px solid var(--navy)}
button:disabled{opacity:.5}
.chip{display:inline-block;width:auto;padding:9px 14px;margin:4px 4px 0 0;border-radius:99px;background:var(--bg);border:1.5px solid var(--line);color:var(--ink);font-size:13px;font-weight:600}
.chip.on{background:var(--navy);color:#fff;border-color:var(--navy)}
.chk{display:flex;align-items:center;gap:8px;margin-top:10px}
.chk input{width:auto}
nav{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid var(--line);display:flex;z-index:10;padding-bottom:env(safe-area-inset-bottom)}
nav button{flex:1;background:none;color:var(--slate);font-size:11px;font-weight:600;margin:0;padding:9px 0 7px;border-radius:0;display:flex;flex-direction:column;align-items:center;gap:3px}
nav button.on{color:var(--navy)}
nav .ic{font-size:20px;line-height:1}
.stat{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}
.stat:last-child{border:0}
.stat b{font-size:15px}
.big{font-size:26px;font-weight:800;color:var(--navy)}
.pos{color:var(--green)}.neg{color:var(--red)}.gold-t{color:var(--gold)}
.pill{display:inline-block;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:700;background:var(--ice);color:var(--navy)}
.toast{position:fixed;top:64px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;padding:10px 18px;border-radius:9px;font-size:14px;z-index:99;opacity:0;transition:opacity .25s}
.toast.show{opacity:1}
.hidden{display:none!important}
.tile{flex:1;background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:10px;text-align:center}
.tile .n{font-size:20px;font-weight:800;color:var(--navy)}
.tile .l{font-size:10px;color:var(--slate);font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.item{border:1px solid var(--line);border-radius:9px;padding:10px;margin-bottom:8px;font-size:13px}
.small{font-size:12px;color:var(--slate)}
#loginView main{max-width:380px;margin-top:8vh}
.logo{font-size:24px;font-weight:800;color:var(--navy);text-align:center;margin-bottom:2px}
.logo span{color:var(--gold)}
.sub{font-size:12px;color:var(--slate);text-align:center;margin-bottom:18px}
.doorbtn{font-size:18px;padding:22px;background:var(--gold)}
.doorcount{font-size:40px;font-weight:800;color:var(--navy);text-align:center;margin:6px 0}
</style>
</head>
<body>

<!-- LOGIN -->
<div id="loginView">
<main>
  <div class="card">
    <div class="logo">UHS Roofing <span>Rep Tracker</span></div>
    <div class="sub">Doors · dispositions · nightly numbers</div>
    <label>Name</label><input id="liName" autocomplete="username">
    <label>Password</label><input id="liPw" type="password" autocomplete="current-password">
    <button onclick="login()">Sign In</button>
    <div id="liErr" class="small" style="color:var(--red);margin-top:8px;text-align:center"></div>
  </div>
</main>
</div>

<!-- APP -->
<div id="appView" class="hidden">
<header><h1 id="hdrTitle">Today</h1><div class="who" id="who"></div></header>
<main>

  <!-- TODAY -->
  <section id="tab-today">
    <div class="card">
      <h2>Doors knocked today</h2>
      <div class="doorcount" id="doorCount">0</div>
      <button class="doorbtn" onclick="tapDoor()">+1 DOOR</button>
    </div>
    <div class="card">
      <h2>Today's numbers</h2>
      <div class="row" style="margin-bottom:10px">
        <div class="tile"><div class="n" id="tLeads">0</div><div class="l">Leads</div></div>
        <div class="tile"><div class="n" id="tDemos">0</div><div class="l">Demos</div></div>
        <div class="tile"><div class="n" id="tSigned">0</div><div class="l">Signed</div></div>
      </div>
      <div class="stat"><span>One-call close</span><b id="tOcc">0</b></div>
      <div class="stat"><span>Follow-up contracts</span><b id="tFuc">0</b></div>
      <div class="stat"><span>No-op</span><b id="tNoOp">0</b></div>
      <div class="stat"><span>Gross revenue</span><b class="pos" id="tGross">$0</b></div>
      <div class="stat"><span>Turn-downs</span><b class="neg" id="tTd">0 (<span id="tTdAmt">$0</span>)</b></div>
      <div class="stat"><span><b>Commission</b></span><span class="big gold-t" id="tComm">$0</span></div>
      <button class="gold" onclick="show('log')">+ Log Appointment</button>
    </div>
    <div class="card">
      <h2>Today's entries</h2>
      <div id="todayList" class="small">Loading…</div>
    </div>
  </section>

  <!-- placeholders filled by Tasks 7-8 -->
  <section id="tab-log" class="hidden"></section>
  <section id="tab-history" class="hidden"></section>
  <section id="tab-team" class="hidden"></section>

</main>
<nav>
  <button id="nav-today" class="on" onclick="show('today')"><span class="ic">🏠</span>Today</button>
  <button id="nav-log" onclick="show('log')"><span class="ic">📋</span>Log</button>
  <button id="nav-history" onclick="show('history')"><span class="ic">🕘</span>History</button>
  <button id="nav-team" class="hidden" onclick="show('team')"><span class="ic">📊</span>Team</button>
</nav>
</div>

<div class="toast" id="toast"></div>

<script>
// ====== CONFIG — paste your Apps Script Web App URL here before deploying ======
const DEFAULT_API = "PASTE_APPS_SCRIPT_WEB_APP_URL_HERE";
const API = localStorage.getItem('roof_api') || (new URLSearchParams(location.search).get('api')) || DEFAULT_API;
if (new URLSearchParams(location.search).get('api')) localStorage.setItem('roof_api', new URLSearchParams(location.search).get('api'));

let TOKEN = localStorage.getItem('roof_token') || '';
let ME = JSON.parse(localStorage.getItem('roof_me') || 'null');
let META = JSON.parse(localStorage.getItem('roof_meta') || 'null');
let pendingTaps = 0;
const TAP_BATCH = 5;

async function api(action, payload={}) {
  const body = JSON.stringify(Object.assign({action, token: TOKEN}, payload));
  const r = await fetch(API, {method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body});
  const j = await r.json();
  if (j.authExpired) { logout(); throw new Error('Session expired — sign in again.'); }
  if (!j.ok) throw new Error(j.error || 'Request failed');
  return j;
}
function toast(m, ms=2200){ const t=document.getElementById('toast'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), ms); }
const $ = id => document.getElementById(id);
const fmt$ = n => '$' + Number(n||0).toLocaleString(undefined,{maximumFractionDigits:0});

async function login(){
  $('liErr').textContent='';
  try{
    const j = await fetch(API, {method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'},
      body: JSON.stringify({action:'login', name:$('liName').value.trim(), password:$('liPw').value})}).then(r=>r.json());
    if(!j.ok) { $('liErr').textContent = j.error || 'Login failed'; return; }
    TOKEN=j.token; ME=j.me; META={outcomes:j.outcomes, leadSources:j.leadSources};
    localStorage.setItem('roof_token',TOKEN); localStorage.setItem('roof_me',JSON.stringify(ME)); localStorage.setItem('roof_meta',JSON.stringify(META));
    boot();
  }catch(e){ $('liErr').textContent='Cannot reach server. Check connection.'; }
}
function logout(){ TOKEN=''; ME=null; localStorage.removeItem('roof_token'); localStorage.removeItem('roof_me');
  $('appView').classList.add('hidden'); $('loginView').classList.remove('hidden'); }

async function boot(){
  $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden');
  $('who').textContent = ME.name + ' · tap to sign out';
  $('who').onclick = logout;
  if (ME.role === 'admin') $('nav-team').classList.remove('hidden');
  show('today');
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushTaps(); });
}

function show(t){
  ['today','log','history','team'].forEach(k=>{
    $('tab-'+k).classList.toggle('hidden', k!==t);
    $('nav-'+k).classList.toggle('on', k===t);
  });
  $('hdrTitle').textContent = {today:'Today', log:'Log Appointment', history:'History', team:'Team'}[t];
  if (t==='today') loadToday();
  if (t==='history') loadHistory && loadHistory();
  if (t==='team') loadTeam && loadTeam();
}

async function loadToday(){
  try{
    const j = await api('getToday');
    $('doorCount').textContent = j.totals.doorsKnocked;
    $('tLeads').textContent = j.totals.leadsIssued; $('tDemos').textContent = j.totals.demos; $('tSigned').textContent = j.totals.roofingAgreements;
    $('tOcc').textContent = j.totals.oneCallClose; $('tFuc').textContent = j.totals.followUpContracts; $('tNoOp').textContent = j.totals.noOp;
    $('tGross').textContent = fmt$(j.totals.grossRevenue);
    $('tTd').innerHTML = j.totals.turnDownCount; $('tTdAmt').textContent = fmt$(j.totals.turnDownRevenue);
    $('tComm').textContent = fmt$(j.totals.commission);
    $('todayList').innerHTML = j.entries.length ? j.entries.map(e=>`
      <div class="item" onclick="editEntry(${e.row})"><b>${e.customerName||'(no name)'}</b> · ${e.outcome}
      ${e.outcome==='Contract Signed' ? ' · '+fmt$(e.contractAmount)+' · '+fmt$(e.totalCommission)+' comm' : ''}
      ${e.pendingApproval ? ' <span class="pill" style="background:var(--gold);color:#fff">pending approval</span>' : ''}</div>`).join('')
      : 'No appointments logged yet today.';
  }catch(e){ toast(e.message); }
}

async function tapDoor(){
  $('doorCount').textContent = Number($('doorCount').textContent) + 1;
  pendingTaps++;
  if (pendingTaps >= TAP_BATCH) flushTaps();
}
async function flushTaps(){
  if (!pendingTaps) return;
  const n = pendingTaps; pendingTaps = 0;
  try{ await api('tapDoor', {count:n}); }catch(e){ pendingTaps += n; toast('Door taps queued — will retry'); }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
if (TOKEN && ME) boot();
</script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add pwa/index.html
git commit -m "feat: PWA shell — login, nav, Today screen"
```

---

### Task 7: Log Appointment screen

**Files:**
- Modify: `pwa/index.html` — replace the placeholder `<section id="tab-log" class="hidden"></section>` and append the matching JS before the closing `</script>`.

- [ ] **Step 1: Replace the placeholder section**

```html
<section id="tab-log" class="hidden">
  <div class="card">
    <h2>Log an appointment</h2>
    <div class="row"><div><label>Date</label><input id="lDate" type="date"></div></div>
    <label>Customer name</label><input id="lName">
    <label>Customer phone</label><input id="lPhone" inputmode="tel">
    <label>Lead source</label><select id="lSource"></select>
    <div class="chk"><input type="checkbox" id="lConfirmed"><label style="margin:0">Appointment confirmed</label></div>
    <div class="chk"><input type="checkbox" id="lQualified"><label style="margin:0">Qualified sit</label></div>
    <div class="chk"><input type="checkbox" id="lPresented"><label style="margin:0">Presented price/products/hour</label></div>

    <label>Outcome</label>
    <div id="lOutcomes"></div>

    <div id="lNonSale" class="hidden">
      <label>Reason</label><input id="lReason">
      <div id="lFollowupBlock" class="hidden"><label>Follow-up date</label><input id="lFollowupDate" type="date"></div>
    </div>

    <div id="lSold" class="hidden">
      <div class="row"><div><label>Square count</label><input id="lSquares" inputmode="numeric" oninput="commPreview()"></div>
      <div><label>Cost per square $</label><input id="lCostPerSq" inputmode="decimal" oninput="commPreview()"></div></div>
      <div class="row"><div><label>Contract amount $</label><input id="lContract" inputmode="decimal" oninput="commPreview()"></div>
      <div><label>Cash amount $</label><input id="lCash" inputmode="decimal"></div></div>
      <label>Down payment $</label><input id="lDown" inputmode="decimal">
      <label>Signed type (optional)</label><input id="lSignedType" placeholder="Y">
      <div class="chk"><input type="checkbox" id="lClosedFollowup"><label style="margin:0">Closed on a follow-up visit</label></div>
      <div class="item" id="commBox" style="margin-top:10px;border-style:dashed">Commission: —</div>

      <div class="chk"><input type="checkbox" id="lFinancing" onchange="toggleFinancing()"><label style="margin:0">Applied financing</label></div>
      <div id="financeBlock" class="hidden">
        <label>Financing result</label><select id="lFinResult"><option>Approved</option><option>Denied</option><option>Partial</option></select>
        <label>Financing source</label><input id="lFinSource">
        <div class="row"><div><label>Approved amount $</label><input id="lApproved" inputmode="decimal"></div>
        <div><label>Denied amount $</label><input id="lDenied" inputmode="decimal"></div></div>
      </div>

      <div class="chk"><input type="checkbox" id="lGutters" onchange="toggleGutters()"><label style="margin:0">Gutters included</label></div>
      <div id="guttersBlock" class="hidden row">
        <div><label>Gutter LF</label><input id="lGutterLF" inputmode="decimal" oninput="commPreview()"></div>
        <div><label>Gutter $/LF</label><input id="lGutterRate" inputmode="decimal" oninput="commPreview()"></div>
      </div>

      <div class="chk"><input type="checkbox" id="lSiding" onchange="toggleSiding()"><label style="margin:0">Siding included</label></div>
      <div id="sidingBlock" class="hidden row">
        <div><label>Siding sqft</label><input id="lSidingSqft" inputmode="decimal" oninput="commPreview()"></div>
        <div><label>Siding $/sqft</label><input id="lSidingRate" inputmode="decimal" oninput="commPreview()"></div>
      </div>

      <label>Added work amount $</label><input id="lAddedWork" inputmode="decimal" oninput="commPreview()">
      <div class="chk"><input type="checkbox" id="lCrmx"><label style="margin:0">CRMX screenshot uploaded</label></div>
    </div>

    <button onclick="submitLog()" id="logBtn">Save</button>
  </div>
</section>
```

- [ ] **Step 2: Add the matching JS** — insert before the closing `</script>` from Task 6 (after `flushTaps`, before the `serviceWorker` registration line)

```js
let editingRow = null;

function outcomesUI(){
  $('lSource').innerHTML = META.leadSources.map(s=>`<option>${s}</option>`).join('');
  $('lOutcomes').innerHTML = META.outcomes.map(o=>`<button type="button" class="chip" data-o="${o}" onclick="pickOutcome('${o}')">${o}</button>`).join('');
}
function pickOutcome(o){
  document.querySelectorAll('#lOutcomes .chip').forEach(c=>c.classList.toggle('on', c.dataset.o===o));
  $('lOutcomes').dataset.picked = o;
  const signed = o === 'Contract Signed';
  $('lSold').classList.toggle('hidden', !signed);
  $('lNonSale').classList.toggle('hidden', signed);
  $('lFollowupBlock').classList.toggle('hidden', o !== 'Follow-up Needed');
  if (signed) commPreview();
}
function toggleFinancing(){ $('financeBlock').classList.toggle('hidden', !$('lFinancing').checked); }
function toggleGutters(){ $('guttersBlock').classList.toggle('hidden', !$('lGutters').checked); }
function toggleSiding(){ $('sidingBlock').classList.toggle('hidden', !$('lSiding').checked); }

function rate_(cps){ return cps<580 ? null : cps<600 ? .05 : cps<630 ? .075 : .10; }
function commPreview(){
  const cps = Number($('lCostPerSq').value)||0;
  const contract = Number($('lContract').value)||0;
  const rate = rate_(cps);
  const roofComm = rate==null ? 0 : contract*rate;
  const guttersAmt = $('lGutters').checked ? (Number($('lGutterLF').value)||0)*(Number($('lGutterRate').value)||0) : 0;
  const sidingAmt = $('lSiding').checked ? (Number($('lSidingSqft').value)||0)*(Number($('lSidingRate').value)||0) : 0;
  const addedWork = Number($('lAddedWork').value)||0;
  const flat = (guttersAmt+sidingAmt+addedWork)*0.10;
  const total = roofComm+flat;
  $('commBox').innerHTML = rate==null
    ? `<span class="neg">Below $580/sq floor — saves as <b>pending manager approval</b></span>`
    : `Roof ${(rate*100).toFixed(1)}% (${fmt$(roofComm)}) + flat 10% (${fmt$(flat)}) = <b>${fmt$(total)}</b>`;
}

function resetLogForm(){
  editingRow = null;
  ['lName','lPhone','lReason','lFollowupDate','lSquares','lCostPerSq','lContract','lCash','lDown','lSignedType',
   'lFinSource','lApproved','lDenied','lGutterLF','lGutterRate','lSidingSqft','lSidingRate','lAddedWork'].forEach(i=>$(i).value='');
  ['lConfirmed','lQualified','lPresented','lClosedFollowup','lFinancing','lGutters','lSiding','lCrmx'].forEach(i=>$(i).checked=false);
  $('lDate').value = new Date().toISOString().slice(0,10);
  $('financeBlock').classList.add('hidden'); $('guttersBlock').classList.add('hidden'); $('sidingBlock').classList.add('hidden');
  document.querySelectorAll('#lOutcomes .chip').forEach(c=>c.classList.remove('on'));
  delete $('lOutcomes').dataset.picked;
  $('lSold').classList.add('hidden'); $('lNonSale').classList.add('hidden');
  commPreview();
}

function collectLogData(){
  const outcome = $('lOutcomes').dataset.picked || '';
  return {
    date: $('lDate').value, customerName: $('lName').value, customerPhone: $('lPhone').value, leadSource: $('lSource').value,
    apptConfirmed: $('lConfirmed').checked, qualifiedSit: $('lQualified').checked, presentedPriceProductsHour: $('lPresented').checked,
    outcome,
    outOfScopeReason: outcome==='Out of Scope' ? $('lReason').value : '',
    noSignReason: (outcome!=='Out of Scope' && outcome!=='Contract Signed') ? $('lReason').value : '',
    followUpDate: outcome==='Follow-up Needed' ? $('lFollowupDate').value : '',
    signedType: $('lSignedType').value, closedOnFollowup: $('lClosedFollowup').checked,
    squareCount: $('lSquares').value, costPerSquare: $('lCostPerSq').value,
    contractAmount: $('lContract').value, cashAmount: $('lCash').value, downPayment: $('lDown').value,
    appliedFinancing: $('lFinancing').checked, financingResult: $('lFinancing').checked ? $('lFinResult').value : '',
    financingSource: $('lFinSource').value, approvedAmount: $('lApproved').value, deniedAmount: $('lDenied').value,
    guttersIncluded: $('lGutters').checked, gutterLF: $('lGutterLF').value, gutterRate: $('lGutterRate').value,
    sidingIncluded: $('lSiding').checked, sidingSqft: $('lSidingSqft').value, sidingRate: $('lSidingRate').value,
    addedWorkAmount: $('lAddedWork').value, crmxUploaded: $('lCrmx').checked,
  };
}

async function submitLog(){
  if (!$('lOutcomes').dataset.picked) { toast('Pick an outcome first'); return; }
  $('logBtn').disabled = true;
  try{
    const data = collectLogData();
    const action = editingRow ? 'editAppointment' : 'logAppointment';
    const payload = editingRow ? {row: editingRow, data} : {data};
    const j = await api(action, payload);
    toast(j.commission && j.commission.pending ? 'Saved — pending manager approval' : 'Saved ✓', 2800);
    resetLogForm();
    show('today');
  }catch(e){ toast(e.message); }
  $('logBtn').disabled = false;
}

async function editEntry(row){
  try{
    const j = await api('getHistory', {from:'2000-01-01', to:'2999-12-31'}); // server scopes to caller's own rows unless admin
    const e = j.entries.find(x=>x.row===row);
    if (!e) { toast('Entry not found'); return; }
    show('log');
    resetLogForm();
    editingRow = row;
    $('lDate').value = e.date;
    pickOutcome(e.outcome);
    toast('Editing — fields not yet pulled back individually; re-enter and Save to overwrite this row.', 4000);
  }catch(e){ toast(e.message); }
}
</script>
```

> **Known scope cut, flagged not silent:** `editEntry` switches into edit mode and lets the rep/admin overwrite the row, but does not pre-populate every field from the original entry (the `getHistory` response is a summary, not the full row). Pre-fill is a real gap for a usable edit flow — Task 9 below extends `getHistory_`/`entriesFor_` server-side to return full field data so this can be fixed before the manual smoke pass in Task 10. Listing it now so it isn't lost.

- [ ] **Step 3: Commit**

```bash
git add pwa/index.html
git commit -m "feat: Log Appointment screen with live commission preview"
```

---

### Task 8: Fix edit pre-fill — return full row data from getHistory/getToday

**Files:**
- Modify: `apps-script/Code.gs:entriesFor_` (the function from Task 4)
- Modify: `pwa/index.html:editEntry`

- [ ] **Step 1: Expand `entriesFor_` to return every field, not just the summary**

Replace the `entriesFor_` function body from Task 4 with:

```js
function entriesFor_(repName, from, to) {
  const sh = ss_().getSheetByName('Dispositions');
  const rows = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const dateStr = fmt_(rows[i][1]);
    if (rows[i][2] !== repName || dateStr < from || dateStr > to) continue;
    const r = rows[i];
    out.push({
      row: i + 1, date: dateStr, customerName: r[3], customerPhone: r[4], leadSource: r[5], outcome: r[6],
      presentedPriceProductsHour: r[7] === 'Y', outOfScopeReason: r[8], followUpDate: r[9] ? fmt_(r[9]) : '',
      signedType: r[10], noSignReason: r[11], contractAmount: r[12], cashAmount: r[13], downPayment: r[14],
      appliedFinancing: r[15] === 'Y', financingResult: r[16], financingSource: r[17], approvedAmount: r[18], deniedAmount: r[19],
      squareCount: r[20], costPerSquare: r[21], rate: r[22], roofCommission: r[23], managerApprovedBelowFloor: r[24],
      guttersIncluded: r[25] === 'Y', gutterLF: r[26], gutterRate: r[27],
      sidingIncluded: r[28] === 'Y', sidingSqft: r[29], sidingRate: r[30],
      addedWorkAmount: r[31], closedOnFollowup: r[32] === 'Y',
      flatCommission: r[33], totalCommission: r[34], crmxUploaded: r[35] === 'Y', apptConfirmed: r[36] === 'Y', qualifiedSit: r[37] === 'Y',
      pendingApproval: r[6] === 'Contract Signed' && r[22] === '' && r[24] !== 'Y',
    });
  }
  return out;
}
```

- [ ] **Step 2: Re-run the commission test (unaffected, but cheap to confirm nothing else broke)**

Run: `node test/commission.test.js` — expect all passing.

- [ ] **Step 3: Rewrite `editEntry` in `pwa/index.html` to pre-fill every field**

```js
async function editEntry(row){
  try{
    const j = await api('getHistory', {from:'2000-01-01', to:'2999-12-31'});
    const e = j.entries.find(x=>x.row===row);
    if (!e) { toast('Entry not found'); return; }
    show('log'); resetLogForm(); editingRow = row;
    $('lDate').value = e.date; $('lName').value = e.customerName; $('lPhone').value = e.customerPhone;
    $('lSource').value = e.leadSource; $('lConfirmed').checked = e.apptConfirmed; $('lQualified').checked = e.qualifiedSit;
    $('lPresented').checked = e.presentedPriceProductsHour;
    pickOutcome(e.outcome);
    $('lReason').value = e.outcome==='Out of Scope' ? e.outOfScopeReason : e.noSignReason;
    $('lFollowupDate').value = e.followUpDate;
    $('lSquares').value = e.squareCount; $('lCostPerSq').value = e.costPerSquare;
    $('lContract').value = e.contractAmount; $('lCash').value = e.cashAmount; $('lDown').value = e.downPayment;
    $('lSignedType').value = e.signedType; $('lClosedFollowup').checked = e.closedOnFollowup;
    $('lFinancing').checked = e.appliedFinancing; toggleFinancing();
    $('lFinResult').value = e.financingResult || 'Approved'; $('lFinSource').value = e.financingSource;
    $('lApproved').value = e.approvedAmount; $('lDenied').value = e.deniedAmount;
    $('lGutters').checked = e.guttersIncluded; toggleGutters(); $('lGutterLF').value = e.gutterLF; $('lGutterRate').value = e.gutterRate;
    $('lSiding').checked = e.sidingIncluded; toggleSiding(); $('lSidingSqft').value = e.sidingSqft; $('lSidingRate').value = e.sidingRate;
    $('lAddedWork').value = e.addedWorkAmount; $('lCrmx').checked = e.crmxUploaded;
    commPreview();
  }catch(e){ toast(e.message); }
}
```

- [ ] **Step 4: Commit**

```bash
git add apps-script/Code.gs pwa/index.html
git commit -m "fix: edit flow pre-fills every field instead of just outcome+date"
```

---

### Task 9: History and Team (Manager Dashboard) screens

**Files:**
- Modify: `pwa/index.html` — replace the two remaining placeholder sections and append JS.

- [ ] **Step 1: Replace `<section id="tab-history">` placeholder**

```html
<section id="tab-history" class="hidden">
  <div class="card">
    <h2>History</h2>
    <div class="row"><div><label>From</label><input id="hFrom" type="date"></div><div><label>To</label><input id="hTo" type="date"></div></div>
    <div id="hRepPick" class="hidden"><label>Rep</label><select id="hRep"></select></div>
    <button class="ghost" onclick="loadHistory()">Search</button>
  </div>
  <div class="card"><div id="historyList" class="small">Pick a range and search.</div></div>
</section>
```

- [ ] **Step 2: Replace `<section id="tab-team">` placeholder**

```html
<section id="tab-team" class="hidden">
  <div class="card">
    <h2>Team rollup</h2>
    <div class="row"><div><label>From</label><input id="rFrom" type="date"></div><div><label>To</label><input id="rTo" type="date"></div></div>
    <button class="ghost" onclick="loadTeam()">Run Rollup</button>
    <div class="row" style="margin:10px 0">
      <div class="tile"><div class="n" id="raGross">$0</div><div class="l">Gross revenue</div></div>
      <div class="tile"><div class="n" id="raComm">$0</div><div class="l">Commission</div></div>
      <div class="tile"><div class="n" id="raClose">0%</div><div class="l">Close rate</div></div>
    </div>
    <div id="teamRows" class="small">Pick a range and run.</div>
  </div>
  <div class="card">
    <h2>Pending manager approval</h2>
    <div id="pendingList" class="small">None.</div>
  </div>
  <div class="card">
    <h2>Manage reps</h2>
    <label>Name</label><input id="rmName">
    <label>Password</label><input id="rmPw">
    <label>Role</label><select id="rmRole"><option value="rep">rep</option><option value="admin">admin</option></select>
    <div class="row">
      <button class="ghost" onclick="addRep()">Add Rep</button>
      <button class="ghost" onclick="resetPw()">Reset Password</button>
    </div>
    <div id="repList" class="small" style="margin-top:10px"></div>
  </div>
</section>
```

- [ ] **Step 3: Append the matching JS** — before the closing `</script>` (after `editEntry`)

```js
async function loadHistory(){
  $('hRepPick').classList.toggle('hidden', ME.role !== 'admin');
  try{
    const from = $('hFrom').value || today_str(); const to = $('hTo').value || today_str();
    const payload = {from, to};
    if (ME.role==='admin' && $('hRep').value) payload.rep = $('hRep').value;
    const j = await api('getHistory', payload);
    $('historyList').innerHTML = j.entries.length ? j.entries.map(e=>`
      <div class="item" onclick="editEntry(${e.row})"><b>${e.date}</b> · ${e.customerName||'(no name)'} · ${e.outcome}
      ${e.outcome==='Contract Signed' ? ' · '+fmt$(e.contractAmount)+' · '+fmt$(e.totalCommission)+' comm' : ''}
      ${e.pendingApproval ? ' <span class="pill" style="background:var(--gold);color:#fff">pending</span>' : ''}</div>`).join('')
      : 'No entries in range.';
  }catch(e){ toast(e.message); }
}
function today_str(){ return new Date().toISOString().slice(0,10); }

async function loadTeam(){
  try{
    const from = $('rFrom').value || today_str(); const to = $('rTo').value || today_str();
    const j = await api('adminTeamRollup', {from, to});
    $('raGross').textContent = fmt$(j.totals.grossRevenue); $('raComm').textContent = fmt$(j.totals.commission);
    $('raClose').textContent = j.totals.demos ? Math.round(j.totals.roofingAgreements/j.totals.demos*100)+'%' : '0%';
    $('teamRows').innerHTML = j.team.map(r=>`
      <div class="stat"><span><b>${r.rep}</b> · ${r.leadsIssued} leads · ${r.roofingAgreements} signed · ${r.doorsKnocked} doors</span>
      <span>${fmt$(r.grossRevenue)} · <span class="gold-t">${fmt$(r.commission)}</span></span></div>`).join('') || 'No activity.';
    $('pendingList').innerHTML = j.pending.length ? j.pending.map(p=>`
      <div class="item"><b>${p.rep}</b> · ${p.customerName||'(no name)'} · ${p.date}
      <div class="row"><button class="ghost" onclick="approveFloor(${p.row})">Approve rate</button></div></div>`).join('')
      : 'None.';
    $('hRep').innerHTML = j.reps.filter(r=>r.role==='rep').map(r=>`<option>${r.name}</option>`).join('');
    $('repList').innerHTML = j.reps.map(r=>`
      <div class="item"><b>${r.name}</b> <span class="pill">${r.role}</span> ${r.active?'':'<span class="neg">· inactive</span>'}
      <div class="row"><button class="ghost" onclick="toggleRep('${r.name.replace(/'/g,"\\'")}',${!r.active})">${r.active?'⏸ Deactivate':'▶️ Activate'}</button></div></div>`).join('') || 'No reps yet.';
  }catch(e){ toast(e.message); }
}
async function approveFloor(row){
  const rate = prompt('Approved commission rate (e.g. 0.05 for 5%):');
  if (!rate) return;
  try{
    await api('editAppointment', {row, data: Object.assign({}, await fetchRowForEdit(row), {managerOverrideRate: Number(rate)})});
    toast('Approved ✓'); loadTeam();
  }catch(e){ toast(e.message); }
}
async function fetchRowForEdit(row){
  const j = await api('getHistory', {from:'2000-01-01', to:'2999-12-31'});
  return j.entries.find(x=>x.row===row) || {};
}
async function addRep(){
  try{ await api('adminManageRep', {op:'add', name:$('rmName').value.trim(), password:$('rmPw').value, role:$('rmRole').value});
    toast('Rep added ✓'); $('rmName').value=''; $('rmPw').value=''; loadTeam(); }
  catch(e){ toast(e.message); }
}
async function resetPw(){
  try{ await api('adminManageRep', {op:'resetPassword', name:$('rmName').value.trim(), password:$('rmPw').value});
    toast('Password reset ✓'); $('rmPw').value=''; }
  catch(e){ toast(e.message); }
}
async function toggleRep(name, active){
  try{ await api('adminManageRep', {op: active?'reactivate':'deactivate', name}); toast(active?'Activated ✓':'Deactivated ✓'); loadTeam(); }
  catch(e){ toast(e.message); }
}
```

> Note: `approveFloor` calls `getHistory` to fetch the full row (admin's own scope is all reps, but `getHistory_` only returns rows for `req.rep` or the caller — since `fetchRowForEdit` here doesn't pass `rep`, this only works when the admin is approving their own logged rows. **Fix before Task 10:** add a `rep` lookup — `entriesFor_` is keyed by rep name, so `approveFloor` needs the pending item's `rep` field threaded through. Step 4 below fixes it.

- [ ] **Step 4: Fix `approveFloor` to pass the correct rep**

```js
async function approveFloor(row, repName){
  const rate = prompt('Approved commission rate (e.g. 0.05 for 5%):');
  if (!rate) return;
  try{
    const j = await api('getHistory', {from:'2000-01-01', to:'2999-12-31', rep: repName});
    const entry = j.entries.find(x=>x.row===row) || {};
    await api('editAppointment', {row, data: Object.assign({}, entry, {managerOverrideRate: Number(rate)})});
    toast('Approved ✓'); loadTeam();
  }catch(e){ toast(e.message); }
}
```

Update the pending-list button in `loadTeam` to pass the rep along:

```js
<button class="ghost" onclick="approveFloor(${p.row}, '${p.rep.replace(/'/g,"\\'")}')">Approve rate</button>
```

(Remove the now-unused `fetchRowForEdit` helper.)

- [ ] **Step 5: Commit**

```bash
git add pwa/index.html
git commit -m "feat: History and Team (Manager Dashboard) screens"
```

---

### Task 10: Service worker, manifest, icons, SETUP.md

**Files:**
- Create: `pwa/sw.js`
- Create: `pwa/manifest.json`
- Create: `pwa/icon-192.png`, `pwa/icon-512.png` (copied placeholders)
- Create: `SETUP.md`

- [ ] **Step 1: Write `pwa/sw.js`**

```js
// UHS Roofing Rep Tracker — minimal service worker.
// Caches the app shell for fast loads; API calls (POST) always go to network.
const CACHE = 'uhs-roofing-tracker-v1';
const SHELL = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return; // API posts go straight to network
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
```

- [ ] **Step 2: Write `pwa/manifest.json`**

```json
{
  "name": "UHS Roofing Rep Tracker",
  "short_name": "Roofing Tracker",
  "description": "Doors knocked, dispositions, and nightly numbers for Unlimited Home Services roofing reps.",
  "start_url": "./index.html",
  "display": "standalone",
  "background_color": "#1B2A41",
  "theme_color": "#1B2A41",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- [ ] **Step 3: Copy placeholder icons from the bathroom tracker**

```bash
cp "../../Unlimited Home Services - Bathroom/rep-tracker/pwa/icon-192.png" pwa/icon-192.png
cp "../../Unlimited Home Services - Bathroom/rep-tracker/pwa/icon-512.png" pwa/icon-512.png
```

(ponytail: same icon as the bathroom app — swap for a roofing-specific logo before real launch; purely cosmetic, zero functional risk.)

- [ ] **Step 4: Write `SETUP.md`**

```markdown
# UHS Roofing Rep Tracker — Setup Runbook (one-time, ~5 minutes)

Architecture: **PWA on GitHub Pages** → **Google Apps Script web app** (the API, runs as your Google account) → **Google Sheet** (auto-created, your reporting home). Fully independent of the bathroom-division UHS Rep Tracker — separate repo, separate Apps Script project, separate Sheet.

## Step 1 — Deploy the Apps Script backend (manual, your browser)
1. Go to **https://script.new** (logged in as tedbeedle@gmail.com).
2. Name the project `UHS Roofing Rep Tracker API`.
3. Delete the placeholder and paste the entire contents of `apps-script/Code.gs`.
4. **Deploy → New deployment → type: Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** ← required so reps' phones can POST; every request is still password-checked in code.
5. Click **Deploy**, authorize the permissions prompt, and **copy the Web app URL** (`https://script.google.com/macros/s/…/exec`).

The spreadsheet **"UHS Roofing Rep Tracker — 2026"** creates itself in your Drive on the first API call — tabs, headers, and the seeded rep roster included.

## Step 2 — Point the app at your API
Paste the Web app URL into `pwa/index.html`, replacing `PASTE_APPS_SCRIPT_WEB_APP_URL_HERE` in the `DEFAULT_API` constant. Commit and push (GitHub Pages picks it up automatically).

## Step 3 — Reset seeded passwords
All eight seeded accounts (Chris Jones, Dave Kershaw, Sheldon Stimeling, Andrew Fielder, James Meadows — role `rep`; Stacy Clark, Jessica Henson, Ted Beedle — role `admin`) start with the temporary password `Roofing2026!`. Sign in as an admin → **Team** tab → enter each rep's name + a real password → **Reset Password**. Do this for all eight before handing phones to reps.

## Step 4 — Reps install the app
Reps visit the app URL on their phone → Share → **Add to Home Screen** → it installs like an app.

## Daily flow
- Rep taps **+1 DOOR** all day; taps batch client-side (every 5 taps, or when the app backgrounds) so there's no network call per knock.
- Each appointment gets logged in **Log**: outcome chips, two-tap save for non-sale outcomes, full sale detail (price/sq with a live commission preview, financing, gutters, siding, added work) for Contract Signed.
- Sub-$580/sq deals still save — they show "pending manager approval" instead of a normal save confirmation, and surface on the **Team** tab's Pending list until an admin approves a rate.
- **Today** tab shows live nightly numbers, computed from the day's logged dispositions plus the door count — no second nightly form.
- Admins use **Team** for any date-range rollup, the pending-approval queue, and rep management (add / reset password / deactivate).

## Commission math (built in, matches the spec)
Roof commission: <$580/sq → blocked pending manager approval · $580–599.99 → 5% · $600–629.99 → 7.5% · ≥$630 → 10%, applied to Contract Amount.
Flat 10% on gutters $ (LF × $/LF) + siding $ (sqft × $/sqft) + added work — no exceptions, no splits.

## Files
- `apps-script/Code.gs` — backend (paste into script.new)
- `pwa/` — frontend source (deployed to GitHub Pages)
- `test/commission.test.js` — run with `node test/commission.test.js`; covers the commission floor/tier boundaries
```

- [ ] **Step 5: Commit**

```bash
git add pwa/sw.js pwa/manifest.json pwa/icon-192.png pwa/icon-512.png SETUP.md
git commit -m "feat: service worker, manifest, icons, setup runbook"
```

---

### Task 11: Manual smoke pass (per spec's Testing section)

**Files:** none — this is a manual verification pass after a real deploy, run once `SETUP.md` Steps 1-2 are done against a real Apps Script deployment.

- [ ] **Step 1:** Log one disposition per outcome type; confirm each saves correctly and appears in Today's entry list.
- [ ] **Step 2:** Log a signed deal at each commission tier boundary ($579, $580, $599, $600, $629, $630); confirm the computed rate and dollar amount shown in the save toast match the tier table.
- [ ] **Step 3:** Confirm a sub-$580 deal saves with "pending manager approval" (not blocked) and appears on the Team tab's Pending list; use **Approve rate** to clear it and confirm the flag disappears on next rollup.
- [ ] **Step 4:** Tap the doors-knocked counter past the 5-tap batch threshold, refresh mid-session, confirm the count persists (i.e. the flush actually reached the server).
- [ ] **Step 5:** Confirm Today's auto-computed nightly numbers match a manual count of that day's logged dispositions.
- [ ] **Step 6:** Confirm the admin Team rollup for a date range matches the sum of individual rep numbers for the same range.
- [ ] **Step 7:** Edit a same-day entry as the logging rep — confirm it succeeds. Try editing a different rep's entry as a rep (not admin) — confirm the server rejects it with "not your entry". Try editing yesterday's entry as a rep — confirm "same-day edits only". Confirm an admin can edit any entry regardless of date or rep.

---

## Self-Review

**Spec coverage:**
- Architecture (PWA/Apps Script/Sheet, single endpoint, CacheService auth) — Tasks 2-3.
- Data model incl. both schema fixes (Siding $/Sqft, Closed On Follow-up) — Task 2 header + Task 2 code.
- All 8 named actions (login, logAppointment, getToday, tapDoor, getHistory, editAppointment, adminTeamRollup, adminManageRep) — Tasks 3-5.
- Screens 1-5 (Login, Today, Log Appointment, History, Manager Dashboard) — Tasks 6, 7, 9.
- Commission engine incl. floor/override — Task 1 (TDD) + Task 3 wiring.
- Error handling: offline door-tap queueing (batch+flush-on-hide) — Task 6; duplicate-submit guard (`logBtn`/save-button disable) — Task 7; manager-approval-pending visibility — Tasks 6, 9.
- Testing checklist from the spec — Task 11, verbatim.
- **Not covered, by design:** the Looker Studio report (spec section "Looker Studio report") is out of scope for this plan — it's a one-time manual step (open a pre-built Linking-API URL and click Save) with no code to write, not an implementation task. Flagging so it isn't mistaken for an oversight; happy to write a follow-up plan for it if wanted.

**Placeholder scan:** no TBD/TODO markers; the two `<section>` placeholders in Task 6 are explicitly filled by name in Tasks 7 and 9, not left unfinished at plan end.

**Type/field consistency:** cross-checked column indices used in `entriesFor_` (Task 4 → corrected in Task 8), `rangeTotals_` (Task 5), and `rowFor_` (Task 3) against the single column-order table in the plan header — all three use the same 0-based indices for the same fields. `computeCommission_`'s field names (`contractAmount`, `costPerSquare`, `guttersIncluded`, `gutterLF`, `gutterRate`, `sidingIncluded`, `sidingSqft`, `sidingRate`, `addedWorkAmount`, `managerOverrideRate`) match what `collectLogData()` in the PWA sends and what `rowFor_` reads.

**Self-found issues fixed inline during drafting (not deferred):** the original `editEntry` only set date+outcome (Task 7) — fixed by expanding `entriesFor_` and rewriting `editEntry` in Task 8. The original `approveFloor` fetched the wrong rep's rows — fixed in Task 9 Step 4. Both are called out above rather than silently rewritten, since a worker executing Task 7 or Task 9's first draft in isolation would ship a real bug otherwise.
