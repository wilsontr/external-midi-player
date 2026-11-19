# T21: Live per-channel note activity in the part strip

- **ID**: T21
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 0.5–1 day
- **Depends on**: T2 (parsed note times), T11 (16-part strip), T16 (position-driven updates)
- **Modules**: `src/parser.ts` (activity tracker), `src/playlist.ts` (lifecycle and accessor), `src/scheduler.ts` (velocity-0 tracking fix), `src/ui.ts` (part strip), `src/styles.css` (active state), `tests/unit/parser.test.ts`, `tests/unit/playlist.test.ts`, `tests/unit/scheduler.test.ts`, `tests/e2e/channel-activity.spec.ts`, `README.md`, design doc
- **Requirements**: R3 (extends T11 and T16; no new R-ID)

## Objective

Turn the 16-part strip from a static "channels this song uses" map into a live note-activity display: each cell lights while its channel has at least one note sounding, like an SC-88 channel meter reduced to on/off. The data is already in the playback parse; this task surfaces it and keeps it correct across pause, seek and track changes.

## Scope

- **Activity definition.** A channel is active at position `t` when it has at least one held note (note-on not yet followed by note-off or note-on velocity 0), at least one note released under sustain (CC64 ≥ 64, until the pedal lifts), or a note-on within `ACTIVITY_HOLD_MS` (suggest 120 ms) so a note shorter than the 50 ms UI tick still lights the cell. Binary only: no velocity shading and no decay envelope.
- **Tracker (`parser.ts`).** Add a small pure `ChannelActivity` class (or equivalent factory) built from `ParsedSong.events`. It keeps an incremental event cursor and the position it has advanced to, per-channel sounding-note counts keyed by note number, the sustain state per channel, and the last note-on time per channel. API: `reset(positionSec, options)`, `advance(positionSec)`, `activeChannels()`. It handles overlapping notes, repeated note-ons of the same note, note-on velocity 0, CC64, CC120 (all sound off), CC123 (all notes off) and CC121 (reset controllers); it never rescans the event list on a normal tick.
- **Reset semantics.** Every start, pause→resume and seek resets the tracker to "no notes sounding", because the scheduler releases sounding notes and never re-strikes notes that began before a seek or pause. A seek also adopts the pedal/controller state strictly before the target (the same cut-off `sendStateAt` uses), since the scheduler re-sends that state there; a fresh start and a resume begin with the pedal up. Stop, end of song, output loss and a track switch clear the tracker.
- **Player (`playlist.ts`).** Keep the current `ParsedSong` (the same event array the scheduler uses) alongside the instrument summary. Create and reset the tracker on start, seek, pause, stop, end, output loss and track switch, and expose `activeChannels(): ReadonlySet<number>` (or a boolean-vector equivalent) computed at `position()`. No new timer: the UI's existing progress tick drives it.
- **UI (`ui.ts`).** On the existing 50 ms progress tick, while the player is `playing` and the loaded song is ready, read `player.activeChannels()` and toggle a `data-active` attribute on the 16 part cells; render once on start and on a committed seek, and clear on pause, stop, end and output loss. The active style must be distinguishable from `data-used` and idle in greyscale (a filled/inverted cell or an inset LED bar), not by hue alone, and must keep LCD ink contrast. Update each cell's `aria-label` only when its state changes (for example "Channel 3, playing" versus "Channel 3, used by this song") and leave the single `aria-live` region untouched. Data keeps updating under `prefers-reduced-motion`, like the level meters.
- **Scheduler consistency (`scheduler.ts`).** Treat a `note-on` with velocity 0 as a note-off in `sendEvent`'s `sounding` tracking, the same rule the tracker uses, so the two notions of "sounding" cannot disagree. This is a small correctness fix, not a change to what is sent.
- **Tests.** Unit-test the tracker directly with synthetic event lists: note pairs, overlapping notes, same-note retriggers, velocity-0 offs, sustain on/off, CC120/123/121, the hold window, `reset` at a position inside a held note, and seek adoption of the pedal state. Unit-test the player's reset/clear points and the scheduler's velocity-0 handling. Add one Playwright spec with a file that has two note channels plus a program-only channel: assert the right cells light and clear, a short drum hit is visible, pause/resume and stop clear, and a seek into a held note leaves the channel dark until the next note-on. Keep T11's 16-cell and unchanged-strip assertions working.
- **Docs.** Update the design doc's main-LCD bullet (no longer a "static" strip) and the part-map bullet (per-note activity now exists in the strip; the Instruments card stays program-only), README behaviour notes, the T11 follow-up note (point at T21), and the task index/coverage.

## Acceptance criteria

- [x] A channel with a held note is active; it clears after the last note-off, within at most the hold window.
- [x] Overlapping notes and repeated note-ons of the same note keep the cell lit until the last matching off.
- [x] A note-on with velocity 0 ends the note, and the scheduler's sounding map agrees.
- [x] A note shorter than the 50 ms tick still lights its cell for the hold window (percussion and channel 10 included).
- [x] Sustain keeps a released note active until CC64 drops; CC120, CC123 and CC121 clear the channel; a channel with only program changes never lights.
- [x] Pause stops activity at once; resume starts dark and lights only notes that start after the resume point; stop, end, output loss and a track switch clear every cell; the between-song gap is dark.
- [x] A seek resets the tracker: channels whose notes began before the target stay dark (the scheduler does not re-strike them), while notes at or after the target light; forward and backward seeks both behave, and a paused seek stays dark.
- [x] All 16 cells remain, the active state is legible in greyscale and meets contrast, accessible names change only on transitions, and reduced-motion mode still updates the data.
- [x] Activity is driven by the existing progress tick and committed seeks (no new timer), and each event is visited once as the position advances rather than rescanned every tick.
- [x] `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass; docs and index updated.

## Notes

- **Why not reuse `Scheduler.sounding`.** It is updated when events are handed to the browser, up to 200 ms early (the look-ahead); it is private; it is cleared on pause and seek; and it has no sustain model. A feed from it would light early and lie after a seek. Deriving from the parsed events at `player.position()` is the same source T16 uses for the live program.
- **Why incremental rather than "intervals containing t".** A seek does not re-strike notes that began before the target, so a pure interval query would light channels that are actually silent after a seek. Starting empty at every reset and counting only note-ons the cursor passes matches the scheduler: a note held across a seek stays dark until the next note-on.
- **The hold window is not a note timer.** `ACTIVITY_HOLD_MS` only keeps the LED visible after a note ends; MIDI timing is untouched. Without it the 20 Hz sampling would make short drum hits invisible. Keep it a named constant for review tuning; 120 ms is the starting point.
- **Sustain edge case.** On a seek the pedal state is adopted from the file just before the target because the scheduler re-sends controllers there. On resume the pedal starts up: pause released the sounding notes and sent CC64 = 0, and resume deliberately re-sends no state. A module that kept a pedal down on a channel with no sounding notes (so pause never sent CC64 = 0 for it) is the one case the display cannot match; that is accepted.
- **Accessibility.** The strip is continuous data, not status, so it must not write to the `aria-live` region and should not change the 16 labels on every tick. Labels are written only when a channel's binary state changes; the cells are not focusable, so this is not announced as it happens.
- **Performance.** 16 cells at 20 Hz and one pass over the events as the position advances; no new timer, worker, dependency or stored data. The parsed song is already kept alive for the scheduler.
- **Out of scope.** Velocity/level shading, a decay envelope, activity in the Instruments card rows (it stays program-only), per-channel mute/solo, MIDI-input monitoring (this reads the file, not the wire), and a scheduler-provided activity feed.
- **Estimate.** The tracker and its unit tests are the bulk; the UI work is one attribute, one CSS state and the existing tick.
