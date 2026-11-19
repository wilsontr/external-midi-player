# Task List — Browser MIDI Playlist Player (MVP)

Task breakdown of [`Browser MIDI Playlist Player — MVP Design.md`](../docs/Browser%20MIDI%20Playlist%20Player%20%E2%80%94%20MVP%20Design.md).
Each file is one milestone, in build order. Total estimate: ~4.5 developer-days.

## Task schema (fixed)

Every task file **must** follow this exact schema, in this exact order:

```markdown
# T<n>: <Title>

- **ID**: T<n>
- **Milestone**: <milestone title from the design doc>
- **Status**: pending | in-progress | blocked | done
- **Estimate**: <effort in developer-days>
- **Depends on**: <comma-separated task IDs, or "none">
- **Modules**: <source files this task owns or edits>
- **Requirements**: <R-IDs from the design doc's functional-requirements table>

## Objective
1–2 sentences: what this task delivers and why it is ordered here.

## Scope
Bulleted list of deliverables.

## Acceptance criteria
- [ ] Checkable items, taken from the doc's acceptance checks / risk mitigations.

## Notes
Design constraints, mitigations, and open questions that apply to this task.
```

Rules:

- File naming: `T<n>-<kebab-case-title>.md`, ordered by milestone.
- `Status` is one of: `pending`, `in-progress`, `blocked`, `done`. Update the table below when it changes.
- `Requirements` cites R-IDs (R1–R12) from the design doc; every R-ID must appear in at least one task.
- Do not add or remove schema fields; free content belongs in `Scope`, `Acceptance criteria`, or `Notes`.

## Task index

| ID | File | Milestone | Estimate | Status |
| --- | --- | --- | --- | --- |
| T1 | [T1-scaffold-and-device-access.md](T1-scaffold-and-device-access.md) | Scaffold and device access | 0.5 day | done |
| T2 | [T2-parsing-and-scheduler.md](T2-parsing-and-scheduler.md) | Parsing and scheduler | 1 day | done |
| T3 | [T3-transport-and-playlist.md](T3-transport-and-playlist.md) | Transport and playlist | 1 day | done |
| T4 | [T4-audio-monitoring.md](T4-audio-monitoring.md) | Audio monitoring | 1 day | done |
| T5 | [T5-hardening.md](T5-hardening.md) | Hardening and deploy | 1 day | done |
| T6 | [T6-github-pages-deploy.md](T6-github-pages-deploy.md) | Hardening and deploy | 0.5 day | done |
| T7 | [T7-software-synth-output.md](T7-software-synth-output.md) | After the MVP | 2–3 days | done |
| T8 | [T8-player-refinements.md](T8-player-refinements.md) | After the MVP | 3–4 days | done |
| T9 | [T9-channel-instruments-card.md](T9-channel-instruments-card.md) | After the MVP | 1 day | done |
| T10 | [T10-m3u-playlist-saving-loading.md](T10-m3u-playlist-saving-loading.md) | After the MVP | 0.5–1 day | done |
| T11 | [T11-half-rack-faceplate-skin.md](T11-half-rack-faceplate-skin.md) | After the MVP | 2–3 days | done |
| T12 | [T12-first-run-sample-song.md](T12-first-run-sample-song.md) | After the MVP | 0.25–0.5 day | done |
| T13 | [T13-start-setup-pre-roll.md](T13-start-setup-pre-roll.md) | After the MVP | 0.5 day | done |
| T14 | [T14-start-lead-older-hardware.md](T14-start-lead-older-hardware.md) | After the MVP | 0.5 day | done |
| T15 | [T15-faceplate-refinements.md](T15-faceplate-refinements.md) | After the MVP | 0.5 day | done |
| T16 | [T16-live-instruments-card.md](T16-live-instruments-card.md) | After the MVP | 0.5 day | done |
| T17 | [T17-slim-playlist-rows.md](T17-slim-playlist-rows.md) | After the MVP | 0.25 day | done |
| T18 | [T18-selection-playing-markers.md](T18-selection-playing-markers.md) | After the MVP | 0.25 day | done |
| T19 | [T19-ableton-volume-knob-drag.md](T19-ableton-volume-knob-drag.md) | After the MVP | 0.5 day | done |
| T20 | [T20-track-metadata-titles-and-viewer.md](T20-track-metadata-titles-and-viewer.md) | After the MVP | 1–1.5 days | done |
| T21 | [T21-live-channel-note-activity.md](T21-live-channel-note-activity.md) | After the MVP | 0.5–1 day | done |

Requirement coverage (per task `Requirements` field): R1, R2 → T3, T8, T10, T15, T17, T18; R3 → T2, T3, T8, T9, T10, T12, T15, T16, T17, T18, T20, T21; R4 → T1; R5 → T2, T5, T7, T13, T14; R6, R7 → T3, T5, T8; R8 → T2; R9 → T4, T8, T15; R10 → T4, T8, T15, T19; R11 → T4, T5; R12 → T3, T8, T15; R13 → T1, T3, T4, T10, T12, T20.

T6 is a delivery task: it carries no new functional requirement and exercises R1–R13 against the production HTTPS origin. It splits the deploy half out of milestone 5 so the GitHub Pages + CI work can be reviewed on its own.

T7 shipped as an embedded SpessaSynth output (Apache-2.0) behind the existing MIDI output picker, with a timestamp-preserving `MIDIOutput` adapter so `scheduler.ts` is untouched: Web MIDI timestamps are translated to `AudioContext` time and the engine's processor applies each message at the right render quantum, so no JS timer is involved (R5). It adds no new R-ID. The bundled GeneralUser GS SF3 (8.4 MB, Licence v2.0) and the engine chunk load only when the built-in synth is picked.

T8 is a post-MVP feature bundle: playlist/layout refinements plus timeline seeking and a panic-before-track-switch behavior. It cites the affected MVP requirements; seeking is a new post-MVP capability with no new R-ID.

T9 is a post-MVP informational feature: a read-only card listing the channels and GM instruments of the song currently playing. It adds no new R-ID; the card extends R3 and is built only from the playback parse, so it is not persisted. It has no playback interaction by design.

T10 is a post-MVP playlist interchange feature: it saves the current playlist as an M3U/M3U8 file and rebuilds the playlist from one, preserving order. It adds no new R-ID; it reuses R1's file selection, R2's ordering, R3's names/durations and R13's persistence. Because a browser cannot read original file paths, loading resolves references against files already in the playlist first and only then needs the MIDI files selected alongside the playlist; the imported bytes are still copied into `localStorage`.

T11 is a post-MVP presentation task: it reskins the player as a 90s half-rack module (amber dot-matrix LCDs, rubber keys with LEDs, Helvetica Neue silkscreen labels) and regroups the existing panels into two rack units. It adds no new R-ID and changes no playback behaviour; every control, test ID and accessible name stays. Live per-channel note activity in the 16-part strip is left for follow-up T21.

T12 is a post-MVP first-run convenience: it ships one small General MIDI file and seeds the playlist with it only when the playlist store has never been written, so a new visitor can press Play before selecting any files. It adds no new R-ID and reuses the ordinary add/persist path, so Clear playlist stays clear across reloads and M3U load/save semantics are unchanged.

T20 is a post-MVP metadata task: it reads the SMF `Track Name`, `Text Event` and `Copyright Notice` metas, decodes them as UTF-8, Shift_JIS, EUC-JP, ISO-2022-JP or Windows-1252, uses a usable `Track Name` as the displayed song title, and adds a per-row viewer that lists all three fields on an LCD-style dialog. It cites R3 and R13; the file name remains the identity for persistence and M3U paths, and playback timing is untouched.

T21 is a post-MVP presentation add-on: the 16-part strip lights each channel while it has a note sounding (held or sustained, with a short minimum lit time), follows playback and seeks, and clears on pause, stop and track changes. It adds no new R-ID and cites R3; activity is derived from the playback parse, so nothing is stored and no timer is added. It also fixes the scheduler's note-on-velocity-0 tracking so both notions of "sounding" agree.

T19 is a post-MVP interaction refinement: the monitor volume knob changes on a relative vertical drag (up increases, down decreases, Shift for fine steps) like a DAW knob, instead of the native horizontal range drag under the cap. It cites R10, keeps the range input for keyboard and assistive technology, and changes no stored data or audio behaviour.

T18 is a post-MVP playlist presentation fix: selection is a dotted outline and playing is the inverted highlight, both shown together when a row is selected and playing; focus moved to the focused control so it no longer looks like selection. It adds no new R-ID and changes nothing about which entry plays.

T17 is a post-MVP playlist-row trim: the per-row up/down keys and the "Ready" label are gone, with `ERR` shown only on rejected files, so the song name gets the freed width. Reordering is drag-only (R2) and the full error still reaches the status region. It is presentation-only and adds no new R-ID.

T16 is a post-MVP refinement of T9: the Instruments card now shows the program in effect at the current playback position, updating when the file's program changes play and following pause and seek, instead of listing every change up front. It adds no new R-ID, cites R3, adds no timer or parse, and does not change the stored playlist.

T15 is a post-MVP faceplate refinement: a single click selects a playlist row and double-click plays it, the Panic status line clears when the next song starts, the audio input/output pickers move onto the front unit (with their notices), the audio-routing card and browser-latency line are deleted, the keypad gap tightens so Panic fits its row, and the shortcut hints move into Quick start. It cites the affected R-IDs and changes no playback timing.

T14 is a post-MVP refinement of T13 for older hardware: the tick-0 setup is spread across a 250 ms start lead with a clear 100 ms tail, so a 1990s module that stalls while loading a bank of patches has finished before the first note. It adds no new R-ID and cites R5; the lead is a scheduler option (`startLeadMs`), and files without tick-0 setup are unchanged.

T13 is a post-MVP timing fix: a song whose file front-loads a multi-part setup on tick 0 used to send that whole state at the same instant as the first chord, which a serial MIDI line cannot carry, so the opening arrived late, rolled and clipped. The scheduler now pre-rolls the tick-0 setup ahead of song time 0 at one message per 1.25 ms, then anchors the clock after it. It adds no new R-ID and cites R5; files without tick-0 setup are unchanged.

## Backlog (post-MVP, from "After the MVP")

Not tracked as tasks yet; each would become its own task file if scheduled.

- Upgrade playlist persistence from localStorage to IndexedDB for very large playlists (0.5 day)
- Tempo change, A–B looping, per-channel mute and remapping (2–4 days)
- Record the monitored input to WAV (1 day)
- Installable offline app (0.5 day)

## Open questions (from the design doc)

- [ ] Is live play-along a goal? If so, recommend hardware direct monitoring (affects T4).
- [ ] Do any target MIDI files rely on SysEx (GM/GS/XG resets)? Requires `sysex: true` (affects T1).
- [ ] Should playback send a GM reset or program changes before each song? (affects T3)
- [ ] Which audio interfaces must be supported; do any need inputs above channels 1–2? (affects T4)
