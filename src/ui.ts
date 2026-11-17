/**
 * Single-screen UI: header (app name, notices, Connect devices, status) plus
 * the playback / playlist / audio-monitor panels. All user-visible status is
 * written to the one aria-live region. The layout is a plain DOM build with
 * native controls, so it is keyboard-accessible by construction.
 * See the design doc, "UI" and "MIDI output > Device access".
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

  if (typeof navigator.requestMIDIAccess !== 'function') {
    // Show a notice instead of a broken UI (ticket T1).
    root.querySelector<HTMLElement>('[data-testid="unsupported-notice"]')!.hidden = false;
    root.querySelector<HTMLButtonElement>('[data-testid="connect-button"]')!.disabled = true;
  }
}
