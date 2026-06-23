/**
 * Unlimited Roofing Rep Tracker - Apps Script backend.
 * Deploy as a standalone web app: Execute as Me, access Anyone.
 * POST JSON { action, token?, ...payload } -> JSON response.
 */

const SS_PROP = 'ROOFING_REP_TRACKER_SPREADSHEET_ID';
const SALT_PROP = 'ROOFING_REP_TRACKER_SALT';
const ADMIN_PIN_PROP = 'ROOFING_REP_TRACKER_ADMIN_PIN';
const KPI_SHEET_ID = '1sYx3ARdazMCn0oCuC_svI3DxQ4PhPhH6yXU5QfFgryc'; // Unlimited Roofing — KPI Tracker (historical data)
const TZ = 'America/New_York';
const TOKEN_TTL_SECONDS = 43200;
const ROOF_FLOOR = 580;
const FLAT_RATE = 0.10;

const TABS = {
  Reps: ['Rep ID','Name','Password Hash','Role','Active','Created'],
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

const OUTCOMES = ['Contract Signed','Follow-up Needed','No Show','Rescheduled','Out of Scope','Disinterested','Cancelled'];
const LEAD_SOURCES = ['Company Lead','Retail Nightly','Self-Gen','Referral','Canvass','Roofer Stage','Angi\'s List','Guaranteed Estimates','Other'];
const NO_SIGN_REASONS = ['Think It Over','Price','Spouse Not Present','Financing','Competitor','Timing','Not Qualified','Other'];

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
  return ss;
}

function sheet_(name) { return ss_().getSheetByName(name); }

function seedReps_() {
  const reps = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty(SS_PROP)).getSheetByName('Reps');
  if (reps.getLastRow() > 1) return;
  SEED_REPS.forEach((r, idx) => reps.appendRow(['R' + String(idx + 1).padStart(3, '0'), r[0], '', r[1], true, new Date()]));
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
      return { row:i + 1, repId:rows[i][0], name:rows[i][1], hash:rows[i][2], role:rows[i][3], active:rows[i][4] };
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
    sh.appendRow([id, req.name, req.password ? hash_(req.password) : '', req.role === 'admin' ? 'admin' : 'rep', true, new Date()]);
    audit_(sess.name, 'adminManageRep', id, 'add ' + req.name);
    return json_({ ok:true, repId:id });
  }
  const rep = findRepAny_(req.name);
  if (!rep) return json_({ ok:false, error:'rep not found' });
  if (mode === 'resetPassword') sheet_('Reps').getRange(rep.row, 3).setValue(hash_(req.password || ''));
  else if (mode === 'setActive') sheet_('Reps').getRange(rep.row, 5).setValue(!!req.active);
  else if (mode === 'setRole') sheet_('Reps').getRange(rep.row, 4).setValue(req.role === 'admin' ? 'admin' : 'rep');
  else return json_({ ok:false, error:'unknown rep mode' });
  audit_(sess.name, 'adminManageRep', rep.repId, mode + ' ' + rep.name);
  return json_({ ok:true });
}

function listReps_() {
  return sheet_('Reps').getDataRange().getValues().slice(1).map(r => ({ repId:r[0], name:r[1], role:r[3], active:r[4], hasPassword:!!r[2] }));
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

// ---------- dashboard data (admin-only; read-only aggregation, no writes) ----------
function adminDashboardData_(req) {
  return json_({ ok: true, live: liveDashboardAgg_(), historical: historicalDashboardAgg_() });
}

function blankAgg_() {
  return { leadsIssued: 0, demos: 0, noOp: 0, sits: 0, oneCallClose: 0, followUpContracts: 0, roofingAgreements: 0,
    grossRevenue: 0, turnDownCount: 0, turnDownRevenue: 0, doorsKnocked: 0, commission: 0, dispositionRows: 0, signed: 0 };
}

function liveDashboardAgg_() {
  const rows = sheet_('Dispositions').getDataRange().getValues().slice(1);
  const doorRows = sheet_('DoorsKnocked').getDataRange().getValues().slice(1);
  const byDate = {}, byRep = {}, byLeadSource = {};
  const bump = (map, key) => { if (!map[key]) map[key] = blankAgg_(); return map[key]; };

  rows.forEach(r => {
    const date = fmtDate_(r[2]), rep = r[3], leadSource = r[6] || '(blank)', outcome = r[7];
    const d = bump(byDate, date), rp = bump(byRep, rep), ls = bump(byLeadSource, leadSource);
    [d, rp, ls].forEach(a => { a.leadsIssued++; a.dispositionRows++; });
    if (outcome === 'No Show' || outcome === 'Cancelled') [d, rp, ls].forEach(a => a.noOp++);
    else [d, rp, ls].forEach(a => a.demos++);
    if (r[41] === 'Y') [d, rp, ls].forEach(a => a.sits++); // Qualified Sit
    if (outcome === 'Contract Signed') {
      [d, rp, ls].forEach(a => { a.roofingAgreements++; a.signed++; });
      if (r[10]) [d, rp, ls].forEach(a => a.followUpContracts++); else [d, rp, ls].forEach(a => a.oneCallClose++);
      const gutterTotal = r[27] === 'Y' ? num_(r[28]) * num_(r[29]) : 0;
      const sidingTotal = r[31] === 'Y' ? num_(r[32]) * num_(r[33]) : 0;
      const revenue = num_(r[14]) + gutterTotal + sidingTotal + num_(r[35]);
      [d, rp, ls].forEach(a => a.grossRevenue += revenue);
      rp.commission += num_(r[38]);
    }
    if (r[18] === 'Denied') {
      [d, rp, ls].forEach(a => { a.turnDownCount++; a.turnDownRevenue += num_(r[21]); });
    }
  });

  doorRows.forEach(r => {
    const date = fmtDate_(r[1]), rep = r[2];
    bump(byDate, date).doorsKnocked += num_(r[3]);
    bump(byRep, rep).doorsKnocked += num_(r[3]);
  });

  return { byDate: Object.values(byDate), byRep: Object.values(byRep), byLeadSource: Object.values(byLeadSource) };
}

function historicalDashboardAgg_() {
  const kpiSs = SpreadsheetApp.openById(KPI_SHEET_ID);
  const repDaily = kpiSs.getSheetByName('Historical Rep Daily KPI').getDataRange().getValues();
  const rdHeader = repDaily[0];
  const ri = {}; rdHeader.forEach((h, i) => ri[h] = i);
  const byDate = {}, byRep = {};
  const bump = (map, key) => { if (!map[key]) map[key] = blankAgg_(); return map[key]; };

  repDaily.slice(1).forEach(r => {
    const date = r[ri['Date']], rep = r[ri['Rep']];
    const d = bump(byDate, date), rp = bump(byRep, rep);
    [d, rp].forEach(a => {
      a.leadsIssued += num_(r[ri['Leads Issued']]);
      a.demos += num_(r[ri["Leads Demo'd"]]);
      a.noOp += num_(r[ri['No Op']]);
      a.sits += num_(r[ri['Qualified Sits']]);
      a.oneCallClose += num_(r[ri['One Call Close']]);
      a.followUpContracts += num_(r[ri['Follow Up Contracts']]);
      a.roofingAgreements += num_(r[ri['Roofing Agreements']]);
      a.grossRevenue += num_(r[ri['Gross Revenue']]);
      a.turnDownCount += num_(r[ri['Turn-down #']]);
      a.turnDownRevenue += num_(r[ri['Turn-down Total Revenue']]);
      a.doorsKnocked += num_(r[ri['Doors Knocked']]);
    });
    rp.dispositionRows += num_(r[ri['Disposition Rows']]);
    rp.signed += num_(r[ri['Disposition Signed Count']]);
  });

  const lsRows = kpiSs.getSheetByName('Historical Lead Source KPI').getDataRange().getValues();
  const lsHeader = lsRows[0];
  const li = {}; lsHeader.forEach((h, i) => li[h] = i);
  const byLeadSource = {};
  lsRows.slice(1).forEach(r => {
    const source = r[li['Lead Source']];
    const ls = bump(byLeadSource, source);
    ls.leadsIssued += num_(r[li['Appointments']]);
    ls.signed += num_(r[li['Signed Count']]);
    ls.roofingAgreements += num_(r[li['Signed Count']]);
    ls.grossRevenue += num_(r[li['Contract Amount']]);
  });

  return { byDate: Object.values(byDate), byRep: Object.values(byRep), byLeadSource: Object.values(byLeadSource) };
}
function boolText_(v) { return truthy_(v) ? 'Y' : 'N'; }
