# T7: Software synth output

- **ID**: T7
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 2–3 days (decision-dependent)
- **Depends on**: T2, T3
- **Modules**: `src/synthOutput.ts` (new: engine, adapter, bundled bank), `src/ui.ts` (output picker and selection), `src/midiDevices.ts` (clearing the hardware selection), `vite.config.ts` (CSP), `src/assets/GeneralUserGS.sf3`, tests and docs; `scheduler.ts` and `playlist.ts` are unchanged by design
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

- [x] **AC1 — Decision.** Choose one approach (engine and integration path, or
  explicitly the external-synth route) and record it in this ticket's Notes
  with: the chosen engine/integration, licence, bundle and SoundFont size,
  timing approach, why the other options were rejected, the runtime-dependency
  decision, and the concrete follow-up scope (implementation or docs).
- [x] The concrete scope from AC1 is written into this ticket (or a follow-up
  ticket) so it can be executed without re-litigating the decision.
- [x] If a synth is embedded: a playlist plays audibly to it with no external
  MIDI hardware, through the normal output selection.
- [x] If a synth is embedded: note timing meets the existing bar (no JS-timer
  note dispatch) and pause/stop/next/previous plus Panic silence it exactly
  like the hardware path.
- [x] If the external route is chosen: per-OS setup (FluidSynth virtual port,
  Windows GS Wavetable Synth, or equivalent) is documented in the README and
  verified in Chrome and Firefox.
- [x] The existing hardware MIDI path and the audio monitor are unchanged; the
  software output is additive.
- [x] Licences (engine and SoundFont) and asset sizes are recorded, and the
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

### Decisions as implemented (AC1)

- **Engine.** `spessasynth_lib` 4.4.8 (Apache-2.0), which pulls `spessasynth_core` 4.4.10 (Apache-2.0), `fflate` 0.8.3 (MIT) and `stb-vorbis` 0.0.7 (Apache-2.0). Chosen over `js-synthesizer` (an LGPL-2.1 FluidSynth WASM wrapper: heavier licence surface, smaller maintenance footprint) and over the sample-based GM players (`soundfont-player`, WebAudioFont, Tone.js), which need per-instrument glue for program changes, drums, pitch bend and controllers and expose no message-level API. Approach A (an external FluidSynth / GS Wavetable port) was rejected because it needs a per-OS install and leaves the app without an in-app output, which is the actual request.
- **Integration.** The timestamp-preserving adapter, `SynthMidiOutput` in `src/synthOutput.ts`: a real `EventTarget` implementing `MIDIOutput`, so `scheduler.ts` and `playlist.ts` are untouched. `send(bytes, timestamp)` converts the Web MIDI `DOMHighResTimeStamp` to the audio clock and calls `synth.sendMessage(bytes, 0, { time })`. The other two options were rejected: event-list playback would fork the transport, and immediate dispatch would break the no-JS-timer rule because the scheduler hands messages over up to 200 ms early.
- **Timing.** SpessaSynth 4.4 added `SynthMethodOptions.time`: the processor keeps an event queue sorted by `AudioContext` time and applies each message at the render quantum it is due, so note timing never passes through a JS timer (R5). `audioTimeFor` reads `AudioContext.currentTime` and `performance.now()` back to back on every send, so the clock mapping cannot accumulate drift; the residual error is bounded by one measurement (tens of µs for `performance.now`, one render quantum for `currentTime`). Pause, stop, next, previous and Panic need no special handling: they already send note-off plus CC64 = 0 / CC123 / CC120 / CC121 through the same `send`.
- **SoundFont.** GeneralUser GS **2.0.3 BETA**, Vorbis-compressed as SF3, **8,423,728 bytes**, built by SpessaSynth (its own demo bank), `sha256 e2ed326ff44d15f78f2fdc72403b6fa6b77ee7266d3aad0d2198bc95797bc66c`, at `src/assets/GeneralUserGS.sf3`. Licence **v2.0**: the author grants unrestricted use and modification in software projects and asks that redistribution ship a local copy with attribution (the licence text is embedded in the SF3's `ICMT` chunk and repeated in the README). The licence also states that the provenance of some samples is not fully documented — recorded in the README rather than hidden.
- **Sizes.** Initial JS is unchanged at 92.67 kB (gzip 26.91) because the engine is a dynamic `import()`; the synth's own chunk is 333.26 kB (gzip 125.10), the AudioWorklet processor 815,753 bytes (gzip 255 kB) and the SoundFont 8.4 MB. The bank and the engine are only fetched when the user actually picks the built-in synth; a visitor who never picks it downloads none of it (beyond the option in the picker).
- **CSP.** The production policy gained `'wasm-unsafe-eval'` in `script-src`, because the SF3 decoder compiles a WebAssembly module even at startup (`isReady` awaits the SF3 decoder). The token does not enable JavaScript `eval`, and every module and asset it runs is still same-origin. Verified against the built site: synth loads and plays under the CSP in Chromium and Firefox with no console violations.
- **Runtime dependency decision.** Approved by the maintainer for this ticket ("implement T7 with SpessaSynth", "bundle GeneralUser GS as SF3"), including the bundled bank; recorded here rather than assumed. `@tonejs/midi` and `midi-file` are no longer the only runtime dependencies.
- **UX.** The built-in synth is one more entry in the existing MIDI output picker, offered before Connect devices is pressed (it needs no permission, unlike Web MIDI and the microphone). Selecting it loads the worklet and the bank behind a "Loading the built-in synth…" status, and only then becomes the selected output, so Play can never start against a half-loaded instrument. Output selection is exclusive: picking the synth clears the hardware selection and vice versa, and switching mid-song stops playback like any other output switch. A failed load (404, blocked worklet) reports one line in the aria-live region and leaves the picker and the rest of the player usable.
- **Deliberately not done.** The chosen output is not remembered across reloads: restoring it would fetch 8.4 MB before any user gesture, and browsers will not start an `AudioContext` without one. Revisit with T12-style first-run work if it matters. The bank is not persisted (far beyond `localStorage`); per-channel synth routing, MIDI control of the synth, and rendering the synth to a file are out of scope.
- **Tests.** Vitest covers the clock mapping and the adapter (timestamps, no-timestamp sends, the `MIDIOutput` surface, `clear()` being a no-op). Playwright covers the permission-free option, a single bank fetch across reselects, audible playback (a real `AudioContext` with the analyser spliced into the synth's output), Stop and Panic silencing it, Pause releasing the sounding note, and a 404 bank. The spec leaves the real `AudioContext` in place via `mockDevices({ mockAudio: false })`; the transport keys are pressed with Enter there because headless Firefox reserves a strip at the bottom of the window once a real audio context is running.
