/**
 * Unlimited Roofing Rep Tracker - Apps Script backend.
 * Deploy as a standalone web app: Execute as Me, access Anyone.
 * POST JSON { action, token?, ...payload } -> JSON response.
 *
 * Sections:
 *  - Auth/session, rep app write path (logAppointment_/editAppointment_/tapDoor_) — UNTOUCHED by dashboard v2.
 *  - Commission math (commission_/roofCommissionRate_) — knobs: ROOF_FLOOR, FLAT_RATE below.
 *  - Dashboard v2 aggregation (bottom of file, "dashboard data" section) — adminDashboardData_,
 *    aggregateWindow_, Goals tab, lead-source alias map. Every adjustable value is tagged // ADJUST:.
 *    Run `grep ADJUST apps-script/Code.gs` to list them all. See docs/ADJUSTING.md for the
 *    non-coder runbook (changing goals, adding reps, redeploying).
 */

const SS_PROP = 'ROOFING_REP_TRACKER_SPREADSHEET_ID';
const SALT_PROP = 'ROOFING_REP_TRACKER_SALT';
const ADMIN_PIN_PROP = 'ROOFING_REP_TRACKER_ADMIN_PIN';
const KPI_SHEET_ID = '1sYx3ARdazMCn0oCuC_svI3DxQ4PhPhH6yXU5QfFgryc'; // Unlimited Roofing — KPI Tracker (historical data)
const RECON_SHEET_ID = '1HeDRyGCD_dt7daaZ6MlLzkiJ5AXwhlY9-b-5GIsypKE'; // Final Reporting Reconciliation — corrected historical funnel/contracts/revenue (frozen snapshot)
const HIST_CUTOVER = '2026-06-23'; // ADJUST: last date covered by frozen history; the live app is authoritative for dates AFTER this
const TZ = 'America/New_York';
const TOKEN_TTL_SECONDS = 43200;
const ROOF_FLOOR = 580; // ADJUST: commission floor — cost/sq below this pays no roof commission until manager override
const FLAT_RATE = 0.10; // ADJUST: flat commission rate for gutters/siding/added-work
// ADJUST: commission breakpoints by cost-per-square live in roofCommissionRate_() below (5% / 7.5% / 10%)

const TABS = {
  Reps: ['Rep ID','Name','Password Hash','Role','Active','Created','Branch'],
  Dispositions: [
    'Entry ID','Timestamp','Date','Rep','Customer Name','Customer Phone','Lead Source','Appointment Outcome',
    'Presented Price/Products/Hour','Out-of-Scope Reason','Follow-up Date','Signed','Signed Type','No-Sign Reason',
    'Contract Amount','Cash Amount','Down Payment','Applied Financing','Financing Result','Financing Source',
    'Approved Amount','Denied Amount','Square Count','Cost Per Square','Commission Rate','Roof Commission $',
    'Manager-Approved Below Floor','Gutters Included','Gutter LF','Gutter $/LF','Gutter Commission $',
    'Siding Included','Siding Sqft','Siding $/Sqft','Siding Commission $','Added Work Amount',
    'Added Work Commission $','Flat-Rate Commission $','Total Commission $','CRMX Screenshot Uploaded',
    'Appointment Confirmed','Qualified Sit','Manager Notes','Updated At'
  ],
  DoorsKnocked: ['Timestamp','Date','Rep','Tap Count'],
  AuditLog: ['Timestamp','Actor','Action','Entry ID','Details'],
};

const SEED_REPS = [
  ['Chris Jones','rep'], ['Dave Kershaw','rep'], ['Sheldon Stimeling','rep'], ['Andrew Fielder','rep'],
  ['James Meadows','rep'], ['Stacy Clark','admin'], ['Jessica Henson','admin'], ['Ted Beedle','admin'],
];
const DEFAULT_BRANCH = 'Roanoke'; // ADJUST: branch new/legacy reps are seeded/migrated into

const OUTCOMES = ['Contract Signed','Follow-up Needed','No Show','Rescheduled','Out of Scope','Disinterested','Cancelled'];
const LEAD_SOURCES = ['Company Lead','Retail Nightly','Self-Gen','Referral','Canvass','Roofer Stage','Angi\'s List','Guaranteed Estimates','Gutter','Other'];
const NO_SIGN_REASONS = ['Think It Over','Price','Spouse Not Present','Financing','Competitor','Timing','Not Qualified','Other'];

// ADJUST: collapse messy historical lead-source labels into the canonical LEAD_SOURCES list.
// Unmapped values pass through unchanged (so new sources show up rather than disappearing).
const LEAD_SOURCE_ALIASES = {
  'Gutter guy': 'Gutter', 'Gutter Lead': 'Gutter', 'Gutter lead': 'Gutter', // all gutter variants -> the one 'Gutter' source
  'W ted self gen insurance deal': 'Self-Gen',
  'Office Call In': 'Company Lead',
  'Not specified': 'Other', '': 'Other',
};

function canonicalLeadSource_(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'Other';
  return LEAD_SOURCE_ALIASES[s] || s;
}

// ADJUST: seed values for the Goals tab — edited live in the spreadsheet after first run, not here.
const GOALS_DEFAULTS = {
  squaresTarget: 5000, revenueTarget: 3000000, contractsTarget: 276,
  donationGoal: 10000, donatedToDate: 0,
  demoRateTarget: 0.8, occTarget: 0.3, sitRateTarget: '', closeRateTarget: '',
};

// ---- pure helpers (no Apps Script API calls — covered by test/dashboard-helpers.test.js) ----

function compareWindow_(start, end) {
  const startMs = Date.parse(start + 'T00:00:00Z');
  const endMs = Date.parse(end + 'T00:00:00Z');
  const days = Math.round((endMs - startMs) / 86400000) + 1;
  const compareEndMs = startMs - 86400000;
  const compareStartMs = compareEndMs - (days - 1) * 86400000;
  return { compareStart: isoFromMs_(compareStartMs), compareEnd: isoFromMs_(compareEndMs) };
}

function isoFromMs_(ms) { return new Date(ms).toISOString().slice(0, 10); }

function goalPct_(value, target) {
  if (!target) return 0;
  const p = Math.round((Number(value) || 0) / target * 100);
  return Math.max(0, Math.min(100, p));
}

function delta_(curr, prev) {
  curr = Number(curr) || 0; prev = Number(prev) || 0;
  const diff = round2_(curr - prev);
  const pctChange = prev ? round2_((curr - prev) / Math.abs(prev) * 100) : (curr ? 100 : 0);
  const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  return { diff, pctChange, dir };
}

function doGet() {
  return ContentService.createTextOutput('Unlimited Roofing Rep Tracker API is up.');
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok:false, error:'bad json' }); }
  try {
    const action = req.action;
    if (action === 'bootstrap') return bootstrap_(req);
    if (action === 'login') return login_(req);
    const sess = session_(req.token);
    if (!sess) return json_({ ok:false, error:'auth', authExpired:true });
    if (action === 'meta') return json_({ ok:true, me:sess, outcomes:OUTCOMES, leadSources:LEAD_SOURCES, noSignReasons:NO_SIGN_REASONS });
    if (action === 'logAppointment') return logAppointment_(req, sess);
    if (action === 'getToday') return getToday_(req, sess);
    if (action === 'tapDoor') return tapDoor_(req, sess);
    if (action === 'getHistory') return getHistory_(req, sess);
    if (action === 'editAppointment') return editAppointment_(req, sess);
    if (action === 'adminTeamRollup') return adminOnly_(sess, () => adminTeamRollup_(req));
    if (action === 'adminManageRep') return adminOnly_(sess, () => adminManageRep_(req, sess));
    if (action === 'adminApproveDeal') return adminOnly_(sess, () => adminApproveDeal_(req, sess));
    if (action === 'adminDashboardData') return adminOnly_(sess, () => adminDashboardData_(req));
    if (action === 'getGoals') return adminOnly_(sess, () => json_({ ok:true, goals:getGoals_() }));
    return json_({ ok:false, error:'unknown action' });
  } catch (err) {
    return json_({ ok:false, error:String(err && err.message ? err.message : err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function adminOnly_(sess, fn) {
  if (sess.role !== 'admin') return json_({ ok:false, error:'admin only' });
  return fn();
}

function ss_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(SS_PROP);
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Unlimited Roofing Rep Tracker - 2026');
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
  const old = ss.getSheetByName('Sheet1');
  if (old && Object.keys(TABS).length > 0) ss.deleteSheet(old);
  seedReps_();
  migrateRepsBranch_(ss);
  ensureGoalsTab_(ss);
  return ss;
}

function sheet_(name) { return ss_().getSheetByName(name); }

function seedReps_() {
  const reps = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty(SS_PROP)).getSheetByName('Reps');
  if (reps.getLastRow() > 1) return;
  SEED_REPS.forEach((r, idx) => reps.appendRow(['R' + String(idx + 1).padStart(3, '0'), r[0], '', r[1], true, new Date(), DEFAULT_BRANCH]));
}

function migrateRepsBranch_(ss) {
  const sh = ss.getSheetByName('Reps');
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  if (headers.indexOf('Branch') !== -1) return;
  const col = headers.length + 1;
  sh.getRange(1, col).setValue('Branch').setFontWeight('bold');
  const lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, col, lastRow - 1, 1).setValue(DEFAULT_BRANCH);
}

function ensureGoalsTab_(ss) {
  let sh = ss.getSheetByName('Goals');
  if (sh) return sh;
  sh = ss.insertSheet('Goals');
  sh.appendRow(['Key', 'Value']);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, 2).setFontWeight('bold');
  Object.keys(GOALS_DEFAULTS).forEach(k => sh.appendRow([k, GOALS_DEFAULTS[k]]));
  return sh;
}

function getGoals_() {
  const rows = sheet_('Goals').getDataRange().getValues().slice(1);
  const g = {};
  rows.forEach(r => { if (r[0]) g[r[0]] = r[1]; });
  return g;
}

function salt_() {
  const props = PropertiesService.getScriptProperties();
  let salt = props.getProperty(SALT_PROP);
  if (!salt) { salt = Utilities.getUuid(); props.setProperty(SALT_PROP, salt); }
  return salt;
}

function hash_(pw) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pw || '') + salt_());
  return raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function makeToken_(repId, name, role) {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('roof_tok_' + token, JSON.stringify({ repId, name, role }), TOKEN_TTL_SECONDS);
  return token;
}

function session_(token) {
  if (!token) return null;
  const raw = CacheService.getScriptCache().get('roof_tok_' + token);
  return raw ? JSON.parse(raw) : null;
}

function bootstrap_(req) {
  ss_();
  const pin = PropertiesService.getScriptProperties().getProperty(ADMIN_PIN_PROP);
  if (!pin || req.pin !== pin) return json_({ ok:false, error:'bad pin' });
  if (!req.name || !req.password) return json_({ ok:false, error:'name and password required' });
  const rep = findRepAny_(req.name);
  if (!rep) return json_({ ok:false, error:'seeded admin name not found' });
  if (rep.role !== 'admin') return json_({ ok:false, error:'bootstrap requires an admin seed account' });
  sheet_('Reps').getRange(rep.row, 3).setValue(hash_(req.password));
  sheet_('Reps').getRange(rep.row, 5).setValue(true);
  audit_(req.name, 'bootstrap', '', 'admin password set');
  return json_({ ok:true, token:makeToken_(rep.repId, rep.name, rep.role), me:{ repId:rep.repId, name:rep.name, role:rep.role } });
}

function login_(req) {
  ss_();
  const rep = findRep_(req.name);
  if (!rep || !rep.hash || rep.hash !== hash_(req.password)) return json_({ ok:false, error:'Invalid name or password' });
  return json_({ ok:true, token:makeToken_(rep.repId, rep.name, rep.role), me:{ repId:rep.repId, name:rep.name, role:rep.role } });
}

function findRep_(name) {
  const rep = findRepAny_(name);
  return rep && rep.active === true ? rep : null;
}

function findRepAny_(name) {
  const rows = sheet_('Reps').getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]).toLowerCase() === String(name || '').toLowerCase()) {
      return { row:i + 1, repId:rows[i][0], name:rows[i][1], hash:rows[i][2], role:rows[i][3], active:rows[i][4], branch:rows[i][6] || DEFAULT_BRANCH };
    }
  }
  return null;
}

function logAppointment_(req, sess) {
  const d = req.data || {};
  const calc = commission_(d);
  const id = d.entryId || ('D' + Utilities.formatDate(new Date(), TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 1000));
  sheet_('Dispositions').appendRow(rowFromData_(id, sess.name, d, calc, new Date()));
  audit_(sess.name, 'logAppointment', id, d.outcome || '');
  return json_({ ok:true, entryId:id, calc });
}

function editAppointment_(req, sess) {
  const d = req.data || {};
  if (!d.entryId) return json_({ ok:false, error:'entryId required' });
  const sh = sheet_('Dispositions');
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] !== d.entryId) continue;
    const currentRep = rows[i][3];
    const currentDate = fmtDate_(rows[i][2]);
    if (sess.role !== 'admin' && (currentRep !== sess.name || currentDate !== today_())) return json_({ ok:false, error:'same-day own entries only' });
    const calc = commission_(d);
    sh.getRange(i + 1, 1, 1, TABS.Dispositions.length).setValues([rowFromData_(d.entryId, currentRep, d, calc, new Date())]);
    audit_(sess.name, 'editAppointment', d.entryId, d.outcome || '');
    return json_({ ok:true, entryId:d.entryId, calc });
  }
  return json_({ ok:false, error:'entry not found' });
}

function rowFromData_(id, rep, d, calc, updatedAt) {
  const signed = d.outcome === 'Contract Signed';
  return [
    id, new Date(), d.date || today_(), rep, d.customerName || '', d.customerPhone || '', d.leadSource || '', d.outcome || '',
    boolText_(d.presented), d.outOfScopeReason || '', d.followUpDate || '', signed ? 'Y' : 'N', d.signedType || '', d.noSignReason || '',
    signed ? num_(d.contractAmount) : '', signed ? num_(d.cashAmount) : '', signed ? num_(d.downPayment) : '', boolText_(d.appliedFinancing),
    d.financingResult || '', d.financingSource || '', numOrBlank_(d.approvedAmount), numOrBlank_(d.deniedAmount),
    numOrBlank_(d.squareCount), numOrBlank_(d.costPerSquare), calc.rate === null ? '' : calc.rate, calc.roofCommission === null ? '' : calc.roofCommission,
    boolText_(d.managerApprovedBelowFloor), boolText_(d.guttersIncluded), numOrBlank_(d.gutterLf), numOrBlank_(d.gutterPricePerLf), calc.gutterCommission,
    boolText_(d.sidingIncluded), numOrBlank_(d.sidingSqft), numOrBlank_(d.sidingPricePerSqft), calc.sidingCommission,
    numOrBlank_(d.addedWorkAmount), calc.addedWorkCommission, calc.flatCommission, calc.totalCommission,
    boolText_(d.crmxUploaded), boolText_(d.appointmentConfirmed), boolText_(d.qualifiedSit), d.managerNotes || '', updatedAt
  ];
}

function commission_(d) {
  if (d.outcome !== 'Contract Signed') return { rate:0, roofCommission:0, gutterCommission:0, sidingCommission:0, addedWorkCommission:0, flatCommission:0, totalCommission:0, pendingApproval:false };
  const contract = num_(d.contractAmount);
  const cps = num_(d.costPerSquare);
  let rate = roofCommissionRate_(cps);
  let pending = false;
  if (rate === null) {
    rate = d.overrideRate === '' || d.overrideRate == null ? null : Number(d.overrideRate);
    pending = rate === null;
  }
  const roofCommission = rate === null ? null : round2_(contract * rate);
  const gutterTotal = truthy_(d.guttersIncluded) ? num_(d.gutterLf) * num_(d.gutterPricePerLf) : 0;
  const sidingTotal = truthy_(d.sidingIncluded) ? num_(d.sidingSqft) * num_(d.sidingPricePerSqft) : 0;
  const addedTotal = num_(d.addedWorkAmount);
  const gutterCommission = round2_(gutterTotal * FLAT_RATE);
  const sidingCommission = round2_(sidingTotal * FLAT_RATE);
  const addedWorkCommission = round2_(addedTotal * FLAT_RATE);
  const flatCommission = round2_(gutterCommission + sidingCommission + addedWorkCommission);
  const totalCommission = roofCommission === null ? flatCommission : round2_(roofCommission + flatCommission);
  return { rate, roofCommission, gutterCommission, sidingCommission, addedWorkCommission, flatCommission, totalCommission, pendingApproval:pending };
}

function roofCommissionRate_(costPerSquare) {
  if (!costPerSquare || costPerSquare < ROOF_FLOOR) return null;
  if (costPerSquare < 600) return 0.05;
  if (costPerSquare < 630) return 0.075;
  return 0.10;
}

function tapDoor_(req, sess) {
  const count = Math.max(1, Number(req.count) || 1);
  sheet_('DoorsKnocked').appendRow([new Date(), req.date || today_(), sess.name, count]);
  return json_({ ok:true, count });
}

function getToday_(req, sess) {
  const date = req.date || today_();
  return json_({ ok:true, date, appointments:getEntries_(date, date, sess), totals:rollup_(date, date, sess.name) });
}

function getHistory_(req, sess) {
  const start = req.start || today_();
  const end = req.end || start;
  return json_({ ok:true, entries:getEntries_(start, end, sess) });
}

function getEntries_(start, end, sess) {
  const rows = sheet_('Dispositions').getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const date = fmtDate_(rows[i][2]);
    if (date < start || date > end) continue;
    if (sess.role !== 'admin' && rows[i][3] !== sess.name) continue;
    out.push(entryFromRow_(rows[i]));
  }
  return out.reverse();
}

function entryFromRow_(r) {
  return {
    entryId:r[0], date:fmtDate_(r[2]), rep:r[3], customerName:r[4], customerPhone:r[5], leadSource:r[6], outcome:r[7],
    presented:r[8], outOfScopeReason:r[9], followUpDate:fmtDate_(r[10]), signedType:r[12], noSignReason:r[13],
    contractAmount:r[14], cashAmount:r[15], downPayment:r[16], appliedFinancing:r[17], financingResult:r[18], financingSource:r[19],
    approvedAmount:r[20], deniedAmount:r[21], squareCount:r[22], costPerSquare:r[23], commissionRate:r[24], roofCommission:r[25],
    managerApprovedBelowFloor:r[26], guttersIncluded:r[27], gutterLf:r[28], gutterPricePerLf:r[29], sidingIncluded:r[31],
    sidingSqft:r[32], sidingPricePerSqft:r[33], addedWorkAmount:r[35], totalCommission:r[38], crmxUploaded:r[39],
    appointmentConfirmed:r[40], qualifiedSit:r[41], managerNotes:r[42], pendingApproval:r[7] === 'Contract Signed' && r[24] === ''
  };
}

function adminTeamRollup_(req) {
  const start = req.start || today_();
  const end = req.end || start;
  return json_({ ok:true, start, end, rollup:rollup_(start, end, ''), reps:repRollups_(start, end), pending:pendingApprovals_() });
}

function repRollups_(start, end) {
  const reps = sheet_('Reps').getDataRange().getValues().slice(1).filter(r => r[4] === true).map(r => r[1]);
  return reps.map(rep => Object.assign({ rep }, rollup_(start, end, rep)));
}

function rollup_(start, end, repName) {
  const totals = { leadsIssued:0, demos:0, noOp:0, oneCallClose:0, followUpContracts:0, roofingAgreements:0, grossRevenue:0, turnDownCount:0, turnDownRevenue:0, doorsKnocked:0, commissionPaid:0, closeRate:0 };
  const rows = sheet_('Dispositions').getDataRange().getValues();
  rows.slice(1).forEach(r => {
    const date = fmtDate_(r[2]);
    if (date < start || date > end) return;
    if (repName && r[3] !== repName) return;
    totals.leadsIssued++;
    const outcome = r[7];
    const presented = r[8] === 'Y';
    if (presented || outcome === 'Contract Signed' || outcome === 'Follow-up Needed') totals.demos++;
    if (outcome === 'No Show' || outcome === 'Cancelled') totals.noOp++;
    if (outcome === 'Contract Signed') {
      totals.roofingAgreements++;
      const gutterTotal = r[27] === 'Y' ? num_(r[28]) * num_(r[29]) : 0;
      const sidingTotal = r[31] === 'Y' ? num_(r[32]) * num_(r[33]) : 0;
      const addedTotal = num_(r[35]);
      totals.grossRevenue += num_(r[14]) + gutterTotal + sidingTotal + addedTotal;
      totals.commissionPaid += num_(r[38]);
      if (!r[10]) totals.oneCallClose++; else totals.followUpContracts++;
    }
    if (r[18] === 'Denied') { totals.turnDownCount++; totals.turnDownRevenue += num_(r[21]); }
  });
  const doors = sheet_('DoorsKnocked').getDataRange().getValues();
  doors.slice(1).forEach(r => {
    const date = fmtDate_(r[1]);
    if (date < start || date > end) return;
    if (repName && r[2] !== repName) return;
    totals.doorsKnocked += num_(r[3]);
  });
  totals.closeRate = totals.demos ? round2_(totals.roofingAgreements / totals.demos) : 0;
  Object.keys(totals).forEach(k => { if (typeof totals[k] === 'number') totals[k] = round2_(totals[k]); });
  return totals;
}

function pendingApprovals_() {
  return sheet_('Dispositions').getDataRange().getValues().slice(1).filter(r => r[7] === 'Contract Signed' && r[24] === '').map(entryFromRow_);
}

function adminApproveDeal_(req, sess) {
  const entryId = req.entryId;
  const rate = Number(req.rate);
  if (!entryId || !(rate >= 0)) return json_({ ok:false, error:'entryId and rate required' });
  const sh = sheet_('Dispositions');
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] !== entryId) continue;
      const roofCommission = round2_(num_(rows[i][14]) * rate);
      const total = round2_(roofCommission + num_(rows[i][37]));
      sh.getRange(i + 1, 25).setValue(rate);
      sh.getRange(i + 1, 26).setValue(roofCommission);
      sh.getRange(i + 1, 27).setValue('Y');
      sh.getRange(i + 1, 39).setValue(total);
      sh.getRange(i + 1, 43).setValue(req.notes || 'Approved by ' + sess.name);
      sh.getRange(i + 1, 44).setValue(new Date());
      audit_(sess.name, 'adminApproveDeal', entryId, 'rate=' + rate);
      return json_({ ok:true, roofCommission, totalCommission:total });
  }
  return json_({ ok:false, error:'entry not found' });
}

function adminManageRep_(req, sess) {
  const mode = req.mode;
  if (mode === 'list') return json_({ ok:true, reps:listReps_() });
  if (mode === 'add') {
    if (findRepAny_(req.name)) return json_({ ok:false, error:'rep exists' });
    const sh = sheet_('Reps');
    const id = 'R' + String(sh.getLastRow()).padStart(3, '0');
    sh.appendRow([id, req.name, req.password ? hash_(req.password) : '', req.role === 'admin' ? 'admin' : 'rep', true, new Date(), req.branch || DEFAULT_BRANCH]);
    audit_(sess.name, 'adminManageRep', id, 'add ' + req.name);
    return json_({ ok:true, repId:id });
  }
  const rep = findRepAny_(req.name);
  if (!rep) return json_({ ok:false, error:'rep not found' });
  if (mode === 'resetPassword') sheet_('Reps').getRange(rep.row, 3).setValue(hash_(req.password || ''));
  else if (mode === 'setActive') sheet_('Reps').getRange(rep.row, 5).setValue(!!req.active);
  else if (mode === 'setRole') sheet_('Reps').getRange(rep.row, 4).setValue(req.role === 'admin' ? 'admin' : 'rep');
  else if (mode === 'setBranch') sheet_('Reps').getRange(rep.row, 7).setValue(req.branch || DEFAULT_BRANCH);
  else return json_({ ok:false, error:'unknown rep mode' });
  audit_(sess.name, 'adminManageRep', rep.repId, mode + ' ' + rep.name);
  return json_({ ok:true });
}

function listReps_() {
  return sheet_('Reps').getDataRange().getValues().slice(1).map(r => ({ repId:r[0], name:r[1], role:r[3], active:r[4], hasPassword:!!r[2], branch:r[6] || DEFAULT_BRANCH }));
}

function audit_(actor, action, entryId, details) {
  sheet_('AuditLog').appendRow([new Date(), actor || '', action || '', entryId || '', details || '']);
}

function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function fmtDate_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v || ''); }
function num_(v) { const n = Number(String(v == null ? '' : v).replace(/[$,]/g, '')); return isFinite(n) ? n : 0; }
function numOrBlank_(v) { const n = num_(v); return n === 0 && (v === '' || v == null) ? '' : n; }
function round2_(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function truthy_(v) { return v === true || v === 'Y' || v === 'Yes' || v === 'on' || v === 1 || v === '1'; }

// ---------- dashboard v2 data (admin-only; read-only aggregation, no writes) ----------
//
// Funnel (AUTHORITATIVE — overrides v1/Looker): Leads -> Qualified Sits -> Demos -> Close.
//   leadsIssued      = disposition row count
//   qualifiedSits    = Qualified Sit flag == 'Y'           (col 41)
//   demos            = Presented Price/Products/Hour=='Y'  (col 8)  -- "demo" = product shown
//   roofingAgreements= outcome == 'Contract Signed'
//   oneCallCloses    = Signed Type == 'One Call Close'      (col 12, reported, not inferred)
//   followUpContracts= Signed Type == 'Follow Up Contract'  (col 12)
// Rates (computed client-side from these raw counts): sitRate=qualifiedSits/leadsIssued,
// demoRate=demos/qualifiedSits, closeRate=roofingAgreements/demos, occRate=oneCallCloses/qualifiedSits.

function blankAgg_(keys) {
  return Object.assign({
    leadsIssued: 0, qualifiedSits: 0, demos: 0, roofingAgreements: 0, oneCallCloses: 0, followUpContracts: 0,
    grossRevenue: 0, turnDownCount: 0, turnDownRevenue: 0, doorsKnocked: 0, commission: 0, squaresSold: 0,
  }, keys || {});
}

function repBranchMap_() {
  const rows = sheet_('Reps').getDataRange().getValues().slice(1);
  const m = {};
  rows.forEach(r => { m[r[1]] = r[6] || DEFAULT_BRANCH; });
  return m;
}

function sumAgg_(rows) {
  const t = blankAgg_();
  rows.forEach(r => Object.keys(t).forEach(k => { t[k] += Number(r[k]) || 0; }));
  return t;
}

// Aggregates live (Dispositions/DoorsKnocked) + historical (KPI Tracker) data for one date
// window and branch, filtering every source by its own date column BEFORE aggregating.
function aggregateWindow_(start, end, branch, opts) {
  opts = opts || {};
  const repBranch = repBranchMap_();
  const branchOf = rep => repBranch[rep] || DEFAULT_BRANCH; // ADJUST: reps missing from the Reps tab default here
  const branchOk = rep => !branch || branch === 'All' || branchOf(rep) === branch;
  const byRep = {}, byDate = {}, byLeadSource = {};
  const bump = (map, key, keys) => { if (!map[key]) map[key] = blankAgg_(keys); return map[key]; };

  sheet_('Dispositions').getDataRange().getValues().slice(1).forEach(r => {
    const date = fmtDate_(r[2]); // Date col index 2
    if (date < start || date > end) return;
    const rep = r[3];
    if (!branchOk(rep)) return;
    const leadSource = canonicalLeadSource_(r[6]);
    const outcome = r[7];
    const rp = bump(byRep, rep, { rep, branch: branchOf(rep) });
    const dt = bump(byDate, date, { date });
    const ls = bump(byLeadSource, leadSource, { leadSource });
    [rp, dt, ls].forEach(a => a.leadsIssued++);
    if (r[41] === 'Y') [rp, dt, ls].forEach(a => a.qualifiedSits++); // Qualified Sit
    if (r[8] === 'Y') [rp, dt, ls].forEach(a => a.demos++); // Presented Price/Products/Hour -> demo
    if (outcome === 'Contract Signed') {
      [rp, dt, ls].forEach(a => a.roofingAgreements++);
      if (r[12] === 'One Call Close') [rp, dt, ls].forEach(a => a.oneCallCloses++);
      else if (r[12] === 'Follow Up Contract') [rp, dt, ls].forEach(a => a.followUpContracts++);
      const gutterTotal = r[27] === 'Y' ? num_(r[28]) * num_(r[29]) : 0;
      const sidingTotal = r[31] === 'Y' ? num_(r[32]) * num_(r[33]) : 0;
      const revenue = num_(r[14]) + gutterTotal + sidingTotal + num_(r[35]);
      [rp, dt, ls].forEach(a => { a.grossRevenue += revenue; a.squaresSold += num_(r[22]); });
      rp.commission += num_(r[38]);
    }
    if (r[18] === 'Denied') [rp, dt, ls].forEach(a => { a.turnDownCount++; a.turnDownRevenue += num_(r[21]); });
  });

  sheet_('DoorsKnocked').getDataRange().getValues().slice(1).forEach(r => {
    const date = fmtDate_(r[1]); // Date col index 1
    if (date < start || date > end) return;
    const rep = r[2];
    if (!branchOk(rep)) return;
    bump(byRep, rep, { rep, branch: branchOf(rep) }).doorsKnocked += num_(r[3]);
    bump(byDate, date, { date }).doorsKnocked += num_(r[3]);
  });

  // ---- HISTORICAL (frozen, pre-app) — only contributes for dates on/before HIST_CUTOVER ----
  // The live app above is authoritative after the cutover; new data flows in there automatically.
  if (start <= HIST_CUTOVER) {
    const histEnd = end < HIST_CUTOVER ? end : HIST_CUTOVER; // clamp to the frozen window

    // 1) AUTHORITATIVE reconciled funnel + contracts + revenue + turndowns, per rep/date, from the
    //    manual-review reconciliation sheet ('_nightly_corrected' = the blessed value). In this model
    //    OCC, Follow-Up, and 'Roofing Agreements' are three SEPARATE signed categories, so total
    //    signed contracts = their sum.
    const rec = SpreadsheetApp.openById(RECON_SHEET_ID).getSheetByName('Corrected Reconciliation').getDataRange().getValues();
    const ci = {}; (rec[0] || []).forEach((h, i) => { ci[String(h).replace(/^﻿/, '')] = i; });
    const cnum = (r, k) => num_(r[ci[k]]);
    rec.slice(1).forEach(r => {
      if (!r || !r[ci['Date']]) return;
      const date = fmtDate_(r[ci['Date']]);
      if (date < start || date > histEnd) return;
      const rep = r[ci['Rep']];
      if (!branchOk(rep)) return;
      const occ = cnum(r, 'occ_nightly_corrected');
      const fu = cnum(r, 'followup_contracts_nightly_corrected');
      const ra = cnum(r, 'roofing_agreements_nightly_corrected');
      const rp = bump(byRep, rep, { rep, branch: branchOf(rep) });
      const dt = bump(byDate, date, { date });
      [rp, dt].forEach(a => {
        a.leadsIssued += cnum(r, 'leads_nightly_corrected');
        a.demos += cnum(r, 'demos_nightly_corrected');
        a.oneCallCloses += occ;
        a.followUpContracts += fu;
        a.roofingAgreements += occ + fu + ra; // total signed = the three signed categories summed
        a.grossRevenue += cnum(r, 'gross_revenue_nightly_corrected');
        a.turnDownCount += cnum(r, 'turndown_count_nightly_corrected');
        a.turnDownRevenue += cnum(r, 'turndown_revenue_nightly_corrected');
      });
    });

    const kpiSs = SpreadsheetApp.openById(KPI_SHEET_ID);

    // 2) Doors + qualified sits are NOT in the reconciliation (never nightly-tracked). Take what the
    //    Rep Daily rollup has — doors are the only source; historical sits are approximate (flagged).
    const repDaily = kpiSs.getSheetByName('Historical Rep Daily KPI').getDataRange().getValues();
    const ri = {}; (repDaily[0] || []).forEach((h, i) => { ri[h] = i; });
    repDaily.slice(1).forEach(r => {
      const date = fmtDate_(r[ri['Date']]);
      if (date < start || date > histEnd) return;
      const rep = r[ri['Rep']];
      if (!branchOk(rep)) return;
      const rp = bump(byRep, rep, { rep, branch: branchOf(rep) });
      const dt = bump(byDate, date, { date });
      [rp, dt].forEach(a => { a.doorsKnocked += num_(r[ri['Doors Knocked']]); a.qualifiedSits += num_(r[ri['Qualified Sits']]); });
    });

    // 3) Squares-sold (not in the reconciliation) + the lead-source breakdown come from the raw
    //    'Historical Customer Dispositions' tab. Signed-only; revenue = contract+gutter+added (live-style).
    //    Lead-source figures are disposition-derived and may not sum exactly to the reconciled rep totals.
    const histDispo = kpiSs.getSheetByName('Historical Customer Dispositions').getDataRange().getValues();
    const hi = {}; (histDispo[0] || []).forEach((h, i) => { hi[String(h).replace(/^﻿/, '')] = i; });
    histDispo.slice(1).forEach(r => {
      const date = fmtDate_(r[hi['Date']]);
      if (date < start || date > histEnd) return;
      const rep = r[hi['Rep']];
      if (!branchOk(rep)) return;
      const src = canonicalLeadSource_(r[hi['Lead Source']]);
      const ls = opts.skipHistLeadSource ? null : bump(byLeadSource, src, { leadSource: src });
      if (ls) ls.leadsIssued++; // every disposition row is one appointment for its source
      const s = String(r[hi['Signed']] || '').trim().toLowerCase();
      if (!(s.indexOf('contract') === 0 || s.indexOf('contig') === 0 || s.indexOf('contin') === 0)) return; // signed/contingency only
      const sq = num_(r[hi['Square Count']]);
      const gutter = truthy_(r[hi['Gutters Included']]) ? num_(r[hi['Gutter LF']]) * num_(r[hi['Gutter $/LF']]) : 0;
      const revenue = num_(r[hi['Contract Amount']]) + gutter + num_(r[hi['Added Work Amount']]);
      bump(byRep, rep, { rep, branch: branchOf(rep) }).squaresSold += sq;
      bump(byDate, date, { date }).squaresSold += sq;
      if (ls) { ls.roofingAgreements++; ls.grossRevenue += revenue; ls.squaresSold += sq; }
    });
  }

  return {
    byRep: Object.values(byRep), byDate: Object.values(byDate), byLeadSource: Object.values(byLeadSource),
    totals: sumAgg_(Object.values(byRep)), // totals from byRep only — byLeadSource historical rows mirror the same underlying deals, summing both would double-count
  };
}

function adminDashboardData_(req) {
  const branch = req.branch || 'All';
  const end = req.end || today_();
  const start = req.start || end;
  const cmp = compareWindow_(start, end);
  const current = aggregateWindow_(start, end, branch);
  const compare = aggregateWindow_(cmp.compareStart, cmp.compareEnd, branch, { skipHistLeadSource: true });
  const ytdStart = today_().slice(0, 4) + '-01-01'; // ADJUST: change if the goal year ever isn't the calendar year
  const ytd = aggregateWindow_(ytdStart, today_(), branch, { skipHistLeadSource: true });
  return json_({
    ok: true,
    current: { byRep: current.byRep, byDate: current.byDate, byLeadSource: current.byLeadSource, totals: current.totals },
    compare: { byRep: compare.byRep, totals: compare.totals },
    ytd: { squaresSold: ytd.totals.squaresSold, grossRevenue: ytd.totals.grossRevenue, contracts: ytd.totals.roofingAgreements },
    goals: getGoals_(),
    start, end, branch, compareStart: cmp.compareStart, compareEnd: cmp.compareEnd,
  });
}

function boolText_(v) { return truthy_(v) ? 'Y' : 'N'; }
