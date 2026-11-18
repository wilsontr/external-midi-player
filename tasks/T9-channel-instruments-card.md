# T9: Channel and instrument card

- **ID**: T9
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 1 day
- **Depends on**: T3, T8
- **Modules**: `parser.ts`, `playlist.ts`, `ui.ts`, `styles.css`, unit and e2e tests
- **Requirements**: R3 (no new R-ID; the card shows information about the song currently playing)

## Objective

Add a read-only **Instruments** card that lists the MIDI channels used by the song that is currently playing, each with the MIDI instrument (program change) the file defines for it. It is loaded from the playback parse only — never by scanning the playlist — and is purely informational: no active feedback, no highlighting of the sounding channel, no playback visualization.

## Scope

**Channel/instrument summary (`parser.ts`)**

- Export a pure `summarizeInstruments(song: ParsedSong): ChannelInstrument[]` that scans the existing flat event list once (O(n)) and returns, in ascending channel order, every channel that carries at least one channel-voice event (note-on, note-off, control-change, program-change, pitch-bend, channel-pressure). Tempo-only files therefore return `[]`.
- Per channel, report the program history in file order with consecutive duplicates collapsed (`0 → 5 → 0` stays three entries, `5 → 5` collapses to one), each with the bank-select values (CC0/CC32) in effect when that program was selected (`null` when the file never sent bank select). A channel with no program change reports the MIDI default program 0 marked `fromFile: false`; a channel whose programs come from the file reports `fromFile: true`.
- Export a 128-entry General MIDI Level 1 name table and `gmInstrumentName(program): string` (program 0 = "Acoustic Grand Piano", 127 = "Gunshot"). Keep the table in `parser.ts` so the module split does not change; see Notes if it outgrows that home.
- Keep `ParsedSong` unchanged and do not attach the summary to it: the caller derives it from the parse result it already has. The "parsed events are discarded after the duration parse" memory rule still holds.

**Playback-only lifecycle (`playlist.ts`)**

- Add an exported `InstrumentsState`: `{ status: 'none' } | { status: 'loading' } | { status: 'ready'; channels: ChannelInstrument[] }`, exposed as `PlaylistPlayer.instrumentsState()`.
- Set `loading` when a song starts loading, and `ready` with `summarizeInstruments(result.song)` after the playback parse succeeds — the same parse the scheduler already needs. Do **not** compute or store a summary in the background duration parse, on `PlaylistEntry`, in the reducer or in `localStorage`, and do not enqueue any extra work when the playlist changes.
- `ready` persists through pause and seek. Reset to `none` on stop, on the end of the last song, on output loss and when a load is abandoned; `loading` covers the gap before the next auto-advanced song parses. On a parse failure the card falls back to `none` (or `loading` for the following track, which the player already tries).
- Fire the existing `onChange` when the instrument state changes so the UI re-renders exactly then, not per tick.

**Card (`ui.ts`, `styles.css`)**

- Add `<section class="panel" data-testid="instruments-panel" aria-labelledby="instruments-heading">` with `<h2 id="instruments-heading">Instruments</h2>`, matching the existing panel pattern, plus a caption naming the song (hidden when nothing is loaded).
- Render from `player.instrumentsState()`:
  - `none` → "Play a song to see its MIDI channels and instruments."
  - `loading` → "Reading instruments…"
  - `ready` with no channels → "This file has no channel events."
  - `ready` with channels → one row per channel: `Channel 1 — Acoustic Grand Piano · program 1`, with every program in order joined by "→", bank select appended when present, and `(default)` for the implicit program 0. Channel 10 is the GM percussion channel: `Channel 10 — Drums · kit 1`, no melodic GM name.
- The card contains no interactive controls, no per-channel mute/remap, no sounding-note indicator, no progress bar, and no colour-only meaning. Long names wrap; there is no horizontal overflow at 360 px.
- Accessibility: a semantic `<ul>`/`<li>` list, channel and instrument together in each item's accessible name, `aria-labelledby` on the panel, and no writes to the single `aria-live` status region from the card.
- Layout: at ≥ 960 px the card sits at the **bottom of the left column** — after Header and Audio monitor, with the Playlist in the right column spanning down beside it. Below 960 px it stacks in one column after the monitor and before the playlist. DOM order is header, playback, monitor, instruments, playlist; add the `instruments` grid area and let the playlist span the last two rows.

**Tests**

- Vitest: summary extraction on format-0 and format-1 fixtures; default program; program-only channel; multi-channel ordering; consecutive duplicate collapse and A→B→A histories; bank select; percussion channel; no-channel file; GM table boundaries (0 and 127) and length.
- Vitest player: `none` before playback; `loading` immediately after play; `ready` with the expected channels after the parse; unchanged through pause and seek; `none` after stop, end of the last song, output loss and a failed load; summary changes when `next` starts another song; the background duration parse leaves the state `none` (no extra loading for playlist entries).
- Playwright: the card is empty before play, lists the playing file's channels afterwards, keeps the list through pause, clears on stop, swaps when the playing file changes, labels channel 10 as drums, stays unchanged (same text/DOM, no active class) while playing, fits 360 px without overflow, and at ≥ 960 px sits below the monitor with the playlist to its right.
- The project Definition of Done passes.

## Acceptance criteria

- [x] `summarizeInstruments` lists every channel with channel-voice events in ascending order, with program history and bank select, never retaining the parsed event list.
- [x] The Instruments card shows only the song that is currently playing, listing each channel plus its GM instrument name and 1-based program number, with channel 10 labelled as drums and multi-program channels shown in order.
- [x] Before playback the card shows the play prompt; while the song loads it shows the reading state; a file with no channel events shows the empty-message state.
- [x] Pause and seek keep the list; stop, end of the last song, output loss and a failed load clear it; starting another song replaces it.
- [x] No playlist entry is parsed or persisted for this card: summaries are computed only from the playback parse, and the background duration parse leaves the card untouched.
- [x] The card stays static during playback (no highlight, animation or progress) and re-renders only when the instrument state changes.
- [x] At ≥ 960 px the card is at the bottom of the left column with the Playlist to its right; below that it stacks, with no horizontal overflow at 360 px.
- [x] The card is keyboard- and screen-reader-accessible (heading association, semantic list, channel and instrument in each item) and writes nothing to the status region.
- [x] Vitest, Playwright and `tsc --noEmit` pass, and the task index plus design doc are updated.

## Notes

- **"Track" means the song being played.** The parser flattens SMF tracks into one time-sorted event list and does not retain original track numbers, so the card is per file: all channels used anywhere in the current .mid, not per embedded SMF track. Showing SMF-track grouping would require keeping per-track identity from `midi-file`, which the architecture deliberately avoids.
- **No persistence, deliberately.** Earlier drafts persisted a per-entry summary so the card could follow the playlist highlight. Restricting the card to the playing file removes that: the only parse that matters already happens on play, so the card costs no extra file reads and the saved playlist schema is untouched. The trade-off is that the card is empty until a song is played and clears on stop, which matches the requested "currently playing" scope.
- **Display decisions to confirm while implementing:**
  - Program and channel numbers are shown 1-based (musician convention); the data stays 0-based.
  - All programs used by a channel are shown, because a channel can change instrument (common in General MIDI files). There is deliberately no timing or highlight.
  - Bank select is shown only when the file sends CC0/CC32; a non-GM bank means the GM name is a best-effort label.
  - Channel 10 relies on the GM convention; a file that uses channel 10 for melodic material is still labelled drums. GM2/GS/XG kit names are out of scope.
- **No new R-ID.** The card extends R3's per-song information, matching how T7/T8 cite affected MVP requirements without adding one. Update the README coverage line accordingly.
- **No new dependency, no new module.** The GM table and summary live in `parser.ts`; if the table makes that file unwieldy, splitting it into a small `src/gm.ts` is a module-split change that needs approval first.
- **Where the summary lives:** `PlaylistPlayer.instrumentsState()` is the single source; the UI must not re-summarize the song or cache a copy. Setting it calls `onChange`, which renders transport, playlist and card together.
- **Out of scope:** per-channel mute and remapping (still backlog), instrument audition, GM/GS/XG reset display, per-note or per-channel activity, following playlist selection while stopped, and any editing of the file's program changes.
- **Test fixtures:** extend the existing hand-built SMF helpers — `tests/unit/parser.test.ts` already builds program/CC events, and the Playwright `midiFile` helper accepts raw setup bytes for program changes on several channels.
- **Design doc and index:** update the "After the MVP" bullet and the UI-layout sentence to the current-playing/left-column behavior; update the T9 row, coverage and note in `tasks/README.md`.

### Decisions as implemented

- **Playback-only, no persistence:** the card is driven by `PlaylistPlayer.instrumentsState()` and filled from the same parse the scheduler uses. Nothing is added to `PlaylistEntry`, the reducer, the stored playlist or the background duration parse; the saved-playlist schema is untouched.
- **Lifecycle:** `loading` while a song is being parsed, `ready` once it starts, unchanged through pause and seek, and `none` on stop, the end of the last song, output loss, a failed load, and pausing while a load is still in flight. The auto-advance gap shows `loading` for the incoming song.
- **Layout:** at ≥ 960 px the grid is `header | playback`, `monitor | playlist`, `instruments | playlist`; the playlist spans the last two rows, so the card sits under the monitor in the left column. Below 960 px it stacks after the monitor.
- **Display:** program and channel numbers are 1-based, channel 10 is `Drums · kit N`, banks appear only when sent, and the implicit default program is marked `(default)`. A small caption names the song.
- **Tests:** Vitest covers the summary (programs, banks, defaults, ordering, percussion, GM names) and the playback-only lifecycle; Playwright covers the states, track switches, a byte-identical DOM while playing/pausing, and the wide/narrow placement.
