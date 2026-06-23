# Sonnet execution prompt — Roofing Dashboard v2

Copy everything below the line into a fresh Sonnet (Claude Code) session running in the repo.

---

You are implementing "Dashboard v2" for the Unlimited Roofing Rep Tracker.

## Context & ground rules
- Repo (canonical, local): `C:\Users\Ted\Desktop\GENERATED CONTENT\Claude\Unlimited Home Services - Roofing\rep-tracker`
- Remote: `github.com/toasty-glitch/unlimited-roofing-rep-tracker`. Work on branch `dashboard-v2` (already exists). Do NOT commit to `master`.
- READ FIRST, in full: `docs/superpowers/specs/2026-06-23-roofing-dashboard-v2-design.md`. It is authoritative. This prompt summarizes; the spec governs.
- Files you will edit: `apps-script/Code.gs`, `pwa/dashboard.html`. Files you will create: `docs/ADJUSTING.md`. Files you will touch: `README.md` (add a Maintenance section), `pwa/sw.js` (bump cache version), `test/` (add a helper test).
- Do NOT change the rep app write path (`pwa/index.html` form/save logic). Read-only aggregation changes only.
- You cannot deploy Apps Script yourself — that is Ted's manual step. Your job is correct code + docs + tests. Put the deploy steps in `docs/ADJUSTING.md`.
- Single-user local ops, lazy-senior style: smallest correct diff, no new build tooling, no new runtime deps. The dashboard already loads Chart.js from CDN; dials are hand-rolled inline SVG (no gauge library).

## What to build

### 1. Fix the aggregation key bug (Code.gs)
`adminDashboardData_` builds `byDate`/`byRep`/`byLeadSource` maps but never writes the key onto the
aggregate objects, so the dashboard renders `undefined` labels. Attach `rep` / `date` / `leadSource`
/ `branch` to each aggregate. Add `squaresSold` (sum of `Square Count`, Dispositions col index 22,
on `Contract Signed` rows).

### 2. Uniform date filtering (Code.gs)
Filter every source to the requested window BEFORE aggregating, using its date column:
- `Dispositions` Date = col index 2.
- `DoorsKnocked` Date = col index 1.
- `Historical Rep Daily KPI` Date = col index 0.
- `Historical Lead Source KPI` Date = col index 0 (this column EXISTS — v1 ignored it; use it).
Result: lead source is date-filterable for any range. There is no lead-source date limitation.

### 3. Authoritative funnel math (Code.gs + dashboard.html) — DO NOT use v1's definitions
Funnel: Leads -> Qualified Sits -> Demos (product shown) -> Close.
Base counts per disposition row:
- Leads = row count.
- Qualified Sits = `Qualified Sit` == 'Y' (col 41).
- Demos = `Presented Price/Products/Hour` == 'Y' (col 8). "Demo" means product was shown.
- Agreements = outcome == 'Contract Signed'. One Call Close = signed, no follow-up date; Follow-Up Contract = signed, has follow-up date.
Rates:
- Sit Rate = Qualified Sits / Leads
- Demo Rate = Demos / Qualified Sits        (dial target 80%)
- Close Rate = Agreements / Demos
- One Call Close % = One Call Closes / (One Call + Follow-Up)   (dial target 30%) — add a `// CONFIRM:` comment on the denominator.
v1 counted `demos = presented||signed||follow-up` and `demos/leads`. Replace that.

### 4. Branch field (Code.gs)
Add a `Branch` column to the `Reps` tab schema. Migrate/seed existing reps to `Roanoke`. Carry
`branch` through `findRepAny_`/`listReps_`/`adminManageRep`. Dispositions inherit branch from the rep
at read time. `adminDashboardData` accepts a `branch` filter.

### 5. Goals tab (Code.gs)
New `Goals` tab (key/value rows), seeded:
`squaresTarget=5000`, `revenueTarget=3000000`, `contractsTarget=276`, `donationGoal=10000`,
`donatedToDate=0`, `demoRateTarget=0.8`, `occTarget=0.3`. Add admin action `getGoals` (read only).
NO `setGoals` / no on-dashboard editor — these are edited directly in the sheet.

### 6. adminDashboardData contract (Code.gs)
Accept `{ start, end, branch }`. Compute the prior equal-length window
(`compareStart`/`compareEnd` = the [len]-day block immediately before `[start,end]`). Return:
- `current`: `{ byRep, byLeadSource, byDate, totals }` for `[start,end]` + branch.
- `compare`: `{ byRep, totals }` for the prior equal-length window (delta source).
- `ytd`: `{ squaresSold, grossRevenue, contracts }` Jan 1 -> today, branch-filtered, IGNORING the selector (drives yearly dials).
- `goals`: from the Goals tab.
Merge historical + live within each window.

### 7. Dashboard UI (dashboard.html), top to bottom
1. Control bar: branch dropdown + date presets (This month / Last 14 days / YTD / Custom with two date inputs). Changing range refetches.
2. Yearly goal dials (YTD, fixed targets): Squares Sold, Total Revenue, Total Contracts, Donated ($/$10k). Inline SVG ring gauges, value/target + % to goal.
3. Range KPI dials (follow selector): Sit Rate, Demo Rate (vs 80%), Close Rate, One Call Close % (vs 30%).
4. Scorecards for the selected range.
5. Rep comparison table: one column per rep, value + inline green/red delta vs `compare`.
6. Lead source table + squares-vs-gross-revenue bubble chart with avg-contract-price and median-squares reference lines (port from the Looker report).
7. Revenue trend line (historical->live), fixed to use the `date` key.
8. Doors funnel: Doors -> Leads -> Qualified Sits -> Demos -> Closes with stage conversion %.
9. Commission-by-rep bar (live period).
Reuse the existing SVG ring-gauge pattern (track circle + value arc via stroke-dasharray). Yearly
dials amber (donation pink), KPI dials teal. One reusable `gauge()` helper.

### 8. Maintainability (REQUIRED — Ted will not edit code)
- Mark every hard-coded knob with `// ADJUST:` (or `<!-- ADJUST: -->`): commission ladder
  (`ROOF_FLOOR`, 5/7.5/10% breakpoints, `FLAT_RATE`), date presets, the dial set, `DEFAULT_API`.
- Top-of-file header comment in `Code.gs` and `dashboard.html`: what it does + where the knobs are.
- Create `docs/ADJUSTING.md` — plain-English runbook for a non-coder: change a goal, add a rep,
  change a commission rate, redeploy the Apps Script after a code change (Manage deployments -> Edit
  -> New version, URL stays), and bump the service-worker cache. Add a `## Maintenance` section to
  `README.md` pointing to it.
- Bump the cache version string in `pwa/sw.js` (otherwise phones serve a stale shell).

## Testing
- Add an assert-based test in `test/` for the pure helpers that run outside Apps Script: the
  prior-equal-length compare-window math, percent/delta formatting, and goal-% clamping (0–100).
- Apps Script-bound functions are verified manually by Ted in the deployed web app (document how).

## Done = all of:
- `grep ADJUST` lists every code knob; `docs/ADJUSTING.md` exists and is non-coder readable.
- Dials, deltas, date selector, branch filter present; rep/lead-source/date labels are real (not `undefined`).
- Funnel math matches section 3 exactly (not v1's).
- Helper test passes; state the command + result.
- Commits are on `dashboard-v2` with clear messages. Do not deploy; leave Looker untouched.

When unsure about a metric denominator or a layout call, leave a `// CONFIRM:` note and keep going;
don't block.
