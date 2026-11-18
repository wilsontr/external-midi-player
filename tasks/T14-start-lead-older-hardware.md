# T14: Start lead for older hardware

- **ID**: T14
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 0.5 day
- **Depends on**: T13
- **Modules**: `src/scheduler.ts`, `tests/unit/scheduler.test.ts`, `README.md`, design doc
- **Requirements**: R5

## Objective

Give a DIN-attached 1990s sound module enough time to apply a song's opening patch changes before the first note, so the start of the track is evenly spaced instead of jittering. The reproducer is `Sonic_2_Chemical_Plant.mid` on a Korg 05R/W: T13 moved most of its tick-0 state ahead of the clock, but the 23 setup messages were spread over only 28.75 ms and the first note followed 5 ms later, which is not enough time for nine program changes to load.

## Scope

- Replace T13's 1.25 ms-per-message pre-roll with a **start lead**: the tick-0 setup spans `max(250 ms, serial floor + 100 ms)` from the first message to song time 0, and its last 100 ms are left clear for the receiver to settle. Setup messages are spread evenly across the lead, never faster than the 1.25 ms serial floor.
- Add a `startLeadMs` scheduler option (default 250, clamped to ≥ 0) so the lead can be tuned per output later; `0` still keeps the serial floor and the 100 ms settle tail.
- Keep the T13 rules: only tick-0 setup is moved, tick-0 notes still share `t0`, the tick loop skips pre-rolled indices, resume/paused-seek re-anchor without re-sending, and a failed send reports and stops the transport.
- Report the last *spread* setup timestamp through `lastSentWall` so a pause, stop or track switch anchors after the whole setup, not after the serial-span estimate.
- Unit tests for the 250 ms lead, the spread, a longer configured lead, the reported last setup timestamp, and the unchanged note-first file.
- Update the scheduler section, risks table, testing list and README.

## Acceptance criteria

- [x] A file with nine tick-0 program changes and a first chord gets 250 ms from its first setup message to `t0`, with the setup spread across the first 150 ms and 100 ms of silence after it.
- [x] Tick-0 notes still share `t0`; no note is pre-rolled.
- [x] A setup too large for the lead at the serial floor extends the lead rather than crowding messages (`lead = serialSpan + 100`).
- [x] `startLeadMs` changes the lead; `startLeadMs: 0` keeps the serial floor and settle.
- [x] `stop()`/`paused` anchoring uses the last setup message's timestamp.
- [x] A file with no tick-0 setup still starts at `now + 100`.
- [x] `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass.
- [x] Design doc, README and the T13 note are updated.

## Notes

- **Measured reproducer.** `Sonic_2_Chemical_Plant.mid`: 10 tracks, 192 PPQ, 136 BPM, one tempo. Tick 0 carries 30 channel events — 14 controllers, 9 program changes (including the drum kit on channel 10), 6 note-ons and a stale note-off — i.e. 23 setup messages. Under T13 that gave `t0 = now + 100 + 23 × 1.25 + 5 = 133.75 ms`, so the 05R/W had 34 ms from the last program change to the first chord.
- **Why this is hardware-only.** The same file is clean on Maestro and 88emuPlayer, which synthesize the file internally. The 05R/W is fed over DIN at 31.25 kbps and has to load patches and their effect algorithms when the program changes arrive; while it does, its MIDI receive handling stalls and the first notes land unevenly.
- **Why spread as well as wait.** A longer fixed gap alone does not help if the module's receive buffer is being filled while it is stalled on a patch load. Spreading the 23 messages over 150 ms (≈6.8 ms each) gives it time per message, and the clear tail gives it 100 ms to finish before the chord.
- **Why 250 ms.** It is a conservative default for 1990s modules without being noticeable on a software output. The `startLeadMs` option is the tuning point; a per-output "Start lead" control is the natural follow-up if a module needs more (the scheduler already accepts the value).
- **Scope.** Only fresh starts with tick-0 setup take the lead; resume, paused-seek resume and files with no tick-0 setup are unchanged. The lead does not alter note timing inside the song.
