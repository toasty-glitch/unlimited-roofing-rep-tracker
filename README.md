# Unlimited Roofing Rep Tracker

Mobile PWA and Google Apps Script backend for replacing the Customer Disposition Form and Retail Nightly Numbers form with one appointment-first workflow.

## Structure

- `pwa/` - static GitHub Pages app.
- `apps-script/Code.gs` - Apps Script API backend and Google Sheet bootstrapper.
- `SETUP.md` - deployment runbook.
- `docs/superpowers/specs/2026-06-22-roofing-rep-tracker-design.md` - approved design spec.

## Deploy

1. Deploy `apps-script/Code.gs` as a Google Apps Script web app.
2. Publish `pwa/` through GitHub Pages using `.github/workflows/deploy-pages.yml`.
3. Open the app once with `?api=YOUR_SCRIPT_EXEC_URL`, or set `DEFAULT_API` in `pwa/index.html` before publishing.

## Maintenance

Changing a goal, adding a rep, adjusting the commission ladder, redeploying after a code
edit, or bumping the service-worker cache — see **[docs/ADJUSTING.md](docs/ADJUSTING.md)**,
written for non-coders. Every adjustable code knob is tagged `// ADJUST:` in
`apps-script/Code.gs` and `pwa/dashboard.html` — `grep ADJUST` those two files to find them all.
