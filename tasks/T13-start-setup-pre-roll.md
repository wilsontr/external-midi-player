# T13: Start-of-song setup pre-roll

- **ID**: T13
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 0.5 day
- **Depends on**: T2, T8
- **Modules**: `src/scheduler.ts`, `tests/unit/scheduler.test.ts`, `tests/unit/schedulerTimingStress.test.ts` (fixture only), `README.md`, design doc
- **Requirements**: R5

## Objective

Stop the opening of a song from sounding rushed, rolled or clipped when its file front-loads a full multi-part setup on tick 0. `GunstarHeroes_AncientRuins.mid` is the reproducer: its first tick carries 114 channel messages (77 controllers, 16 program changes, 5 pitch bends and a 16-note chord) and those are only 326 bytes, but a DIN MIDI line is serial at 31.25 kbps, so the batch takes ~104 ms to come out and the file's first note-offs (at 108.9 ms) arrive before the last chord notes have even started.

## Scope

- On a fresh start (`play()` from stopped, or an explicit `startAtMs` for a track switch), collect the events at tick 0 that configure a part — program change, control change, pitch bend and channel pressure — and hand them to `MIDIOutput.send` immediately, one message every 1.25 ms (a 3-byte message costs 0.96 ms on the wire), starting at the normal 100 ms lead.
- Place `t0` after that pre-roll (last message + 1.25 ms + a 5 ms gap) instead of at `now + 100`; the tick loop skips the pre-rolled indices so nothing is sent twice.
- Do not pre-roll tick-0 notes: a chord that the file puts on one tick still goes out together at `t0`. Files with no tick-0 setup keep the existing 100 ms lead.
- Do not pre-roll on resume, on resume-after-paused-seek, or after a seek (the state was already delivered); clear the pre-roll bookkeeping on stop, dispose, seek re-anchor, error and end of song.
- A `send` that throws during the pre-roll must report through `onError`, leave the scheduler stopped/reset and never start the tick timer.
- Unit tests for: setup ahead of `t0` with tick-0 notes still together, no pre-roll for a note-first file, no duplicate on resume, explicit `startAtMs` anchoring, and the failed-send path.
- Document the behaviour in the scheduler section, the risks table and the testing list, and add a README behaviour note.

## Acceptance criteria

- [x] A file with tick-0 setup has those messages handed over at `play()` time, 1.25 ms apart, ending before `t0`; its tick-0 note-ons all share `t0`.
- [x] `t0` moves to after the pre-roll: e.g. 98 setup messages give `t0 = now + 100 + 98 × 1.25 + 5` (`now + 227.5 ms`).
- [x] A file with no tick-0 setup starts exactly as before (`t0 = now + 100`, first tick sends at `t0`).
- [x] Resume, paused-seek resume and track-switch starts keep their existing anchors; setup is not re-sent.
- [x] The tick loop never re-sends a pre-rolled event, in either the normal or the late-clamp path.
- [x] A failed pre-roll send reports once, leaves `isPlaying()` false and does not start the timer; `stop()`/`pause()` after it do not throw.
- [x] `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass.
- [x] Design doc and README updated.

## Notes

- **Measured reproducer.** Parse of the tick-0 batch: 114 messages / 326 bytes. At 31.25 kbps (10 bits per byte) that is 104.3 ms. The 16 note-ons sit between 5.4 ms and 103.4 ms into the batch, while the chord's first note-offs are timestamped at 108.9 ms — so the last voices sound for ~6 ms and the "chord" is heard as a ~100 ms roll that is cut off. Chrome 157 on macOS delivers the app's timestamps exactly (verified with a CoreMIDI virtual destination), so the scheduler was correct; the loss is in the serial link. The maintenance machine's persisted output is `Scarlett 2i4 USB`, a DIN MIDI port.
- **Why 88emuPlayer is clean.** It renders the file inside its own SC-88 emulation, so the same batch never crosses a 31.25 kbps wire. That is a difference in the transport, not in the file's timing.
- **Why pre-roll rather than spread.** Spacing the whole tick-0 batch would spread the chord itself; moving only the setup ahead leaves 16 simultaneous notes (48 bytes ≈ 15 ms on the wire, unavoidable for a 16-part chord) and gives every note its full written length.
- **1.25 ms per message.** One 3-byte message occupies 0.96 ms at 31.25 kbps; 1.25 ms leaves a little margin for the interface's inter-message gap. A large setup therefore delays the first note by its own drain time (98 messages ≈ 128 ms), which is the honest cost of getting the state out first.
- **Scope kept to tick 0.** Later state changes are sparse and timed by the music; the pathological case is the song-start dump. `sendStateAt` already restores state on seek using the same classification.
- **Timing superseded by T14.** This ticket shipped the setup at 1.25 ms intervals with a 5 ms gap (98 messages gave `t0 = now + 227.5 ms`). T14 replaced that with a 250 ms start lead: the setup is spread across the lead and its last 100 ms stay clear, so slow modules finish loading patches before the clock starts. The mechanism, the classification of setup events and the no-double-send/skip rules are unchanged.
- **Still out of scope.** The file also opens with a Roland GS Reset SysEx (`F0 41 10 42 12 40 00 7F 00 41 F7`), which the app drops by design (`requestMIDIAccess({ sysex: false })`). That is a patch-mode difference rather than a timing one, and changing it reopens the design doc's SysEx open question.
