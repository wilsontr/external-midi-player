# T1: Scaffold and device access

- **ID**: T1
- **Milestone**: Scaffold and device access
- **Status**: done
- **Estimate**: 0.5 day
- **Depends on**: none
- **Modules**: `midiDevices.ts`, app scaffold (Vite + TypeScript config, entry point, `ui.ts` header wiring)
- **Requirements**: R4

## Objective

Stand up the static Vite + TypeScript app (no backend, one runtime dependency: `@tonejs/midi`) and prove device access end to end: a "Connect devices" flow that grants the MIDI and microphone permissions and populates a live MIDI output picker. Everything later builds on this, so it comes first.

## Scope

- Vite + TypeScript project scaffold; one screen: a header plus three stacked panels (playback, playlist, audio monitor) as placeholders, at least 360 px wide, keyboard-accessible.
- Header panel: app name, unsupported-browser notice when `navigator.requestMIDIAccess` is missing, and a "Connect devices" button that triggers the MIDI and microphone permission prompts.
- `midiDevices.ts`:
  - Call `navigator.requestMIDIAccess({ sysex: false })` on a user click (required for the Firefox permission flow).
  - Populate the MIDI output picker from `access.outputs`; label each entry with `name` and `manufacturer`.
  - Listen to `access.onstatechange`; if the selected output disconnects, stop playback and show a warning.
  - Remember the last chosen output by `name` in `localStorage` and reselect it if present.
- Firefox onboarding: explain the MIDI site-permission add-on prompt before the user clicks "Connect devices"; show a retry path if it is cancelled.
- Secure-context requirement: app must be served over HTTPS (or `localhost` in development).

## Acceptance criteria

- [x] Dropping a new USB synth into the machine makes it appear in the output picker; unplugging removes it within 1 s (R4).
- [x] The output picker labels show both name and manufacturer.
- [x] Reloading the page reselects the previously chosen output (by name) when still connected.
- [x] In Firefox, the add-on permission prompt is explained before it fires and a retry is offered after cancellation.
- [x] Browsers without `navigator.requestMIDIAccess` show the unsupported-browser notice instead of a broken UI.
- [x] "Connect devices" triggers both the MIDI and microphone permission prompts.
- [x] The layout renders at at least 360 px wide as a single screen and is keyboard-accessible.

## Notes

- Minimum supported browsers: current and previous desktop releases of Chrome/Edge and Firefox.
- Risk: Firefox's MIDI add-on prompt confuses users — mitigation is the pre-click explanation plus retry (see T1 scope).
- Open question: if target files rely on SysEx (GM/GS/XG resets), `requestMIDIAccess` must use `sysex: true`, which strengthens the permission prompt.
