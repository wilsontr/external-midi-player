# External MIDI Player

Browser-based MIDI playlist player: plays `.mid` files out to external MIDI
hardware and monitors that hardware's audio back into the computer. Static
Vite + TypeScript app, no backend.

- Design (source of truth):
  [`Browser MIDI Playlist Player — MVP Design.md`](Browser%20MIDI%20Playlist%20Player%20%E2%80%94%20MVP%20Design.md)
- Milestones: [`tasks/`](tasks/README.md) — T1–T5 and T8 are complete; T6
  (GitHub Pages deployment and CI) and T7 (software synth output) are pending.

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
| `src/parser.ts` | Parse `.mid` files into flat, time-sorted event lists (tempo map, channels preserved) |
| `src/scheduler.ts` | Look-ahead scheduler with future-timestamped `MIDIOutput.send()`, note tracking and Panic |
| `src/playlist.ts` | Playlist entries, load/clear, transport state, background duration parse, auto-advance, seek forwarding, Panic-before-track-switch |
| `src/audioMonitor.ts` | Audio input capture, gain/mute, stereo level meter with an accessible dBFS description, output routing, latency |
| `src/ui.ts` | Responsive single-screen layout, Connect devices flow (MIDI + mic prompts), seekable timeline, single aria-live status region |
| `src/main.ts` | Entry point |

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
