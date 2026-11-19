/**
 * Single-screen UI, styled as a 90s half-rack tone module: a front unit (audio
 * monitor strip, amber playback LCD, transport keypad) and an expansion unit
 * (song-list LCD, part map), with the printed Quick start label
 * between them. Both units span the app width and their internals stack below
 * the wide breakpoint. All user-visible status is written to the one aria-live
 * region on the playback LCD's bottom line. The layout is a plain DOM build
 * with native controls, so it is keyboard-accessible by construction.
 * See the design doc, "UI layout" and "MIDI output > Device access".
 */

import { AudioMonitor, CLIP_THRESHOLD_DB, DB_FLOOR } from "./audioMonitor";
import { MidiDevices } from "./midiDevices";
import {
  SoftwareSynth,
  SYNTH_OUTPUT_ID,
  SYNTH_OUTPUT_NAME,
} from "./synthOutput";
// The first-run sample (T12). `?url` keeps the emitted URL base-aware and
// content-hashed, so it works from a GitHub Pages subpath (T6).
import sampleSongUrl from "./assets/debussy-poissons-dor.mid?url";
import {
  M3U_MAX_BYTES,
  PlaylistPlayer,
  buildM3u,
  entryDisplayName,
  isPlaylistFileName,
  matchM3u,
  parseM3u,
  type PlaylistEntry,
} from "./playlist";
import {
  gmInstrumentName,
  isMidiFileName,
  programAt,
  type ChannelInstrument,
  type ChannelProgram,
  type SongMetadata,
} from "./parser";

/** Formats seconds as m:ss, optionally with tenths (for the elapsed readout). */
function formatTime(seconds: number, tenths = false): string {
  const clamped = Math.max(0, seconds);
  const whole = Math.floor(clamped);
  const m = Math.floor(whole / 60);
  const sec = String(whole % 60).padStart(2, "0");
  return tenths
    ? `${m}:${sec}.${Math.floor((clamped - whole) * 10)}`
    : `${m}:${sec}`;
}

const ENTRY_DRAG_TYPE = "application/x-midi-entry";

/** Whether the printed Quick start label is expanded ("1") or collapsed ("0"). */
const QUICKSTART_STORAGE_KEY = "external-midi-player.quickstart-expanded";

/** GitHub mark (Octicons "mark-github", MIT), drawn in currentColor. */
const GITHUB_ICON = `<svg class="github-icon" viewBox="0 0 16 16" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

/**
 * Display name of the bundled first-run song (T12). Its asset file name is
 * URL-safe and deliberately different from what the playlist row reads.
 */
const SAMPLE_SONG_NAME = "Debussy - Poissons d'or";

/** True when `bytes` start with an SMF `MThd` header chunk. */
function hasMidiHeader(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return (
    head.length === 4 &&
    head[0] === 0x4d &&
    head[1] === 0x54 &&
    head[2] === 0x68 &&
    head[3] === 0x64
  );
}

/** Level LEDs per meter ladder; the red clip light is the twelfth segment. */
const LADDER_SEGMENTS = 11;

/**
 * Vertical pointer travel, in CSS pixels, that covers the knob's whole 0–100
 * range. Roughly the knob's own visual height, so the gesture feels like the
 * hardware it represents (T19).
 */
const KNOB_TRAVEL_PX = 120;

/** Shift-drag trims at a quarter speed for fine level setting (T19). */
const KNOB_FINE_SCALE = 0.25;

/**
 * Transport icons are inline SVG: the LCD font has no play/stop glyphs, and a
 * text glyph would fall back to a different typeface mid-key.
 */
const ICON = {
  previous: '<path d="M6 5h3v14H6zM20 5v14L9 12z"/>',
  play: '<path d="M8 4l12 8-12 8z"/>',
  pause: '<path d="M8 4h4v16H8zM16 4h4v16h-4z"/>',
  stop: '<path d="M5 5h14v14H5z"/>',
  next: '<path d="M15 5h3v14h-3zM4 5v14l11-7z"/>',
  remove:
    '<path d="M8.5 6L12 9.5 15.5 6 18 8.5 14.5 12 18 15.5 15.5 18 12 14.5 8.5 18 6 15.5 9.5 12 6 8.5z"/>',
  info: '<path d="M11 10h2v9h-2zM11 5h2v2h-2z"/>',
} as const;

function icon(name: keyof typeof ICON): string {
  return (
    '<svg class="key-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    ICON[name] +
    "</svg>"
  );
}

/**
 * One vertical LED ladder for the stereo input meter: 11 level segments plus
 * the red clip segment on top. The level segments are driven from
 * `data-level` (1 = bottom) and `data-lit`; the clip segment is toggled with
 * the `hidden` attribute so the CLIP test ID keeps working.
 */
function meterLadder(side: "left" | "right"): string {
  const clipTestId = side === "left" ? ' data-testid="clip-indicator"' : "";
  const levels = Array.from(
    { length: LADDER_SEGMENTS },
    (_, i) => LADDER_SEGMENTS - i,
  )
    .map((level) => {
      const kind = level > LADDER_SEGMENTS - 3 ? "led-amber" : "led-green";
      return (
        '<span class="meter-slot"><span class="led ' +
        kind +
        '" data-level="' +
        level +
        '" data-lit="false"></span></span>'
      );
    })
    .join("");
  return (
    '<div class="ladder" data-testid="meter-' +
    side +
    '" aria-hidden="true">' +
    '<span class="meter-slot meter-slot-clip">' +
    '<span class="led led-red led-clip"' +
    clipTestId +
    " hidden></span></span>" +
    levels +
    "</div>"
  );
}

/** The 16 fixed channel cells of the playback LCD's part strip. */
function partStrip(): string {
  return Array.from({ length: 16 }, (_, index) => {
    const channel = index + 1;
    return (
      '<li class="part-cell" data-testid="part-cell" data-channel="' +
      channel +
      '" data-used="false" data-active="false" aria-label="Channel ' +
      channel +
      '">' +
      channel +
      "</li>"
    );
  }).join("");
}

/**
 * Builds the layout into `root` and wires the Connect devices flow:
 * one click triggers *both* the Web MIDI and the microphone permission
 * prompts (both must originate from this user gesture).
 */
export function createUi(root: HTMLElement): void {
  root.innerHTML = `
    <div class="rack">
      <section class="quickstart" data-testid="quickstart" aria-labelledby="quickstart-heading">
        <div class="quickstart-head">
          <h2 class="silk-label" id="quickstart-heading">Info</h2>
          <button
            type="button"
            class="rubber-key quickstart-toggle"
            data-testid="quickstart-toggle"
            aria-expanded="true"
            aria-controls="quickstart-body"
          >Hide info</button>
        </div>
        <div class="quickstart-body" id="quickstart-body">
          <p class="how-to-intro">
            MIDI player catered to playback on external MIDI synths. How to use:
          </p>
          <ol class="how-to" data-testid="how-to">
            <li>Connect your hardware.</li>
            <li>Click <strong>Connect devices</strong>.</li>
            <li>Allow MIDI and microphone access when the browser asks.</li>
            <li>Select your MIDI output.</li>
            <li>Select your audio input and output.</li>
            <li>Load your MIDI files and listen.</li>
          </ol>
          <p class="silk-hint quickstart-shortcuts" data-testid="quickstart-shortcuts">
            Shortcuts: Space play/pause · Esc panic · ← previous · → next
          </p>
          <p class="notice silk-notice" data-testid="unsupported-notice" hidden>
            This browser does not support Web MIDI. Use a current desktop version
            of Chrome, Edge, or Firefox to connect MIDI devices.
          </p>
          <p class="notice silk-notice" data-testid="firefox-onboarding" hidden>
            Firefox may ask you to install a Web MIDI site permission before it
            can list MIDI devices. That prompt is safe — it only lets this page
            talk to your MIDI hardware. Click "Connect devices", then allow the
            permission when asked.
          </p>
          <div class="info-foot">
          <div class="info-credits">
          <p class="font-credit" data-testid="player-credit">Player by <a href="https://github.com/wilsontr">Trevor Wilson</a></p>
          <p class="font-credit">
            LCD font:
            <a href="http://fontstruct.com/fontstructions/show/664062" rel="license noopener" target="_blank">Graph 35+ pix</a>
            by 30100flo,
            <a href="https://creativecommons.org/licenses/by-sa/3.0/" rel="license noopener" target="_blank">CC BY-SA 3.0</a>
          </p>
          </div>
          <a
            class="github-link"
            data-testid="github-link"
            href="https://github.com/wilsontr/external-midi-player"
            rel="noopener"
            target="_blank"
            aria-label="Source on GitHub"
            title="Source on GitHub"
          >${GITHUB_ICON}</a>
          </div>
        </div>
      </section>
      <header class="unit unit-front" data-testid="header" aria-label="App header">
        <div class="unit-brand">
          <h1 class="brand-name">External MIDI Player</h1>
          <p class="brand-model">MIDI playback module · 16 channels</p>
          <span class="power-lamp" aria-hidden="true">
            <span class="led led-green" data-lit="true"></span>
            <span class="silk-caption">Power</span>
          </span>
        </div>
        <div class="face face-front">
          <section class="strip strip-monitor" data-testid="monitor-panel" aria-labelledby="monitor-heading">
            <h2 class="silk-label" id="monitor-heading">Audio monitor</h2>
            <div class="knob-section">
              <label class="silk-label" for="monitor-volume">Volume</label>
              <div class="knob-wrap">
                <input
                  class="knob-input"
                  type="range"
                  id="monitor-volume"
                  min="0"
                  max="100"
                  value="100"
                  data-testid="volume-slider"
                />
                <div class="knob" data-testid="volume-knob" aria-hidden="true">
                  <span class="knob-pointer"></span>
                </div>
              </div>
              <span class="sr-only" data-testid="volume-text">100%</span>
            </div>
            <div class="mute-section">
              <button
                type="button"
                class="rubber-key mute-key"
                data-testid="mute-button"
                aria-pressed="true"
              >
                <span class="led led-red led-mute" data-testid="mute-led" data-lit="true" aria-hidden="true"></span>
                <span class="key-cap">Mute</span>
              </button>
            </div>
            <div
              class="meter"
              data-testid="meter"
              role="meter"
              aria-label="Input level"
              aria-valuemin="-100"
              aria-valuemax="0"
              aria-valuenow="-100"
              aria-valuetext="Left −∞ dBFS, Right −∞ dBFS"
            >
              <div class="ladder-group">
                ${meterLadder("left")}
                <span class="silk-caption" aria-hidden="true">L</span>
              </div>
              <div class="ladder-group">
                ${meterLadder("right")}
                <span class="silk-caption" aria-hidden="true">R</span>
              </div>
            </div>
          </section>

          <section class="strip strip-lcd" data-testid="playback-panel" aria-labelledby="playback-heading">
            <h2 class="sr-only" id="playback-heading">Playback</h2>
            <div class="lcd lcd-main">
              <div class="lcd-top">
                <span class="lcd-cell"><span class="lcd-tag">Song</span><span data-testid="song-number">--</span></span>
                <span class="lcd-state" data-testid="lcd-state" data-state="stopped" aria-hidden="true">STOP</span>
                <span class="lcd-cell"><span class="lcd-tag">Time</span><span data-testid="time-display">0:00.0 / 0:00</span></span>
              </div>
              <p class="lcd-title" data-testid="current-title">No song selected.</p>
              <div class="lcd-seek">
                <div
                  class="timeline disabled"
                  data-testid="timeline"
                  role="slider"
                  tabindex="-1"
                  aria-label="Playback position"
                  aria-valuemin="0"
                  aria-valuemax="0"
                  aria-valuenow="0"
                  aria-valuetext="0:00.0 of 0:00"
                  aria-disabled="true"
                ><div class="timeline-fill" data-testid="timeline-fill"></div></div>
              </div>
              <ol class="part-strip" data-testid="part-strip" aria-label="Channels used by the playing song">
                ${partStrip()}
              </ol>
              <p class="status-region lcd-status" role="status" aria-live="polite" data-testid="status-region"></p>
            </div>
            <p class="sr-only" data-testid="playback-state" data-state="stopped">Nothing playing.</p>
          </section>

          <div class="strip strip-keys">
            <div class="output-row">
              <label class="silk-label" for="midi-output">MIDI output</label>
              <span class="select-wrap">
                <select id="midi-output" class="lcd-select" data-testid="output-picker" disabled>
                  <option value="">Select an output…</option>
                </select>
              </span>
            </div>
            <div class="output-row">
              <label class="silk-label" for="audio-input">Audio input</label>
              <span class="select-wrap">
                <select id="audio-input" class="lcd-select" data-testid="audio-input-picker" disabled>
                  <option value="">Select an input…</option>
                </select>
              </span>
            </div>
            <div class="output-row" data-testid="audio-output-row">
              <label class="silk-label" for="audio-output">Audio output</label>
              <span class="select-wrap">
                <select id="audio-output" class="lcd-select" data-testid="audio-output-picker" disabled>
                  <option value="">System default</option>
                </select>
              </span>
              <button type="button" class="rubber-key key-small" data-testid="grant-output-button" hidden>Choose output device…</button>
            </div>
            <p class="notice silk-notice" data-testid="monitor-unavailable" hidden>
              This browser cannot capture audio, so monitoring is unavailable.
            </p>
            <p class="notice silk-notice" data-testid="audio-output-note" hidden>
              This browser cannot choose a monitoring output, so audio plays to the system default output.
            </p>
            <p class="notice silk-notice" data-testid="feedback-warning" hidden>
              The input and output are the same device. Unmute with care: a microphone near the
              speakers can cause feedback.
            </p>
            <div class="transport-block">
            <div class="keypad" data-testid="keypad" role="group" aria-label="Transport">
              <div class="key-cell">
                <button type="button" class="rubber-key key-transport" data-testid="previous-button" aria-label="⏮ Previous">${icon("previous")}</button>
                <span class="silk-caption" aria-hidden="true">Prev</span>
              </div>
              <div class="key-cell key-cell-play" data-testid="play-key" data-state="stopped">
                <span class="led led-play" data-testid="play-led" data-state="stopped" aria-hidden="true"></span>
                <button type="button" class="rubber-key key-transport" data-testid="play-button" aria-label="▶ Play"><span class="key-glyph" data-testid="play-glyph">${icon("play")}</span></button>
                <span class="silk-caption" data-testid="play-caption" aria-hidden="true">Play</span>
              </div>
              <div class="key-cell">
                <button type="button" class="rubber-key key-transport" data-testid="next-button" aria-label="⏭ Next">${icon("next")}</button>
                <span class="silk-caption" aria-hidden="true">Next</span>
              </div>
              <div class="key-cell">
                <button type="button" class="rubber-key key-transport" data-testid="stop-button" aria-label="⏹ Stop">${icon("stop")}</button>
                <span class="silk-caption" aria-hidden="true">Stop</span>
              </div>
              <div class="key-cell key-cell-panic">
                <button type="button" class="rubber-key key-panic" data-testid="panic-button" aria-label="Panic"><span class="key-cap">Panic</span></button>
                <span class="silk-caption key-caption-spacer" aria-hidden="true">&nbsp;</span>
              </div>
            </div>
            <div class="connect-row">
              <span class="led led-connect" data-testid="connect-led" data-state="disconnected" aria-hidden="true"></span>
              <button type="button" class="rubber-key connect-key" data-testid="connect-button">Connect devices</button>
              <button type="button" class="rubber-key connect-key" data-testid="retry-button" hidden>Retry</button>
              <button type="button" class="rubber-key connect-key info-key" data-testid="info-button" aria-label="Info: metadata for the playing song">Info</button>
            </div>
            </div>
          </div>
        </div>
      </header>

      <section class="unit unit-exp" data-testid="expansion-unit" aria-label="Expansion unit">
        <div class="face face-exp">
          <section class="strip strip-songs" data-testid="playlist-panel" aria-labelledby="playlist-heading">
            <h2 class="sr-only" id="playlist-heading">Playlist</h2>
            <div class="playlist-keys" role="group" aria-label="Playlist files">
              <button type="button" class="rubber-key key-small compact" data-testid="add-files-button" aria-label="Add files" title="Add files">+</button>
              <button type="button" class="rubber-key key-small" data-testid="load-files-button">Load files</button>
              <button type="button" class="rubber-key key-small" data-testid="clear-playlist-button">Clear playlist</button>
              <button type="button" class="rubber-key key-small" data-testid="save-playlist-button" disabled>Save playlist</button>
              <button type="button" class="rubber-key key-small" data-testid="load-playlist-button">Load playlist</button>
              <input type="file" multiple accept=".mid,.midi" hidden data-testid="file-input" />
              <input type="file" multiple accept=".mid,.midi" hidden data-testid="load-file-input" />
              <input type="file" multiple accept=".m3u,.m3u8,.mid,.midi" hidden data-testid="playlist-file-input" />
            </div>
            <p class="silk-hint playlist-file-hint" data-testid="playlist-file-hint">
              Save playlist writes the order and file names as an .m3u8. Loading uses files already
              in your playlist; to add new ones, select the playlist with its .mid files together.
            </p>
            <div class="lcd lcd-songs">
              <div class="lcd-top lcd-top-songs">
                <span class="lcd-tag">Song list</span>
                <span data-testid="song-count">0 songs</span>
              </div>
              <div class="drop-zone" data-testid="drop-zone">
                <span>Drop .mid files on this unit</span>
              </div>
              <ol class="playlist" aria-label="Playlist" data-testid="playlist"></ol>
              <p class="lcd-empty" data-testid="playlist-empty">No songs yet.</p>
            </div>
          </section>

          <aside class="exp-side">
            <section class="lcd lcd-partmap" data-testid="instruments-panel" aria-labelledby="instruments-heading">
              <h2 class="lcd-tag" id="instruments-heading">Instruments</h2>
              <p class="instruments-caption" data-testid="instruments-caption" hidden></p>
              <p class="lcd-hint" data-testid="instruments-empty">Play a song to see its MIDI channels and instruments.</p>
              <ul class="instrument-list" data-testid="instrument-list" hidden></ul>
            </section>
          </aside>
        </div>
      </section>
    </div>
    <dialog
      class="lcd metadata-dialog"
      data-testid="metadata-dialog"
      aria-labelledby="metadata-title"
    >
      <header class="metadata-head">
        <span class="lcd-tag">Metadata</span>
        <h2 class="metadata-heading" id="metadata-title">Song metadata</h2>
        <p class="metadata-filename" data-testid="metadata-filename"></p>
      </header>
      <div class="metadata-body" data-testid="metadata-body">
        <p class="metadata-status" data-testid="metadata-status" hidden></p>
        <div class="metadata-sections" data-testid="metadata-sections">
          <section class="metadata-field" aria-labelledby="metadata-tracknames-heading">
            <h3 class="lcd-tag" id="metadata-tracknames-heading">Track Name</h3>
            <ol class="metadata-list" data-testid="metadata-track-names"></ol>
            <p class="metadata-empty" data-testid="metadata-empty-track-names" hidden>None recorded.</p>
          </section>
          <section class="metadata-field" aria-labelledby="metadata-text-heading">
            <h3 class="lcd-tag" id="metadata-text-heading">Text Event</h3>
            <ol class="metadata-list" data-testid="metadata-text-events"></ol>
            <p class="metadata-empty" data-testid="metadata-empty-text-events" hidden>None recorded.</p>
          </section>
          <section class="metadata-field" aria-labelledby="metadata-copyright-heading">
            <h3 class="lcd-tag" id="metadata-copyright-heading">Copyright Notice</h3>
            <ol class="metadata-list" data-testid="metadata-copyrights"></ol>
            <p class="metadata-empty" data-testid="metadata-empty-copyrights" hidden>None recorded.</p>
          </section>
        </div>
        <p class="metadata-truncated" data-testid="metadata-truncated" hidden>
          Some values are not shown because this file has more metadata than the viewer keeps.
        </p>
      </div>
      <footer class="metadata-foot">
        <button type="button" class="rubber-key key-small" data-testid="metadata-close">Close</button>
      </footer>
    </dialog>
  `;

  const connectButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="connect-button"]',
  )!;
  const retryButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="retry-button"]',
  )!;
  const connectLed = root.querySelector<HTMLElement>(
    '[data-testid="connect-led"]',
  )!;
  const quickstartToggle = root.querySelector<HTMLButtonElement>(
    '[data-testid="quickstart-toggle"]',
  )!;
  const quickstartBody = root.querySelector<HTMLElement>("#quickstart-body")!;
  const unsupportedNotice = root.querySelector<HTMLElement>(
    '[data-testid="unsupported-notice"]',
  )!;
  const firefoxOnboarding = root.querySelector<HTMLElement>(
    '[data-testid="firefox-onboarding"]',
  )!;
  const outputPicker = root.querySelector<HTMLSelectElement>(
    '[data-testid="output-picker"]',
  )!;
  const playbackState = root.querySelector<HTMLElement>(
    '[data-testid="playback-state"]',
  )!;
  const currentTitle = root.querySelector<HTMLElement>(
    '[data-testid="current-title"]',
  )!;
  const playButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="play-button"]',
  )!;
  const stopButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="stop-button"]',
  )!;
  const previousButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="previous-button"]',
  )!;
  const nextButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="next-button"]',
  )!;
  const panicButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="panic-button"]',
  )!;
  const timeline = root.querySelector<HTMLElement>('[data-testid="timeline"]')!;
  const timelineFill = root.querySelector<HTMLElement>(
    '[data-testid="timeline-fill"]',
  )!;
  const timeDisplay = root.querySelector<HTMLElement>(
    '[data-testid="time-display"]',
  )!;
  const audioInputPicker = root.querySelector<HTMLSelectElement>(
    '[data-testid="audio-input-picker"]',
  )!;
  const audioOutputPicker = root.querySelector<HTMLSelectElement>(
    '[data-testid="audio-output-picker"]',
  )!;
  const audioOutputRow = root.querySelector<HTMLElement>(
    '[data-testid="audio-output-row"]',
  )!;
  const audioOutputNote = root.querySelector<HTMLElement>(
    '[data-testid="audio-output-note"]',
  )!;
  const grantOutputButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="grant-output-button"]',
  )!;
  const monitorUnavailable = root.querySelector<HTMLElement>(
    '[data-testid="monitor-unavailable"]',
  )!;
  const muteButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="mute-button"]',
  )!;
  const volumeSlider = root.querySelector<HTMLInputElement>(
    '[data-testid="volume-slider"]',
  )!;
  const volumeText = root.querySelector<HTMLElement>(
    '[data-testid="volume-text"]',
  )!;
  const meter = root.querySelector<HTMLElement>('[data-testid="meter"]')!;
  const levelLeds = {
    left: [
      ...root.querySelectorAll<HTMLElement>(
        '[data-testid="meter-left"] .led[data-level]',
      ),
    ],
    right: [
      ...root.querySelectorAll<HTMLElement>(
        '[data-testid="meter-right"] .led[data-level]',
      ),
    ],
  };
  const clipLeds = [...root.querySelectorAll<HTMLElement>(".led-clip")];
  const knob = root.querySelector<HTMLElement>('[data-testid="volume-knob"]')!;
  const knobWrap = root.querySelector<HTMLElement>(".knob-wrap")!;
  const muteLed = root.querySelector<HTMLElement>('[data-testid="mute-led"]')!;
  const lcdState = root.querySelector<HTMLElement>(
    '[data-testid="lcd-state"]',
  )!;
  const songNumber = root.querySelector<HTMLElement>(
    '[data-testid="song-number"]',
  )!;
  const playKey = root.querySelector<HTMLElement>('[data-testid="play-key"]')!;
  const playLed = root.querySelector<HTMLElement>('[data-testid="play-led"]')!;
  const playGlyph = root.querySelector<HTMLElement>(
    '[data-testid="play-glyph"]',
  )!;
  const playCaption = root.querySelector<HTMLElement>(
    '[data-testid="play-caption"]',
  )!;
  const partCells = [
    ...root.querySelectorAll<HTMLElement>('[data-testid="part-cell"]'),
  ];
  const feedbackWarning = root.querySelector<HTMLElement>(
    '[data-testid="feedback-warning"]',
  )!;
  const instrumentsCaption = root.querySelector<HTMLElement>(
    '[data-testid="instruments-caption"]',
  )!;
  const instrumentsEmpty = root.querySelector<HTMLElement>(
    '[data-testid="instruments-empty"]',
  )!;
  const instrumentList = root.querySelector<HTMLUListElement>(
    '[data-testid="instrument-list"]',
  )!;
  const expansionUnit = root.querySelector<HTMLElement>(
    '[data-testid="expansion-unit"]',
  )!;
  const songCount = root.querySelector<HTMLElement>(
    '[data-testid="song-count"]',
  )!;
  const dropZone = root.querySelector<HTMLElement>(
    '[data-testid="drop-zone"]',
  )!;
  const addFilesButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="add-files-button"]',
  )!;
  const loadFilesButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="load-files-button"]',
  )!;
  const clearPlaylistButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="clear-playlist-button"]',
  )!;
  const savePlaylistButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="save-playlist-button"]',
  )!;
  const loadPlaylistButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="load-playlist-button"]',
  )!;
  const fileInput = root.querySelector<HTMLInputElement>(
    '[data-testid="file-input"]',
  )!;
  const loadFileInput = root.querySelector<HTMLInputElement>(
    '[data-testid="load-file-input"]',
  )!;
  const playlistFileInput = root.querySelector<HTMLInputElement>(
    '[data-testid="playlist-file-input"]',
  )!;
  const playlistEmpty = root.querySelector<HTMLElement>(
    '[data-testid="playlist-empty"]',
  )!;
  const playlistList = root.querySelector<HTMLOListElement>(
    '[data-testid="playlist"]',
  )!;
  const metadataDialog = root.querySelector<HTMLDialogElement>(
    '[data-testid="metadata-dialog"]',
  )!;
  const metadataTitle = root.querySelector<HTMLElement>("#metadata-title")!;
  const metadataFilename = root.querySelector<HTMLElement>(
    '[data-testid="metadata-filename"]',
  )!;
  const metadataBody = root.querySelector<HTMLElement>(
    '[data-testid="metadata-body"]',
  )!;
  const metadataStatus = root.querySelector<HTMLElement>(
    '[data-testid="metadata-status"]',
  )!;
  const metadataSections = root.querySelector<HTMLElement>(
    '[data-testid="metadata-sections"]',
  )!;
  const metadataTruncated = root.querySelector<HTMLElement>(
    '[data-testid="metadata-truncated"]',
  )!;
  const metadataClose = root.querySelector<HTMLButtonElement>(
    '[data-testid="metadata-close"]',
  )!;
  const metadataFields = [
    {
      key: "trackNames" as const,
      list: root.querySelector<HTMLOListElement>(
        '[data-testid="metadata-track-names"]',
      )!,
      empty: root.querySelector<HTMLElement>(
        '[data-testid="metadata-empty-track-names"]',
      )!,
    },
    {
      key: "textEvents" as const,
      list: root.querySelector<HTMLOListElement>(
        '[data-testid="metadata-text-events"]',
      )!,
      empty: root.querySelector<HTMLElement>(
        '[data-testid="metadata-empty-text-events"]',
      )!,
    },
    {
      key: "copyrights" as const,
      list: root.querySelector<HTMLOListElement>(
        '[data-testid="metadata-copyrights"]',
      )!,
      empty: root.querySelector<HTMLElement>(
        '[data-testid="metadata-empty-copyrights"]',
      )!,
    },
  ];

  const statusRegion = root.querySelector<HTMLElement>(
    '[data-testid="status-region"]',
  )!;
  function setStatus(message: string): void {
    statusRegion.textContent = message;
    // The line is clipped to one row; the title keeps the full text readable.
    if (message) statusRegion.title = message;
    else statusRegion.removeAttribute("title");
  }

  function isFirefox(): boolean {
    return /firefox/i.test(navigator.userAgent);
  }

  const synth = new SoftwareSynth({ onStatus: setStatus });

  const midi = new MidiDevices({
    onStatus: setStatus,
    onOutputsChanged: () => renderOutputs(),
    onSelectionChange: (id) => {
      // A hardware output taking over — picked, or the remembered device
      // reselected by Connect devices — releases the built-in synth. Without
      // this the picker showed the device while `selectedOutput` kept
      // preferring the synth, so playback went somewhere the UI did not show.
      if (id !== null) synth.deselect();
      outputPicker.value = synth.selectedId() ?? id ?? "";
      renderConnectionLed();
      // Switching outputs mid-song: release on the old one, don't carry over.
      if (id !== null && player.state !== "stopped") player.stop();
    },
    onSelectedOutputLost: () => {
      player.outputLost();
      setStatus("MIDI output disconnected - playback stopped.");
    },
  });

  /** Whichever output is currently chosen: the built-in synth wins when picked. */
  const selectedOutput = (): MIDIOutput | null =>
    synth.selectedOutput() ?? midi.selectedOutput();

  const player = new PlaylistPlayer({
    getOutput: selectedOutput,
    onChange: () => {
      renderTransport();
      renderPlaylist();
      renderInstruments();
    },
    onStatus: setStatus,
  });

  const STATE_TEXT = {
    stopped: "Nothing playing.",
    playing: "Playing",
    paused: "Paused",
  };
  /** Cleared as soon as the next song starts (see renderTransport). */
  const PANIC_STATUS = "Panic: all notes off sent on all 16 channels.";
  const STATE_LCD = { stopped: "STOP", playing: "PLAY", paused: "PAUSE" };

  function renderTransport(): void {
    const state = player.state;
    const playing = state === "playing";
    playButton.setAttribute("aria-label", playing ? "⏸ Pause" : "▶ Play");
    playCaption.textContent = playing ? "Pause" : "Play";
    const glyph = icon(playing ? "pause" : "play");
    if (playGlyph.innerHTML !== glyph) playGlyph.innerHTML = glyph;
    playKey.dataset.state = state;
    playLed.dataset.state = state;
    playbackState.dataset.state = state;
    playbackState.textContent = STATE_TEXT[state];
    lcdState.dataset.state = state;
    lcdState.textContent = STATE_LCD[state];
    const { entries, currentId } = player.playlist;
    const index = entries.findIndex((entry) => entry.id === currentId);
    songNumber.textContent =
      index < 0
        ? "--"
        : `${String(index + 1).padStart(2, "0")}/${String(entries.length).padStart(2, "0")}`;
    const current = player.currentEntry();
    currentTitle.textContent = current
      ? entryDisplayName(current)
      : "No song selected.";
    updateProgress();
    // A new song starting clears a stale Panic line; other status messages
    // (errors, device loss, file rejections) are left alone.
    if (state === "playing" && statusRegion.textContent === PANIC_STATUS) {
      setStatus("");
    }
  }

  /** One instrument entry: GM name, 1-based program, bank when selected. */
  function describeProgram(channel: number, program: ChannelProgram): string {
    const bank =
      program.bankMsb === null && program.bankLsb === null
        ? ""
        : ` · bank ${program.bankMsb ?? 0}:${program.bankLsb ?? 0}`;
    const suffix = `${bank}${program.fromFile ? "" : " (default)"}`;
    if (channel === 9) return `Drums · kit ${program.program + 1}${suffix}`;
    return `${gmInstrumentName(program.program)} · program ${program.program + 1}${suffix}`;
  }

  /** Stable key for one channel's live program, used to skip no-op re-renders. */
  function programKey(
    item: ChannelInstrument,
    program: ChannelProgram,
  ): string {
    return `${item.channel}:${program.program}:${program.bankMsb ?? ""}:${
      program.bankLsb ?? ""
    }:${program.fromFile ? 1 : 0}`;
  }

  /** The live programs of the ready card at the current position, as a key. */
  function liveInstrumentsSignature(): string {
    const state = player.instrumentsState();
    if (state.status !== "ready") return "";
    const positionSec = player.position();
    return state.channels
      .map((item) => programKey(item, programAt(item, positionSec)))
      .join("|");
  }

  /** Last key renderInstruments wrote; ticks only re-render when it changes. */
  let lastInstrumentsSignature = "";
  /** Channels (1-16) the playing song uses, for the part cells' labels. */
  let usedChannels = new Set<number>();

  function createInstrumentRow(
    item: ChannelInstrument,
    program: ChannelProgram,
  ): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "instrument-row";
    li.setAttribute("data-testid", "instrument-row");
    li.dataset.channel = String(item.channel + 1);
    const channel = document.createElement("span");
    channel.className = "instrument-channel";
    channel.textContent = `Channel ${item.channel + 1}`;
    const detail = document.createElement("span");
    detail.className = "instrument-detail";
    // The program in effect at the current playback position, so the card
    // follows the file's program changes as they play (and when seeking back).
    detail.textContent = describeProgram(item.channel, program);
    li.append(channel, detail);
    return li;
  }

  /**
   * The instruments of the song currently playing, plus the part strip that
   * marks its channels. The card follows the playback position: each channel
   * shows the program in effect now, so a mid-song program change updates the
   * row as it plays (and a seek back restores the earlier one). The part strip
   * marks the channels the song uses; `renderActivity` lights the ones with a
   * note sounding (T21).
   */
  function renderInstruments(): void {
    const state = player.instrumentsState();
    const entry = player.currentEntry();
    const caption =
      state.status === "none" || entry === null ? "" : entryDisplayName(entry);
    instrumentsCaption.hidden = caption === "";
    if (instrumentsCaption.textContent !== caption)
      instrumentsCaption.textContent = caption;

    let empty = "";
    let channels: ChannelInstrument[] = [];
    if (state.status === "none") {
      empty = "Play a song to see its MIDI channels and instruments.";
    } else if (state.status === "loading") {
      empty = "Reading instruments…";
    } else if (state.channels.length === 0) {
      empty = "This file has no channel events.";
    } else {
      channels = state.channels;
    }
    instrumentsEmpty.hidden = empty === "";
    if (instrumentsEmpty.textContent !== empty)
      instrumentsEmpty.textContent = empty;

    instrumentList.hidden = channels.length === 0;
    const positionSec = player.position();
    const live = channels.map((item) => programAt(item, positionSec));
    lastInstrumentsSignature = channels
      .map((item, index) => programKey(item, live[index]))
      .join("|");
    const rows = channels.map((item, index) =>
      createInstrumentRow(item, live[index]),
    );
    const current = instrumentList.children;
    const unchanged =
      current.length === rows.length &&
      rows.every(
        (row, index) => current[index]?.textContent === row.textContent,
      );
    if (!unchanged) instrumentList.replaceChildren(...rows);

    // The part strip is the 1-16 view of the same data: outlined cells are
    // the channels this song uses, and every cell clears when the song stops.
    usedChannels = new Set(channels.map((item) => item.channel + 1));
    for (const cell of partCells) {
      const on = usedChannels.has(Number(cell.dataset.channel));
      if (cell.dataset.used !== String(on)) cell.dataset.used = String(on);
    }
    renderActivity();
  }

  /**
   * Live note activity (T21): a filled cell while its channel has a note
   * sounding. Driven by the progress tick and committed seeks only; the
   * player returns nothing unless it is playing, so pause, stop, end, output
   * loss and the between-song gap are dark. Attributes and accessible names
   * are written only on a transition, and nothing goes to the aria-live
   * region (this is continuous data, not status).
   */
  function renderActivity(): void {
    const active =
      player.state === "playing" && player.instrumentsState().status === "ready"
        ? player.activeChannels()
        : null;
    for (const cell of partCells) {
      const channel = Number(cell.dataset.channel);
      const on = active !== null && active.has(channel - 1);
      if (cell.dataset.active !== String(on)) cell.dataset.active = String(on);
      const label = on
        ? `Channel ${channel}, playing`
        : usedChannels.has(channel)
          ? `Channel ${channel}, used by this song`
          : `Channel ${channel}`;
      if (cell.getAttribute("aria-label") !== label)
        cell.setAttribute("aria-label", label);
    }
  }

  function currentDuration(): number {
    return player.currentEntry()?.durationSec ?? 0;
  }

  /** The timeline is live only while playing or paused, and only once the duration is known. */
  function seekableNow(): boolean {
    return (
      (player.state === "playing" || player.state === "paused") &&
      currentDuration() > 0
    );
  }

  let timelineSeekable = false;
  let draggingTimeline = false;
  let previewSeconds = 0;

  /** Updates the timeline fill and its accessible value description. */
  function renderTimeline(positionSec: number, totalSec: number): void {
    const position = Math.max(0, Math.min(totalSec, positionSec));
    const ratio = totalSec > 0 ? position / totalSec : 0;
    timelineFill.style.width = `${ratio * 100}%`;
    const now = position.toFixed(1);
    if (timeline.getAttribute("aria-valuenow") !== now)
      timeline.setAttribute("aria-valuenow", now);
    const max = totalSec.toFixed(1);
    if (timeline.getAttribute("aria-valuemax") !== max)
      timeline.setAttribute("aria-valuemax", max);
    const text = `${formatTime(position, true)} of ${formatTime(totalSec)}`;
    if (timeline.getAttribute("aria-valuetext") !== text) {
      timeline.setAttribute("aria-valuetext", text);
    }
  }

  function renderElapsed(positionSec: number, totalSec: number): void {
    const text = `${formatTime(positionSec, true)} / ${formatTime(totalSec)}`;
    if (timeDisplay.textContent !== text) timeDisplay.textContent = text;
  }

  /** Refreshes the timeline and elapsed / total readout (runs 20×/s). */
  function updateProgress(): void {
    // The instrument card follows the playhead while playing; re-rendering is
    // a no-op unless a row's text actually changed (program changes are sparse).
    if (
      player.state === "playing" &&
      player.instrumentsState().status === "ready" &&
      liveInstrumentsSignature() !== lastInstrumentsSignature
    ) {
      renderInstruments();
    }
    renderActivity();
    const total = currentDuration();
    const seekable = seekableNow();
    if (seekable !== timelineSeekable) {
      timelineSeekable = seekable;
      timeline.tabIndex = seekable ? 0 : -1;
      timeline.setAttribute("aria-disabled", String(!seekable));
      timeline.classList.toggle("disabled", !seekable);
    }
    if (draggingTimeline) {
      // The drag preview owns the display until the pointer is released.
      renderElapsed(previewSeconds, total);
      return;
    }
    const position = Math.max(0, Math.min(total, player.position()));
    renderTimeline(position, total);
    renderElapsed(position, total);
  }

  /** Commits a seek (on pointer release or a keyboard step). */
  function commitSeek(positionSec: number): void {
    const total = currentDuration();
    if (!timelineSeekable || total <= 0) return;
    const position = Math.max(0, Math.min(total, positionSec));
    player.seek(position);
    renderTimeline(position, total);
    renderElapsed(position, total);
    // A paused seek changes the card's instruments without a tick to drive it.
    renderInstruments();
  }

  /** Shows a pending seek while the pointer is still down (not committed yet). */
  function previewSeek(positionSec: number): void {
    const total = currentDuration();
    previewSeconds = Math.max(0, Math.min(total, positionSec));
    renderTimeline(previewSeconds, total);
    renderElapsed(previewSeconds, total);
  }

  function timelineSecondsAt(clientX: number): number {
    const rect = timeline.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return (
      Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) *
      currentDuration()
    );
  }

  timeline.addEventListener("pointerdown", (event) => {
    if (!timelineSeekable || event.button !== 0) return;
    draggingTimeline = true;
    timeline.focus();
    try {
      timeline.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a nicety; dragging still works without it.
    }
    previewSeek(timelineSecondsAt(event.clientX));
    event.preventDefault();
  });
  timeline.addEventListener("pointermove", (event) => {
    if (!draggingTimeline) return;
    previewSeek(timelineSecondsAt(event.clientX));
  });
  timeline.addEventListener("pointerup", (event) => {
    if (!draggingTimeline) return;
    draggingTimeline = false;
    try {
      timeline.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    commitSeek(previewSeconds);
  });
  timeline.addEventListener("pointercancel", () => {
    if (!draggingTimeline) return;
    draggingTimeline = false;
    updateProgress();
  });
  timeline.addEventListener("keydown", (event) => {
    if (!timelineSeekable) return;
    const total = currentDuration();
    const position = draggingTimeline
      ? previewSeconds
      : Math.max(0, Math.min(total, player.position()));
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = position - 1;
        break;
      case "ArrowRight":
        next = position + 1;
        break;
      case "PageDown":
        next = position - 10;
        break;
      case "PageUp":
        next = position + 10;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = total;
        break;
      default:
        return;
    }
    // Keep the document shortcut handler (←/→ = previous/next) out of this.
    event.preventDefault();
    commitSeek(next);
  });

  const rows = new Map<string, HTMLLIElement>();
  /** Row picked by a single click, when it is not the playing/next entry. */
  let selectedId: string | null = null;
  /** Last `currentId` renderPlaylist saw, to notice playback moving. */
  let renderedCurrentId: string | null = null;
  /** The entry whose metadata the dialog is showing, if any (T20). */
  let metadataEntryId: string | null = null;
  /** Invalidates an in-flight metadata read when the dialog closes/reopens. */
  let metadataReadToken = 0;

  function createRow(id: string): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "playlist-row";
    li.setAttribute("data-testid", "playlist-row");
    li.dataset.id = id;
    li.draggable = true;
    li.innerHTML = `
      <span class="drag-handle" aria-hidden="true" title="Drag to reorder"></span>
      <span class="entry-number" data-testid="entry-number" aria-hidden="true"></span>
      <span class="entry-name" data-testid="entry-name"></span>
      <span class="entry-duration" data-testid="entry-duration"></span>
      <span class="entry-status" data-testid="entry-status"></span>
      <span class="entry-buttons">
        <button type="button" class="row-key" data-action="play">${icon("play")}</button>
        <button type="button" class="row-key" data-action="metadata" data-testid="metadata-button" title="Metadata">${icon("info")}</button>
        <button type="button" class="row-key" data-action="remove">${icon("remove")}</button>
      </span>`;
    return li;
  }

  function updateRow(
    li: HTMLLIElement,
    entry: PlaylistEntry,
    isCurrent: boolean,
    isSelected: boolean,
    index: number,
  ): void {
    const set = (testId: string, text: string): void => {
      const el = li.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
      if (el.textContent !== text) el.textContent = text;
    };
    // Row numbers are derived from the order, so add/load/remove/reorder and a
    // reload all renumber consistently.
    set("entry-number", String(index + 1));
    const displayName = entryDisplayName(entry);
    set("entry-name", displayName);
    set(
      "entry-duration",
      entry.durationSec === undefined
        ? entry.status === "error"
          ? "-"
          : "…"
        : formatTime(entry.durationSec),
    );
    const status = li.querySelector<HTMLElement>(
      '[data-testid="entry-status"]',
    )!;
    const error = entry.status === "error";
    status.hidden = !error;
    set("entry-status", error ? "ERR" : "");
    if (error) status.title = `Error: ${entry.error ?? "unreadable"}`;
    else status.removeAttribute("title");
    li.dataset.status = entry.status;
    li.classList.toggle("current", isCurrent);
    if (isCurrent) li.setAttribute("aria-current", "true");
    else li.removeAttribute("aria-current");
    // Selected and playing are independent markers that can combine on one
    // row: a dotted outline for the selection, the inverted row for playing.
    if (isSelected) li.setAttribute("data-selected", "true");
    else li.removeAttribute("data-selected");
    const label = (action: string, text: string): void => {
      li.querySelector(`[data-action="${action}"]`)!.setAttribute(
        "aria-label",
        `${text} ${displayName}`,
      );
    };
    label("play", "Play");
    label("metadata", "Metadata for");
    label("remove", "Remove");
    const disabled = entry.status === "error";
    li.querySelector<HTMLButtonElement>('[data-action="play"]')!.disabled =
      disabled;
    li.querySelector<HTMLButtonElement>('[data-action="metadata"]')!.disabled =
      disabled;
  }

  /** Keyed reconcile: rows are reused so focus and drag state survive updates. */
  function renderPlaylist(): void {
    const { entries, currentId } = player.playlist;
    if (currentId !== renderedCurrentId) {
      // Playback moved (start, auto-advance, next/previous, remove): the
      // selection follows the entry that is now playing or queued to play.
      renderedCurrentId = currentId;
      selectedId = currentId;
    }
    if (
      selectedId !== null &&
      !entries.some((entry) => entry.id === selectedId)
    ) {
      selectedId = currentId;
    }
    playlistEmpty.hidden = entries.length > 0;
    savePlaylistButton.disabled = entries.length === 0;
    const count = `${entries.length} ${entries.length === 1 ? "song" : "songs"}`;
    if (songCount.textContent !== count) songCount.textContent = count;
    if (
      metadataEntryId !== null &&
      !entries.some((entry) => entry.id === metadataEntryId)
    ) {
      metadataDialog.close();
    }
    const live = new Set(entries.map((e) => e.id));
    for (const [id, li] of rows) {
      if (!live.has(id)) {
        li.remove();
        rows.delete(id);
      }
    }
    entries.forEach((entry, index) => {
      let li = rows.get(entry.id);
      if (!li) {
        li = createRow(entry.id);
        rows.set(entry.id, li);
      }
      updateRow(
        li,
        entry,
        entry.id === currentId,
        entry.id === selectedId,
        index,
      );
      if (playlistList.children[index] !== li) {
        playlistList.insertBefore(li, playlistList.children[index] ?? null);
      }
    });
  }

  function entryIndex(id: string): number {
    return player.playlist.entries.findIndex((e) => e.id === id);
  }

  /** Replaces one metadata list with `Track N` + decoded text rows. */
  function renderMetadataValues(
    list: HTMLOListElement,
    values: SongMetadata["trackNames"],
  ): void {
    const rows = values.map((value) => {
      const li = document.createElement("li");
      li.className = "metadata-row";
      li.dataset.track = String(value.track + 1);
      const track = document.createElement("span");
      track.className = "metadata-track";
      track.textContent = `Track ${value.track + 1}`;
      const text = document.createElement("span");
      text.className = "metadata-value";
      // Metadata is untrusted text: never innerHTML.
      text.textContent = value.text;
      li.append(track, text);
      return li;
    });
    list.replaceChildren(...rows);
  }

  /** Fills the dialog for a loaded entry. */
  function renderMetadata(entry: PlaylistEntry, metadata: SongMetadata): void {
    metadataTitle.textContent = entryDisplayName(entry);
    metadataFilename.textContent = entry.file.name;
    for (const field of metadataFields) {
      const values = metadata[field.key];
      renderMetadataValues(field.list, values);
      field.empty.hidden = values.length > 0;
    }
    metadataTruncated.hidden = !metadata.truncated;
    metadataStatus.hidden = true;
    metadataStatus.textContent = "";
    metadataSections.hidden = false;
    metadataBody.setAttribute("aria-busy", "false");
  }

  /** Loading or error state: no field sections, one message in the body. */
  function showMetadataMessage(message: string): void {
    metadataSections.hidden = true;
    metadataTruncated.hidden = true;
    metadataStatus.hidden = false;
    metadataStatus.textContent = message;
    metadataBody.setAttribute(
      "aria-busy",
      message === "Reading metadata…" ? "true" : "false",
    );
  }

  /**
   * Opens the metadata dialog for one entry. A stored summary renders at once;
   * a legacy row without one shows a loading line while `metadataFor` parses
   * (or reuses the background queue's in-flight parse). Opening never touches
   * the transport.
   */
  async function openMetadata(id: string): Promise<void> {
    const entry = player.playlist.entries.find(
      (candidate) => candidate.id === id,
    );
    if (entry === undefined || entry.status === "error") return;
    metadataEntryId = id;
    metadataReadToken += 1;
    const token = metadataReadToken;
    metadataTitle.textContent = entryDisplayName(entry);
    metadataFilename.textContent = entry.file.name;
    if (!metadataDialog.open) metadataDialog.showModal();
    if (entry.metadata !== undefined) {
      renderMetadata(entry, entry.metadata);
      return;
    }
    showMetadataMessage("Reading metadata…");
    const result = await player.metadataFor(id);
    if (token !== metadataReadToken || !metadataDialog.open) return;
    const current = player.playlist.entries.find(
      (candidate) => candidate.id === id,
    );
    if (current === undefined) {
      metadataDialog.close();
      return;
    }
    if (result.status === "ok") renderMetadata(current, result.metadata);
    else showMetadataMessage(`Could not read metadata: ${result.message}`);
  }

  metadataClose.addEventListener("click", () => metadataDialog.close());

  // Info key (T22): the playing or paused song's metadata; a no-op otherwise.
  root
    .querySelector<HTMLButtonElement>('[data-testid="info-button"]')!
    .addEventListener("click", () => {
      if (player.state === "stopped") return;
      const current = player.currentEntry();
      if (current !== null) void openMetadata(current.id);
    });
  metadataDialog.addEventListener("click", (event) => {
    // A click on the backdrop targets the dialog itself; clicks on the panel
    // bubble from a child.
    if (event.target === metadataDialog) metadataDialog.close();
  });
  metadataDialog.addEventListener("close", () => {
    metadataEntryId = null;
    metadataReadToken += 1;
  });

  function addFiles(files: File[]): void {
    if (files.length === 0) return;
    const { added, rejected } = player.add(files);
    const parts: string[] = [];
    if (added > 0) parts.push(`Added ${added} file${added === 1 ? "" : "s"}.`);
    if (rejected.length > 0) {
      parts.push(
        `Rejected ${rejected.length} file${rejected.length === 1 ? "" : "s"} (not .mid or .midi): ${rejected.join(", ")}`,
      );
    }
    setStatus(parts.join(" "));
  }

  playlistList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button[data-action]");
    const li = target.closest<HTMLLIElement>("li");
    if (!li) return;
    const id = li.dataset.id!;
    if (!button) {
      // A single click only selects the row; double-click starts playback.
      // While stopped the selection also becomes the song Play will start;
      // while playing/paused it is just the row the outline sits on.
      const entry = player.playlist.entries.find((e) => e.id === id);
      if (entry && entry.status !== "error") {
        selectedId = id;
        player.selectEntry(id);
        renderPlaylist();
      }
      return;
    }
    switch (button.dataset.action) {
      case "play":
        player.playEntry(id);
        break;
      case "metadata":
        void openMetadata(id);
        break;
      case "remove":
        player.remove(id);
        break;
    }
  });

  playlistList.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement;
    // The row keys keep their own click behaviour; a double-click there is
    // not a second way to play.
    if (target.closest("button[data-action]")) return;
    const li = target.closest<HTMLLIElement>("li");
    if (!li) return;
    selectedId = li.dataset.id!;
    player.playEntry(li.dataset.id!);
  });

  // Drag to reorder (internal rows only; external files are handled below).
  let draggedId: string | null = null;
  function clearDropMarks(): void {
    for (const li of rows.values())
      li.classList.remove("drop-before", "drop-after");
  }
  playlistList.addEventListener("dragstart", (event) => {
    const li = (event.target as HTMLElement).closest<HTMLLIElement>("li");
    if (!li || !event.dataTransfer) return;
    draggedId = li.dataset.id!;
    event.dataTransfer.setData(ENTRY_DRAG_TYPE, draggedId);
    event.dataTransfer.effectAllowed = "move";
  });
  playlistList.addEventListener("dragover", (event) => {
    if (draggedId === null) return;
    event.preventDefault();
    clearDropMarks();
    const li = (event.target as HTMLElement).closest<HTMLLIElement>("li");
    if (!li) return;
    const rect = li.getBoundingClientRect();
    li.classList.add(
      event.clientY > rect.top + rect.height / 2 ? "drop-after" : "drop-before",
    );
  });
  playlistList.addEventListener("drop", (event) => {
    if (draggedId === null) return;
    event.preventDefault();
    const id = draggedId;
    draggedId = null;
    clearDropMarks();
    const from = entryIndex(id);
    const li = (event.target as HTMLElement).closest<HTMLLIElement>("li");
    let to: number;
    if (!li) {
      to = player.playlist.entries.length - 1;
    } else {
      const rect = li.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      to = entryIndex(li.dataset.id!) + (after ? 1 : 0);
      if (from < to) to -= 1;
    }
    if (from >= 0) player.move(id, to);
  });
  playlistList.addEventListener("dragend", () => {
    draggedId = null;
    clearDropMarks();
  });

  // File drops: anywhere on the expansion unit; stray drops elsewhere must not
  // navigate away.
  const hasFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");
  expansionUnit.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dropZone.classList.add("drag-over");
  });
  expansionUnit.addEventListener("dragleave", (event) => {
    if (!expansionUnit.contains(event.relatedTarget as Node | null)) {
      dropZone.classList.remove("drag-over");
    }
  });
  expansionUnit.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dropZone.classList.remove("drag-over");
    handleDroppedFiles(Array.from(event.dataTransfer?.files ?? []));
  });
  window.addEventListener("dragover", (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    if (hasFiles(event)) event.preventDefault();
  });

  function loadFiles(files: File[]): void {
    if (files.length === 0) return;
    const { added, rejected } = player.load(files);
    const parts: string[] = [];
    if (added > 0)
      parts.push(
        `Loaded ${added} file${added === 1 ? "" : "s"} - playlist replaced.`,
      );
    if (rejected.length > 0) {
      parts.push(
        `Rejected ${rejected.length} file${rejected.length === 1 ? "" : "s"} (not .mid or .midi): ${rejected.join(", ")}`,
      );
    }
    if (added === 0) parts.push("Playlist unchanged.");
    setStatus(parts.join(" "));
  }

  function clearPlaylist(): void {
    if (player.playlist.entries.length === 0) {
      setStatus("The playlist is already empty.");
      return;
    }
    player.clear();
    setStatus("Playlist cleared.");
  }

  /** A short, screen-reader-friendly list; long M3U selections stay bounded. */
  function summarizeList(items: string[]): string {
    const shown = items.slice(0, 5);
    const rest = items.length - shown.length;
    return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
  }

  /** Downloads the current playlist as an M3U8 of names and order (T10). */
  function savePlaylist(): void {
    const entries = player.playlist.entries;
    if (entries.length === 0) return;
    const url = URL.createObjectURL(
      new Blob([buildM3u(entries)], { type: "audio/x-mpegurl" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "midi-playlist.m3u8";
    document.body.append(link);
    link.click();
    link.remove();
    // Give the browser time to start the download before releasing the blob.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(
      `Saved ${entries.length} ${entries.length === 1 ? "entry" : "entries"} to midi-playlist.m3u8.`,
    );
  }

  /**
   * Loads a playlist file plus the MIDI files it references. M3U references
   * are names, not bytes, so a reference first resolves against files selected
   * with the playlist and then against the files already in the playlist —
   * re-loading a playlist exported in this session needs no extra selection.
   * New files must be picked with the playlist. Matched files go through the
   * ordinary Load path (replace, stop, persist).
   */
  async function loadPlaylist(files: File[]): Promise<void> {
    const playlists = files.filter((f) => isPlaylistFileName(f.name));
    const midiFiles = files.filter((f) => isMidiFileName(f.name));
    if (playlists.length === 0) {
      setStatus(
        "Select an .m3u or .m3u8 playlist together with its .mid files.",
      );
      return;
    }
    if (playlists.length > 1) {
      setStatus(`Select one playlist at a time (got ${playlists.length}).`);
      return;
    }
    const playlistFile = playlists[0];
    if (playlistFile.size > M3U_MAX_BYTES) {
      setStatus(
        `${playlistFile.name}: playlist file is too large (over 1 MB).`,
      );
      return;
    }
    let text: string;
    try {
      text = await playlistFile.text();
    } catch {
      setStatus(`${playlistFile.name}: could not be read.`);
      return;
    }
    const parsed = parseM3u(text);
    if (parsed.error !== undefined) {
      setStatus(`${playlistFile.name}: ${parsed.error}.`);
      return;
    }
    const existingFiles = player.playlist.entries.map((entry) => entry.file);
    const matched = matchM3u(parsed.tracks, midiFiles, existingFiles);

    const parts: string[] = [];
    if (matched.files.length === 0) {
      if (parsed.tracks.length === 0) {
        parts.push(`${playlistFile.name}: no MIDI file references found.`);
      } else if (midiFiles.length === 0 && existingFiles.length === 0) {
        parts.push(`${playlistFile.name} was selected without its MIDI files.`);
      } else if (midiFiles.length === 0) {
        parts.push(
          `No files from ${playlistFile.name} matched the current playlist.`,
        );
      } else {
        parts.push(
          `No files from ${playlistFile.name} matched the selection or the current playlist.`,
        );
      }
      if (matched.missing.length > 0) {
        parts.push(
          `Not found in the selection or playlist: ${summarizeList(matched.missing)}.`,
        );
      }
      if (parsed.unsupported.length > 0) {
        parts.push(
          `Skipped unsupported: ${summarizeList(parsed.unsupported)}.`,
        );
      }
      parts.push(
        "Select the playlist together with its .mid files, or add those files first. Playlist unchanged.",
      );
      setStatus(parts.join(" "));
      return;
    }

    player.load(matched.files);
    const total = parsed.tracks.length;
    parts.push(
      `Loaded ${matched.files.length} of ${total} ${total === 1 ? "entry" : "entries"} ` +
        `from ${playlistFile.name} - playlist replaced.`,
    );
    if (matched.fromPlaylist > 0) {
      parts.push(
        `Used ${matched.fromPlaylist} ${matched.fromPlaylist === 1 ? "file" : "files"} already in the playlist.`,
      );
    }
    if (matched.missing.length > 0) {
      parts.push(
        `Not found in the selection or playlist: ${summarizeList(matched.missing)}.`,
      );
    }
    if (parsed.unsupported.length > 0) {
      parts.push(`Skipped unsupported: ${summarizeList(parsed.unsupported)}.`);
    }
    if (matched.ambiguous.length > 0) {
      parts.push(
        `Duplicate file names matched in selection order: ${summarizeList(matched.ambiguous)}.`,
      );
    }
    if (matched.extra.length > 0) {
      parts.push(
        `Ignored ${matched.extra.length} selected ${matched.extra.length === 1 ? "file" : "files"} ` +
          `not in the playlist: ${summarizeList(matched.extra.map((f) => f.name))}.`,
      );
    }
    setStatus(parts.join(" "));
  }

  /** Dropping a playlist (with or without its files) loads it; otherwise append. */
  function handleDroppedFiles(files: File[]): void {
    if (files.length === 0) return;
    if (files.some((f) => isPlaylistFileName(f.name))) {
      void loadPlaylist(files);
      return;
    }
    addFiles(files);
  }

  addFilesButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    addFiles(Array.from(fileInput.files ?? []));
    fileInput.value = "";
  });
  loadFilesButton.addEventListener("click", () => loadFileInput.click());
  loadFileInput.addEventListener("change", () => {
    loadFiles(Array.from(loadFileInput.files ?? []));
    loadFileInput.value = "";
  });
  clearPlaylistButton.addEventListener("click", clearPlaylist);
  savePlaylistButton.addEventListener("click", savePlaylist);
  loadPlaylistButton.addEventListener("click", () => playlistFileInput.click());
  playlistFileInput.addEventListener("change", () => {
    const files = Array.from(playlistFileInput.files ?? []);
    playlistFileInput.value = "";
    void loadPlaylist(files);
  });

  function panic(): void {
    if (selectedOutput() === null) {
      player.stop();
      setStatus("Select a MIDI output first.");
      return;
    }
    player.panic();
    setStatus(PANIC_STATUS);
  }

  playButton.addEventListener("click", () => player.togglePlay());
  stopButton.addEventListener("click", () => player.stop());
  previousButton.addEventListener("click", () => player.previous());
  nextButton.addEventListener("click", () => player.next());
  panicButton.addEventListener("click", panic);

  document.addEventListener("keydown", (event) => {
    // The modal owns Escape/Space/arrows while it is open. In particular, Esc
    // must close the viewer, not reach the global Panic shortcut below.
    if (metadataDialog.open) return;
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if (event.key === "Escape") {
      event.preventDefault();
      panic();
    } else if (typing) {
      return;
    } else if (event.key === " " && tag !== "BUTTON") {
      event.preventDefault();
      player.togglePlay();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      player.previous();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      player.next();
    }
  });

  setInterval(updateProgress, 50);
  renderTransport();

  /**
   * The Connect key's LED: red until MIDI access is granted and at least one
   * output is present, green after that. The LCD status line carries the words
   * for assistive tech.
   */
  function renderConnectionLed(): void {
    const connected =
      synth.isSelected() || (midi.connected && midi.listOutputs().length > 0);
    connectLed.dataset.state = connected ? "connected" : "disconnected";
  }

  /** (Re)build the picker from the current output list plus the built-in synth. */
  function renderOutputs(): void {
    const outputs = midi.listOutputs();
    outputPicker.replaceChildren(
      new Option("Select an output…", ""),
      ...outputs.map((o) => new Option(`${o.name} (${o.manufacturer})`, o.id)),
      // The software synth needs no permission and no hardware, so it is
      // offered (and the picker enabled) before Connect devices is pressed.
      ...(synth.supported
        ? [new Option(SYNTH_OUTPUT_NAME, SYNTH_OUTPUT_ID)]
        : []),
    );
    outputPicker.disabled = false;
    // Selecting the built-in synth only happens when it is supported, so the
    // value always matches an option in the list.
    outputPicker.value = synth.selectedId() ?? midi.selectedId() ?? "";
    renderConnectionLed();
  }

  const monitor = new AudioMonitor({
    onStatus: setStatus,
    onDevicesChanged: () => renderAudioDevices(),
    onInputLost: () => renderAudioDevices(),
  });
  let audioReady = false;

  /** (Re)build both audio pickers from the monitor's device lists. */
  function renderAudioDevices(): void {
    audioInputPicker.replaceChildren(
      new Option("Select an input…", ""),
      ...monitor.inputs().map((d) => new Option(d.label, d.id)),
    );
    audioInputPicker.value = monitor.selectedInput ?? "";
    audioInputPicker.disabled = !audioReady;

    const hasOutputChoice = monitor.routing !== "default";
    audioOutputRow.hidden = !hasOutputChoice;
    audioOutputNote.hidden = hasOutputChoice;
    audioOutputPicker.replaceChildren(
      new Option("System default", ""),
      ...monitor.outputs().map((d) => new Option(d.label, d.id)),
    );
    audioOutputPicker.value = monitor.selectedOutput;
    audioOutputPicker.disabled = !audioReady;
    grantOutputButton.hidden = !monitor.canSelectAudioOutput;
    grantOutputButton.disabled = !audioReady;
    updateFeedbackWarning();
  }

  function updateFeedbackWarning(): void {
    // The panel notice below the audio pickers is the only feedback warning:
    // the LCD status line stays reserved for device and file status.
    const shared = monitor.sharesDevice();
    feedbackWarning.hidden = !shared;
  }

  /** Mirrors the monitor's mute/volume (restored from storage) into the controls. */
  function renderMonitorControls(): void {
    const muted = monitor.muted;
    muteButton.setAttribute("aria-pressed", String(muted));
    // The key caption stays "Mute"; the old visible label is kept as the
    // accessible name so the control's name does not change in the reskin.
    muteButton.setAttribute("aria-label", muted ? "🔇 Muted" : "🔊 Monitoring");
    muteLed.dataset.lit = String(muted);
    const percent = Math.round(monitor.volume * 100);
    volumeSlider.value = String(percent);
    volumeText.textContent = `${percent}%`;
    // The knob is pure CSS: its rotation follows the range input's value.
    knob.style.setProperty("--turn", String(percent / 100));
  }

  /** Lights the bottom `lit` segments of one ladder; 1 is the bottom segment. */
  function renderLadder(leds: HTMLElement[], db: number): void {
    const fraction = Math.max(0, Math.min(1, (db - -60) / 60));
    const lit = Math.round(fraction * LADDER_SEGMENTS);
    for (const led of leds) {
      const on = String(Number(led.dataset.level) <= lit);
      if (led.dataset.lit !== on) led.dataset.lit = on;
    }
  }

  const formatDb = (db: number): string =>
    db <= DB_FLOOR ? "−∞" : db.toFixed(1).replace("-", "−");
  let clipUntil = 0;
  let meterDescribedAt = -Infinity;

  /**
   * The ladders are the visual meter; the level is exposed through the meter's
   * `aria-valuetext` (T8 removed the visible numeric readout). Throttled to
   * ~10 Hz so a screen reader is not flooded by animation frames.
   */
  function describeMeter(now: number, left: number, right: number): void {
    if (now - meterDescribedAt < 100) return;
    meterDescribedAt = now;
    const text = `Left ${formatDb(left)} dBFS, Right ${formatDb(right)} dBFS`;
    if (meter.getAttribute("aria-valuetext") !== text) {
      meter.setAttribute("aria-valuetext", text);
      const loudest = Math.min(0, Math.max(DB_FLOOR, Math.max(left, right)));
      meter.setAttribute(
        "aria-valuenow",
        String(Math.round(loudest * 10) / 10),
      );
    }
  }

  /** Meter and clip LED, driven by requestAnimationFrame. */
  function meterFrame(now: number): void {
    const { left, right } = monitor.peaks();
    renderLadder(levelLeds.left, left);
    renderLadder(levelLeds.right, right);
    describeMeter(now, left, right);
    if (Math.max(left, right) > CLIP_THRESHOLD_DB) clipUntil = now + 1000;
    const clipping = now <= clipUntil;
    for (const led of clipLeds) {
      if (led.hidden !== !clipping) led.hidden = !clipping;
    }
    requestAnimationFrame(meterFrame);
  }

  audioInputPicker.addEventListener("change", () => {
    const requested = audioInputPicker.value || null;
    void monitor.selectInput(requested).then((selected) => {
      // A failed open leaves the picker showing a device that is not monitored;
      // put it back on whatever is actually captured. Skip this if the user has
      // already picked another device while this one was opening.
      if (!selected && audioInputPicker.value === (requested ?? "")) {
        audioInputPicker.value = monitor.selectedInput ?? "";
      }
      updateFeedbackWarning();
    });
  });
  audioOutputPicker.addEventListener("change", () => {
    void monitor.selectOutput(audioOutputPicker.value).then(() => {
      audioOutputPicker.value = monitor.selectedOutput;
      updateFeedbackWarning();
    });
  });
  grantOutputButton.addEventListener("click", () => {
    void monitor.grantOutput().then(() => renderAudioDevices());
  });
  muteButton.addEventListener("click", () => {
    monitor.setMuted(!monitor.muted);
    renderMonitorControls();
  });
  volumeSlider.addEventListener("input", () => {
    monitor.setVolume(Number(volumeSlider.value) / 100);
    renderMonitorControls();
  });

  /**
   * T19: the knob is a relative vertical drag — up increases, down decreases —
   * with the change taken from the pointer delta, never from the pointer's
   * position. The range input stays the accessible control and the single
   * source of truth; only its native pointer drag is replaced (the input is
   * `pointer-events: none`, so the gesture lands on `.knob-wrap`). The value is
   * accumulated separately from the input so sub-step movement still adds up:
   * reading the rounded percentage back each move would dead-zone slow drags.
   */
  let knobDrag: { pointerId: number; lastY: number; value: number } | null =
    null;

  function endKnobDrag(event: PointerEvent): void {
    if (knobDrag === null || event.pointerId !== knobDrag.pointerId) return;
    knobDrag = null;
    delete knobWrap.dataset.dragging;
    document.body.classList.remove("knob-dragging");
    if (knobWrap.hasPointerCapture(event.pointerId))
      knobWrap.releasePointerCapture(event.pointerId);
  }

  knobWrap.addEventListener("pointerdown", (event) => {
    // Primary button / first touch only: a right-click is not a drag, and a
    // second pointer must never take over a drag that is already in progress.
    if (event.button !== 0 || knobDrag !== null) return;
    knobDrag = {
      pointerId: event.pointerId,
      lastY: event.clientY,
      value: Number(volumeSlider.value),
    };
    // Capture keeps the gesture tracking once the finger leaves the knob.
    knobWrap.setPointerCapture(event.pointerId);
    knobWrap.dataset.dragging = "true";
    document.body.classList.add("knob-dragging");
    // The input can no longer be clicked through (`pointer-events: none`), so
    // keep the click-to-focus behaviour of the control the knob replaces.
    volumeSlider.focus({ preventScroll: true });
    // No text selection, and no scroll from the pointer gesture itself.
    event.preventDefault();
  });

  knobWrap.addEventListener("pointermove", (event) => {
    if (knobDrag === null || event.pointerId !== knobDrag.pointerId) return;
    const dy = knobDrag.lastY - event.clientY;
    if (dy === 0) return;
    knobDrag.lastY = event.clientY;
    const scale = event.shiftKey ? KNOB_FINE_SCALE : 1;
    knobDrag.value = Math.min(
      100,
      Math.max(0, knobDrag.value + (dy / KNOB_TRAVEL_PX) * 100 * scale),
    );
    volumeSlider.value = String(knobDrag.value);
    monitor.setVolume(Number(volumeSlider.value) / 100);
    renderMonitorControls();
  });

  knobWrap.addEventListener("pointerup", endKnobDrag);
  knobWrap.addEventListener("pointercancel", endKnobDrag);
  knobWrap.addEventListener("lostpointercapture", endKnobDrag);

  if (!monitor.supported) {
    monitorUnavailable.hidden = false;
    setStatus("Audio monitoring is unavailable in this browser.");
  }
  renderAudioDevices();
  renderMonitorControls();
  // The built-in synth needs no permission, so it is in the picker from the
  // start; MIDI devices join it once Connect devices has been pressed.
  renderOutputs();
  requestAnimationFrame(meterFrame);

  async function connectDevices(): Promise<void> {
    connectButton.disabled = true;
    retryButton.hidden = true;
    try {
      // Both prompts must be triggered from this user gesture.
      const [midiGranted, micGranted] = await Promise.all([
        midi.connect(),
        monitor.unlock(),
      ]);
      renderConnectionLed();
      audioReady = micGranted;
      renderAudioDevices();

      const parts: string[] = [];
      if (midiGranted) {
        const count = midi.listOutputs().length;
        parts.push(count > 0 ? "Connected." : "Connected, no MIDI outputs.");
      } else {
        parts.push("MIDI access denied or cancelled.");
      }
      parts.push(
        micGranted
          ? "Microphone access granted."
          : "Microphone permission not granted.",
      );
      setStatus(parts.join(" "));

      if (midiGranted) {
        firefoxOnboarding.hidden = true;
        if (midi.listOutputs().length === 0) {
          retryButton.hidden = false;
          retryButton.textContent = "Refresh";
        }
      } else {
        // Denied/cancelled (or unsupported): offer the retry path.
        retryButton.hidden = false;
        retryButton.textContent = "Retry";
      }
    } catch {
      renderConnectionLed();
      setStatus(
        'Connecting devices failed - click "Connect devices" to retry.',
      );
      retryButton.hidden = false;
      retryButton.textContent = "Retry";
    } finally {
      connectButton.disabled = false;
    }
  }

  /**
   * Picking the built-in synth loads its SoundFont first (about 8.4 MB) and
   * only then takes over as the selected output, so playback can never start
   * against a half-loaded instrument.
   */
  let synthLoading = false;
  async function chooseBuiltInSynth(): Promise<void> {
    if (synthLoading) return;
    synthLoading = true;
    outputPicker.disabled = true;
    setStatus("Loading the built-in synth…");
    try {
      await synth.prepare();
      // One output at a time: a hardware selection left in place would come
      // back the moment the synth were deselected.
      midi.clear();
      synth.select();
      if (player.state !== "stopped") player.stop();
      setStatus("SpessaSynth ready.");
    } catch (error) {
      synth.deselect();
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(`The built-in synth could not start: ${detail}`);
    } finally {
      synthLoading = false;
      renderOutputs();
    }
  }

  function handlePickerChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value === SYNTH_OUTPUT_ID) {
      void chooseBuiltInSynth();
      return;
    }
    synth.deselect();
    if (value !== "") midi.select(value);
  }

  connectButton.addEventListener("click", () => {
    void connectDevices();
  });
  retryButton.addEventListener("click", () => {
    void connectDevices();
  });
  outputPicker.addEventListener("change", handlePickerChange);

  if (typeof navigator.requestMIDIAccess !== "function") {
    // Show a notice instead of a broken UI (ticket T1) and announce it in the
    // single aria-live region (ticket T5).
    unsupportedNotice.hidden = false;
    connectButton.disabled = true;
    setStatus(
      "This browser does not support Web MIDI. Use a current desktop version of Chrome, Edge, or Firefox.",
    );
  } else {
    // Explain the add-on permission prompt *before* the first click.
    if (isFirefox()) firefoxOnboarding.hidden = false;
    // Until the user connects, the LCD spells out the device state.
    setStatus("Devices not connected");
  }

  /** The stored disclosure state; a missing or unreadable value means expanded. */
  function readQuickstartExpanded(): boolean {
    try {
      return localStorage.getItem(QUICKSTART_STORAGE_KEY) !== "0";
    } catch {
      return true;
    }
  }

  /** Applies the disclosure, optionally remembering the choice. */
  function setQuickstartExpanded(expand: boolean, persist: boolean): void {
    quickstartToggle.setAttribute("aria-expanded", String(expand));
    quickstartToggle.textContent = expand ? "Hide info" : "Show info";
    quickstartBody.hidden = !expand;
    if (!persist) return;
    try {
      localStorage.setItem(QUICKSTART_STORAGE_KEY, expand ? "1" : "0");
    } catch {
      // Private mode or a full store: the toggle still works for this visit.
    }
  }

  setQuickstartExpanded(readQuickstartExpanded(), false);
  quickstartToggle.addEventListener("click", () => {
    setQuickstartExpanded(
      quickstartToggle.getAttribute("aria-expanded") !== "true",
      true,
    );
  });

  renderConnectionLed();

  // The player restores a saved playlist without emitting a change; show it.
  renderPlaylist();
  renderInstruments();
  void seedSampleSong();

  /**
   * First-run sample (T12): a profile whose playlist store has never been
   * written starts with the bundled song, on the ordinary add/persist path, so
   * the transport, LCD and part map have something to play before the user has
   * picked any files. Fire-and-forget: it must not delay first paint or block
   * Connect devices, and it never throws.
   *
   * Success is silent — the row and its duration are the feedback. Failure says
   * one line in the status region and leaves the app fully usable, and is not
   * retried this session.
   */
  async function seedSampleSong(): Promise<void> {
    if (!player.needsSeed()) return;
    try {
      const response = await fetch(sampleSongUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      // Re-check after every await: the user may have added, loaded or cleared
      // files while this was in flight, and the sample must never override them.
      if (!player.needsSeed()) return;
      // An error page or a truncated asset must not become a persisted row.
      if (!hasMidiHeader(bytes)) throw new Error("not a MIDI file");
      player.seed(
        new File([bytes], `${SAMPLE_SONG_NAME}.mid`, { type: "audio/midi" }),
      );
    } catch {
      setStatus("Could not load the sample song — add files to start.");
    }
  }
}
