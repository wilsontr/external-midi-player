# T16: Live instruments card

- **ID**: T16
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 0.5 day
- **Depends on**: T9 (card), T3/T8 (transport)
- **Modules**: `src/parser.ts` (timed program summary), `src/ui.ts` (card follows the playhead), unit and e2e tests, `README.md`, design doc
- **Requirements**: R3 (extends T9; no new R-ID)

## Objective

Make the Instruments card describe what is selected **now**, not the whole program history at once: as the song plays through a program change, the affected channel's row updates. Pausing and seeking show the program in effect at that position.

## Scope

- **Timed program summary (`parser.ts`)**: add the program change's song time (`seconds`) to every `ChannelProgram` in `summarizeInstruments`; the implicit default program 0 for a channel with no program change has `time: 0`. `ParsedSong` and the flat event list stay unchanged.
- **Lookup (`parser.ts`)**: export `programAt(channel, positionSec)` — the last program change at or before the position, or the MIDI default before the channel's first change. Program entries are time-ordered, so the scan stops early.
- **Card (`ui.ts`)**: render each channel's row from `programAt(channel, player.position())` instead of joining the whole program history with `→`. Keep the same channel/GM/bank/drums formatting and `(default)` marker.
- **Update cadence**: drive the card from the existing 50 ms progress tick while playing, and from a committed seek, so it follows the playhead without adding a timer. The renderer already replaces the list only when a row's text changes, so unchanged rows do no DOM work. Stop/end/output loss still clears the card; a pause keeps the program that was in effect.
- **Tests**: parser coverage for program times and `programAt` (boundaries, default before the first change, last change wins); the e2e static-card test is replaced by one that plays a file whose channel changes program halfway, asserts the row changes, then pauses and seeks back to assert the earlier program. Existing card/lifecycle/layout tests stay.
- **Docs**: design doc part-map bullet, README behaviour note, T9 superseded note, task index/coverage.

## Acceptance criteria

- [x] Each channel row shows the program in effect at the current playback position (channel 10 as drums, bank select when present, `(default)` before the file selects one).
- [x] A program change during playback updates that channel's row within a progress tick; other rows are untouched.
- [x] Pausing keeps the program that was playing; seeking back (playing or paused) restores the earlier program, and seeking forward applies later ones.
- [x] Stopping, ending the last song, output loss and a failed load still clear the card; switching songs replaces it.
- [x] The card still lists every channel the song uses from the start, so the layout does not grow as program changes arrive.
- [x] No new timer: the card is driven by the existing progress tick and committed seeks; unchanged rows are not re-rendered.
- [x] `programAt` returns the latest change at or before the position, the last of several changes at the same time, and the default before the first change.
- [x] `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass; docs and index updated.

## Notes

- **Feasible because the data was already there.** `summarizeInstruments` walked the sorted event list in time order; the only missing piece was the event time. The UI already polls `player.position()` every 50 ms for the timeline, so the card can derive the live program with no scheduler or player state change, and no extra parse.
- **What "now" means.** The state is the last program change at or before the playback position — the same program the scheduler has handed the output by then. A channel whose first program change is later in the song shows the MIDI default (program 0, `(default)`) until that change plays; that is what the module has been told so far, rather than a preview of the file's later program. Files that put their setup on tick 0 (the common case) show it immediately.
- **History is no longer displayed.** The card used to show `program 40 → 41 → 40`; it now shows only the current program. The full history still exists internally (it is what `programAt` scans) and the parser tests still pin it; a future "changes" affordance can use it without re-parsing.
- **Bank select** is the value in effect when the current program change happened, as in T9; a bank change on its own does not change the row.
- **Performance.** At most 16 rows are rebuilt per 50 ms tick; the existing text comparison means the DOM is only replaced when a program actually changes. The part strip stays static.
- **No new dependency, module, persistence or R-ID.** The parse is still the playback parse only; nothing is added to `PlaylistEntry`, the reducer, the stored playlist or the background duration parse.
- **Supersedes T9's static rule.** T9 deliberately kept the card static ("no timing or highlight") and its e2e asserted the innerHTML never changed. That requirement is replaced here; T9's lifecycle, accessibility, formatting and layout acceptance criteria still hold.
