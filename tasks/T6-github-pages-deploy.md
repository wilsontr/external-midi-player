# T6: GitHub Pages deployment and CI

- **ID**: T6
- **Milestone**: Hardening and deploy
- **Status**: pending
- **Estimate**: 0.5 day
- **Depends on**: T5
- **Modules**: `.github/workflows/deploy.yml`, `vite.config.ts`, `README.md`
- **Requirements**: R1–R13 (delivery over HTTPS)

## Objective

Publish the static build on GitHub Pages over HTTPS and make every push to
`main` verify the app and deploy it automatically. This completes the deploy
half of milestone 5: T5 covers hardening and the manual matrix, T6 covers the
concrete hosting provider and CI.

## Scope

- **Vite base path.** Build so the site works at
  `https://<owner>.github.io/<repo>/` (and on a custom domain): set
  `base: './'` in `vite.config.ts` and verify the built `index.html` uses
  relative asset URLs. Keep `npm run dev` and the Playwright suite working
  unchanged.
- **Deploy workflow** (`.github/workflows/deploy.yml`):
  - Triggers: `push` to `main`, `workflow_dispatch`, and `pull_request`
    (PRs verify but never deploy).
  - `verify` job: `npm ci`, `npx tsc --noEmit`, `npx vitest run`,
    `npx playwright install --with-deps chromium firefox`,
    `npx playwright test`.
  - `build` job (needs `verify`): `npm ci`, `npm run build`, upload `dist`
    with `actions/upload-pages-artifact` (only outside PRs).
  - `deploy` job (needs `build`, `main` only, including manual dispatches): `actions/deploy-pages`
    with `environment: github-pages`, `pages: write`, `id-token: write`,
    and a `pages` concurrency group on the deploy job itself so PR checks
    are not queued behind deployments.
- **One-time repository setup** (documented in the README):
  - Settings → Pages → Build and deployment → Source: **GitHub Actions**.
  - Optionally confirm the `github-pages` environment and "Enforce HTTPS".
  - No repository secrets: the workflow uses the default token and OIDC.
- **README:** live URL, one-time setup, how to redeploy/roll back, and the
  fact that storage and permissions are per origin (the Pages origin starts
  with an empty playlist).
- **Smoke check of the deployed URL** on the first deploy: page loads with no
  404s, the six-step guide renders, and the permission prompts work over
  HTTPS in Chrome and Firefox.

## Acceptance criteria

- [ ] `npm run build` produces a `dist/index.html` whose asset URLs are
  relative, and the built site loads from a `/external-midi-player/` subpath
  with no 404s.
- [ ] Pushing to `main` runs typecheck, unit tests and Playwright (Chromium
  and Firefox), then deploys; a failing test stops the deploy and leaves the
  previous site live.
- [ ] The workflow uses `actions/upload-pages-artifact` + `actions/deploy-pages`
  with `pages: write`, `id-token: write` and the `github-pages` environment.
- [ ] `workflow_dispatch` redeploys the current `main` without a new commit.
- [ ] The Pages URL is HTTPS and Web MIDI and microphone permission prompts
  work there (secure context), with the app fully usable.
- [ ] Pull requests run verification but do not deploy.
- [ ] Rollback is documented: re-run the last good deploy, or revert and push.
- [ ] No secrets are added to the repository.
- [ ] The app is deployed and reachable over HTTPS and works there (the deploy acceptance moved from T5).

## Notes

**Why a relative base.** An absolute base would hard-code the repository name
in the checked-in config; `base: './'` works for project pages, user pages and
custom domains, and a single-page app has no routes that need an absolute
base. It was checked locally: a build served from
`http://localhost:4200/external-midi-player/` rendered with no failed
requests, and the dev server still works with `--base=./`. GitHub Pages
redirects `/repo` to `/repo/`, so the relative URLs resolve correctly.
`actions/configure-pages` is not needed for this setup; if the project later
switches to an absolute base, use its `base_path` output instead.

**Workflow skeleton.**

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx vitest run
      - run: npx playwright install --with-deps chromium firefox
      - run: npx playwright test

  build:
    needs: verify
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
        uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    permissions:
      pages: write
      id-token: write
    concurrency:
      group: pages
      cancel-in-progress: false
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Use the current major versions of the official actions at implementation
time. `npm run build` already runs `tsc --noEmit` before `vite build`; the
separate typecheck in `verify` gives a faster, clearer failure.

**Expected URL:** `https://wilsontr.github.io/external-midi-player/`
(repository `wilsontr/external-midi-player`). Confirm the owner/repo and the
Pages URL after the first deploy.

**CI notes.**
- Node 22 matches the local environment and satisfies Vite 8. Optionally add
  `engines` to `package.json` and use it for `setup-node`.
- Playwright installs both browsers with `--with-deps`; the e2e config starts
  the Vite dev server on port 4173 itself. The Firefox leg currently cannot
  run in the development sandbox, so CI is where it gets exercised.
- Cache `~/.cache/ms-playwright` keyed on the lockfile if the install time
  becomes annoying; npm caching is already enabled.
- PR runs do not upload the Pages artifact and the deploy job is skipped, so
  forks cannot deploy.
- A re-run of the last successful workflow redeploys that commit (artifact
  retention is 90 days); reverting the bad commit and pushing is the other
  rollback path.

**Verification plan after the first deploy.**
1. `curl -I https://wilsontr.github.io/external-midi-player/` returns 200 and
   HTML; browser devtools show no failed requests and no mixed content.
2. In Chrome and Firefox: Connect devices → grant MIDI/microphone → pick a
   virtual MIDI output (IAC / loopMIDI) and an audio input → play a file and
   confirm monitoring; reload and confirm the playlist, current entry, device
   choices, mute and volume are restored (R13) on the new origin.
3. Temporarily break a test (or the build) on a branch/PR and confirm
   verification fails and no deployment occurs; the live site stays up.

**Relationship to T5.** T5 is complete: hardening, the manual matrix and the
Firefox Playwright leg passed. This ticket owns the deployment acceptance that
moved from T5. Use the T5 checks as the pre-release gate, then run the
deployed-site smoke test.

**Constraints.** Pages is static and HTTPS-only, which matches R1–R13 (no
backend, secure context required for Web MIDI and `getUserMedia`). The
production build now injects a baseline meta CSP (T5); keep it when deploying
and verify the Pages origin has no CSP violations, including the Worker asset.
GitHub Pages does not let us set response headers, so the meta CSP is the
option. A custom domain is optional and does not change the relative base;
update the README URL and Pages settings if one is added.
