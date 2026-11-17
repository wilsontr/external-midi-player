# T4: Audio monitoring

- **ID**: T4
- **Milestone**: Audio monitoring
- **Status**: done
- **Estimate**: 1 day
- **Depends on**: T1
- **Modules**: `audioMonitor.ts`, `ui.ts` (audio monitor panel)
- **Requirements**: R9, R10, R11, R13

## Objective

Capture a chosen audio input, route it through a Web Audio graph to the chosen output with volume/mute/metering, and make it work in both Chrome and Firefox. This is the "listening" path, independent of the MIDI path.

## Scope

- `audioMonitor.ts`:
  - Capture with `getUserMedia`, constrained so instrument audio passes through unaltered (echoCancellation, noiseSuppression, autoGainControl all off; `channelCount` ideal 2; `sampleRate` ideal 48000).
  - Call `getUserMedia({ audio: true })` once on the first click to unlock device labels, then list `audioinput` devices from `enumerateDevices()`.
  - Listen to `mediaDevices.ondevicechange` and refresh both pickers; on input change, stop the old tracks before opening the new one.
  - Graph: `MediaStreamAudioSourceNode` → `GainNode` (volume and mute) → output, with a parallel `ChannelSplitterNode` → one `AnalyserNode` per channel for the stereo meter (pre-gain, so the meter reads while monitoring is muted).
  - Create the `AudioContext` with `latencyHint: 'interactive'`; resume it from a user click.
  - Meter reads peak level from the analyser on `requestAnimationFrame`, shown in dBFS with a clip indicator above −1 dBFS.
  - Monitoring starts muted (avoids feedback when the input is a mic near speakers); warn when input and output share a device.
- Output device routing:
  - Chrome: `audioContext.setSinkId(outputId)` (lowest-latency path).
  - Firefox: graph ends in a `MediaStreamAudioDestinationNode` played by a hidden `<audio>` element, and `audio.setSinkId(outputId)` picks the device after the user grants it with `selectAudioOutput()`. The picker lists only granted outputs there; enumerated-but-ungranted devices would reject `setSinkId`.
  - If neither is available, audio goes to the system default output and the picker is hidden.
- Latency readout: show `audioContext.baseLatency + outputLatency` so users see the browser's share.
- Persistence: remember the input and output devices (by id, falling back to a unique label), mute and volume in `localStorage`; restore them after `unlock()` when the mic permission makes device names available.
- `ui.ts` — audio monitor panel: input picker, output picker (or "System default"), mute toggle (on by default), volume slider, stereo level meter, latency readout.

## Acceptance criteria

- [x] The chosen input is audible through the chosen output (R9).
- [x] Mute is on by default; volume and a live level meter work (R10).
- [x] Monitoring output device is selectable where supported; otherwise it falls back to the system default with a note (R11).
- [x] Device names appear in the pickers after mic permission is granted.
- [x] Unplugging / re-plugging an audio device refreshes both pickers via `ondevicechange`.
- [x] Meter shows dBFS peak with a clip indicator above −1 dBFS.
- [x] Latency readout shows `baseLatency + outputLatency`.
- [x] Monitoring starts muted; a warning appears when input and output share a device.
- [x] The audio input, output, mute and volume are restored after a reload (R13).

## Notes

- Expected round trip is ~10–40 ms on Chrome (higher on Firefox's `<audio>` path) — fine for listening, not for playing along live. The interface's own direct monitoring remains the low-latency option.
- Risk: Firefox cannot set the output on an `AudioContext` — use the `<audio>` + `setSinkId` path, default output as last resort.
- Multichannel interfaces may expose only 2 channels; route the instrument to inputs 1–2 for the MVP.
- Device ids can rotate between sessions, so a saved selection falls back to a unique device label; a saved output that is no longer selectable (e.g. not re-granted in Firefox) is skipped and the system default is used.
- Open questions: is live play-along a goal (rules out browser monitoring)? Which audio interfaces must be supported, and do any need inputs above channels 1–2?
