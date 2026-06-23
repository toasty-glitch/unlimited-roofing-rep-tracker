# Adjusting the Rep Tracker & Dashboard (no coding required)

This guide covers the changes you can make yourself without touching any code, and the
exact clicks for the few changes that do need a code edit + redeploy.

## Things you change in the spreadsheet — no code, no deploy

Open the **Unlimited Roofing Rep Tracker** Google Sheet (the one the Apps Script created;
its name is shown when you open the Apps Script project, or find it in your Drive).

### Change a goal or target
1. Open the **Goals** tab.
2. Find the row for the value you want to change (`squaresTarget`, `revenueTarget`,
   `contractsTarget`, `donationGoal`, `donatedToDate`, `demoRateTarget`, `occTarget`).
3. Edit the **Value** column. Rates (`demoRateTarget`, `occTarget`) are decimals — `0.8` means 80%.
4. Refresh the dashboard in your browser. Done — no deploy needed.

### Update "donated to date"
Same as above — it's just the `donatedToDate` row in the **Goals** tab. There is no editor
on the dashboard itself; this is intentional so it can't be changed by accident.

### Add, deactivate, or change a rep's branch/role
Use the **Manager** tab inside the rep tracker app (not the dashboard) — same as today.
Branch is a new field there; new reps default to **Roanoke** if left blank.

### Add a new lead source
Lead sources are a fixed list (`LEAD_SOURCES` in the code) shown in the rep app's dropdown.
Adding a brand-new source requires a code edit (see below). Cleaning up messy historical
labels (e.g. "Gutter guy" vs "Gutter Lead") is a code edit too — see "Lead-source aliases" below.

## Things that need a code edit (each marked `// ADJUST:` in the file)

If you search the project files for the word `ADJUST`, you'll find every value below,
each with a comment explaining what it does. You don't have to find them yourself — a
developer or agent can `grep ADJUST apps-script/Code.gs pwa/dashboard.html` to list them all.

### Change the commission ladder
File: `apps-script/Code.gs`
- `ROOF_FLOOR` — cost-per-square below this pays no commission until a manager approves a rate.
- `FLAT_RATE` — the 10% rate applied to gutters/siding/added-work.
- The 5% / 7.5% / 10% breakpoints live in the `roofCommissionRate_` function.

### Change the lead-source alias map
File: `apps-script/Code.gs`, constant `LEAD_SOURCE_ALIASES`. Add an entry like
`'Messy Label': 'Clean Label'` to fold a historical typo/variant into a clean bucket.
Anything not listed passes through unchanged.

### Change date-range presets, dial set, or the brand color palette
File: `pwa/dashboard.html`.
- Date presets ("This month" / "Last 14 days" / "YTD") — the `PRESETS` object.
- Which metric each dial shows — `buildYearlyDials` / `buildKpiDials`.
- Colors — the `// ADJUST: brand palette` block at the top of the `<style>` section.

### Redeploy Apps Script after any `Code.gs` edit
The web app URL stays the same — you're publishing a new *version* of the same deployment.
1. Open the Apps Script project (Extensions → Apps Script from the spreadsheet, or the
   Apps Script editor directly).
2. Paste in / save the updated `Code.gs`.
3. Click **Deploy → Manage deployments**.
4. Click the pencil (edit) icon on the existing web app deployment.
5. Under **Version**, choose **New version**, add a short description, click **Deploy**.
6. The existing `/exec` URL keeps working — nothing in `dashboard.html` or `index.html` needs
   to change.

### Bump the cache after a `pwa/` edit (so phones don't serve a stale page)
File: `pwa/sw.js`, constant `CACHE`. Bump the version suffix (e.g. `v1` → `v2`) any time
`dashboard.html`, `index.html`, or other `pwa/` files change, then redeploy/republish the
`pwa/` folder (GitHub Pages). Phones will pick up the new cache on next load.

## Where to look when something seems wrong

- **Dashboard shows "undefined" labels** — this was the v1 bug (fixed in v2); if it
  reappears, check that `aggregateWindow_` in `Code.gs` is still attaching `rep`/`date`/
  `leadSource`/`branch` keys to each aggregate row.
- **A metric looks off** — check the "Metric definitions" comment block directly above
  `aggregateWindow_` in `Code.gs`; it's the single source of truth for what counts as a
  lead, sit, demo, close, etc.
- **Apps Script-bound functions** (anything touching the spreadsheet) can only be verified
  by opening the deployed web app and clicking through — there's no automated test harness
  for code that runs inside Google's servers. The `test/` folder covers the pure JavaScript
  math (commission calc, rollups, dashboard date/percent helpers) that can run outside Apps
  Script.
