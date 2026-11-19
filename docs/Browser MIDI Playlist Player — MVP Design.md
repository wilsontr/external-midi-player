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

| Capability                           | Chrome / Edge (desktop)                                      | Firefox (desktop)                                                         |
| ------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Web MIDI output                      | Yes; permission prompt on `requestMIDIAccess()`              | Yes (108+); first use triggers a site-permission add-on install prompt    |
| Timestamped `MIDIOutput.send()`      | Yes                                                          | Yes                                                                       |
| Audio input via `getUserMedia`       | Yes                                                          | Yes                                                                       |
| Device names in `enumerateDevices()` | After mic permission is granted                              | After mic permission is granted                                           |
| Choose audio output                  | `AudioContext.setSinkId()` or `HTMLMediaElement.setSinkId()` | `HTMLMediaElement.setSinkId()`; outputs exposed via `selectAudioOutput()` |

Minimum supported versions are the current release and the one before it at launch. The app shows an unsupported-browser notice when `navigator.requestMIDIAccess` is missing.

## Functional requirements

Each requirement below is in scope for the MVP and has an acceptance check.

| ID  | Requirement                                                                  | Acceptance check                                                         |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| R1  | Add .mid/.midi files by file picker or drag-and-drop                         | 10 files dropped at once all appear, in drop order                       |
| R2  | Reorder and remove playlist entries                                          | Drag to reorder; remove button per row                                   |
| R3  | Show each entry's name and duration; reject unreadable files with a message  | A corrupt file shows an error row and is skipped                         |
| R4  | List all MIDI outputs and update the list when devices are plugged in or out | Unplugging a USB synth removes it within 1 s                             |
| R5  | Play the selected entry to the chosen output with no audible timing drift    | A 5-minute file ends within 50 ms of its computed duration               |
| R6  | Play, pause, resume, stop, next, previous                                    | Pause and stop leave no hanging notes                                    |
| R7  | Auto-advance to the next entry; stop at the end of the list                  | Last song ends, transport returns to stopped                             |
| R8  | Panic button                                                                 | Sends all-notes-off and reset-controllers on all 16 channels             |
| R9  | List audio inputs and monitor the chosen one                                 | Input is audible through the chosen output                               |
| R10 | Monitor volume, mute, and a live level meter                                 | Mute is on by default                                                    |
| R11 | Choose the monitoring output device where supported                          | Falls back to the system default with a note                             |
| R12 | Show playback position and elapsed / total time                              | Updates at least 10 times per second                                     |
| R13 | Persist the playlist, current entry, chosen devices and monitor settings     | Reload restores the playlist, highlight, device choices, mute and volume |

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
2. On a fresh start, send the file's tick-0 setup — program/bank changes, controllers, pitch bend and channel pressure, everything that configures a part rather than sounds a note — ahead of `t0`, spread across a 250 ms start lead but never faster than the 1.25 ms serial floor, with the lead's last 100 ms left clear; place `t0` at the end of the lead. MIDI is a serial line (0.96 ms for a 3-byte message at 31.25 kbps), and older modules stall while they load the patches a program change selects, so both the ordering and the breathing room matter: batched with the first chord, the setup makes the opening arrive late, rolled and clipped. A file with no tick-0 setup keeps the 100 ms lead; a setup too large for the lead extends it at the serial floor.
3. Every 25 ms a dedicated Worker timer (with a `setInterval` fallback) sends every event whose time falls before `now + 200 ms` with `output.send(bytes, t0 + eventTime)`.
4. Track which notes are currently on, per channel, so they can be released.
5. When the cursor passes the last event, wait for the scheduled tail to finish, then fire `ended`.

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
  name: string          // file.name without extension (display fallback)
  durationSec?: number  // filled in by a background parse
  metadata?: SongMetadata // Track Name / Text Event / Copyright values (T20)
  status: 'ready' | 'error'
  error?: string
}
```

**Behaviour**

- Files are accepted by extension (.mid, .midi) and by the `MThd` header check during parsing.
- After adding, entries are parsed one at a time in the background to fill in durations; parsed data is then discarded to save memory. The same pass retains the file's `Track Name`, `Text Event` and `Copyright Notice` values and the title resolved from them, because those are small (T20).
- **Display name (T20):** a row, the LCD title, the Instruments caption, the row keys' accessible names and the M3U `#EXTINF` title use the file's usable `Track Name`; the file name without its extension is the fallback. "Usable" means trimmed, non-empty and not `untitled` (case-insensitive). Only the first track's (`Track 1` in the viewer) name may name the song; if it has no usable `Track Name`, later tracks are ignored and the file name is used. The original file name remains the identity for `localStorage`, M3U path lines and file matching.
- **Text encodings (T20):** the three text metas are detected per value as UTF-8 (with or without BOM), ISO-2022-JP, Shift_JIS, EUC-JP or Windows-1252, using the browser's `TextDecoder`; this is what makes the Stanford files' `Text Event`s and Shift_JIS titles readable. Empty values are omitted and retained metadata is capped so a pathological file cannot bloat storage or the DOM.
- **Metadata viewer (T20):** every healthy row has a metadata key that opens a modal LCD dialog listing every retained `Track Name`, `Text Event` and `Copyright Notice` with its track number, in file order. Values are inserted as text only. Close, Escape and a backdrop click dismiss it and return focus to the key; while it is open the global transport shortcuts (including Esc = Panic) are suspended. Opening or closing it never changes playback.
- The current entry is highlighted. A single click selects a row: while stopped the selection is the entry that plays next (highlight, LCD title and Play target), and while playing or paused the selected row carries the dotted outline while the playing row keeps its highlight and title. Starting playback (Play key, double-click, next/previous or auto-advance) selects that row too, so it shows the highlight with the dotted outline on top; a single click on another row moves only the selection. Double-clicking a row, or its Play key, plays that entry from the start.
- Auto-advance moves to the next `ready` entry, skipping `error` entries, with a fixed 1 s gap so external synths finish their release tails.
- Removing the playing entry stops playback. Reordering during playback keeps the current song playing.
- **Load files** replaces the playlist with the files chosen in the picker (after stopping playback); non-MIDI files are rejected and, if nothing valid is selected, the existing playlist is unchanged. **Clear playlist** stops playback, empties the list and persists the empty list. Rows are numbered 1..N from their order, so the numbers follow add, load, remove, reorder and a reload.

**Player state** is one of `stopped`, `playing` or `paused`. Play and resume go to `playing`; pause goes to `paused`; stop, end of list and output disconnect go to `stopped`.

**Persistence**

- The playlist (file bytes, names, durations, metadata, order and the current entry) lives in `localStorage`; the current entry is the "position in the playlist" that is restored. Metadata is optional in the stored shape, so playlists written before T20 restore and are reparsed in the background for it.
- The selected MIDI output is remembered by name (T1). The audio input and output are remembered by device id, falling back to a unique device label when an id has rotated; mute and volume are stored too.
- Playlist writes are debounced; the small audio settings are written immediately. Stored data is versioned, corrupt data is ignored, and storage failures (quota, private mode) leave the session working without persistence.
- On reload the playlist and current entry are shown immediately; the MIDI output is reselected on "Connect devices" and the audio devices after the microphone permission is granted. Playback always returns stopped, never mid-song.
- A store that has never been written starts with the bundled sample `Debussy - Poissons d'or` in the playlist, selected but stopped (T12). The sample is served from the app's own origin under the existing CSP, and the first write persists its bytes, so a reload restores it from `localStorage` instead of refetching it. Once anything has been written — including the empty list left by **Clear playlist** — the store is authoritative and the sample is not re-seeded.

**M3U interchange (post-MVP, T10)**

- **Save playlist** downloads `midi-playlist.m3u8`: UTF-8, `#EXTM3U`, then an `#EXTINF` duration and the file name for every row in order (`-1` for an unknown duration).
- **Load playlist** takes one `.m3u`/`.m3u8` plus, when needed, the `.mid`/`.midi` files it references, in one selection or a drop. References match by `webkitRelativePath` when the browser exposes one, otherwise by case-insensitive base name, and are resolved against the selected files first and the files already in the playlist second — so re-loading a playlist exported in this session needs only the playlist file. Duplicate names are assigned in selection order. The matched files replace the playlist in M3U order through the ordinary Load path, so playback stops and the result is persisted like any other rows.
- A browser keeps no original path for a `File`, so a saved playlist stores names only; loading therefore resolves against files already in the playlist or ones selected with it, and genuinely new files must be selected. Missing references, unsupported entries (URLs and non-MIDI files) and ignored extra selections go to the single status region. `#EXTINF` durations are written from the app's own parse but ignored on import, where the background parse stays authoritative.

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

Expected round trip from input jack to speakers is roughly 10–40 ms on Chrome, depending on OS, driver and buffer size, and somewhat higher on Firefox's `<audio>` path. That is fine for listening to playback, but not for playing along live. The monitor still measures `audioContext.baseLatency + outputLatency` internally; the figure is no longer displayed on the faceplate, and the interface's own direct monitoring remains the low-latency option.

## UI layout

One responsive screen styled as a 90s **half-rack tone module** (T11). Charcoal chassis, amber dot-matrix LCDs, grey rubber keys with LEDs and Helvetica Neue silkscreen labels; the whole faceplate theme is a block of `:root` tokens in `styles.css`, with no image assets. Every control keeps its behaviour, test ID and accessible name. The layout is at least 360 px wide.

Above the rack sits a printed, collapsible **Quick start** label. At 960 px and wider the two rack units then span the full app width, stacked unit 1 above unit 2. Inside unit 1 the strips run **monitor | LCD | keypad**; inside unit 2 the **song list** (≈ 60%) sits beside the **part map** (≈ 40%). Below 960 px each unit's internals stack in DOM order. The DOM order is quick start, unit 1, unit 2, and tab order follows it.

1. **Quick start (printed label above the rack):** a short getting-started list (connect hardware → "Connect devices" → allow MIDI + microphone → choose MIDI output, audio input and output → load files), the keyboard-shortcut line, the unsupported-browser and Firefox onboarding notices, and the visible LCD-font credit line. The header is 18 px and the body 14 px, with 1 em of padding and 1 em under the header. A "Hide/Show quick start" toggle collapses the body; the header and toggle stay visible, and the choice is stored in `localStorage` (`external-midi-player.quickstart-expanded`) and restored on load.
2. **Unit 1 — front panel.**
   - _Monitor strip:_ the volume control as a rotary knob drawn over the existing range input (the input stays focusable, labelled and keyboard-operable), a latching **Mute** rubber key with a red LED, and the stereo input level as two vertical 12-segment LED ladders (green with the top three amber, plus a red clip LED in place of the old CLIP text). The level is exposed through the meter's accessible description rather than a visible numeric readout.
   - _Main amber LCD:_ song number, title, state (`PLAY` / `PAUSE` / `STOP`), elapsed time and length, the segmented seek bar, a static 16-part strip that marks the channels the playing song uses (from the same data as the part map, cleared on stop) and, on its bottom line, the single `aria-live` status region.
   - _Keypad strip:_ MIDI output, audio input and audio output pickers as LCD-styled selects (the audio pair sits directly under the MIDI output, with the Firefox output-grant key and the feedback/output notices); previous, play/pause, next, stop and red-orange Panic rubber keys with silkscreen captions and a green/amber LED on Play; a red/green LED beside the "Connect devices" / "Retry" keys that trigger the MIDI and microphone permission prompts. On load the LCD starts with "Devices not connected", and the LED stays red until MIDI access is granted and an output is present.
   - The app name is the unit's silkscreen brand line.
3. **Unit 2 — expansion unit.**
   - _Song list LCD:_ playlist keys (`+` Add files, Load files, Clear playlist, Save playlist, Load playlist), a dashed "Drop .mid files on this unit" strip (dropping anywhere on unit 2 works), and numbered rows with the display name (the file's Track Name when usable, otherwise its file name), duration right-aligned, an `ERR` badge on rejected rows and Play/metadata/remove row keys (healthy rows carry no status text). The current song is an inverted row; rejected files are dimmed and struck through, with the full error kept in the badge tooltip and the status region. Drag to reorder; the row keys keep their accessible names.
   - _Part map LCD:_ the currently playing file's MIDI channels with the General MIDI instrument in effect at the current playback position (channel 10 shown as drums, bank select when present). The channels are listed from the start; each row updates when the file's program changes play and follows pause and seek. Empty until a song plays, with no per-note activity.
   - _Metadata dialog (T20):_ a modal LCD panel with the display name and original file name, then three sections — Track Name, Text Event, Copyright Notice — listing every retained value as `Track N` plus decoded text, or "None recorded.". The body scrolls, long values and unbroken Japanese strings wrap, and a truncation note appears when the cap applied. It is a native `<dialog>` with `aria-labelledby`, a Close key, Escape and backdrop dismissal, and a CJK font fallback for metadata values.

Power and play state are shown by an LED plus `aria-pressed` or text, never colour alone; focus is a 2 px `--focus` ring on the focused control, and a selected song-list row carries a dashed LCD-ink outline (the playing highlight can sit under it). LCD ink meets 4.5:1 on the LCD background and the unlit-pixel grid is at or below 12 % opacity. Disabled keys are flat and unlit. Under `prefers-reduced-motion` nothing blinks or moves, though the meters still update.

The LCD readouts use the self-hosted **Graph 35+ pix** font (CC BY-SA 3.0, credited in the Quick start label) at multiples of 8 px, with smoothing off and no synthetic bold; every other label uses the `"Helvetica Neue", Helvetica, Arial, sans-serif` stack.

Keyboard shortcuts: Space = play/pause, Esc = Panic, ←/→ = previous/next. Status messages (device lost, file rejected) appear in the single `aria-live` region on the playback LCD.

## Risks and mitigations

The biggest risks are Firefox's audio output routing and stuck notes on external gear; both have fallbacks.

| Risk                                                      | Impact                                                               | Mitigation                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Firefox cannot set the output device on an `AudioContext` | Monitoring goes to the default output, or adds latency via `<audio>` | Use the `<audio>` + `setSinkId` path; default output as last resort                    |
| Firefox's MIDI add-on prompt confuses users               | Users cancel and see no devices                                      | Explain the prompt before clicking "Connect devices"; show a retry                     |
| Notes hang after pause, stop or disconnect                | External synth drones                                                | Track sounding notes; release them, plus CC64 = 0; Panic button                        |
| Scheduled messages cannot be cancelled in Chrome          | Up to 200 ms of notes play after pause                               | Keep look-ahead at 200 ms; release after the last queued event                         |
| Serial MIDI congestion at song start                      | Opening chord arrives late and rolled, then clips early              | Pre-roll and spread tick-0 setup across a 250 ms start lead before `t0` (T13, T14)     |
| Background tabs throttle timers to 1 s                    | Gaps or bursts in playback                                           | Run the scheduler tick in a Worker (implemented in T5); look-ahead covers short stalls |
| Multichannel interfaces expose only 2 channels            | Inputs above 1–2 unreachable                                         | Document it; route the instrument to inputs 1–2 for the MVP                            |
| Monitoring a mic through speakers                         | Feedback howl                                                        | Monitor starts muted; warning when input and output share a device                     |
| Malformed or huge MIDI files                              | Parser throws or UI stalls                                           | Parse in try/catch; mark entry as error; skip on auto-advance                          |
| A virtual MIDI port loops back into the same synth        | Doubled notes                                                        | Out of scope; documented in help text                                                  |

## Testing

Automated tests cover parsing and scheduling logic; device behaviour is checked by hand on real hardware in both browsers.

**Automated (Vitest)**

- Event-list builder: format 0 and 1 fixtures, tempo changes, overlapping notes on one channel.
- Scheduler with a fake clock and a mock `MIDIOutput`: every event sent once, timestamps correct, release messages sent on pause and stop.
- Start pre-roll and start lead: tick-0 setup goes out ahead of `t0`, spread across the lead (never faster than the serial floor, with a clear settle tail) and is not re-sent by the tick loop or on resume, while tick-0 notes stay together at `t0`; a longer configured lead spreads further, a file with no tick-0 setup keeps the 100 ms lead, the last setup timestamp is reported for a following start, and a failed pre-roll send reports and leaves the transport stopped.
- Scheduler seek: old notes released, the MIDI state at the target re-sent (program/bank, controllers, pitch bend, channel pressure), notes before the target not re-struck, paused seeks stay paused, stopped seeks ignored, and the resumed clock anchored after the delivered tail.
- Scheduler timing stress: a dense five-minute event list driven by a jittered tick loop — exact timestamps inside the look-ahead, bounded lateness after a 500 ms stall, no past timestamps and no drift.
- Playlist reducer: add, replace (Load) and clear, remove, reorder, auto-advance skipping error entries, and moving the highlight off a failed current entry.
- Metadata (T20): ASCII/UTF-8/Shift_JIS/EUC-JP/ISO-2022-JP/Windows-1252 fixtures, including `並木学` and `©`; the first-track-only title rule; track indices; the retention cap; the viewer's on-demand, cached and shared parse; metadata persistence and legacy/malformed stored metadata.
- Persistence: playlist and audio settings save/restore, corrupt data ignored, storage failures handled.
- Worker tick timer: start/stop/dispose, pause/resume, and the worker-error fallback; a Playwright assertion that playback creates the Worker.

**Automated (Playwright, Chromium and Firefox)**

- UI flows with mocked `requestMIDIAccess` and `getUserMedia`: add/load/clear files, row numbering, play, pause, next, Panic, device disconnect.
- Reload restores the playlist, current entry and audio settings.
- Seek: click/drag and keyboard seeking while playing and paused (state restoration, no hanging notes) and the disabled-while-stopped policy.
- Track switch: Panic is timestamped before the first note of the new track.
- Metadata (T20): a Shift_JIS title replaces the row/LCD title, `untitled` falls back, the dialog lists all three fields, Esc closes it without Panicking, focus returns to the key, HTML values render literally, the title survives a reload, M3U keeps the file-name path, and the dialog fits at 360 px.

**Manual matrix**

- Browsers: Chrome and Firefox, current release, on Windows and macOS.
- MIDI: one USB-MIDI synth, one DIN interface, one virtual port (IAC on macOS, loopMIDI on Windows).
- Audio: one USB audio interface with the synth's output connected.
- Checks: timing over a 5-minute file, no hanging notes after each transport action, hot-plug of MIDI and audio devices, feedback-safe default.

## Milestones and effort

The MVP is about 4.5 developer-days for one experienced front-end developer, built in this order so each step can be demoed:

1. **Scaffold and device access (0.5 day):** Vite + TypeScript app, permission flow, MIDI output picker with hot-plug.
2. **Parsing and scheduler (1 day):** event-list builder, look-ahead scheduler, note tracking, Panic, unit tests.
3. **Transport and playlist (1 day):** play/pause/stop/next/previous, auto-advance, drag-and-drop, reorder, progress display.
4. **Audio monitoring (1 day):** input and output pickers, graph, meter, mute, Chrome and Firefox output paths, latency readout.
5. **Hardening and deploy (1 day):** Worker timer, error states, baseline CSP, Playwright tests and manual matrix (T5); static deploy over HTTPS via GitHub Pages + Actions (T6).

### After the MVP

- Player and playlist refinements (T8): seek with program/controller restoration, compact add/load/clear, row numbering, responsive two-column layout, startup mute policy and panic before track changes (3–4 days).
- Channel and instrument card (T9): read-only list of the currently playing file's channels and their General MIDI instruments, with no playback feedback (1 day).
- Save and load the playlist as an M3U/M3U8 file (T10): export the current order and names, and rebuild the playlist from a playlist file plus the MIDI files it references; the browser cannot read original paths, so the bytes still come from the user's selection (0.5–1 day).
- Half-rack faceplate skin (T11): restyle the player as a 90s half-rack tone module with amber dot-matrix LCDs, rubber keys with LEDs and Helvetica Neue panel labels, grouping the panels into a front-panel unit (monitor, transport, status) and an expansion unit (song list, part map, audio routing); presentation only (2–3 days).
- First-run sample song (T12): ship one small General MIDI file and seed the playlist with it only when the playlist store has never been written, so a new visitor can press Play before choosing files; no autoplay, no new dependency (0.25–0.5 day).
- Start-of-song setup pre-roll (T13): send tick-0 program/controller state ahead of the song clock at MIDI wire speed so a front-loaded 16-part setup cannot make the opening chord arrive late, rolled and clipped on a serial DIN port; files without tick-0 setup keep the 100 ms lead (0.5 day).
- Start lead for older modules (T14): spread that tick-0 setup across a 250 ms lead with a clear 100 ms tail, so a 1990s module that stalls while loading a bank of patches has finished before the first note; the lead is a scheduler option so it can become a per-output control if some hardware needs more (0.5 day).
- Playlist marker standard (T18): dotted outline = selected, inverted row = playing, both on the same row when it is both; focus stays on the focused control rather than drawing a selection-looking row outline (0.25 day).
- Slim playlist rows (T17): drop the per-row up/down keys and the "Ready" text for a wider name, showing `ERR` only on rejected files; reordering stays drag-only (0.25 day).
- Live instruments card (T16): the part-map rows show the program in effect at the current playback position instead of the file's whole program history, updating as program changes play and following pause/seek (0.5 day).
- Faceplate refinements (T15): single-click selection vs double-click playback, clear the Panic notice when a song starts, move the audio pickers onto the front unit, delete the audio-routing card and the browser-latency line, widen the keypad gap to fit Panic, and move the shortcut hints into Quick start (0.5 day).
- DAW-style volume knob (T19): the monitor knob takes a relative vertical drag (up increases, down decreases, Shift for fine steps) from the value at the press, so pressing it no longer jumps the level; the range input keeps the keyboard, the accessible name and the focus ring (0.5 day).
- Upgrade playlist persistence from `localStorage` to IndexedDB for very large playlists (0.5 day).
- Tempo change, A–B looping, per-channel mute and remapping (2–4 days).
- Record the monitored input to WAV (1 day).
- Built-in SoundFont synth (T7): SpessaSynth behind the normal output picker, so a playlist plays audibly with no MIDI hardware. The scheduler is unchanged — its future-timestamped `MIDIOutput.send()` calls are translated onto the `AudioContext` clock and applied by the synth's processor at the right render quantum, so no JS timer is involved. The engine and the bundled GeneralUser GS SF3 (~8.4 MB, Licence v2.0) load only when the output is picked, and the production CSP allows `'wasm-unsafe-eval'` for the SF3 decoder (Apache-2.0 engine dependencies).
- Installable offline app (0.5 day).

### Open questions

- [ ] Is live play-along a goal? If so, monitoring latency rules out browser monitoring and the doc should recommend hardware direct monitoring.
- [ ] Do any target MIDI files rely on SysEx (for example GM/GS/XG resets)? That would require `sysex: true` and a stronger permission prompt. (Yes: the T13 reproducer opens with a Roland GS Reset, which the app drops — a patch-mode difference, separate from the timing fix.)
- [ ] Should playback send a GM reset or program changes before each song so external synths start from a known state?
- [ ] Which audio interfaces must be supported, and do any need inputs above channels 1–2?
