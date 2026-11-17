# T7: Software synth output

- **ID**: T7
- **Milestone**: After the MVP
- **Status**: pending
- **Estimate**: 2–3 days (decision-dependent)
- **Depends on**: T2, T3
- **Modules**: a new synth-output module plus `scheduler.ts`/`playlist.ts` wiring, `ui.ts` output picker, and dependency/asset config — the exact set is decided in AC 1
- **Requirements**: R5 (timing for the new output); no new functional requirement

## Objective

Let the app play its playlist audibly on a machine with no MIDI hardware, without
changing the existing hardware path. The first deliverable is an explicit
decision on how to do that; implementation follows the decision.

## Scope

Loosely specified on purpose: pick an approach first, then write the concrete
implementation scope into this ticket.

**Candidate approaches**

- **A. External synth over a virtual MIDI port.** Run an open-source synth
  alongside the app — FluidSynth (LGPL-2.1) on macOS/Linux, Qsynth, or the
  Windows GS Wavetable Synth — and select its port in the existing MIDI output
  picker. Already works today with no app changes; FluidSynth's CoreMIDI
  driver creates a `FluidSynth virtual port` destination, and its ALSA
  sequencer driver registers a port on Linux. This is the baseline: choose it
  if the real goal is local testing rather than an in-app feature, and the
  task becomes documenting/verifying the setup.
- **B. Embed [`spessasynth_lib`](https://github.com/spessasus/spessasynth_lib)**
  (Apache-2.0): SF2/SF3/DLS, AudioWorklet, actively developed. Needs a game
  SoundFont asset and an adapter between the app's playback path and the
  synth.
- **C. Embed [`js-synthesizer`](https://github.com/jet2jet/js-synthesizer)**
  (BSD-3-Clause wrapper around a FluidSynth WebAssembly core, LGPL-2.1): GM
  playback with SoundFonts, closest in behaviour to FluidSynth. LGPL
  compliance and a larger bundle need checking.
- **D. Sample-based GM player** (`soundfont-player`, WebAudioFont, or
  Tone.js + a GM instrument map; all MIT/BSD): lighter engine, but more glue
  for program changes, drums, pitch bend and controllers.
- **E. Timeboxed spike first** (0.5 day): try B and C on a branch against the
  app's timing requirements, then decide. This can be part of AC 1 rather
  than a separate outcome.

**Integration options** (part of the decision)

- **Timestamp-preserving adapter** — keep the existing scheduler and implement
  `MIDIOutput.send(bytes, timestamp)` on top of the synth, scheduling each
  message against the `AudioContext` clock.
- **Event-list playback** — bypass the MIDI byte path for the software output
  and schedule the already-parsed `song.events` directly on the audio clock.
- **Immediate dispatch** — hand messages to the synth as they arrive. Rejected
  by default: the scheduler sends events up to 200 ms early, and re-timing
  them with JS timers would break the project's no-timer note-timing rule.
- Or **no integration** (approach A).

**Decision factors**: licence and attribution; bundle plus SoundFont size
(tens to over 100 MB for a full GM bank); GM/GS coverage; timing approach;
maintenance/activity; testability; the runtime-dependency approval required by
`AGENTS.md`; UX (a separate "Built-in synth" output vs. a help note and an
external synth); and the effect on the static bundle/deployment (T6).

**Out of scope for now**: mobile, per-instrument editing, GS/XG effects, and
recording the rendered audio.

## Acceptance criteria

- [ ] **AC1 — Decision.** Choose one approach (engine and integration path, or
  explicitly the external-synth route) and record it in this ticket's Notes
  with: the chosen engine/integration, licence, bundle and SoundFont size,
  timing approach, why the other options were rejected, the runtime-dependency
  decision, and the concrete follow-up scope (implementation or docs).
- [ ] The concrete scope from AC1 is written into this ticket (or a follow-up
  ticket) so it can be executed without re-litigating the decision.
- [ ] If a synth is embedded: a playlist plays audibly to it with no external
  MIDI hardware, through the normal output selection.
- [ ] If a synth is embedded: note timing meets the existing bar (no JS-timer
  note dispatch) and pause/stop/next/previous plus Panic silence it exactly
  like the hardware path.
- [ ] If the external route is chosen: per-OS setup (FluidSynth virtual port,
  Windows GS Wavetable Synth, or equivalent) is documented in the README and
  verified in Chrome and Firefox.
- [ ] The existing hardware MIDI path and the audio monitor are unchanged; the
  software output is additive.
- [ ] Licences (engine and SoundFont) and asset sizes are recorded, and the
  project Definition of Done still passes (`vitest`, `playwright test`,
  `tsc --noEmit`).

## Notes

- The current [scheduler](../src/scheduler.ts) calls `output.send(bytes, t0 + eventTime)`
  for a real `MIDIOutput`, with a 200 ms look-ahead. Any embedded synth must
  either honour those timestamps or be fed the parsed event list directly.
  `js-synthesizer` and `spessasynth_lib` expose immediate note/CC APIs, not a
  Web MIDI-timestamped `send`, so an adapter is expected either way.
- Approach A is usable today (FluidSynth's CoreMIDI virtual destination shows
  up in the browser's MIDI outputs; on Windows the GS Wavetable Synth is
  already a MIDI output). If T7's real driver is local testing, A may be the
  correct decision and the ticket shrinks to documentation.
- SoundFonts: FluidR3_GM is MIT and is the easy default; GeneralUser GS is free
  to use but check its terms. A full GM bank is large — check the static
  deployment impact before bundling one into the app.
- Adding a runtime dependency needs the "ask first" step in `AGENTS.md`; the
  decision should record the approval, not assume it.
- The design doc estimates a built-in SoundFont synth at 2–3 days; this ticket
  inherits that estimate only if a synth is embedded.
