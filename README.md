# External MIDI Player

Browser-based MIDI playlist player: plays `.mid` files out to external MIDI
hardware and monitors that hardware's audio back into the computer. Static
Vite + TypeScript app, no backend.

- Design (source of truth):
  [`Browser MIDI Playlist Player — MVP Design.md`](Browser%20MIDI%20Playlist%20Player%20%E2%80%94%20MVP%20Design.md)
- Milestones: [`tasks/`](tasks/README.md) — T1–T6 and T8–T11 are complete; T7
  (software synth output) is pending.

## Quickstart

```bash
npm install
npm run dev        # http://localhost:5173
```

Use `localhost` (or HTTPS) — Web MIDI and `getUserMedia` require a secure
context. Open the page in a desktop Chrome/Edge or Firefox and click
**Connect devices**.

## Tests

```bash
npx vitest run          # unit tests (device logic)
npx playwright test     # e2e, Chromium + Firefox (mocked Web MIDI / getUserMedia)
npx tsc --noEmit        # typecheck
```

CI runs the same three commands on every push and pull request — see
[Deployment](#deployment).

## Deployment

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

### One-time repository setup

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Optionally confirm **Settings → Environments → `github-pages`** exists (the
   workflow creates it on the first deploy) and add a required reviewer or a
   branch rule.
3. Confirm **Enforce HTTPS** is on once Pages has issued the certificate.

No repository secrets are needed: the workflow uses the default `GITHUB_TOKEN`
and OIDC.

### Redeploy and rollback

- **Redeploy without a new commit:** Actions → *Deploy to GitHub Pages* →
  **Run workflow** on `main` (`workflow_dispatch`).
- **Rollback:** re-run the last successful workflow run — it rebuilds and
  deploys that commit from scratch (artifacts are kept for 90 days) — or revert
  the bad commit and push, and let the workflow redeploy `main`.
- Every deploy to the same site replaces the whole `dist` tree; there is no
  partial update.

### Build output

`npm run build` writes `dist/` with **relative** asset URLs (`./assets/…` in
`index.html`, `../fonts/…` from the stylesheet), because `vite.config.ts` sets
`base: './'`. The same build therefore works at
`https://<owner>.github.io/<repo>/`, at a user page, and on a custom domain —
GitHub Pages' redirect from `/repo` to `/repo/` keeps the relative URLs
correct. `npm run dev` and Playwright are unchanged: they still serve from the
origin root.

### Storage is per origin

Playlist bytes, the current entry, device names, mute and volume are in
`localStorage`, which is scoped to the origin. The Pages origin starts with an
empty playlist and no remembered devices even if you have been using
`localhost`; connect devices again there. Clearing the playlist on the Pages
origin stays cleared, exactly as locally.

## Structure

| File | Responsibility |
| --- | --- |
| `src/midiDevices.ts` | Web MIDI access, output listing, hot-plug, remembering the selected output by name |
| `src/parser.ts` | Parse `.mid` files into flat, time-sorted event lists (tempo map, channels preserved) |
| `src/scheduler.ts` | Look-ahead scheduler with future-timestamped `MIDIOutput.send()`, note tracking and Panic |
| `src/playlist.ts` | Playlist entries, load/clear, transport state, background duration parse, auto-advance, seek forwarding, Panic-before-track-switch |
| `src/audioMonitor.ts` | Audio input capture, gain/mute, stereo level meter with an accessible dBFS description, output routing, latency |
| `src/ui.ts` | Half-rack faceplate markup (two units), knob/LED/part-strip wiring, Connect devices flow (MIDI + mic prompts), seekable timeline, single aria-live status region |
| `src/styles.css` | Faceplate skin: `:root` design tokens, chassis and LCD textures, responsive rack layout |
| `src/main.ts` | Entry point |
| `public/fonts/` | Self-hosted Graph 35+ pix LCD font (CC BY-SA 3.0) with its licence and attribution |
| `legacy/t11-pre-faceplate/` | Pre-T11 UI files, kept for a possible swap back |

## Behaviour notes

- **Startup mute policy (T8, intentional):** a fresh profile starts with
  monitoring muted (R10 feedback safety); later visits restore the saved
  mute/volume instead of forcing mute.
- **Seeking (T8):** the timeline is live while playing or paused and commits on
  release. While playing, sounding notes are released and the MIDI state at the
  target (program/bank, controllers, pitch bend, channel pressure) is re-sent
  after the look-ahead tail before playback continues from the target. A
  stopped song always restarts from 0, so seeking is disabled while stopped.
- **Track switches (T8):** switching to a different entry while playing or
  paused sends the full Panic (CC123/120/121 and CC64 = 0 on all 16 channels)
  after the old queue's tail, and the new track starts after the panic.

## Browser support

Current and previous desktop releases of Chrome/Edge and Firefox. Browsers
without `navigator.requestMIDIAccess` show an unsupported-browser notice.
Firefox users are shown the site-permission (add-on) explanation before the
first connect.

## Third-party assets

Code is MIT (see [`LICENSE`](LICENSE)).

`public/fonts/graph-35-pix.ttf` and `public/fonts/graph-35-pix.woff2` are
**Graph 35+ pix** by 30100flo (Florian Contreras), licensed under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). The WOFF2 is
a format conversion of the original TTF. Both files, their unchanged
`license.txt` and the archive's `readme.txt` ship together in `public/fonts/`;
see [`public/fonts/README.md`](public/fonts/README.md) for the full attribution.
The licence covers the font files only, not the application code.

## UI skin notes (T11)

- The faceplate is a single committed dark theme. Every colour is a `:root`
  token in `src/styles.css`; there are no image assets. If a light skin is
  wanted later, swap the token block.
- The volume knob is the existing `#monitor-volume` range input made
  transparent over a CSS-rotated knob — no custom drag code.
- The LCD font is served from `public/` (same-origin), so the production CSP
  allows it; `font-src 'self'` is declared explicitly in `vite.config.ts`.
- `legacy/t11-pre-faceplate/` holds the pre-T11 `ui.ts` and `styles.css` for a
  possible swap back; nothing imports them.
