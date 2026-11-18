# T17: Slim playlist rows

- **ID**: T17
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 0.25 day
- **Depends on**: T3, T8
- **Modules**: `src/ui.ts`, `src/styles.css`, e2e and unit tests, `README.md`, design doc
- **Requirements**: R2, R3

## Objective

Give the song name more of the row by removing the per-row up/down keys and the "Ready" label, keeping an `ERR` badge for rejected files. Rows carry only what is useful at a glance: number, name, duration, error state, Play and remove.

## Scope

- **Remove the up/down row keys** (and their click actions and the now-unused up/down icons). Reordering remains drag-and-drop, which is what R2 requires; the drag handle, move handling and persistence are unchanged.
- **Remove the "Ready" label** for healthy rows: the status span is hidden (so it costs no width and adds no flex gap) and shows `ERR` only when the entry is in the error state. Keep the full error text available as the badge's `title` and in the single `aria-live` status region, which already reports the file name and reason when a load fails.
- **Reclaim horizontal space**: two row keys instead of four, no per-row status text or gap, and the row gap tightened from 8 px to 6 px. The name keeps `flex: 1` and absorbs the freed width; the duration stays right-aligned.
- **Leave room for `ERR`**: the status span is `flex: 0 0 auto` when shown, so a long name wraps instead of shrinking the badge, and the row keeps the badge visible at 360 px.
- Update the reorder e2e tests to drag-only, the corrupt-row test to assert `ERR` (and no status on healthy rows), and the docs/index.

## Acceptance criteria

- [x] Rows no longer render up/down keys; drag-and-drop and the row's Play/remove keys still work, and remove still does not play.
- [x] Healthy rows show no status text; rejected rows show exactly `ERR` with the full error in a `title` and in the status region.
- [x] The name column gains the width freed by the removed keys and label (two buttons instead of four, no status gap, 6 px row gap).
- [x] `ERR` is not clipped or wrapped at 360 px on an error row.
- [x] Row numbers, selection, double-click playback, duration and remove/persist behaviour are unchanged.
- [x] `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass; docs and index updated.

## Notes

- **Keyboard reordering.** The up/down keys were the keyboard-accessible way to reorder; with them gone, reordering is pointer/drag only. R2's acceptance check is "drag to reorder; remove button per row", so this still meets the requirement, and every row keeps its Play and remove keys for keyboard use. If keyboard reordering is wanted back without the arrows, the natural follow-up is to make the drag handle focusable and move the row with the arrow keys (no extra width).
- **Why `ERR` and not the message.** The full error (`File too small…`, unreadable drive, parse failure) is long and is already announced in the status region; the row badge only has to say that this entry is not playable. The `title` preserves the detail on hover.
- **No hidden reserved column.** The badge is hidden rather than an always-present empty slot, so healthy rows use the full width; on an error row it appears and the name wraps around it. The span is non-shrinking for exactly that reason.
- **No data changes.** Entry status, the error text, reorder persistence and the accessible Play/remove names are unchanged; this is a presentation-only ticket.
