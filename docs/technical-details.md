# Technical details

## Storage is per origin

Playlist bytes, the current entry, device names, mute and volume are in
`localStorage`, which is scoped to the origin. The Pages origin starts with an
empty playlist and no remembered devices even if you have been using
`localhost`; connect devices again there. Clearing the playlist on the Pages
origin stays cleared, exactly as locally.

## Structure

| File                        | Responsibility                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/midiDevices.ts`        | Web MIDI access, output listing, hot-plug, remembering the selected output by name                                                                               |
| `src/parser.ts`             | Parse `.mid` files into flat, time-sorted event lists (tempo map, channels preserved); instrument summary and live channel-activity tracker                      |
| `src/scheduler.ts`          | Look-ahead scheduler with future-timestamped `MIDIOutput.send()`, note tracking and Panic                                                                        |
| `src/synthOutput.ts`        | Built-in SpessaSynth output: the bundled GeneralUser GS bank, and a `MIDIOutput` that renders the scheduler's timestamped messages at audio time; renders into the monitor bus (T24)  |
| `src/playlist.ts`           | Playlist entries, load/clear, transport state, background duration parse, auto-advance, seek forwarding, Panic-before-track-switch                               |
| `src/audioMonitor.ts`       | The shared monitor bus (context, gain/mute, stereo meter tap with an accessible dBFS description, output routing) for captured input and the built-in synth; capture and latency |
| `src/ui.ts`                 | Half-rack faceplate markup (two units), knob/LED/part-strip wiring, Connect devices flow (MIDI + mic prompts), seekable timeline, single aria-live status region |
| `src/styles.css`            | Faceplate skin: `:root` design tokens, chassis and LCD textures, responsive rack layout                                                                          |
| `src/main.ts`               | Entry point                                                                                                                                                      |
| `public/fonts/`             | Self-hosted Graph 35+ pix LCD font (CC BY-SA 3.0) with its licence and attribution                                                                               |
| `src/assets/`               | Bundled assets fetched at runtime: the first-run sample song (CC BY-NC-SA 4.0) and the built-in synth's GeneralUser GS SoundFont                                 |
| `legacy/t11-pre-faceplate/` | Pre-T11 UI files, kept for a possible swap back                                                                                                                  |

## Behaviour notes

- **Startup mute policy (T8, intentional):** a fresh profile starts with
  monitoring muted (R10 feedback safety), which since T24 also keeps the
  built-in synth silent until Mute is turned off; later visits restore the
  saved mute/volume instead of forcing mute.
- **Monitor bus (T24):** `AudioMonitor` owns the single `AudioContext`, the
  volume/mute gain and one permanent pre-gain meter tap. The captured input and
  the built-in synth both feed that bus, so the monitor knob, Mute, the VU
  ladders and the chosen output device govern both. The synth does not create
  or close the context; a failed load tears down only the engine. The VU is a
  signal meter (tap before the gain), so it keeps reading while muted, as it
  already did for the input. Selecting the built-in synth while muted reports
  it in the status line; it does not auto-unmute, because unmuting would also
  unmute a live microphone monitor.
- **Track metadata (T20):** the song list, LCD title, Instruments caption,
  row-key names and the M3U `#EXTINF` title use the file's `Track Name` when it
  has a usable one (trimmed, non-empty, not `untitled`); otherwise they keep
  the file name without its extension. Only the first track's (`Track 1` in
  the viewer) name may name the song; if it has no usable `Track Name`, every
  later track is ignored and the file name is used. The main LCD title is
  clamped to two lines with an ellipsis, so a long title cannot push the seek
  bar down. The `Track Name`, `Text Event` and `Copyright Notice` values are
  decoded per value as UTF-8, ISO-2022-JP, Shift_JIS, EUC-JP or Windows-1252,
  so Stanford-style Text Events and Japanese titles read correctly. Every healthy
  row's info key opens an amber LCD dialog listing all three fields with their
  track numbers; Close, Esc or a backdrop click dismisses it and returns focus
  to the key. While it is open the transport shortcuts — including Esc = Panic
  — are suspended. Metadata is persisted with the playlist and old stored rows
  are reparsed for it in the background; the original file name stays the M3U
  path and storage identity.
- **Instruments card (T16):** the card lists the channels the playing file
  uses and shows the program in effect at the current playback position, so a
  mid-song program change updates its row; pausing or seeking shows the
  program at that position. The channels themselves are listed from the start.
- **Part strip activity (T21):** in the main LCD's 16-part strip an outlined
  cell is a channel the playing song uses, and a filled cell is a channel with
  a note sounding now (held, held by the sustain pedal, or struck within the
  last 120 ms so short drum hits show). It reads the playback parse at the
  playhead, not the MIDI wire. Pause, stop, end of song, output loss and a
  track switch clear it; after a resume or seek, notes that began earlier stay
  dark (they are not re-struck) and only later note-ons light.
- **Playlist selection (T15, T18):** a single click selects a row and a
  double click (or the row's Play key) plays it from the start. Selection is
  a dotted outline, playing is the inverted highlight, and a row that is both
  shows both. While stopped the selection is the song Play will start; while
  playing or paused a single click moves only the selection, never what is
  sounding.
- **Seeking (T8):** the timeline is live while playing or paused and commits on
  release. While playing, sounding notes are released and the MIDI state at the
  target (program/bank, controllers, pitch bend, channel pressure) is re-sent
  after the look-ahead tail before playback continues from the target. A
  stopped song always restarts from 0, so seeking is disabled while stopped.
- **Track switches (T8):** switching to a different entry while playing or
  paused sends the full Panic (CC123/120/121 and CC64 = 0 on all 16 channels)
  after the old queue's tail, and the new track starts after the panic.
- **Volume knob (T19):** the monitor knob is a relative vertical drag — up
  increases, down decreases, measured from the value at the press, so pressing
  the knob never jumps the level to the pointer. About 120 px covers the whole
  0–100 range, the value clamps at both ends, and Shift trims at a quarter
  speed for fine setting. Dragging outside the knob keeps tracking (pointer
  capture) and no longer selects text or scrolls the page. The
  `#monitor-volume` range input remains the control and the single source of
  truth: clicking the knob focuses it, the arrow/Home/End keys and the focus
  ring still work, and only its native pointer behaviour is replaced.
- **First run (T12):** a browser profile whose playlist store has never been
  written starts with the bundled `Debussy - Poissons d'or` as the current,
  stopped entry, so Play works before any files are chosen. It arrives through
  the ordinary add/persist path (numbering, duration, reorder/remove, M3U
  export and reload all behave normally) and never autoplays. The first stored
  write makes the store authoritative, so Clear playlist — or removing the row
  — survives a reload instead of resurrecting the sample; files added while it
  is still downloading win, and a missing asset reports one status line and
  leaves the player empty but usable.
- **Info key and panel (T22):** the **Info** key right of Connect devices
  opens the metadata viewer for the playing or paused song (it does nothing
  when stopped). The panel above the rack is headed **Info**, credits the
  player and the LCD font, and links to the GitHub repository. The LCD status
  line is a single line; a long message ellipsizes and its full text is in the
  line's tooltip.
- **Built-in synth (T7):** the MIDI output picker also offers **SpessaSynth
  (built-in)**, which plays through SpessaSynth inside the page and needs no
  hardware or permission — it is selectable before Connect devices is pressed.
  Picking it loads the engine and the bundled GeneralUser GS SoundFont (about
  8.4 MB, fetched once) and only then selects it, so Play can never start
  against a half-loaded instrument; the status line reports loading and
  failure. It is an ordinary output otherwise: the same scheduler, pause, stop,
  next/previous, seek and Panic, and only one output (synth or hardware) is
  selected at a time: Connect devices reselecting your remembered hardware
  hands playback back to it, so the picker always shows what is playing. The
  bank is not remembered across reloads. Its audio goes through the monitor bus
  (T24), so the Audio monitor strip's volume, Mute, VU and output device apply
  to it; with the fresh-profile mute still on it is silent, and the status line
  says so when it is selected.
- **Song start (T13, T14):** a fresh start sends the file's tick-0 setup
  (program and bank changes, controllers, pitch bend, channel pressure)
  before the clock starts, spread across a 250 ms start lead but never faster
  than one message per 1.25 ms, with the last 100 ms of the lead left clear.
  That keeps a front-loaded multi-part setup from crowding the first chord
  off a serial MIDI line, and gives an older module time to load the patches
  the program changes selected before the first note. The song's clock starts
  at the end of the lead, which moves the first note from ~100 ms to ~350 ms
  after Play for a file with tick-0 setup; files without one keep the 100 ms
  lead, and tick-0 notes are not spread.

## Browser support

Current and previous desktop releases of Chrome/Edge and Firefox. Browsers
without `navigator.requestMIDIAccess` show an unsupported-browser notice.
Firefox users are shown the site-permission (add-on) explanation before the
first connect.

## UI skin notes (T11)

- The faceplate is a single committed dark theme. Every colour is a `:root`
  token in `src/styles.css`; there are no image assets. If a light skin is
  wanted later, swap the token block.
- The volume knob's rotation is pure CSS, driven by `--turn` from the range
  input. The input stays the accessible control but is pointer-inert (T19), so
  `.knob-wrap` handles the drag gesture in `ui.ts` instead.
- The LCD font is served from `public/` (same-origin), so the production CSP
  allows it; `font-src 'self'` is declared explicitly in `vite.config.ts`.
- `legacy/t11-pre-faceplate/` holds the pre-T11 `ui.ts` and `styles.css` for a
  possible swap back; nothing imports them.
