/**
 * Single-screen UI: header (app name, notices, Connect devices, status) plus
 * the playback / playlist / audio-monitor panels. All user-visible status is
 * written to the one aria-live region. The layout is a plain DOM build with
 * native controls, so it is keyboard-accessible by construction.
 * See the design doc, "UI" and "MIDI output > Device access".
 */

import { MidiDevices } from './midiDevices';

/**
 * Builds the layout into `root` and wires the Connect devices flow:
 * one click triggers *both* the Web MIDI and the microphone permission
 * prompts (both must originate from this user gesture).
 */
export function createUi(root: HTMLElement): void {
  root.innerHTML = `
    <header class="panel" data-testid="header" aria-label="App header">
      <h1>External MIDI Player</h1>
      <p class="notice" data-testid="unsupported-notice" hidden>
        This browser does not support Web MIDI. Use a current desktop version
        of Chrome, Edge, or Firefox to connect MIDI devices.
      </p>
      <p class="notice" data-testid="firefox-onboarding" hidden>
        Firefox may ask you to install a Web MIDI site permission before it
        can list MIDI devices. That prompt is safe — it only lets this page
        talk to your MIDI hardware. Click "Connect devices", then allow the
        permission when asked.
      </p>
      <div class="actions">
        <button type="button" data-testid="connect-button">Connect devices</button>
        <button type="button" data-testid="retry-button" hidden>Retry</button>
      </div>
      <p class="status-region" role="status" aria-live="polite" data-testid="status-region"></p>
    </header>
    <section class="panel" data-testid="playback-panel" aria-labelledby="playback-heading">
      <h2 id="playback-heading">Playback</h2>
      <div class="row">
        <label for="midi-output">MIDI output</label>
        <select id="midi-output" data-testid="output-picker" disabled>
          <option value="">Select an output…</option>
        </select>
      </div>
      <p data-testid="playback-state" data-state="stopped">Nothing playing.</p>
    </section>
    <section class="panel" data-testid="playlist-panel" aria-labelledby="playlist-heading">
      <h2 id="playlist-heading">Playlist</h2>
      <p>No songs yet.</p>
    </section>
    <section class="panel" data-testid="monitor-panel" aria-labelledby="monitor-heading">
      <h2 id="monitor-heading">Audio monitor</h2>
      <p>Device monitoring is not connected yet.</p>
    </section>
  `;

  const connectButton = root.querySelector<HTMLButtonElement>('[data-testid="connect-button"]')!;
  const retryButton = root.querySelector<HTMLButtonElement>('[data-testid="retry-button"]')!;
  const unsupportedNotice = root.querySelector<HTMLElement>('[data-testid="unsupported-notice"]')!;
  const firefoxOnboarding = root.querySelector<HTMLElement>('[data-testid="firefox-onboarding"]')!;
  const outputPicker = root.querySelector<HTMLSelectElement>('[data-testid="output-picker"]')!;
  const playbackState = root.querySelector<HTMLElement>('[data-testid="playback-state"]')!;

  const statusRegion = root.querySelector<HTMLElement>('[data-testid="status-region"]')!;
  function setStatus(message: string): void {
    statusRegion.textContent = message;
  }

  function isFirefox(): boolean {
    return /firefox/i.test(navigator.userAgent);
  }

  const midi = new MidiDevices({
    onStatus: setStatus,
    onOutputsChanged: () => renderOutputs(),
    onSelectionChange: (id) => {
      outputPicker.value = id ?? '';
      if (id === null) setPlaybackState('stopped', 'Nothing playing.');
    },
    onSelectedOutputLost: () => {
      // T3 wires the scheduler stop; for now the playback panel reports it.
      setPlaybackState('stopped', 'Nothing playing.');
      setStatus('MIDI output disconnected — playback stopped.');
    },
  });

  function setPlaybackState(state: string, text: string): void {
    playbackState.dataset.state = state;
    playbackState.textContent = text;
  }

  /** (Re)build the picker from the current output list. */
  function renderOutputs(): void {
    const outputs = midi.listOutputs();
    outputPicker.replaceChildren(
      new Option('Select an output…', ''),
      ...outputs.map((o) => new Option(`${o.name} (${o.manufacturer})`, o.id)),
    );
    outputPicker.disabled = false;
    outputPicker.value = midi.selectedId() ?? '';
  }

  /**
   * Request microphone permission so the permission prompt appears in the
   * same gesture as the MIDI one. T4 owns the capture graph; the tracks are
   * stopped immediately — this only warms up the permission.
   */
  async function requestMicrophonePermission(): Promise<boolean> {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      return false;
    }
    try {
      const stream = await mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      return true;
    } catch {
      return false;
    }
  }

  async function connectDevices(): Promise<void> {
    connectButton.disabled = true;
    retryButton.hidden = true;
    // Both prompts must be triggered from this user gesture.
    const [midiGranted, micGranted] = await Promise.all([
      midi.connect(),
      requestMicrophonePermission(),
    ]);
    connectButton.disabled = false;

    const parts: string[] = [];
    if (midiGranted) {
      const count = midi.listOutputs().length;
      parts.push(
        count > 0
          ? `Connected — ${count} MIDI output${count === 1 ? '' : 's'} found.`
          : 'Connected — no MIDI outputs found yet.',
      );
    } else {
      parts.push('MIDI access denied or cancelled.');
    }
    parts.push(micGranted ? 'Microphone access granted.' : 'Microphone permission not granted.');
    setStatus(parts.join(' '));

    if (midiGranted) {
      firefoxOnboarding.hidden = true;
      if (midi.listOutputs().length === 0) {
        retryButton.hidden = false;
        retryButton.textContent = 'Refresh';
      }
    } else {
      // Denied/cancelled (or unsupported): offer the retry path.
      retryButton.hidden = false;
      retryButton.textContent = 'Retry';
    }
  }

  function handlePickerChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value !== '') midi.select(value);
  }

  connectButton.addEventListener('click', () => {
    void connectDevices();
  });
  retryButton.addEventListener('click', () => {
    void connectDevices();
  });
  outputPicker.addEventListener('change', handlePickerChange);

  if (typeof navigator.requestMIDIAccess !== 'function') {
    // Show a notice instead of a broken UI (ticket T1).
    unsupportedNotice.hidden = false;
    connectButton.disabled = true;
  } else if (isFirefox()) {
    // Explain the add-on permission prompt *before* the first click.
    firefoxOnboarding.hidden = false;
  }
}
