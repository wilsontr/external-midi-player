# T18: Standardize playlist selection and playing markers

- **ID**: T18
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 0.25 day
- **Depends on**: T15, T17
- **Modules**: `src/ui.ts`, `src/styles.css`, e2e tests, `README.md`, design doc
- **Requirements**: R2, R3

## Objective

One visual vocabulary for the song list: a **dotted outline means selected**, an **inverted highlight means playing**, and a row can carry both when it is the selected track and the playing track. This replaces the current mix of a solid selection outline, a dashed focus outline that looked like selection, and a played row that lost its selection marker.

## Scope

- **Selection marker:** draw the selected row with `2px dashed` (the "dotted" faceplate marker) in the LCD ink; on the inverted playing row use the inverted ink so it stays visible. The old solid `--focus` outline is removed.
- **Combining:** render `data-selected` whenever the row is selected, including when it is also `current`. A playing + selected row now shows the highlight with the dotted outline on top; a playing-but-not-selected row shows the highlight only.
- **Focus is not selection:** remove the row-level `:focus-within` outline. Focus is shown by the global `:focus-visible` ring on the focused control (with a dark ring override on the inverted row). This stops a playing row whose Play key was last clicked from looking selected.
- **Selection behaviour unchanged:** selection follows playback when the current entry changes (Play, track switch, next/previous, auto-advance), so a track started that way is both playing and selected. A single click while playing or paused moves the selection to the clicked row, leaving the playing row with its highlight only.
- Update the Playwright selection test to assert `data-selected`, `aria-current` and the computed `dashed` outline in all three states; docs and index.

## Acceptance criteria

- [x] A selected row has a dashed/dotted outline and no highlight.
- [x] The playing row has the inverted highlight; a playing row that is not selected has no outline.
- [x] A row that is both selected and playing shows both the highlight and the dotted outline (in the inverted ink for contrast).
- [x] Starting playback (Play key, double-click, next/previous, auto-advance) selects that row; a single click elsewhere moves the selection without changing playback.
- [x] Focus is drawn on the focused control only; a focused but unselected row is not outlined as if selected.
- [x] The earlier actions map cleanly: Play key/double-click → highlight + dotted; single-click while playing → dotted only on the clicked row, highlight only on the playing row.
- [x] `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass; docs and index updated.

## Notes

- **Why focus moved off the row.** The old `:focus-within` rule drew the same dashed outline whenever a row's Play/remove key had focus. Clicking Play therefore put a selection-looking outline on the playing row, and it could linger after another row was selected if focus stayed inside the first row. The dotted row marker now has exactly one meaning: selected.
- **Why the playing row is normally also selected.** `selectedId` follows `currentId` on every playback change, so "start this track" also selects it. The two markers separate only when the user single-clicks a different row while the current one plays. That keeps the common case unambiguous (both) while allowing an independent "next" or "inspect" selection.
- **Combined contrast.** On the inverted amber row the dotted outline switches to the inverted ink (the same colour rule the old focus outline used), so the selection marker remains visible over the highlight.
- **Presentation only.** No selection persistence, no change to which entry plays, and no change to single/double-click semantics from T15.
