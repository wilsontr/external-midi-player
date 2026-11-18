# Browser MIDI Playlist Player — MVP Design

Nov 16, 2026 · @Trevor Wilson

## Overview and goals

The MVP is a static, single-page web app that plays a playlist of Standard MIDI Files (.mid) to any MIDI output the OS exposes, and monitors an external audio input through the computer's speakers. It targets desktop Chrome and Firefox, needs no backend, and is estimated at 4–5 developer-days.

The intended setup: the browser drives an external synth or sound module over USB/DIN MIDI, and that instrument's audio comes back into an audio interface so it can be heard (and later recorded) on the computer.

**MVP goals**

- Load several .mid files by file picker or drag-and-drop into an ordered playlist.
- Pick a MIDI output (hardware or virtual port) and play the playlist to it with tight timing.
- Play, pause, stop, next, previous, and a Panic button that silences stuck notes.
- Pick an audio input device and monitor it locally with a volume control, mute and level meter.
- Pick the audio output device for monitoring where the browser allows it.
- Remember the playlist, the current entry, the chosen devices and the monitor settings between visits.

**Non-goals for the MVP**

- Safari and mobile browsers (no Web MIDI support in Safari).
- A built-in software synth; playback always goes to a MIDI port.
- Seeking within a song (added post-MVP in T8), tempo change, looping, or channel remapping.
- Recording the monitored audio.
- MIDI input, SysEx, or editing MIDI files.

## Target platforms

Both browsers support every API the MVP needs, but they differ in how permission is granted and how audio output is chosen. The app must be served over HTTPS (or `localhost` in development), since Web MIDI and `getUserMedia` only work in a secure context.

| Capability | Chrome / Edge (desktop) | Firefox (desktop) |
| --- | --- | --- |
| Web MIDI output | Yes; permission prompt on `requestMIDIAccess()` | Yes (108+); first use triggers a site-permission add-on install prompt |
| Timestamped `MIDIOutput.send()` | Yes | Yes |
| Audio input via `getUserMedia` | Yes | Yes |
| Device names in `enumerateDevices()` | After mic permission is granted | After mic permission is granted |
| Choose audio output | `AudioContext.setSinkId()` or `HTMLMediaElement.setSinkId()` | `HTMLMediaElement.setSinkId()`; outputs exposed via `selectAudioOutput()` |

Minimum supported versions are the current release and the one before it at launch. The app shows an unsupported-browser notice when `navigator.requestMIDIAccess` is missing.

## Functional requirements

Each requirement below is in scope for the MVP and has an acceptance check.

| ID | Requirement | Acceptance check |
| --- | --- | --- |
| R1 | Add .mid/.midi files by file picker or drag-and-drop | 10 files dropped at once all appear, in drop order |
| R2 | Reorder and remove playlist entries | Drag to reorder; remove button per row |
| R3 | Show each entry's name and duration; reject unreadable files with a message | A corrupt file shows an error row and is skipped |
| R4 | List all MIDI outputs and update the list when devices are plugged in or out | Unplugging a USB synth removes it within 1 s |
| R5 | Play the selected entry to the chosen output with no audible timing drift | A 5-minute file ends within 50 ms of its computed duration |
| R6 | Play, pause, resume, stop, next, previous | Pause and stop leave no hanging notes |
| R7 | Auto-advance to the next entry; stop at the end of the list | Last song ends, transport returns to stopped |
| R8 | Panic button | Sends all-notes-off and reset-controllers on all 16 channels |
| R9 | List audio inputs and monitor the chosen one | Input is audible through the chosen output |
| R10 | Monitor volume, mute, and a live level meter | Mute is on by default |
| R11 | Choose the monitoring output device where supported | Falls back to the system default with a note |
| R12 | Show playback position and elapsed / total time | Updates at least 10 times per second |
| R13 | Persist the playlist, current entry, chosen devices and monitor settings | Reload restores the playlist, highlight, device choices, mute and volume |

## Architecture

The app has two independent paths: a MIDI path that drives external gear, and an audio path that only listens to what the interface delivers. It is a static Vite + TypeScript build with no backend and two runtime dependencies: `@tonejs/midi` and `midi-file` (the low-level parser `@tonejs/midi` itself wraps, used directly for per-event channel fidelity and linear-time parsing).

&#91;embedded content: architecture · MIDI path out, audio path back in\]

Modules map one-to-one to the boxes: `playlist.ts`, `parser.ts`, `scheduler.ts` and `midiDevices.ts` on the MIDI path; `audioMonitor.ts` on the audio path; a thin `ui.ts` wires both to the controls.

## MIDI output

Timing accuracy comes from handing every message to the browser with a future timestamp, not from JavaScript timers. A look-ahead scheduler converts the file into absolute-time events once, then queues the next \~200 ms of them on each tick.

### Device access

- Call `navigator.requestMIDIAccess({ sysex: false })` on a user click (needed for the Firefox permission flow).
- Populate the output picker from `access.outputs`; label each with `name` and `manufacturer`.
- Listen to `access.onstatechange`. If the selected output disconnects, stop playback and show a warning.
- Remember the last chosen output by `name` in `localStorage` and reselect it if present.

### File parsing

- Parse with `parseMidi` from `midi-file` (the parser `@tonejs/midi` wraps). It handles format 0 and 1 files, running status and the tempo map, and yields note and controller events with times in seconds, keeping each event's channel. The high-level `@tonejs/midi` `Midi`/`Track` API is not used: it collapses a track to a single channel, drops channel pressure and program-change history, and pairs notes in O(n²), which stalls on large files.
- Build one flat, time-sorted event list per song: note-on, note-off, control change, program change, pitch bend and channel pressure. Meta events other than tempo are dropped.
- Keep the original channel numbers. Song duration = time of the last event.
- Parse each added file once in the background, one at a time, to fill in its duration; the parsed events are then discarded so a large playlist stays small in memory.
- Parse again when a song is about to play, and cache the last parsed song so replaying the same file skips the parse.

### Scheduler

1. On play, record `t0 = performance.now() + 100` (ms) minus the resume offset.
2. Every 25 ms a dedicated Worker timer (with a `setInterval` fallback) sends every event whose time falls before `now + 200 ms` with `output.send(bytes, t0 + eventTime)`.
3. Track which notes are currently on, per channel, so they can be released.
4. When the cursor passes the last event, wait for the scheduled tail to finish, then fire `ended`.

### Transport

- **Pause:** stop the scheduler, record the offset, send note-off for every sounding note, and send CC64 = 0 (sustain off). Resume restarts from the offset; notes held across the pause are not re-struck.
- **Stop / next / previous:** same release, offset reset to 0.
- Messages already handed to the browser cannot be cancelled in Chrome (`output.clear()` is not implemented), so the 200 ms look-ahead bounds the overhang. The release messages are sent with a timestamp just after the last queued event.
- **Panic:** for channels 1–16, send CC123 (all notes off), CC120 (all sound off), CC121 (reset controllers) and CC64 = 0.
- **Seek (post-MVP, T8):** click/drag or keyboard (arrows, Page, Home, End); the seek commits on release and only while playing or paused (a stopped song always restarts at 0). A playing seek releases sounding notes, re-sends the MIDI state at the target (program and bank changes, controllers, pitch bend, channel pressure) just after the look-ahead tail, then re-anchors the clock so playback continues from the target; notes that began before the target are not re-struck.
- **Track switch:** switching to a different entry while playing or paused sends Panic (R8) just after the old queue's tail and starts the new track only after the panic, so the old tail cannot cut off the new notes.

## Playlist

The playlist is an ordered list of `File` objects, kept in memory while the app runs and mirrored to `localStorage` so a reload restores it. Nothing is uploaded.

**Entry model**

```
PlaylistEntry {
  id: string            // crypto.randomUUID()
  file: File
  name: string          // file.name without extension
  durationSec?: number  // filled in by a background parse
  status: 'ready' | 'error'
  error?: string
}
```

**Behaviour**

- Files are accepted by extension (.mid, .midi) and by the `MThd` header check during parsing.
- After adding, entries are parsed one at a time in the background to fill in durations; parsed data is then discarded to save memory.
- The current entry is highlighted. Clicking a row (or its Play button) plays that entry from the start.
- Auto-advance moves to the next `ready` entry, skipping `error` entries, with a fixed 1 s gap so external synths finish their release tails.
- Removing the playing entry stops playback. Reordering during playback keeps the current song playing.
- **Load files** replaces the playlist with the files chosen in the picker (after stopping playback); non-MIDI files are rejected and, if nothing valid is selected, the existing playlist is unchanged. **Clear playlist** stops playback, empties the list and persists the empty list. Rows are numbered 1..N from their order, so the numbers follow add, load, remove, reorder and a reload.

**Player state** is one of `stopped`, `playing` or `paused`. Play and resume go to `playing`; pause goes to `paused`; stop, end of list and output disconnect go to `stopped`.

**Persistence**

- The playlist (file bytes, names, durations, order and the current entry) lives in `localStorage`; the current entry is the "position in the playlist" that is restored.
- The selected MIDI output is remembered by name (T1). The audio input and output are remembered by device id, falling back to a unique device label when an id has rotated; mute and volume are stored too.
- Playlist writes are debounced; the small audio settings are written immediately. Stored data is versioned, corrupt data is ignored, and storage failures (quota, private mode) leave the session working without persistence.
- On reload the playlist and current entry are shown immediately; the MIDI output is reselected on "Connect devices" and the audio devices after the microphone permission is granted. Playback always returns stopped, never mid-song.

## Audio input routing

The chosen input is captured with `getUserMedia`, passed through a gain stage and a meter in a Web Audio graph, and played to the chosen output. Browser voice processing is switched off so instrument audio passes through unaltered.

### Capture

```
navigator.mediaDevices.getUserMedia({ audio: {
  deviceId: { exact: inputId },
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: { ideal: 2 },
  sampleRate: { ideal: 48000 }
}})
```

- Call `getUserMedia` once with `{ audio: true }` on the first click to unlock device labels, then list `audioinput` devices from `enumerateDevices()`.
- Listen to `mediaDevices.ondevicechange` and refresh both pickers.
- On input change, stop the old tracks before opening the new one.

### Graph

`MediaStreamAudioSourceNode` → `GainNode` (volume and mute) → output. The meter taps the source in parallel, through a `ChannelSplitterNode` and one `AnalyserNode` per channel, so both peak levels can be read separately and the meter keeps working while monitoring is muted (which is how it starts).

- Create the `AudioContext` with `latencyHint: 'interactive'` and resume it from a user click.
- The meter reads peak level from the analysers on `requestAnimationFrame`, draws stereo bars, and exposes the level in dBFS through the meter's accessible description; a clip indicator lights above −1 dBFS.
- Monitoring starts muted on a fresh profile (no stored settings), which avoids a feedback loop when the input is a microphone near speakers (R10). Later visits restore the saved mute and volume instead of forcing mute. That startup policy is intentional (T8).

### Output device

- **Chrome:** `audioContext.setSinkId(outputId)` routes the graph directly. This is the lowest-latency path.
- **Firefox:** `AudioContext.setSinkId` is not available. The graph ends in a `MediaStreamAudioDestinationNode` played by a hidden `<audio>` element, and `audio.setSinkId(outputId)` picks the device after the user grants it with `selectAudioOutput()`. This path adds some buffering.
- If neither is available, audio goes to the system default output and the picker is hidden.

### Latency

Expected round trip from input jack to speakers is roughly 10–40 ms on Chrome, depending on OS, driver and buffer size, and somewhat higher on Firefox's `<audio>` path. That is fine for listening to playback, but not for playing along live. The UI shows `audioContext.baseLatency + outputLatency` so users can see the browser's share; the interface's own direct monitoring remains the low-latency option.

## UI layout

One responsive screen, keyboard-accessible, at least 360 px wide. Panels stack in one column below 960 px; at 960 px and wider it is two columns with the header and audio monitor on the left and playback and playlist on the right (T8). The DOM order stays row-major, so tab order is sensible in both layouts.

1. **Header:** app name, a short getting-started list (connect hardware → "Connect devices" → allow MIDI + microphone → choose MIDI output, audio input and output → load files), browser-support warning when needed, and a "Connect devices" button that triggers the MIDI and microphone permission prompts.
2. **Playback panel:** MIDI output picker; transport buttons (previous, play/pause, stop, next); Panic; seekable timeline with elapsed and total time; the current song title.
3. **Audio monitor panel:** input picker, output picker (or "System default"), mute toggle (on by default on a fresh profile), volume slider, stereo level meter (bars plus CLIP; the level is exposed through the meter's accessible description rather than a visible numeric readout), and the latency readout.
4. **Playlist panel:** drop zone with a compact "+" (Add files) button, Load files and Clear playlist; numbered, clickable rows with name, duration, status and a remove button; drag handles to reorder.

Keyboard shortcuts: Space = play/pause, Esc = Panic, ←/→ = previous/next. Status messages (device lost, file rejected) appear in a single `aria-live` region.

## Risks and mitigations

The biggest risks are Firefox's audio output routing and stuck notes on external gear; both have fallbacks.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Firefox cannot set the output device on an `AudioContext` | Monitoring goes to the default output, or adds latency via `<audio>` | Use the `<audio>` + `setSinkId` path; default output as last resort |
| Firefox's MIDI add-on prompt confuses users | Users cancel and see no devices | Explain the prompt before clicking "Connect devices"; show a retry |
| Notes hang after pause, stop or disconnect | External synth drones | Track sounding notes; release them, plus CC64 = 0; Panic button |
| Scheduled messages cannot be cancelled in Chrome | Up to 200 ms of notes play after pause | Keep look-ahead at 200 ms; release after the last queued event |
| Background tabs throttle timers to 1 s | Gaps or bursts in playback | Run the scheduler tick in a Worker (implemented in T5); look-ahead covers short stalls |
| Multichannel interfaces expose only 2 channels | Inputs above 1–2 unreachable | Document it; route the instrument to inputs 1–2 for the MVP |
| Monitoring a mic through speakers | Feedback howl | Monitor starts muted; warning when input and output share a device |
| Malformed or huge MIDI files | Parser throws or UI stalls | Parse in try/catch; mark entry as error; skip on auto-advance |
| A virtual MIDI port loops back into the same synth | Doubled notes | Out of scope; documented in help text |

## Testing

Automated tests cover parsing and scheduling logic; device behaviour is checked by hand on real hardware in both browsers.

**Automated (Vitest)**

- Event-list builder: format 0 and 1 fixtures, tempo changes, overlapping notes on one channel.
- Scheduler with a fake clock and a mock `MIDIOutput`: every event sent once, timestamps correct, release messages sent on pause and stop.
- Scheduler seek: old notes released, the MIDI state at the target re-sent (program/bank, controllers, pitch bend, channel pressure), notes before the target not re-struck, paused seeks stay paused, stopped seeks ignored, and the resumed clock anchored after the delivered tail.
- Scheduler timing stress: a dense five-minute event list driven by a jittered tick loop — exact timestamps inside the look-ahead, bounded lateness after a 500 ms stall, no past timestamps and no drift.
- Playlist reducer: add, replace (Load) and clear, remove, reorder, auto-advance skipping error entries, and moving the highlight off a failed current entry.
- Persistence: playlist and audio settings save/restore, corrupt data ignored, storage failures handled.
- Worker tick timer: start/stop/dispose, pause/resume, and the worker-error fallback; a Playwright assertion that playback creates the Worker.

**Automated (Playwright, Chromium and Firefox)**

- UI flows with mocked `requestMIDIAccess` and `getUserMedia`: add/load/clear files, row numbering, play, pause, next, Panic, device disconnect.
- Reload restores the playlist, current entry and audio settings.
- Seek: click/drag and keyboard seeking while playing and paused (state restoration, no hanging notes) and the disabled-while-stopped policy.
- Track switch: Panic is timestamped before the first note of the new track.

**Manual matrix**

- Browsers: Chrome and Firefox, current release, on Windows and macOS.
- MIDI: one USB-MIDI synth, one DIN interface, one virtual port (IAC on macOS, loopMIDI on Windows).
- Audio: one USB audio interface with the synth's output connected.
- Checks: timing over a 5-minute file, no hanging notes after each transport action, hot-plug of MIDI and audio devices, monitoring latency readout, feedback-safe default.

## Milestones and effort

The MVP is about 4.5 developer-days for one experienced front-end developer, built in this order so each step can be demoed:

1. **Scaffold and device access (0.5 day):** Vite + TypeScript app, permission flow, MIDI output picker with hot-plug.
2. **Parsing and scheduler (1 day):** event-list builder, look-ahead scheduler, note tracking, Panic, unit tests.
3. **Transport and playlist (1 day):** play/pause/stop/next/previous, auto-advance, drag-and-drop, reorder, progress display.
4. **Audio monitoring (1 day):** input and output pickers, graph, meter, mute, Chrome and Firefox output paths, latency readout.
5. **Hardening and deploy (1 day):** Worker timer, error states, baseline CSP, Playwright tests and manual matrix (T5); static deploy over HTTPS via GitHub Pages + Actions (T6).

### After the MVP

- Player and playlist refinements (T8): seek with program/controller restoration, compact add/load/clear, row numbering, responsive two-column layout, startup mute policy and panic before track changes (3–4 days).
- Upgrade playlist persistence from `localStorage` to IndexedDB for very large playlists (0.5 day).
- Tempo change, A–B looping, per-channel mute and remapping (2–4 days).
- Record the monitored input to WAV (1 day).
- A built-in SoundFont synth as an alternative output (2–3 days; tracked as T7, with the engine decision as its first step).
- Installable offline app (0.5 day).

### Open questions

- [ ] Is live play-along a goal? If so, monitoring latency rules out browser monitoring and the doc should recommend hardware direct monitoring.
- [ ] Do any target MIDI files rely on SysEx (for example GM/GS/XG resets)? That would require `sysex: true` and a stronger permission prompt.
- [ ] Should playback send a GM reset or program changes before each song so external synths start from a known state?
- [ ] Which audio interfaces must be supported, and do any need inputs above channels 1–2?
