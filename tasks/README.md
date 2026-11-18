# Task List — Browser MIDI Playlist Player (MVP)

Task breakdown of [`Browser MIDI Playlist Player — MVP Design.md`](../Browser%20MIDI%20Playlist%20Player%20%E2%80%94%20MVP%20Design.md).
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
| T6 | [T6-github-pages-deploy.md](T6-github-pages-deploy.md) | Hardening and deploy | 0.5 day | pending |
| T7 | [T7-software-synth-output.md](T7-software-synth-output.md) | After the MVP | 2–3 days | pending |
| T8 | [T8-player-refinements.md](T8-player-refinements.md) | After the MVP | 3–4 days | done |
| T9 | [T9-channel-instruments-card.md](T9-channel-instruments-card.md) | After the MVP | 1 day | done |

Requirement coverage (per task `Requirements` field): R1, R2 → T3, T8; R3 → T2, T3, T8, T9; R4 → T1; R5 → T2, T5, T7; R6, R7 → T3, T5, T8; R8 → T2; R9, R10 → T4, T8; R11 → T4, T5; R12 → T3, T8; R13 → T1, T3, T4.

T6 is a delivery task: it carries no new functional requirement and exercises R1–R13 against the production HTTPS origin. It splits the deploy half out of milestone 5 so the GitHub Pages + CI work can be reviewed on its own.

T7 is a post-MVP enhancement; it adds no new R-ID. R5 is the timing bar if the chosen option becomes a playback output. Its first acceptance criterion is the engine/integration decision.

T8 is a post-MVP feature bundle: playlist/layout refinements plus timeline seeking and a panic-before-track-switch behavior. It cites the affected MVP requirements; seeking is a new post-MVP capability with no new R-ID.

T9 is a post-MVP informational feature: a read-only card listing the channels and GM instruments of the song currently playing. It adds no new R-ID; the card extends R3 and is built only from the playback parse, so it is not persisted. It has no playback interaction by design.

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
