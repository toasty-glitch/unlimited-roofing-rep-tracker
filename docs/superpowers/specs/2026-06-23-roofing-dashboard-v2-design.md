# Roofing Rep Tracker — Dashboard v2 Design

Date: 2026-06-23
Repo: `toasty-glitch/unlimited-roofing-rep-tracker`
Status: approved (design); pending spec review

## Goal

Replace the Looker Studio report ("Ultimate Roofing Reporting Dashboard") with the
in-app `pwa/dashboard.html`, adding three requested features:

1. Date range selector that drives the dashboard.
2. Milestone dials — existing rate KPIs **plus** yearly goal dials.
3. Rep-level deltas for each metric.

The new page becomes the live operational view and the system of reporting record.

## Decisions (locked)

- Donation dial = **manual** number; admin edits "donated to date" against a fixed $10,000 goal.
- Yearly targets (2026): **squares sold 5,000 · total revenue $3,000,000 · total contracts 276**.
- Rep deltas compare against the **prior equal-length period** (e.g. last 14 days vs the 14 days before).
- Scope = **replace** Looker (page must own branch view, lead-source bubble chart, period tables).
- Rate KPI dials = **Demo Rate (target 80%)**, **One Call Close % (target 30%)**, plus
  **Close Rate** (agreements/demos) and **Sit Rate** (sits/demos) for full-funnel health.
- Branches = **add a branch field now**; existing 8 reps seed to "Roanoke".

## Known bug fixed as part of this work

`adminDashboardData_` builds `byDate`/`byRep`/`byLeadSource` maps but never writes the key
(date/rep/leadSource) onto the aggregate objects, so the current dashboard renders
`undefined` rep/date/source labels. v2 attaches these keys.

## Backend — `apps-script/Code.gs`

### Aggregation
- `blankAgg_()` and the agg builders attach identifying keys: `rep`, `date`, `leadSource`, `branch`.
- Add `squaresSold` to the aggregate (sum of `Square Count`, col index 22, on `Contract Signed` rows).
- Branch derived from the rep's `Branch` column at read time (no change to the write path).

### Branch field
- Add `Branch` column to the `Reps` tab schema (`TABS.Reps`).
- `seedReps_` / migration sets existing reps' branch to `Roanoke`.
- Rep lookups (`findRepAny_`, `listReps_`) carry `branch`.
- `adminManageRep` add/edit accepts `branch`.

### Goals tab
- New `Goals` tab (single config row, key/value), keys:
  `squaresTarget=5000`, `revenueTarget=3000000`, `contractsTarget=276`,
  `donationGoal=10000`, `donatedToDate=0`,
  `demoRateTarget=0.8`, `occTarget=0.3`, `sitRateTarget` (optional), `closeRateTarget` (optional).
- Actions: `getGoals` (admin) returns the config; `setGoals` (admin) writes edited values
  (so donated-to-date and targets are editable from the dashboard).

### `adminDashboardData`
- Accepts `{ start, end, branch }`.
- Computes `compareStart`/`compareEnd` = the equal-length window immediately before `[start, end]`.
- Returns:
  - `current`: `{ byRep, byLeadSource, byDate, totals }` filtered to `[start, end]` and branch.
  - `compare`: `{ byRep, totals }` for the prior equal-length window (delta source).
  - `ytd`: `{ squaresSold, grossRevenue, contracts }` for Jan 1 → today, branch-filtered,
    independent of the selected range (drives yearly dials).
  - `goals`: from the Goals tab.
- Live data (Dispositions/DoorsKnocked) is fully date-filterable.
- Historical KPI sheet: `Historical Rep Daily KPI` has a Date column → date-filterable;
  `Historical Lead Source KPI` has **no date** → contributes only to all-time/YTD, not to
  arbitrary custom ranges. The UI labels this rather than silently dropping it.

## Frontend — `pwa/dashboard.html`

Top-to-bottom, single responsive page:

1. **Control bar** — branch dropdown + date presets (This month / Last 14 days / YTD / Custom
   with two date inputs). Selecting a range refetches `adminDashboardData`.
2. **Yearly goal dials** (YTD, fixed targets) — Squares Sold, Total Revenue, Total Contracts,
   Donated. SVG ring gauges (no new dependency). Show value / target and % to goal.
3. **Range KPI dials** (follow the selector) — Demo Rate (vs 80%), OCC% (vs 30%), Close Rate, Sit Rate.
4. **Scorecards** — selected-range totals (leads, demos, sits, closes, gross/net revenue,
   avg contract, doors, commission).
5. **Rep comparison table** — one column per rep, value + inline green/red delta vs prior period.
6. **Lead source** — table + squares-vs-gross-revenue bubble chart with avg-contract-price and
   median-squares reference lines (ported from Looker).
7. **Revenue trend** — historical→live line (fixed to use the `date` key).
8. **Doors funnel** — Doors → Leads → Demos → Sits → Closes with stage conversion %.
9. **Commission by rep** — live-period bar.

### Dials
- Implemented as inline SVG ring gauges: gray track circle + colored value arc via
  `stroke-dasharray`/`stroke-dashoffset`, center % label, value/target subtitle.
- Yearly dials: amber arc (pink for the donation dial). KPI dials: teal arc.
- A small reusable `gauge(pct, opts)` helper renders each.

### Deltas
- For each rep/metric: `current - compare` (counts) or `% change` (revenue), rendered with
  `ti-arrow-up` (green) / `ti-arrow-down` (red); zero shown neutral.

## Testing

- `test/` already exists. Add an assert-based check for the pure helpers that can run outside
  Apps Script: equal-length compare-window math, percent/delta formatting, and goal-percent
  clamping (0–100%). Apps Script-bound functions verified manually in the deployed web app.

## Out of scope

- Changing the rep app (`pwa/index.html`) write path.
- Multi-branch data entry UI beyond tagging reps (dashboard filter only).
- Retiring the Looker report immediately — keep it read-only one cycle as a fallback,
  then delete once numbers reconcile.
