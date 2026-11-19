# T24: Monitor controls and VU for the built-in synth

- **ID**: T24
- **Milestone**: After the MVP
- **Status**: done
- **Estimate**: 0.5 day
- **Depends on**: T4 (audio monitor), T7 (built-in synth), T8 (startup mute policy), T19 (volume knob)
- **Modules**: `src/audioMonitor.ts` (shared monitor bus), `src/synthOutput.ts` (render into the bus), `src/ui.ts` (wiring, meter name, muted hint), `tests/unit/audioMonitor.test.ts`, `tests/e2e/software-synth.spec.ts`, docs
- **Requirements**: R10 (monitor volume, mute and level meter; no new R-ID)

## Objective

The Audio monitor strip — volume knob, Mute and the stereo VU ladders — only governed the captured external input. The built-in SpessaSynth played straight to the system destination, so with the internal synth the strip was cosmetic: the knob and Mute did nothing and the meter stayed dark. Route the built-in synth through the same monitor bus so the strip controls and shows the synth's audio too.

## Scope

- **One monitor bus.** `AudioMonitor` owns the shared `AudioContext`, the volume/mute `GainNode` and the pre-gain meter tap (one `ChannelSplitterNode` and two `AnalyserNode`s, created with the context rather than per capture). It exposes `ensureContext()` and `attachSource(source)`, which wires a generated source into both the gain and the meter tap.
- **The synth renders into it.** `SoftwareSynth` accepts the monitor bus; `prepare()` uses the monitor's `AudioContext` (instead of a private one) and connects the SpessaSynth output through `attachSource`. It does not close a context it does not own. With no bus supplied it keeps the old standalone behaviour, so the class stays usable on its own.
- **What applies.** The volume knob and Mute now attenuate the built-in synth exactly as they attenuate a captured input, the VU ladders read its level (pre-gain, so they still move while muted, like the input meter), and the chosen monitoring output device carries it because it is the same `AudioContext`/`<audio>` sink.
- **Mute policy unchanged.** A fresh profile still starts muted (R10, T8); the Quick start already tells the user to disable Mute, and selecting the built-in synth while muted now says so in the status line so "ready" is not mistaken for "audible". No auto-unmute: one mute state for everything the monitor plays.
- **Meter wording.** The meter's accessible name becomes **Monitor level** and the docs describe it as the monitor bus level (input plus built-in synth) rather than input only.
- **Tests.** Unit coverage for `attachSource` (gain + meter tap, works with no capture, floor when nothing feeds the bus, mono-input mirroring only without a synth) and the one permanent meter tap. Playwright covers the synth being inaudible while muted, audible after unmuting, silent again on Mute and at zero volume, and the VU reading the synth; a post-gain probe measures what actually reaches the destination.

## Acceptance criteria

- [x] The built-in synth's audio passes through the monitor volume/mute gain: muted (the fresh-profile default) is silent, unmuted is audible, Mute silences it again, and volume 0 is silent.
- [x] The monitor VU ladders read the built-in synth's level while it plays, including while muted.
- [x] The chosen monitoring output device carries the built-in synth (Chrome `AudioContext.setSinkId`, Firefox `<audio>` path) because both share one context and sink.
- [x] The captured-input monitor path is unchanged: volume, mute, meter, mono mirroring, feedback warning, hot-plug handling and the startup mute policy behave as before.
- [x] Selecting the built-in synth while the monitor is muted reports that the monitor is muted; the Quick start advice is unchanged.
- [x] The scheduler and playback timing are untouched: the synth remains a `MIDIOutput` with future-timestamped sends (R5), and no JS timer is added.
- [x] `npx vitest run`, `npx playwright test` and `npx tsc --noEmit` pass; docs and the task index are updated.

## Notes

- **Why a shared context.** Two independently created `AudioContext`s cannot share a `GainNode` or an analyser. Giving the monitor graph and the synth one context makes the existing gain and meter the single point where volume, mute, metering and output routing apply; duplicating the graph in the synth's context would have meant two meters, two sinks and two mute states.
- **Pre-gain meter.** The tap stays before the volume/mute gain so it keeps its documented "works while muted" behaviour; for the built-in synth it is a signal meter rather than a post-fader output meter. The alternative (post-gain) would make the VU drop with the knob but would hide a muted input, which is exactly what the feedback-safety design wants to show.
- **Context ownership.** `SoftwareSynth` closes only a context it created itself. Without that, the existing `teardown()` on a failed load would close the monitor's context and silently kill monitoring.
- **No auto-unmute.** Unmuting when the synth is picked would also unmute a live microphone monitor, reintroducing the feedback risk R10 guards against; the status hint plus the Quick start step keep the behaviour predictable instead.
- **Deliberately not done.** Per-source mixer levels (separate synth and input faders), a post-fader VU, and remembering the built-in synth as the output across reloads remain out of scope; this ticket only makes the existing strip govern the synth.
