# T2: Parsing and scheduler

- **ID**: T2
- **Milestone**: Parsing and scheduler
- **Status**: pending
- **Estimate**: 1 day
- **Depends on**: T1
- **Modules**: `parser.ts`, `scheduler.ts`
- **Requirements**: R5, R8

## Objective

Turn a .mid file into absolute-time MIDI events and send them to a `MIDIOutput` with tight timing, plus Panic. This is the core of playback; transport and playlist (T3) wrap it.

## Scope

- `parser.ts`:
  - Parse with `@tonejs/midi` (format 0 and 1 files, running status, tempo map; note and controller events with times in seconds).
  - Build one flat, time-sorted event list per song: note-on, note-off, control change, program change, pitch bend, channel pressure. Drop meta events other than tempo.
  - Keep original channel numbers; song duration = time of the last event.
  - Accept files by extension (.mid, .midi) and verify the `MThd` header during parsing; reject unreadable files with a message.
  - Parse when a song is about to play, not when it is added; cache the last parsed song.
- `scheduler.ts` (look-ahead scheduler):
  - On play, record `t0 = performance.now() + 100` ms, minus any resume offset.
  - Every 25 ms tick, send every event whose time falls before `now + 200 ms` with `output.send(bytes, t0 + eventTime)`.
  - Track which notes are currently on, per channel, so they can be released.
  - When the cursor passes the last event, wait for the scheduled tail to finish, then fire `ended`.
- Panic: for channels 1–16 send CC123 (all notes off), CC120 (all sound off), CC121 (reset controllers), CC64 = 0.
- Unit tests (Vitest):
  - Event-list builder: format 0 and 1 fixtures, tempo changes, overlapping notes on one channel.
  - Scheduler with a fake clock and mock `MIDIOutput`: every event sent once, timestamps correct, release messages sent on pause/stop.

## Acceptance criteria

- [ ] A 5-minute file ends within 50 ms of its computed duration, with no audible timing drift (R5).
- [ ] A corrupt file shows an error message and is skipped (R3 support: parser rejection path).
- [ ] Panic sends all-notes-off and reset-controllers on all 16 channels (R8).
- [ ] Every event is sent exactly once, with correct absolute timestamps, per scheduler unit tests.
- [ ] Sounding notes are tracked per channel and can be released on demand.

## Notes

- Timing accuracy comes from handing every message to the browser with a future timestamp, not from JavaScript timers.
- Messages already handed to Chrome cannot be cancelled (`output.clear()` is not implemented), so the 200 ms look-ahead bounds the overhang; release messages are sent with a timestamp just after the last queued event.
- Background tabs throttle `setInterval` to 1 s; moving the tick into a Worker is T5 (hardening) — the look-ahead covers short stalls in the meantime.
