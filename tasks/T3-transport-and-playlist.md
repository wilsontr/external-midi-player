# T3: Transport and playlist

- **ID**: T3
- **Milestone**: Transport and playlist
- **Status**: done
- **Estimate**: 1 day
- **Depends on**: T2
- **Modules**: `playlist.ts`, `ui.ts` (transport and playlist panels)
- **Requirements**: R1, R2, R3, R6, R7, R12, R13

## Objective

Add the full transport (play/pause/stop/next/previous, auto-advance, progress display) and the playlist (add, reorder, remove, background duration parse) on top of the scheduler from T2.

## Scope

- `playlist.ts`:
  - Ordered list of `File` objects mirrored to `localStorage` (bytes, names, durations, order and current entry); nothing uploaded. A reload restores the list.
  - Entry model: `{ id (crypto.randomUUID()), file, name (file.name without extension), durationSec?, status: 'ready' | 'error', error? }`.
  - Accept files by extension (.mid, .midi) and the `MThd` header check during parsing.
  - After adding, parse entries one at a time in the background to fill durations; discard parsed data to save memory.
  - Current entry highlighted; clicking a row (or its Play button) plays that entry from the start.
  - Auto-advance to the next `ready` entry, skipping `error` entries, with a fixed 1 s gap so external synths finish their release tails.
  - Removing the playing entry stops playback; reordering during playback keeps the current song playing.
  - Persist the playlist and current entry; restore them on load in the `stopped` state. Storage failures must not break the session.
  - Player state machine: play and resume go to `playing`; pause goes to `paused`; stop, end of list, and output disconnect go to `stopped`.
- Transport (wraps `scheduler.ts`):
  - Play/pause/resume/stop/next/previous.
  - Pause: stop scheduler, record offset, note-off every sounding note, CC64 = 0 (sustain off); resume restarts from the offset and held notes are not re-struck.
  - Stop/next/previous: same release, offset reset to 0; release messages sent with a timestamp just after the last queued event.
- `ui.ts` — playback panel:
  - MIDI output picker (populated by T1); transport buttons (previous, play/pause, stop, next); Panic; progress bar with elapsed and total time; current song title.
  - Keyboard shortcuts: Space = play/pause, Esc = Panic, ←/→ = previous/next.
  - Status messages (device lost, file rejected) in a single `aria-live` region.
- Playlist panel: drop zone and "Add files" button; clickable rows with name, duration, status, remove button; drag handles to reorder.
- Unit tests (Vitest) — playlist reducer: add, remove, reorder, auto-advance skipping error entries; persistence save/restore and failure handling.

## Acceptance criteria

- [x] 10 files dropped at once all appear, in drop order (R1).
- [x] Drag to reorder; remove button per row (R2).
- [x] Each entry shows name and duration; a corrupt file shows an error row and is skipped (R3).
- [x] Pause and stop leave no hanging notes (R6).
- [x] Auto-advance moves to the next entry; the last song ends and transport returns to stopped (R7).
- [x] Position and elapsed/total time update at least 10 times per second (R12).
- [x] Player state is always one of `stopped`, `playing`, `paused`.
- [x] Clicking a playlist row plays that entry from the start.
- [x] The playlist and current entry are restored after a reload (R13).

## Notes

- The 200 ms look-ahead bounds overhang on stop/pause (see T2).
- Open question: should playback send a GM reset or program changes before each song so external synths start from a known state? If yes, hook into the `ended`/next boundary here.
- Single click plays a row; the per-row action buttons (play, up, down, remove) keep their own behaviour and never trigger the row click.
- Persistence uses `localStorage`; very large playlists are a post-MVP IndexedDB upgrade.
