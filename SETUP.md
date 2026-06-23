# Unlimited Roofing Rep Tracker - Deployment Runbook

Architecture: static PWA on GitHub Pages -> standalone Google Apps Script web app -> auto-created Google Sheet.

## Current repo

`C:\Users\Ted\Desktop\GENERATED CONTENT\Claude\Unlimited Home Services - Roofing\rep-tracker`

## Files

- `pwa/` - GitHub Pages frontend.
- `apps-script/Code.gs` - Google Apps Script backend.
- `docs/superpowers/specs/2026-06-22-roofing-rep-tracker-design.md` - approved product/design spec.

## 1. Create or connect the GitHub repo

Recommended repo name: `unlimited-roofing-rep-tracker`.

If using GitHub CLI:

```powershell
gh repo create toasty-glitch/unlimited-roofing-rep-tracker --private --source . --remote origin --push
```

Then publish `pwa/` through GitHub Pages. The simplest path is to keep `pwa/` as the Pages root via a GitHub Actions workflow, or copy `pwa/*` to the repo root if using classic Pages from `main`.

## 2. Deploy Apps Script

1. Open https://script.new as the Google account that should own the Sheet.
2. Name it `Unlimited Roofing Rep Tracker API`.
3. Paste `apps-script/Code.gs`.
4. Project Settings -> Script Properties:
   - `ROOFING_REP_TRACKER_ADMIN_PIN` = a temporary bootstrap PIN.
5. Deploy -> New deployment -> Web app:
   - Execute as: Me
   - Who has access: Anyone
6. Copy the `/exec` Web app URL.

The Sheet `Unlimited Roofing Rep Tracker - 2026` is created automatically on first API call. Tabs: `Reps`, `Dispositions`, `DoorsKnocked`, `AuditLog`.

## 3. Point frontend at the API

Open the PWA with `?api=YOUR_SCRIPT_EXEC_URL` once, or replace `DEFAULT_API` in `pwa/index.html` before publishing.

## 4. Bootstrap admin

Open the app, use the setup panel, and bootstrap one of the seeded admin names:

- Ted Beedle
- Stacy Clark
- Jessica Henson

After bootstrap, delete the `ROOFING_REP_TRACKER_ADMIN_PIN` script property if you want the setup path closed.

## 5. Smoke test

- Log one non-sale outcome.
- Log sold deals at $579, $580, $599, $600, $629, and $630 cost/square.
- Confirm sub-$580 appears in Manager approvals.
- Tap doors knocked, refresh, and confirm today totals include the taps after sync.
- Confirm Manager rollup equals the sum of rep totals.
- Confirm same-day edit works for reps and any-day edit works for admins.

## Notes

The app intentionally replaces the old `Customer Disposition Form` and computes the old `Retail Nightly Numbers` metrics from live disposition rows plus door taps. The prior Looker report URL was `https://lookerstudio.google.com/reporting/475018ad-3d87-4755-948a-6ed9f1520ae2`; this project is designed to use a fresh report over the new Sheet shape.
