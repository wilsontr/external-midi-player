/**
 * Single-screen UI: header (app name, notices, Connect devices, status) plus
 * the playback / playlist / audio-monitor panels. All user-visible status is
 * written to the one aria-live region. The layout is a plain DOM build with
 * native controls, so it is keyboard-accessible by construction.
 * See the design doc, "UI" and "MIDI output > Device access".
 */

import { AudioMonitor, CLIP_THRESHOLD_DB, DB_FLOOR } from './audioMonitor';
import { MidiDevices } from './midiDevices';
import { PlaylistPlayer, type PlaylistEntry } from './playlist';

/** Formats seconds as m:ss, optionally with tenths (for the elapsed readout). */
function formatTime(seconds: number, tenths = false): string {
  const clamped = Math.max(0, seconds);
  const whole = Math.floor(clamped);
  const m = Math.floor(whole / 60);
  const sec = String(whole % 60).padStart(2, '0');
  return tenths ? `${m}:${sec}.${Math.floor((clamped - whole) * 10)}` : `${m}:${sec}`;
}

const ENTRY_DRAG_TYPE = 'application/x-midi-entry';

/**
 * Builds the layout into `root` and wires the Connect devices flow:
 * one click triggers *both* the Web MIDI and the microphone permission
 * prompts (both must originate from this user gesture).
 */
export function createUi(root: HTMLElement): void {
  root.innerHTML = `
    <header class="panel" data-testid="header" aria-label="App header">
      <h1>External MIDI Player</h1>
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
      <p class="current-title" data-testid="current-title">No song selected.</p>
      <div class="actions" role="group" aria-label="Transport">
        <button type="button" data-testid="previous-button">⏮ Previous</button>
        <button type="button" data-testid="play-button">▶ Play</button>
        <button type="button" data-testid="stop-button">⏹ Stop</button>
        <button type="button" data-testid="next-button">⏭ Next</button>
        <button type="button" class="danger" data-testid="panic-button">Panic</button>
      </div>
      <div class="row progress-row">
        <progress max="1" value="0" aria-label="Playback position" data-testid="progress"></progress>
        <span data-testid="time-display">0:00.0 / 0:00</span>
      </div>
      <p class="hint">Shortcuts: Space play/pause · Esc panic · ← previous · → next</p>
      <p data-testid="playback-state" data-state="stopped">Nothing playing.</p>
    </section>
    <section class="panel" data-testid="monitor-panel" aria-labelledby="monitor-heading">
      <h2 id="monitor-heading">Audio monitor</h2>
      <p class="notice" data-testid="monitor-unavailable" hidden>
        This browser cannot capture audio, so monitoring is unavailable.
      </p>
      <div class="row">
        <label for="audio-input">Input</label>
        <select id="audio-input" data-testid="audio-input-picker" disabled>
          <option value="">Select an input…</option>
        </select>
      </div>
      <div class="row" data-testid="audio-output-row">
        <label for="audio-output">Output</label>
        <select id="audio-output" data-testid="audio-output-picker" disabled>
          <option value="">System default</option>
        </select>
        <button type="button" data-testid="grant-output-button" hidden>Choose output device…</button>
      </div>
      <p class="hint" data-testid="audio-output-note" hidden>
        This browser cannot choose a monitoring output, so audio plays to the system default output.
      </p>
      <div class="row">
        <button type="button" data-testid="mute-button" aria-pressed="true">🔇 Muted</button>
        <label for="monitor-volume">Volume</label>
        <input type="range" id="monitor-volume" min="0" max="100" value="100" data-testid="volume-slider" />
        <span data-testid="volume-text">100%</span>
      </div>
      <div class="meter" data-testid="meter" role="img" aria-label="Input level meter">
        <div class="meter-bar"><div class="meter-fill" data-testid="meter-left"></div></div>
        <div class="meter-bar"><div class="meter-fill" data-testid="meter-right"></div></div>
      </div>
      <p class="row">
        <span data-testid="meter-text">L −∞ · R −∞ dBFS</span>
        <span class="clip" data-testid="clip-indicator" hidden>CLIP</span>
      </p>
      <p data-testid="latency-readout">Browser latency: —</p>
      <p class="notice" data-testid="feedback-warning" hidden>
        The input and output are the same device. Unmute with care: a microphone near the
        speakers can cause feedback.
      </p>
    </section>
    <section class="panel" data-testid="playlist-panel" aria-labelledby="playlist-heading">
      <h2 id="playlist-heading">Playlist</h2>
      <div class="drop-zone" data-testid="drop-zone">
        <span>Drop .mid files here, or</span>
        <button type="button" data-testid="add-files-button">Add files</button>
        <input type="file" multiple accept=".mid,.midi" hidden data-testid="file-input" />
      </div>
      <p data-testid="playlist-empty">No songs yet.</p>
      <ol class="playlist" aria-label="Playlist" data-testid="playlist"></ol>
    </section>
  `;

  const connectButton = root.querySelector<HTMLButtonElement>('[data-testid="connect-button"]')!;
  const retryButton = root.querySelector<HTMLButtonElement>('[data-testid="retry-button"]')!;
  const unsupportedNotice = root.querySelector<HTMLElement>('[data-testid="unsupported-notice"]')!;
  const firefoxOnboarding = root.querySelector<HTMLElement>('[data-testid="firefox-onboarding"]')!;
  const outputPicker = root.querySelector<HTMLSelectElement>('[data-testid="output-picker"]')!;
  const playbackState = root.querySelector<HTMLElement>('[data-testid="playback-state"]')!;
  const currentTitle = root.querySelector<HTMLElement>('[data-testid="current-title"]')!;
  const playButton = root.querySelector<HTMLButtonElement>('[data-testid="play-button"]')!;
  const stopButton = root.querySelector<HTMLButtonElement>('[data-testid="stop-button"]')!;
  const previousButton = root.querySelector<HTMLButtonElement>('[data-testid="previous-button"]')!;
  const nextButton = root.querySelector<HTMLButtonElement>('[data-testid="next-button"]')!;
  const panicButton = root.querySelector<HTMLButtonElement>('[data-testid="panic-button"]')!;
  const progress = root.querySelector<HTMLProgressElement>('[data-testid="progress"]')!;
  const timeDisplay = root.querySelector<HTMLElement>('[data-testid="time-display"]')!;
  const audioInputPicker = root.querySelector<HTMLSelectElement>('[data-testid="audio-input-picker"]')!;
  const audioOutputPicker = root.querySelector<HTMLSelectElement>('[data-testid="audio-output-picker"]')!;
  const audioOutputRow = root.querySelector<HTMLElement>('[data-testid="audio-output-row"]')!;
  const audioOutputNote = root.querySelector<HTMLElement>('[data-testid="audio-output-note"]')!;
  const grantOutputButton = root.querySelector<HTMLButtonElement>('[data-testid="grant-output-button"]')!;
  const monitorUnavailable = root.querySelector<HTMLElement>('[data-testid="monitor-unavailable"]')!;
  const muteButton = root.querySelector<HTMLButtonElement>('[data-testid="mute-button"]')!;
  const volumeSlider = root.querySelector<HTMLInputElement>('[data-testid="volume-slider"]')!;
  const volumeText = root.querySelector<HTMLElement>('[data-testid="volume-text"]')!;
  const meterLeft = root.querySelector<HTMLElement>('[data-testid="meter-left"]')!;
  const meterRight = root.querySelector<HTMLElement>('[data-testid="meter-right"]')!;
  const meterText = root.querySelector<HTMLElement>('[data-testid="meter-text"]')!;
  const clipIndicator = root.querySelector<HTMLElement>('[data-testid="clip-indicator"]')!;
  const latencyReadout = root.querySelector<HTMLElement>('[data-testid="latency-readout"]')!;
  const feedbackWarning = root.querySelector<HTMLElement>('[data-testid="feedback-warning"]')!;
  const playlistPanel = root.querySelector<HTMLElement>('[data-testid="playlist-panel"]')!;
  const dropZone = root.querySelector<HTMLElement>('[data-testid="drop-zone"]')!;
  const addFilesButton = root.querySelector<HTMLButtonElement>('[data-testid="add-files-button"]')!;
  const fileInput = root.querySelector<HTMLInputElement>('[data-testid="file-input"]')!;
  const playlistEmpty = root.querySelector<HTMLElement>('[data-testid="playlist-empty"]')!;
  const playlistList = root.querySelector<HTMLOListElement>('[data-testid="playlist"]')!;

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
      // Switching outputs mid-song: release on the old one, don't carry over.
      if (id !== null && player.state !== 'stopped') player.stop();
    },
    onSelectedOutputLost: () => {
      player.outputLost();
      setStatus('MIDI output disconnected — playback stopped.');
    },
  });

  const player = new PlaylistPlayer({
    getOutput: () => midi.selectedOutput(),
    onChange: () => {
      renderTransport();
      renderPlaylist();
    },
    onStatus: setStatus,
  });

  const STATE_TEXT = { stopped: 'Nothing playing.', playing: 'Playing', paused: 'Paused' };

  function renderTransport(): void {
    const state = player.state;
    playButton.textContent = state === 'playing' ? '⏸ Pause' : '▶ Play';
    playbackState.dataset.state = state;
    playbackState.textContent = STATE_TEXT[state];
    currentTitle.textContent = player.currentEntry()?.name ?? 'No song selected.';
    updateProgress();
  }

  /** Refreshes the progress bar and elapsed / total readout (runs 20×/s). */
  function updateProgress(): void {
    const total = player.currentEntry()?.durationSec ?? 0;
    const position = total > 0 ? Math.min(player.position(), total) : player.position();
    const value = total > 0 ? position / total : 0;
    if (progress.value !== value) progress.value = value;
    const text = `${formatTime(position, true)} / ${formatTime(total)}`;
    if (timeDisplay.textContent !== text) timeDisplay.textContent = text;
  }

  const rows = new Map<string, HTMLLIElement>();

  function createRow(id: string): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'playlist-row';
    li.setAttribute('data-testid', 'playlist-row');
    li.dataset.id = id;
    li.draggable = true;
    li.innerHTML = `
      <span class="drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
      <span class="entry-name" data-testid="entry-name"></span>
      <span class="entry-duration" data-testid="entry-duration"></span>
      <span class="entry-status" data-testid="entry-status"></span>
      <span class="entry-buttons">
        <button type="button" data-action="play">▶</button>
        <button type="button" data-action="up">↑</button>
        <button type="button" data-action="down">↓</button>
        <button type="button" data-action="remove">✕</button>
      </span>`;
    return li;
  }

  function updateRow(li: HTMLLIElement, entry: PlaylistEntry, isCurrent: boolean): void {
    const set = (testId: string, text: string): void => {
      const el = li.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
      if (el.textContent !== text) el.textContent = text;
    };
    set('entry-name', entry.name);
    set('entry-duration', entry.durationSec === undefined ? (entry.status === 'error' ? '—' : '…') : formatTime(entry.durationSec));
    set('entry-status', entry.status === 'error' ? `Error: ${entry.error ?? 'unreadable'}` : 'Ready');
    li.dataset.status = entry.status;
    li.classList.toggle('current', isCurrent);
    if (isCurrent) li.setAttribute('aria-current', 'true');
    else li.removeAttribute('aria-current');
    const label = (action: string, text: string): void => {
      li.querySelector(`[data-action="${action}"]`)!.setAttribute('aria-label', `${text} ${entry.name}`);
    };
    label('play', 'Play');
    label('up', 'Move up');
    label('down', 'Move down');
    label('remove', 'Remove');
    li.querySelector<HTMLButtonElement>('[data-action="play"]')!.disabled = entry.status === 'error';
  }

  /** Keyed reconcile: rows are reused so focus and drag state survive updates. */
  function renderPlaylist(): void {
    const { entries, currentId } = player.playlist;
    playlistEmpty.hidden = entries.length > 0;
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
      updateRow(li, entry, entry.id === currentId);
      if (playlistList.children[index] !== li) {
        playlistList.insertBefore(li, playlistList.children[index] ?? null);
      }
    });
  }

  function entryIndex(id: string): number {
    return player.playlist.entries.findIndex((e) => e.id === id);
  }

  function addFiles(files: File[]): void {
    if (files.length === 0) return;
    const { added, rejected } = player.add(files);
    const parts: string[] = [];
    if (added > 0) parts.push(`Added ${added} file${added === 1 ? '' : 's'}.`);
    if (rejected.length > 0) {
      parts.push(
        `Rejected ${rejected.length} file${rejected.length === 1 ? '' : 's'} (not .mid or .midi): ${rejected.join(', ')}`,
      );
    }
    setStatus(parts.join(' '));
  }

  playlistList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('button[data-action]');
    const li = target.closest<HTMLLIElement>('li');
    if (!li) return;
    const id = li.dataset.id!;
    if (!button) {
      // Clicking anywhere else in the row plays that entry from the start.
      player.playEntry(id);
      return;
    }
    const index = entryIndex(id);
    switch (button.dataset.action) {
      case 'play':
        player.playEntry(id);
        break;
      case 'remove':
        player.remove(id);
        break;
      case 'up':
      case 'down': {
        const toIndex = button.dataset.action === 'up' ? index - 1 : index + 1;
        if (toIndex < 0 || toIndex >= player.playlist.entries.length) break;
        player.move(id, toIndex);
        // Moving the row in the DOM drops focus; put it back on the same button.
        button.focus();
        break;
      }
    }
  });

  // Drag to reorder (internal rows only; external files are handled below).
  let draggedId: string | null = null;
  function clearDropMarks(): void {
    for (const li of rows.values()) li.classList.remove('drop-before', 'drop-after');
  }
  playlistList.addEventListener('dragstart', (event) => {
    const li = (event.target as HTMLElement).closest<HTMLLIElement>('li');
    if (!li || !event.dataTransfer) return;
    draggedId = li.dataset.id!;
    event.dataTransfer.setData(ENTRY_DRAG_TYPE, draggedId);
    event.dataTransfer.effectAllowed = 'move';
  });
  playlistList.addEventListener('dragover', (event) => {
    if (draggedId === null) return;
    event.preventDefault();
    clearDropMarks();
    const li = (event.target as HTMLElement).closest<HTMLLIElement>('li');
    if (!li) return;
    const rect = li.getBoundingClientRect();
    li.classList.add(event.clientY > rect.top + rect.height / 2 ? 'drop-after' : 'drop-before');
  });
  playlistList.addEventListener('drop', (event) => {
    if (draggedId === null) return;
    event.preventDefault();
    const id = draggedId;
    draggedId = null;
    clearDropMarks();
    const from = entryIndex(id);
    const li = (event.target as HTMLElement).closest<HTMLLIElement>('li');
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
  playlistList.addEventListener('dragend', () => {
    draggedId = null;
    clearDropMarks();
  });

  // File drops: on the playlist panel; stray drops elsewhere must not navigate away.
  const hasFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');
  playlistPanel.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dropZone.classList.add('drag-over');
  });
  playlistPanel.addEventListener('dragleave', (event) => {
    if (!playlistPanel.contains(event.relatedTarget as Node | null)) {
      dropZone.classList.remove('drag-over');
    }
  });
  playlistPanel.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dropZone.classList.remove('drag-over');
    addFiles(Array.from(event.dataTransfer?.files ?? []));
  });
  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });

  addFilesButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files ?? []));
    fileInput.value = '';
  });

  function panic(): void {
    if (midi.selectedOutput() === null) {
      player.stop();
      setStatus('Select a MIDI output first.');
      return;
    }
    player.panic();
    setStatus('Panic: all notes off sent on all 16 channels.');
  }

  playButton.addEventListener('click', () => player.togglePlay());
  stopButton.addEventListener('click', () => player.stop());
  previousButton.addEventListener('click', () => player.previous());
  nextButton.addEventListener('click', () => player.next());
  panicButton.addEventListener('click', panic);

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (event.key === 'Escape') {
      event.preventDefault();
      panic();
    } else if (typing) {
      return;
    } else if (event.key === ' ' && tag !== 'BUTTON') {
      event.preventDefault();
      player.togglePlay();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      player.previous();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      player.next();
    }
  });

  setInterval(updateProgress, 50);
  renderTransport();

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

  const monitor = new AudioMonitor({
    onStatus: setStatus,
    onDevicesChanged: () => renderAudioDevices(),
    onInputLost: () => renderAudioDevices(),
  });
  let audioReady = false;
  let warningShown = false;

  /** (Re)build both audio pickers from the monitor's device lists. */
  function renderAudioDevices(): void {
    audioInputPicker.replaceChildren(
      new Option('Select an input…', ''),
      ...monitor.inputs().map((d) => new Option(d.label, d.id)),
    );
    audioInputPicker.value = monitor.selectedInput ?? '';
    audioInputPicker.disabled = !audioReady;

    const hasOutputChoice = monitor.routing !== 'default';
    audioOutputRow.hidden = !hasOutputChoice;
    audioOutputNote.hidden = hasOutputChoice;
    audioOutputPicker.replaceChildren(
      new Option('System default', ''),
      ...monitor.outputs().map((d) => new Option(d.label, d.id)),
    );
    audioOutputPicker.value = monitor.selectedOutput;
    audioOutputPicker.disabled = !audioReady;
    grantOutputButton.hidden = !monitor.canSelectAudioOutput;
    grantOutputButton.disabled = !audioReady;
    updateFeedbackWarning();
  }

  function updateFeedbackWarning(): void {
    const shared = monitor.sharesDevice();
    feedbackWarning.hidden = !shared;
    if (shared && !warningShown) {
      setStatus('Warning: the monitoring input and output are the same device — feedback is possible.');
    }
    warningShown = shared;
  }

  /** Mirrors the monitor's mute/volume (restored from storage) into the controls. */
  function renderMonitorControls(): void {
    const muted = monitor.muted;
    muteButton.setAttribute('aria-pressed', String(muted));
    muteButton.textContent = muted ? '🔇 Muted' : '🔊 Monitoring';
    const percent = Math.round(monitor.volume * 100);
    volumeSlider.value = String(percent);
    volumeText.textContent = `${percent}%`;
  }

  const meterPercent = (db: number): string =>
    `${Math.max(0, Math.min(100, ((db - -60) / 60) * 100))}%`;
  const formatDb = (db: number): string => (db <= DB_FLOOR ? '−∞' : db.toFixed(1).replace('-', '−'));
  let clipUntil = 0;

  /** Meter and latency readout, driven by requestAnimationFrame. */
  function meterFrame(now: number): void {
    const { left, right } = monitor.peaks();
    meterLeft.style.width = meterPercent(left);
    meterRight.style.width = meterPercent(right);
    const text = `L ${formatDb(left)} · R ${formatDb(right)} dBFS`;
    if (meterText.textContent !== text) meterText.textContent = text;
    if (Math.max(left, right) > CLIP_THRESHOLD_DB) clipUntil = now + 1000;
    clipIndicator.hidden = now > clipUntil;
    const latency = monitor.latencyMs();
    const latencyText =
      latency === null
        ? 'Browser latency: —'
        : `Browser latency: ${latency.toFixed(1)} ms (excludes interface and driver buffering)`;
    if (latencyReadout.textContent !== latencyText) latencyReadout.textContent = latencyText;
    requestAnimationFrame(meterFrame);
  }

  audioInputPicker.addEventListener('change', () => {
    const requested = audioInputPicker.value || null;
    void monitor.selectInput(requested).then((selected) => {
      // A failed open leaves the picker showing a device that is not monitored;
      // put it back on whatever is actually captured. Skip this if the user has
      // already picked another device while this one was opening.
      if (!selected && audioInputPicker.value === (requested ?? '')) {
        audioInputPicker.value = monitor.selectedInput ?? '';
      }
      updateFeedbackWarning();
    });
  });
  audioOutputPicker.addEventListener('change', () => {
    void monitor.selectOutput(audioOutputPicker.value).then(() => {
      audioOutputPicker.value = monitor.selectedOutput;
      updateFeedbackWarning();
    });
  });
  grantOutputButton.addEventListener('click', () => {
    void monitor.grantOutput().then(() => renderAudioDevices());
  });
  muteButton.addEventListener('click', () => {
    monitor.setMuted(!monitor.muted);
    renderMonitorControls();
  });
  volumeSlider.addEventListener('input', () => {
    monitor.setVolume(Number(volumeSlider.value) / 100);
    renderMonitorControls();
  });

  if (!monitor.supported) monitorUnavailable.hidden = false;
  renderAudioDevices();
  renderMonitorControls();
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
      audioReady = micGranted;
      renderAudioDevices();

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
    } catch {
      setStatus('Connecting devices failed — click "Connect devices" to retry.');
      retryButton.hidden = false;
      retryButton.textContent = 'Retry';
    } finally {
      connectButton.disabled = false;
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

  // The player restores a saved playlist without emitting a change; show it.
  renderPlaylist();
}
