# T2: Parsing and scheduler

- **ID**: T2
- **Milestone**: Parsing and scheduler
- **Status**: done
- **Estimate**: 1 day
- **Depends on**: T1
- **Modules**: `parser.ts`, `scheduler.ts`
- **Requirements**: R3, R5, R8

## Objective

Turn a .mid file into absolute-time MIDI events and send them to a `MIDIOutput` with tight timing, plus Panic. This is the core of playback; transport and playlist (T3) wrap it.

## Scope

- `parser.ts`:
  - Parse with `parseMidi` from `midi-file` — the raw event parser that `@tonejs/midi` wraps — instead of the high-level `Midi`/`Track` API, which collapses each track to a single channel, drops channel pressure and program-change history, and pairs notes in O(n²) (688 ms vs 12 ms on a 200k-event file). Format 0 and 1 files, running status, tempo map; note and controller events with times in seconds.
  - Build one flat, time-sorted event list per song: note-on, note-off, control change, program change, pitch bend, channel pressure. Drop meta events other than tempo.
  - Keep original channel numbers; song duration = time of the last event.
  - Accept files by extension (.mid, .midi) and verify the `MThd` header during parsing; reject unreadable files with a message.
  - Wrap parsing in try/catch so malformed or huge files mark the entry as `error` instead of throwing or stalling the UI.
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

- [x] A 5-minute file ends within 50 ms of its computed duration, with no audible timing drift (R5).
- [x] A corrupt file shows an error message and is skipped (R3 support: parser rejection path).
- [x] Panic sends all-notes-off and reset-controllers on all 16 channels (R8).
- [x] Every event is sent exactly once, with correct absolute timestamps, per scheduler unit tests.
- [x] Sounding notes are tracked per channel and can be released on demand.

## Notes

- Timing accuracy comes from handing every message to the browser with a future timestamp, not from JavaScript timers.
- Messages already handed to Chrome cannot be cancelled (`output.clear()` is not implemented), so the 200 ms look-ahead bounds the overhang; release messages are sent with a timestamp just after the last queued event.
- `parser.ts` imports `midi-file` directly, and it is a declared runtime dependency (`^1.2.4`). `@tonejs/midi` pins the same parser version, so npm dedupes them to one copy; declaring it keeps the event types this module consumes on a version this project controls.
- `midi-file` is the second declared runtime dependency, alongside `@tonejs/midi`. Keep it to these two.
- Any note still sounding when the song ends (an unpaired note-on in a truncated or sloppy file) is released with a note-off plus CC64 = 0, so it cannot hang the hardware.
- Background tabs throttle `setInterval` to 1 s; moving the tick into a Worker is T5 (hardening) — the look-ahead covers short stalls in the meantime.
