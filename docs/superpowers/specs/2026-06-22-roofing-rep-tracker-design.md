# Roofing Rep Tracker — Design Spec

**Date:** 2026-06-22
**Status:** Approved, ready for implementation planning

## Purpose

Replace two existing live Google Forms — "Customer Disposition Form" (41 fields,
per-appointment) and "Retail Nightly Numbers" (12 fields, per-rep nightly summary,
currently feeding a Looker Studio dashboard) — with a single mobile PWA that reps use
to log every appointment as it happens. Nightly numbers are computed automatically from
that day's logged appointments instead of being a second manual form. Commission
calculation is built into the entry flow as a live preview, removing rep math errors.

This is the roofing-division equivalent of the existing **UHS Rep Tracker** (bathroom
division, live at https://toasty-glitch.github.io/uhs-rep-tracker/), built as a fully
separate, independent deployment — separate repo, separate Apps Script project,
separate Google Sheet. The two business lines' commission logic and rep rosters do not
overlap and must not share a codebase.

## Architecture

- **Frontend:** Static PWA on GitHub Pages — `index.html`, `manifest.json`, `sw.js`,
  icons. Same shape as UHS Rep Tracker.
- **Backend:** Standalone Google Apps Script web app (`Code.gs`), deployed as a web app
  running as the owner's account, always-on, no server to maintain.
- **Data store:** A Google Sheet, auto-created by the script on first run (bootstrap
  pattern: script checks Script Properties for a stored spreadsheet ID, creates the
  sheet + tabs if missing).
- **API shape:** Single endpoint, `POST { action, token?, ...payload }` → JSON
  response. Actions: `login`, `logAppointment`, `getToday`, `tapDoor`, `getHistory`,
  `editAppointment` (same-day only for reps; any-day for admins), `adminTeamRollup`,
  `adminManageRep` (add/deactivate/reset password).
- **Auth:** Salted SHA-256 password hashes stored in the `Reps` tab. Session tokens via
  `CacheService`, 12h TTL, same as UHS Rep Tracker. Roles: `rep` or `admin`.

## Data model (Sheet tabs)

**Reps**
`Rep ID | Name | Password Hash | Role | Active | Created`
Seeded accounts: Chris Jones, Dave Kershaw, Sheldon Stimeling, Andrew Fielder, James
Meadows (role `rep`); Stacy Clark, Jessica Henson, Ted Beedle (role `admin`).

**Dispositions** (replaces the Customer Disposition Form; fields dropped vs. the old
form are called out below)
```
Timestamp, Date, Rep, Customer Name, Customer Phone, Lead Source, Appointment Outcome,
Presented Price/Products/Hour (Y/N), Out-of-Scope Reason, Follow-up Date,
Signed (Y/N/Type), No-Sign Reason, Contract Amount, Cash Amount, Down Payment,
Applied Financing (Y/N), Financing Result, Financing Source, Approved Amount,
Denied Amount, Square Count, Cost Per Square, Commission Rate, Roof Commission $,
Manager-Approved Below Floor (Y/N), Gutters Included (Y/N), Gutter LF, Gutter $/LF,
Siding Included (Y/N), Siding Sqft, Added Work Amount, Flat-Rate Commission $,
Total Commission $, CRMX Screenshot Uploaded (Y/N), Appointment Confirmed (Y/N),
Qualified Sit (Y/N)
```
Dropped from the old 41-field form (per explicit simplification decisions):
- Split-commission fields (3 fields) — no splits exist; commission always goes 100% to
  the assigned rep.
- At-cost vs. upsale distinction + "who receives payment" routing (3 fields) — added
  work is just an amount at the flat 10% rate, always credited to the closing rep.

**DoorsKnocked**
`Timestamp, Date, Rep, Tap Count` — one row per sync batch from the tap counter
(batched client-side to avoid a network call per tap; synced every N taps or on
app background/foreground transition).

**No NightlySummary tab.** Nightly numbers (leads issued, leads demo'd, no-op, one-call
close, follow-up contracts, roofing agreements, gross revenue, turn-down count, turn-
down revenue) are computed live from that day's `Dispositions` rows by outcome-type
counting and revenue summing, joined with that day's `DoorsKnocked` total. This is a
read-time computation, not a stored row — removes the double-entry the old two-form
system required.

## Screens

1. **Login** — name + password, routes by role.
2. **Today** (rep home) — big door-knock tap counter; "Log Appointment" button;
   today's logged appointments (tap to edit, same-day only); today's auto-computed
   nightly numbers, read-only, live.
3. **Log Appointment** (outcome-chips + expandable detail pattern):
   - Customer name/phone, Lead Source, then large outcome buttons.
   - Non-sale outcomes (No Show, Rescheduled, Out of Scope, Disinterested, Cancelled,
     Follow-up Needed) submit in two taps with a short reason field — no further detail
     required.
   - "Contract Signed" expands inline: price/sq → **live commission preview** updates
     as the rep types → financing block (only shown if financing applied) → gutters/
     siding/added-work block → CRMX-upload checkbox → save.
   - If cost/sq < $580, the row still saves (Roof Commission $ left blank, manager-
     approval-pending flag set); the rep sees a "needs manager approval" confirmation
     instead of a normal save confirmation. Entry stays flagged and visible on the
     Manager Dashboard until an admin sets the rate and clears it.
4. **History** — past entries, filterable by date range; reps edit same-day only,
   admins can edit any entry.
5. **Manager Dashboard** (admin-only) — team rollup for any date range (leads, demos,
   close rate, revenue, commission paid, doors knocked, per-rep breakdown); rep
   management (add / deactivate / reset password), matching UHS Rep Tracker's Team tab.
   Pending manager-approval-required deals surfaced prominently here.

## Commission engine (server-side, in Code.gs)

```js
function roofCommissionRate_(costPerSquare) {
  if (costPerSquare < 580) return null; // blocks save; requires manager approval
  if (costPerSquare < 600) return 0.05;
  if (costPerSquare < 630) return 0.075;
  return 0.10;
}
const FLAT_RATE = 0.10; // gutters, siding, added work — always, no exceptions
```
- Roof commission = roof-portion contract $ × `roofCommissionRate_(costPerSquare)`
- Flat-rate commission = (gutters $ + siding $ + added-work $) × `FLAT_RATE`
- Total commission = roof commission + flat-rate commission
- Below-$580: no auto rate computed; admin sets the rate manually at approval time via
  the Manager Dashboard, and the entry's manager-approval flag clears.
- Commission is always credited 100% to the rep the lead was assigned to. No splits, no
  alternate payees, ever.

## Looker Studio report

Built via Looker Studio's Linking API — a pre-configured report URL with the data
source and full chart layout encoded as URL parameters, so the only manual step is
opening the link and clicking "Save" once to materialize it into the owner's Looker
Studio account. No manual chart-building.

- **Data source:** the new Sheet (a computed daily-rollup tab may be added specifically
  to keep Looker's own calculated fields simple, mirroring the `KPI Feed` pattern used
  for the separate Unlimited Roofing KPI Tracker built earlier).
- **Planned charts:** revenue trend (daily/weekly), close rate by rep, close rate by
  lead source, commission paid by rep, leads→demo→close funnel, doors-knocked vs.
  close-rate correlation, turn-down rate.
- Built fresh, not modeled on the existing Nightly Numbers dashboard
  (lookerstudio.google.com/reporting/475018ad-3d87-4755-948a-6ed9f1520ae2) — the
  underlying data shape is changing enough that matching its exact layout isn't a goal.

## Error handling

- **Offline queueing:** service worker caches the app shell; appointment submissions
  made without connectivity queue in `localStorage` and sync on reconnect. Roofing
  reps are more likely to be in signal dead zones (attics, basements, rural sites) than
  the bathroom-division precedent needed to handle.
- **Duplicate-submit guard** on the save action.
- **Manager-approval-pending** deals stay visibly flagged (Today screen for the rep,
  Manager Dashboard for admins) until an admin clears them.

## Testing

Manual smoke pass after deploy, mirroring `verify` skill practice:
- Log one disposition per outcome type; confirm each saves correctly.
- Log a sold deal at each commission tier boundary ($579, $580, $599, $600, $629,
  $630) and confirm the computed rate and dollar amount are correct at each.
- Confirm a sub-$580 deal blocks save and appears on the Manager Dashboard as pending.
- Tap the doors-knocked counter repeatedly, refresh mid-session, confirm the count
  persists.
- Confirm the day's auto-computed nightly numbers match a manual count of that day's
  logged dispositions.
- Confirm the admin team rollup matches the sum of individual rep numbers for the same
  date range.
