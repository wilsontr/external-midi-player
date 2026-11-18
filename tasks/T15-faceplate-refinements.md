# T15: Faceplate refinements — selection, routing and status

- **ID**: T15
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 0.5 day
- **Depends on**: T8, T11, T13, T14
- **Modules**: `src/playlist.ts` (select-only entry), `src/ui.ts`, `src/styles.css`, e2e specs, `README.md`, design doc
- **Requirements**: R2, R3, R10, R12

## Objective

Tighten the half-rack faceplate now that it has been lived with: a row click should not start playback by accident, the Panic notice should not outlive the next song, the audio pickers belong with the MIDI output on the front unit, and the remaining audio-routing card has outlived its purpose.

## Scope

- **Row click:** single-clicking a playlist row only **selects** it; double-clicking a row plays it from the start. While stopped, the selected row is the one that plays next (highlight, LCD title and Play target). While playing or paused, the selection is shown as an outline on the picked row and the playing row keeps its highlight, title and part map — selecting never changes what is sounding. The per-row Play key still starts playback with one click. Error rows are not selectable.
- **Panic status:** the "Panic: all notes off sent on all 16 channels." line is cleared as soon as the transport enters `playing` — start, track switch, auto-advance and resume all go through the same transition.
- **Audio pickers:** move the audio input and audio output selects (and the Firefox output-grant key) from the audio-routing card into the keypad strip, under the MIDI output picker, with "Audio input" / "Audio output" silkscreen labels. Keep every id and test id, so the monitor wiring is untouched.
- **Notices:** move the monitor-unavailable, output-grant and feedback notices with the pickers; they stay hidden until their condition applies.
- **Keypad gap:** `.keypad` gap 8 px → 6 px so the five transport keys (including Panic) fit the 260 px front-panel strip.
- **Shortcuts:** move the "Shortcuts: Space play/pause · Esc panic · ← previous · → next" line from the keypad strip into the Quick start body (inside the collapsible area).
- **Delete the audio-routing card** and its heading entirely, and delete the "Browser latency" readout. The monitor still measures latency internally; it is no longer displayed.
- Unit tests for select-only behaviour; Playwright coverage for double-click playback, single-click selection, the cleared Panic status, the moved pickers/notices, and the updated expansion-unit layout. Docs and the T11 layout notes updated.

## Acceptance criteria

- [x] A single click on a row while stopped highlights it, shows its title and leaves the transport stopped; it does not send a note.
- [x] A double click on a row plays it from the start, including from playing/paused.
- [x] Single-clicking a row while playing or paused outlines it as the selection without changing the current title, part map or transport; the per-row Play key still plays in one click.
- [x] When playback moves (double-click, next/previous, auto-advance) the selection follows the new current row and its outline clears.
- [x] The Panic status line disappears when the next song starts, including auto-advance and resume.
- [x] The audio input and output pickers (and the output-grant key) sit in the keypad strip under the MIDI output picker; the monitor still lists, selects and persists devices, and the feedback notice still appears when input and output match.
- [x] The audio-routing card and the "Browser latency" line are gone; no element with `data-testid="routing-panel"` or `data-testid="latency-readout"` remains.
- [x] `.keypad` uses a 6 px gap and all five transport keys share one row at 1024 px and 360 px.
- [x] The shortcut line is inside the Quick start body (hidden when it is collapsed) and no longer appears in the keypad strip.
- [x] The expansion unit shows the song list beside the part map only; no horizontal overflow at 360 px and no layout regression at 960/1280 px.
- [x] `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass.

## Notes

- **Two selection states, deliberately.** `currentId` is "the one playing, or the one that plays next"; while playing it names the song on the wire, and the LCD title, part map and auto-advance all read it. Moving it on a single click during playback would make the highlight lie about what is sounding. So while stopped the click moves `currentId` (the selection *is* the next song), and while playing/paused the UI keeps a separate, view-only selection that shows as an outline. The playing row keeps `aria-current`, the title and the part map.
- **Marker semantics superseded by T18.** T18 replaced the solid selection outline with the dotted one, allowed the selection and playing markers to combine on one row, and moved the focus outline off the row so it cannot be mistaken for selection. The click semantics below are unchanged.
- **Selection follows playback.** A double-click, next/previous, auto-advance or removing the current row moves `currentId`; the UI notices and moves the selection with it, so a stale outline never survives a track change. The selection is not persisted: a reload starts with the current row selected.
- **Panic clearing is a rendering rule.** `renderTransport` already runs on every playback-state change; it clears the line only when the state is `playing` and the status still holds the Panic text, so error and device notices are never wiped by a stray re-render.
- **Latency still exists, just not on the faceplate.** `AudioMonitor.latencyMs()` and its unit tests stay; only the UI readout and its animation-loop update are removed.
- **Layout.** The front unit grows by two select rows and the expansion unit loses a card; the part map becomes the only child of the expansion side column. The 360 px layout keeps its single-column stack, and the Quick start shortcuts line stays inside the collapsible body so a collapsed start remains compact.
