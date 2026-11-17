# External MIDI Player

Browser-based MIDI playlist player: plays `.mid` files out to external MIDI
hardware and monitors that hardware's audio back into the computer. Static
Vite + TypeScript app, no backend.

- Design (source of truth):
  [`Browser MIDI Playlist Player — MVP Design.md`](Browser%20MIDI%20Playlist%20Player%20%E2%80%94%20MVP%20Design.md)
- Milestones: [`tasks/`](tasks/README.md) — T1 (scaffold + device access) is
  complete; T2–T5 are pending.

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

## Structure

| File | Responsibility |
| --- | --- |
| `src/midiDevices.ts` | Web MIDI access, output listing, hot-plug, remembering the selected output by name |
| `src/ui.ts` | Single-screen layout, Connect devices flow (MIDI + mic prompts), single aria-live status region |
| `src/main.ts` | Entry point |

T2–T4 will add `src/parser.ts`, `src/scheduler.ts`, `src/playlist.ts`, and
`src/audioMonitor.ts` — one module per architecture box.

## Browser support

Current and previous desktop releases of Chrome/Edge and Firefox. Browsers
without `navigator.requestMIDIAccess` show an unsupported-browser notice.
Firefox users are shown the site-permission (add-on) explanation before the
first connect.
