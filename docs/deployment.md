# Deployment

Live site: <https://wilsontr.github.io/external-midi-player/> — a static build
on GitHub Pages over HTTPS, which is required for Web MIDI and
`getUserMedia` (secure context).

`.github/workflows/deploy.yml` runs on every push to `main`, on pull requests,
and on `workflow_dispatch`:

1. **verify** (Ubuntu) — `npm ci`, `npx tsc --noEmit`, `npx vitest run`, then
   `npx playwright install --with-deps chromium` and
   `npx playwright test --project=chromium`.
2. **verify-firefox** (macOS) — `npx playwright install firefox` and
   `npx playwright test --project=firefox`. Firefox headless on the Linux
   runner drops synthetic pointer events (the Connect key receives no click),
   while the same suite passes on macOS Firefox, so the Firefox leg runs there.
3. **build** — `npm ci` and `npm run build`, then upload `dist` with
   `actions/upload-pages-artifact` (only outside pull requests).
4. **deploy** — `actions/deploy-pages` in the `github-pages` environment with
   `pages: write` and `id-token: write` (only on `main`, never for pull
   requests; the `pages` concurrency group serialises deployments without
   queueing PR checks behind them).

A failing test stops the pipeline before `build`, so nothing is uploaded and
the previous site stays live. Forks cannot deploy: the artifact upload and the
deploy job are both skipped for pull requests.

## One-time repository setup

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Optionally confirm **Settings → Environments → `github-pages`** exists (the
   workflow creates it on the first deploy) and add a required reviewer or a
   branch rule.
3. Confirm **Enforce HTTPS** is on once Pages has issued the certificate.

No repository secrets are needed: the workflow uses the default `GITHUB_TOKEN`
and OIDC.

## Redeploy and rollback

- **Redeploy without a new commit:** Actions → _Deploy to GitHub Pages_ →
  **Run workflow** on `main` (`workflow_dispatch`).
- **Rollback:** re-run the last successful workflow run — it rebuilds and
  deploys that commit from scratch (artifacts are kept for 90 days) — or revert
  the bad commit and push, and let the workflow redeploy `main`.
- Every deploy to the same site replaces the whole `dist` tree; there is no
  partial update.

## Build output

`npm run build` writes `dist/` with **relative** asset URLs (`./assets/…` in
`index.html`, `../fonts/…` from the stylesheet), because `vite.config.ts` sets
`base: './'`. The same build therefore works at
`https://<owner>.github.io/<repo>/`, at a user page, and on a custom domain —
GitHub Pages' redirect from `/repo` to `/repo/` keeps the relative URLs
correct. `npm run dev` and Playwright are unchanged: they still serve from the
origin root.
