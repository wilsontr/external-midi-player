# T5: Hardening and deploy

- **ID**: T5
- **Milestone**: Hardening and deploy
- **Status**: in-progress
- **Estimate**: 1 day
- **Depends on**: T2, T3, T4
- **Modules**: `scheduler.ts`, `workerTimer.ts`, `tickWorker.ts` (Worker tick), `ui.ts` (statuses), `vite.config.ts` (CSP), test suite, static deploy
- **Requirements**: R5, R6, R7, R11

## Objective

Harden the working app against the known risks (timer throttling, stuck notes, device loss, malformed files), complete the automated and manual test coverage, and deploy it as a static site over HTTPS.

## Scope

- Scheduler tick in a dedicated Worker so background tabs are not throttled to 1 s; keep the 200 ms look-ahead. The timer starts/stops/disposes with playback, survives pause/resume, and falls back to `setInterval` if the Worker fails to load. See `src/workerTimer.ts` and `src/tickWorker.ts`.
- Error states: device lost, file rejected, unsupported browser — all surfaced in the single `aria-live` region. A `MIDIOutput.send` that throws (the output vanished mid-song) stops the transport, releases the timer and reports in the same region.
- Baseline content-security-policy for the production build (`default-src 'self'`, `worker-src 'self'`, no inline scripts/styles), injected by Vite at build time only so dev HMR stays unrestricted.
- Worker timer unit tests (start/stop/dispose, worker error fallback) and a Playwright assertion that playback really creates the Worker.
- Playwright tests (Chromium and Firefox) with mocked `requestMIDIAccess` and `getUserMedia`: add files, play, pause, next, Panic, device disconnect, unsupported-browser status.
- Scheduler timing stress (Vitest): drive the tick loop with jittered and deliberately stalled ticks over a dense five-minute event list; assert exact timestamps inside the look-ahead, bounded lateness after a stall beyond it, and no drift (`tests/unit/schedulerTimingStress.test.ts`).
- Manual matrix on real hardware:
  - Browsers: Chrome and Firefox, current release, on Windows and macOS.
  - MIDI: one USB-MIDI synth, one DIN interface, one virtual port (IAC on macOS, loopMIDI on Windows).
  - Audio: one USB audio interface with the synth's output connected.
  - Checks: timing over a 5-minute file, no hanging notes after each transport action, hot-plug of MIDI and audio devices, monitoring latency readout, feedback-safe default.
- Static deploy to any HTTPS host — the concrete GitHub Pages + CI implementation is T6 (Web MIDI and `getUserMedia` require a secure context).

## Acceptance criteria

- [x] Playback timing stays accurate in a background tab (Worker tick, R5). Manual check passed; the Worker creation is also asserted by Playwright.
- [x] No hanging notes after pause, stop, next, previous, or output disconnect (R6, R7).
- [x] Monitoring falls back to the system default with a note where output selection is unavailable (R11).
- [x] All Playwright UI flows pass on Chromium and Firefox.
- [x] The full manual matrix (browsers × MIDI devices × audio) passes. Confirmed by the project owner on 2026-11-17 with Chrome and Firefox, the external MIDI synth and the Scarlett input.
- [ ] The app is deployed and reachable over HTTPS and works there (delivered by T6).
- [x] The tick timer starts/stops/disposes with playback, survives pause/resume and falls back to `setInterval` if the Worker fails (`tests/unit/workerTimer.test.ts`, `tests/unit/scheduler.test.ts`).
- [x] A send/release failure is caught, stops the transport and reports through the single `aria-live` region (`tests/unit/scheduler.test.ts`, `tests/unit/playlist.test.ts`).
- [x] The production build injects the baseline CSP, and the built app (including the Worker) loads and plays under it with no CSP violations.

## Notes

- The baseline CSP is injected by a build-only Vite plugin (`inject-content-security-policy`), so dev-mode HMR (websockets + inline module sources) keeps working. The built site was verified in Chromium with mocked MIDI/audio: no CSP violations, and the Worker asset loads from `assets/`.
- Risks covered here: background-tab timer throttling, scheduled messages that cannot be cancelled in Chrome (200 ms overhang bound), malformed or huge MIDI files (parse in try/catch, mark entry as error, skip on auto-advance).
- Virtual MIDI port looping back into the same synth (doubled notes) is out of scope; document it in help text.
- Deployment automation is split into T6; run the manual matrix against the Pages URL once T6 lands, or against `npm run preview` before then.
- The timing stress test covers scheduler tick jitter deterministically; the Worker tick addresses real background-tab throttling, with the 200 ms look-ahead absorbing short stalls.
- Keep the look-ahead at 200 ms — it is the bound on post-pause overhang.
- Manual matrix confirmed by the project owner on 2026-11-17 (Chrome and Firefox, external synth + Scarlett). The Firefox Playwright leg passed on the same date; only the T6 deployment remains for the deploy acceptance.
