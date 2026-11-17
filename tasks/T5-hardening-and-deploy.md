# T5: Hardening and deploy

- **ID**: T5
- **Milestone**: Hardening and deploy
- **Status**: pending
- **Estimate**: 1 day
- **Depends on**: T2, T3, T4
- **Modules**: `scheduler.ts` (Worker timer), all modules (error states), test suite, static deploy
- **Requirements**: R5, R6, R7, R11

## Objective

Harden the working app against the known risks (timer throttling, stuck notes, device loss, malformed files), complete the automated and manual test coverage, and deploy it as a static site over HTTPS.

## Scope

- Scheduler tick in a Worker so background tabs are not throttled to 1 s; keep the 200 ms look-ahead.
- Error states: device lost, file rejected, unsupported browser — all surfaced in the single `aria-live` region.
- Playwright tests (Chromium and Firefox) with mocked `requestMIDIAccess` and `getUserMedia`: add files, play, pause, next, Panic, device disconnect.
- Scheduler timing stress (Vitest): drive the tick loop with jittered and deliberately stalled ticks over a dense five-minute event list; assert exact timestamps inside the look-ahead, bounded lateness after a stall beyond it, and no drift (`tests/unit/schedulerTimingStress.test.ts`).
- Manual matrix on real hardware:
  - Browsers: Chrome and Firefox, current release, on Windows and macOS.
  - MIDI: one USB-MIDI synth, one DIN interface, one virtual port (IAC on macOS, loopMIDI on Windows).
  - Audio: one USB audio interface with the synth's output connected.
  - Checks: timing over a 5-minute file, no hanging notes after each transport action, hot-plug of MIDI and audio devices, monitoring latency readout, feedback-safe default.
- Static deploy to any HTTPS host — the concrete GitHub Pages + CI implementation is T6 (Web MIDI and `getUserMedia` require a secure context).

## Acceptance criteria

- [ ] Playback timing stays accurate in a background tab (Worker tick, R5).
- [ ] No hanging notes after pause, stop, next, previous, or output disconnect (R6, R7).
- [ ] Monitoring falls back to the system default with a note where output selection is unavailable (R11).
- [ ] All Playwright UI flows pass on Chromium and Firefox.
- [ ] The full manual matrix (browsers × MIDI devices × audio) passes.
- [ ] The app is deployed and reachable over HTTPS and works there (delivered by T6).

## Notes

- Add a baseline content-security-policy (`default-src 'self'`) to the static deploy — deferred from T1 review because dev-mode HMR (websockets + inline module sources) fights a strict meta CSP.
- Risks covered here: background-tab timer throttling, scheduled messages that cannot be cancelled in Chrome (200 ms overhang bound), malformed or huge MIDI files (parse in try/catch, mark entry as error, skip on auto-advance).
- Virtual MIDI port looping back into the same synth (doubled notes) is out of scope; document it in help text.
- Deployment automation is split into T6; run the manual matrix against the Pages URL once T6 lands, or against `npm run preview` before then.
- The timing stress test covers scheduler tick jitter deterministically; moving the tick into a Worker (this ticket) is what addresses real background-tab throttling.
- Keep the look-ahead at 200 ms — it is the bound on post-pause overhang.
