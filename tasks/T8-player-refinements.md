# T8: Player and playlist refinements

- **ID**: T8
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 3–4 days (seek-dependent)
- **Depends on**: T5
- **Modules**: `playlist.ts`, `scheduler.ts`, `ui.ts`, `audioMonitor.ts`, `styles.css`, test suite
- **Requirements**: R1, R2, R3, R6, R7, R10, R12 (seeking is a post-MVP capability; no new R-ID)

## Objective

Polish playlist editing, the monitor/layout presentation and transport switching, and add timeline seeking without regressing hardware playback or the persisted state.

## Scope

**Playlist controls and persistence**

- Replace the "Add files" button with a compact **"+"** that opens the same picker and appends exactly as today; keep an accessible name/title of "Add files".
- Add a **"Load files"** button: choose files, stop playback if needed, and **replace** the current playlist with the selected .mid/.midi files. Reject non-MIDI files with a status; if nothing valid is selected, keep the existing playlist unchanged. Current entry becomes the first ready entry.
- Add a **"Clear playlist"** button: stop playback, clear all entries and the current entry, persist the empty list and show the empty state.
- Number playlist rows **1..N** so the numbering is visible and stays correct after add, load, remove, reorder and reload. Adding files appends and continues the numbering.
- Verify every playlist mutation (+ / Load / Clear / remove / reorder / current change / background duration update) goes through the existing `localStorage` persistence, and a reload restores the rows, order, numbers and current entry. File bytes, names, durations and errors stay as they are today.

**Layout and meter**

- Responsive **two-column layout** at ≥ 960 px: left column contains the **External MIDI Player** header and the **Audio monitor**; right column contains **Playback** and **Playlist**. Below that width the cards stack in one column. No horizontal overflow at 360 px.
- Keep a sensible DOM/tab order in both layouts (the current row-major order — header, playback, monitor, playlist — can stay if grid areas place it).
- Remove the visible numeric **L … · R … dBFS** readout. Keep the stereo bars and the CLIP indicator, and preserve an accessible description of the level (for example an updated `aria-label`/`aria-valuetext` on the meter rather than visible text).

**Timeline seeking**

- Make the timeline seekable by **click/drag**, committing the seek on **release** (and via keyboard: arrows/Page/Home/End). Clamp to 0..duration; disable while the duration is unknown.
- While **playing**: release sounding notes, apply the MIDI state at the target (program changes, bank selects, CCs including volume/pan/expression/sustain, pitch bend and channel pressure), set the next event index and re-anchor the clock so playback continues from the target.
- While **paused**: seek and stay paused at the new position; resume from there.
- While **stopped**: decide and document the behavior (proposed: seeking is disabled until playback starts).
- Progress/elapsed time still updates at least 10 times per second (R12), auto-advance still uses the correct duration, and seeking leaves no hanging notes.

**Startup mute policy**

- Decide and document whether a first visit must start muted. Current behavior: the very first session starts muted (R10 feedback safety), and later sessions restore the persisted mute/volume (T4/T5). If the decision is to start unmuted by default, update R10 and the shared-device warning; otherwise record the current policy as intentional.

**Panic before switching tracks**

- When switching to a different playlist entry while a track is **playing or paused**, send Panic (CC123/120/121 and CC64 = 0 on all 16 channels) after the last queued event, then start the new track only after that panic. No new-track notes may be cut off by the old queue's tail. Starting from stopped does not need a panic.

## Acceptance criteria

- [x] "+" adds files exactly like "Add files"; "Load files" replaces the playlist; "Clear" empties it; all three update `localStorage` and survive a reload.
- [x] Playlist rows show 1..N numbering that stays correct after add/load/remove/reorder/reload.
- [x] At ≥ 960 px the layout is two columns with header + audio monitor left and playback + playlist right; below it stacks; 360 px has no horizontal overflow; keyboard access still works.
- [x] The numeric L/R dBFS readout is gone; the bars and CLIP still work and the meter keeps an accessible level description.
- [x] Click/drag timeline seeking commits on release, works while playing and paused, restores the MIDI state at the target, updates the progress display and leaves no hanging notes.
- [x] The startup mute policy is decided and documented; if it stays as today, a first visit is muted and later visits restore the saved state.
- [x] Switching tracks while playing sends Panic before the new track; the new track starts cleanly with no cut-off or hanging notes.
- [x] Playlist/storage/layout/seek/panic behavior is covered by Vitest and Playwright tests, and the project Definition of Done passes.


## Notes

- **Decisions to confirm while implementing:**
  - Clear/Load confirmation: proposed Load replaces immediately after the explicit file picker; Clear may ask for confirmation when the playlist is non-empty.
  - Seeking while stopped: proposed disabled (the timeline is live only while playing or paused); if enabled later, define whether it starts playback or only sets the resume position.
  - Breakpoint: 960 px; the app's max width needs to grow (currently 720 px) for two comfortable columns.
  - Mute: proposed keep the first-run muted default and restore the saved state thereafter. The player does **not** always start muted today; only a fresh profile (or cleared storage) does.
  - Track-switch delay: the old scheduler can have up to 200 ms of queued events. Panic sits just after that tail; start the new track after the panic rather than at `now + 100 ms`. Reuse the existing 1 s gap where auto-advance already uses it, or a smaller switch delay.
- **Seeking state restoration** is the T3 backlog item: iterate the events before the target, keep the latest program, bank select (CC0/CC32), controllers, pitch bend and channel pressure per channel, release the sounding notes, then resume. Notes that began before the target are not re-struck. This is the main 1–2 day piece.
- **Persistence** already exists (T3/T5): playlist bytes/order/current in `localStorage`. The new Load/Clear APIs must reuse it; row numbers are derived from order, so they restore naturally.
- **"+" implementation:** the current hidden file input stays useful for add; Load needs its own input or a mode flag, and both must reset `value` after selection so the same file can be chosen again.
- **Meter accessibility:** the current e2e asserts the numeric text; replace those assertions with bar/CLIP checks and the accessible level description.
- **Layout:** a grid with areas `"header playback" / "monitor playlist"` at the wide breakpoint keeps the DOM order row-major; the current 360 px stacking test remains the narrow-layout guard.
- **Panic vs release:** `Scheduler.stop()` releases only tracked sounding notes; the requested panic is the full R8 sequence, which also resets controllers and sustain. The Player should trigger it on a track change, not on a normal stop from idle.
- **Design doc updates:** move "Seek within a song" from the After-the-MVP list into this ticket's scope, and note the post-MVP responsive layout and mute policy in the design doc / README. The MVP non-goals remain the MVP non-goals.
- T6 deployment and T7 software synth are independent of T8; deploy these changes through T6 when they are ready.

### Decisions as implemented

- **Startup mute:** kept the current policy and recorded it as intentional: a fresh profile starts muted (R10), later visits restore the saved mute/volume. R10 is unchanged.
- **Seeking while stopped:** disabled (the timeline is live only while playing or paused); a stopped song always restarts at 0. Seeking while paused moves the resume point and re-sends the target state, so resume sounds like the target position.
- **Clear/Load confirmation:** no confirmation dialog. Load replaces immediately after the explicit file picker; Clear acts on the explicit button. Both are single, reversible actions (Load's files come from a picker).
- **Track-switch delay:** Panic is timestamped after the old queue's tail and the new song is anchored 50 ms later (`switchGapMs`), not at `now + 100 ms`, so the old tail and the 64 panic messages cannot cut off new notes.
- **Breakpoint and width:** 960 px breakpoint; the app's max width grew from 720 px to 1200 px.
- **Row numbers:** explicit numbered spans derived from list order (the `<ol>` semantics remain, the visible number is `aria-hidden` to avoid double announcement).
- **Meter accessibility:** the meter is `role="meter"` with an `aria-valuetext` such as "Left −6.0 dBFS, Right −12.0 dBFS", updated at ~10 Hz; the visible numeric readout is removed.
