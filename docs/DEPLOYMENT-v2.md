# Dashboard v2 — deployment sequence

Two pieces change together: the **backend** (`apps-script/Code.gs`, deployed manually in Apps
Script) and the **frontend** (`pwa/dashboard.html`, auto-deployed by GitHub Pages on push to
`master`). The old dashboard expects the old response shape, so there's a short window where
mismatched halves break the dashboard. Deploy in this order to keep that window to ~1–2 minutes.

The **rep app** (`pwa/index.html`) is backward-compatible with the new backend — reps are NOT
affected at any point. Only the admin dashboard has a brief window.

## 0. Pre-flight (already done)
- [x] Code reviewed, funnel math confirmed, QC fixes applied.
- [x] `node test/dashboard-helpers.test.js` and `node test/rollup.test.js` both pass.
- [x] Branch `dashboard-v2` merged into local `master` (not yet pushed).

## 1. Deploy the BACKEND first (Apps Script — manual, ~3 min)
1. Open the rep tracker's Apps Script project (script.google.com → the Unlimited Roofing Rep
   Tracker project; or from the spreadsheet: Extensions → Apps Script).
2. Open `Code.gs`, select all, paste the new contents from
   `apps-script/Code.gs` (this repo, branch you're deploying). Save (Ctrl/Cmd+S).
3. **Run migrations once:** in the editor, pick the function `ss_` in the dropdown and click Run.
   Authorize if prompted. This adds the `Branch` column to the Reps tab (backfilled to Roanoke)
   and creates the `Goals` tab. (It also runs automatically on the next login, but doing it now
   surfaces any error before users hit it.)
4. **Set the Goals tab:** open the spreadsheet → `Goals` tab. Targets are pre-seeded
   (squares 5000, revenue 3000000, contracts 276, donationGoal 10000, demoRateTarget 0.8,
   occTarget 0.3). Set `donatedToDate` to the real number. Adjust any target if needed.
5. **Publish the new version:** Deploy → Manage deployments → (pencil/Edit on the active web app)
   → Version: **New version** → Deploy. The exec URL stays the same (`DEFAULT_API` is unchanged),
   so no frontend edit is needed.

> At this point the OLD dashboard on Pages is briefly broken (old frontend, new backend). The rep
> app keeps working. Proceed straight to step 2.

## 2. Deploy the FRONTEND (push master — ~1–2 min for Pages)
1. `git push origin master`.
2. GitHub Actions ("Deploy PWA to GitHub Pages") runs automatically; watch it go green in the
   repo's Actions tab (~1–2 min).
3. The dashboard at `https://toasty-glitch.github.io/unlimited-roofing-rep-tracker/dashboard.html`
   now serves v2. (The dashboard is not in the service-worker cache list, so it loads fresh — no
   cache-clear needed. The SW cache was bumped to v4 regardless.)

## 3. Verify (after Pages goes green)
- [ ] Log into the dashboard as an admin. Login screen renders (dark, gold heading).
- [ ] Yearly dials populate; **Squares Sold** reads roughly historical signed squares
      (~3,290 YTD) **plus** any app-era squares — not near-zero. Revenue/Contracts dials sensible.
- [ ] Donation dial reflects the `donatedToDate` you set, against $10,000.
- [ ] KPI dials show: Sit, Demo (vs 80%), Close, One Call Close % (vs 30%).
- [ ] Date presets (This month / Last 14 days / YTD) and custom range refetch and change numbers.
- [ ] Branch selector lists Roanoke (+ All).
- [ ] Rep table shows green/red deltas vs the prior equal-length period.
- [ ] Lead-source table shows a single **Gutter** bucket (no "Gutter guy"/"Gutter Lead" split).
- [ ] Open the rep app, start logging an appointment: Lead Source dropdown shows **Gutter** once.

## 4. Rollback (if something's wrong)
- **Backend:** Deploy → Manage deployments → set the active deployment back to the **previous
  version** (Apps Script keeps version history). Instant.
- **Frontend:** `git revert <merge commit>` then `git push` (Pages redeploys the prior dashboard),
  or temporarily roll the Apps Script back so the old dashboard's expected shape returns.
- The `Branch` column and `Goals` tab are additive and harmless if you roll back the code; no data
  is destroyed.

## Notes
- Nothing here touches the Looker Studio report — it stays active in parallel.
- All adjustable knobs are documented in `docs/ADJUSTING.md` (`grep ADJUST` lists them in code).
