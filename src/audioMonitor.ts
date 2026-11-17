/**
 * Audio monitoring (ticket T4): captures a chosen audio input, routes it
 * through a Web Audio graph and plays it to the chosen output. Independent of
 * the MIDI path. See the design doc, "Audio input routing".
 *
 * Graph: `MediaStreamAudioSourceNode` → `GainNode` (volume / mute) → output.
 * The level meter taps the source *before* the gain stage (through a channel
 * splitter and one `AnalyserNode` per channel), so the signal is visible
 * while monitoring is muted — which is how it starts, to avoid a feedback
 * loop when the input is a microphone near the speakers.
 *
 * Output device routing:
 * - `context`: `AudioContext.setSinkId` (Chrome) — lowest latency.
 * - `element`: the graph ends in a `MediaStreamAudioDestinationNode` played by
 *   an `<audio>` element whose `setSinkId` picks the device (Firefox; the
 *   user grants a device with `selectAudioOutput()`).
 * - `default`: neither is available; audio goes to the system default output.
 *
 * DOM-independent apart from the factories below, which tests inject.
 */

export type OutputRouting = 'context' | 'element' | 'default';

export interface AudioDeviceInfo {
  id: string;
  label: string;
  groupId: string;
}

/** Peak level of the two channels, in dBFS (floored at `DB_FLOOR`). */
export interface StereoLevel {
  left: number;
  right: number;
}

export const DB_FLOOR = -100;
/** Peaks above this level are shown as clipping. */
export const CLIP_THRESHOLD_DB = -1;

export const AUDIO_SETTINGS_STORAGE_KEY = 'external-midi-player.audio';

interface StoredAudioSettings {
  version: 1;
  inputId: string | null;
  inputLabel: string;
  outputId: string;
  outputLabel: string;
  muted: boolean;
  volume: number;
}

/** The `setSinkId` / `selectAudioOutput` additions missing from some DOM typings. */
type SinkCapable = { setSinkId?: (sinkId: string) => Promise<void> };
type OutputSelectingDevices = MediaDevices & {
  selectAudioOutput?: () => Promise<{ deviceId: string; label: string; groupId?: string }>;
};

export interface AudioMonitorOptions {
  /** User-visible status (funnels into the single aria-live region). */
  onStatus: (message: string) => void;
  /** Fired whenever the device lists (or the selection after a hot-plug) change. */
  onDevicesChanged: () => void;
  /** Fired when capture stopped by itself because the input went away. */
  onInputLost: () => void;
  /** Injectable for tests. Defaults to `navigator.mediaDevices`. */
  mediaDevices?: MediaDevices;
  /** Injectable for tests. Defaults to `new AudioContext(...)`. */
  createContext?: (options: AudioContextOptions) => AudioContext;
  /** Injectable for tests. Defaults to `document.createElement('audio')`. */
  createAudioElement?: () => HTMLAudioElement;
  /** Injectable for tests. Defaults to feature detection. */
  routing?: OutputRouting;
  /** Storage for the device/mute/volume settings. Defaults to `localStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

/** Picks the best available way to choose the monitoring output device. */
export function detectOutputRouting(): OutputRouting {
  if (typeof AudioContext !== 'undefined') {
    if (typeof (AudioContext.prototype as SinkCapable).setSinkId === 'function') return 'context';
    if (
      typeof HTMLMediaElement !== 'undefined' &&
      typeof (HTMLMediaElement.prototype as SinkCapable).setSinkId === 'function' &&
      typeof AudioContext.prototype.createMediaStreamDestination === 'function'
    ) {
      return 'element';
    }
  }
  return 'default';
}

/** Constraints that keep instrument audio unaltered. */
function captureConstraints(inputId: string): MediaStreamConstraints {
  return {
    audio: {
      deviceId: { exact: inputId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
    },
  };
}

function toDb(peak: number): number {
  return peak <= 0 ? DB_FLOOR : Math.max(DB_FLOOR, 20 * Math.log10(peak));
}

function resolveStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Sandboxed iframe / storage disabled: persistence is best-effort.
    return null;
  }
}

function parseStoredSettings(raw: string | null): StoredAudioSettings | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== 1) return null;
    const volume =
      typeof value.volume === 'number' && Number.isFinite(value.volume)
        ? Math.min(1, Math.max(0, value.volume))
        : 1;
    return {
      version: 1,
      inputId: typeof value.inputId === 'string' ? value.inputId : null,
      inputLabel: typeof value.inputLabel === 'string' ? value.inputLabel : '',
      outputId: typeof value.outputId === 'string' ? value.outputId : '',
      outputLabel: typeof value.outputLabel === 'string' ? value.outputLabel : '',
      muted: typeof value.muted === 'boolean' ? value.muted : true,
      volume,
    };
  } catch {
    return null;
  }
}

export class AudioMonitor {
  readonly routing: OutputRouting;

  private readonly options: AudioMonitorOptions;
  private readonly mediaDevices: OutputSelectingDevices | undefined;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** True while replaying saved settings; suppresses intermediate writes. */
  private restoring = false;
  // Remembered choices survive a device loss, so an unrelated settings change
  // does not forget a device that is merely unplugged for now.
  private rememberedInputId: string | null = null;
  private rememberedInputLabel = '';
  private rememberedOutputId = '';
  private rememberedOutputLabel = '';

  private inputList: AudioDeviceInfo[] = [];
  private outputList: AudioDeviceInfo[] = [];
  /** Outputs granted through `selectAudioOutput()` (Firefox lists none by itself). */
  private grantedOutputs: AudioDeviceInfo[] = [];
  private inputId: string | null = null;
  private outputId = '';
  private isMuted = true;
  private level = 1;
  private unlocked = false;
  private selectToken = 0;

  private stream: MediaStream | null = null;
  private channels = 2;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private analysers: AnalyserNode[] = [];
  private audioElement: HTMLAudioElement | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;

  constructor(options: AudioMonitorOptions) {
    this.options = options;
    this.mediaDevices =
      options.mediaDevices ??
      (typeof navigator !== 'undefined' ? (navigator.mediaDevices as OutputSelectingDevices | undefined) : undefined);
    this.routing = options.routing ?? detectOutputRouting();
    this.storage = options.storage ?? resolveStorage();
    const saved = this.loadSettings();
    if (saved !== null) {
      this.isMuted = saved.muted;
      this.level = saved.volume;
      this.rememberedInputId = saved.inputId;
      this.rememberedInputLabel = saved.inputLabel;
      this.rememberedOutputId = saved.outputId;
      this.rememberedOutputLabel = saved.outputLabel;
    }
  }

  /** True when the browser can capture audio at all. */
  get supported(): boolean {
    return (
      this.mediaDevices !== undefined &&
      typeof this.mediaDevices.getUserMedia === 'function' &&
      (this.options.createContext !== undefined || typeof AudioContext !== 'undefined')
    );
  }

  /** True when the user must grant output devices one at a time (Firefox). */
  get canSelectAudioOutput(): boolean {
    return this.routing === 'element' && typeof this.mediaDevices?.selectAudioOutput === 'function';
  }

  get muted(): boolean {
    return this.isMuted;
  }

  get volume(): number {
    return this.level;
  }

  get selectedInput(): string | null {
    return this.inputId;
  }

  get selectedOutput(): string {
    return this.outputId;
  }

  inputs(): AudioDeviceInfo[] {
    return this.inputList.slice();
  }

  /**
   * Selectable output devices (empty when routing is `default`).
   *
   * On the `<audio>` path the browser only lets `setSinkId` use a non-default
   * device after the user picked it in `selectAudioOutput()`, so offering the
   * enumerated-but-ungranted devices would only produce failed selections.
   * "System default" stays available as its own picker entry.
   */
  outputs(): AudioDeviceInfo[] {
    if (this.routing === 'default') return [];
    if (this.canSelectAudioOutput) return this.grantedOutputs.slice();
    return this.outputList.slice();
  }

  /**
   * Asks for microphone permission once (so device labels become available),
   * then lists the devices and starts listening for hot-plug changes. Must
   * run inside the user's click.
   */
  async unlock(): Promise<boolean> {
    const devices = this.mediaDevices;
    if (!devices || typeof devices.getUserMedia !== 'function') return false;
    try {
      const stream = await devices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      return false;
    }
    this.unlocked = true;
    devices.ondevicechange = () => void this.refreshDevices();
    await this.refreshDevices();
    // Labels are available now; reinstate the settings from the last visit.
    await this.restoreSelection();
    return true;
  }

  /** Re-reads `enumerateDevices()` and reacts to a vanished input or output. */
  async refreshDevices(): Promise<void> {
    const devices = this.mediaDevices;
    if (!devices || !this.unlocked) return;
    let all: MediaDeviceInfo[];
    try {
      all = await devices.enumerateDevices();
    } catch {
      return;
    }
    const describe = (kind: MediaDeviceKind) =>
      all
        .filter((d) => d.kind === kind)
        .map((d, i) => ({
          id: d.deviceId,
          label: d.label || `${kind === 'audioinput' ? 'Input' : 'Output'} ${i + 1}`,
          groupId: d.groupId,
        }));
    this.inputList = describe('audioinput');
    const listed = describe('audiooutput');
    this.outputList = [
      ...listed,
      ...this.grantedOutputs.filter((g) => !listed.some((d) => d.id === g.id)),
    ];

    const inputLost = this.inputId !== null && !this.inputList.some((d) => d.id === this.inputId);
    if (inputLost) this.stopCapture();
    const outputLost = this.outputId !== '' && !this.outputList.some((d) => d.id === this.outputId);
    if (outputLost) this.outputId = '';
    const outputFallbackApplied = outputLost ? await this.applySink() : true;

    // Re-render before reporting, so a feedback warning cannot overwrite the
    // "disconnected" message the user needs to see.
    this.options.onDevicesChanged();
    if (inputLost) {
      this.options.onStatus('Audio input disconnected — monitoring stopped.');
      this.options.onInputLost();
    }
    if (outputLost) {
      this.options.onStatus(
        outputFallbackApplied
          ? 'Monitoring output disconnected — using the system default output.'
          : 'Monitoring output disconnected — could not switch to the system default output.',
      );
    }
  }

  /**
   * Opens `id` (stopping the previous capture first) and starts monitoring it.
   * `null` stops monitoring. Must run inside a user gesture so the context
   * can resume.
   */
  async selectInput(id: string | null): Promise<boolean> {
    const token = ++this.selectToken;
    this.stopCapture();
    if (id === null || !this.mediaDevices) {
      // An explicit "Select an input…" clears the remembered device too.
      this.rememberedInputId = null;
      this.rememberedInputLabel = '';
      this.saveSettings();
      return true;
    }
    let stream: MediaStream;
    try {
      stream = await this.mediaDevices.getUserMedia(captureConstraints(id));
    } catch {
      if (token === this.selectToken) {
        this.options.onStatus('Could not open the selected audio input.');
      }
      return false;
    }
    // A newer selection started while this one was opening: drop this stream.
    if (token !== this.selectToken) {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    let source: MediaStreamAudioSourceNode | null = null;
    let splitter: ChannelSplitterNode | null = null;
    try {
      const context = this.ensureContext();
      source = context.createMediaStreamSource(stream);
      source.connect(this.gain!);
      splitter = context.createChannelSplitter(2);
      source.connect(splitter);
      this.analysers.forEach((analyser, channel) => splitter!.connect(analyser, channel));
    } catch {
      // The browser refused to build the graph (no output device, too many
      // contexts, …): release the capture we just opened rather than leaking it.
      source?.disconnect();
      for (const track of stream.getTracks()) track.stop();
      this.options.onStatus('Could not start audio monitoring on this device.');
      return false;
    }
    this.stream = stream;
    this.inputId = id;
    this.channels = stream.getAudioTracks()[0]?.getSettings?.().channelCount ?? 2;
    const track = stream.getAudioTracks()[0];
    track?.addEventListener?.('ended', () => {
      if (this.stream === stream) {
        this.stopCapture();
        this.options.onStatus('Audio input disconnected — monitoring stopped.');
        this.options.onInputLost();
      }
    });
    this.source = source!;
    this.splitter = splitter!;
    this.rememberedInputId = id;
    this.rememberedInputLabel = this.inputList.find((d) => d.id === id)?.label ?? '';
    this.resume();
    this.saveSettings();
    return true;
  }

  /** Selects the monitoring output; '' is the system default. */
  async selectOutput(id: string): Promise<void> {
    this.outputId = id;
    await this.applySink();
    this.rememberedOutputId = this.outputId;
    this.rememberedOutputLabel = this.outputList.find((d) => d.id === this.outputId)?.label ?? '';
    this.resume();
    this.saveSettings();
  }

  /**
   * Firefox: asks the user to grant an output device with the browser's own
   * picker, then selects it. Returns the granted device, or null if cancelled.
   */
  async grantOutput(): Promise<AudioDeviceInfo | null> {
    const select = this.mediaDevices?.selectAudioOutput;
    if (typeof select !== 'function') return null;
    try {
      const granted = await select.call(this.mediaDevices);
      const info: AudioDeviceInfo = {
        id: granted.deviceId,
        label: granted.label || 'Selected output',
        // Keep the group so the same-device (feedback) warning still works.
        groupId: granted.groupId ?? '',
      };
      if (!this.grantedOutputs.some((d) => d.id === info.id)) this.grantedOutputs.push(info);
      await this.refreshDevices();
      await this.selectOutput(info.id);
      return info;
    } catch {
      this.options.onStatus('No output device selected — using the system default output.');
      return null;
    }
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    this.applyGain();
    this.resume();
    this.saveSettings();
  }

  /** Volume from 0 to 1. */
  setVolume(volume: number): void {
    this.level = Math.min(1, Math.max(0, volume));
    this.applyGain();
    // The slider is a user gesture, so it can also unblock a suspended context.
    this.resume();
    this.saveSettings();
  }

  /** Peak level per channel, in dBFS, read from the analysers. */
  peaks(): StereoLevel {
    if (this.analysers.length < 2 || this.source === null) {
      return { left: DB_FLOOR, right: DB_FLOOR };
    }
    const [left, right] = this.analysers.map((analyser) => {
      const size = analyser.fftSize;
      if (this.buffer === null || this.buffer.length !== size) {
        this.buffer = new Float32Array(size);
      }
      analyser.getFloatTimeDomainData(this.buffer);
      let peak = 0;
      for (let i = 0; i < size; i++) {
        const v = Math.abs(this.buffer[i]);
        if (v > peak) peak = v;
      }
      return toDb(peak);
    });
    // A mono input only feeds the left channel of the splitter.
    return { left, right: this.channels < 2 ? left : right };
  }

  /** The browser's share of the round trip: `baseLatency + outputLatency`, in ms. */
  latencyMs(): number | null {
    const context = this.context;
    if (context === null) return null;
    return (context.baseLatency + (context.outputLatency || 0)) * 1000;
  }

  /** True when the selected input and output look like the same device. */
  sharesDevice(): boolean {
    if (this.inputId === null) return false;
    const input = this.inputList.find((d) => d.id === this.inputId);
    if (!input || !input.groupId) return false;
    const output =
      this.outputId === ''
        ? this.outputList.find((d) => d.id === 'default')
        : this.outputList.find((d) => d.id === this.outputId);
    return output !== undefined && output.groupId === input.groupId;
  }

  /** Stops capture and closes the graph. */
  dispose(): void {
    this.stopCapture();
    if (this.mediaDevices) this.mediaDevices.ondevicechange = null;
    void this.context?.close();
    this.context = null;
    this.gain = null;
    this.analysers = [];
    if (this.audioElement !== null) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
      this.audioElement = null;
    }
  }

  private stopCapture(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.source?.disconnect();
    this.source = null;
    // Disconnect the per-channel meter tap too, so repeated input changes do
    // not leave old splitters wired into the analysers.
    this.splitter?.disconnect();
    this.splitter = null;
    this.inputId = null;
  }

  private loadSettings(): StoredAudioSettings | null {
    if (this.storage === null) return null;
    try {
      return parseStoredSettings(this.storage.getItem(AUDIO_SETTINGS_STORAGE_KEY));
    } catch {
      return null;
    }
  }

  /** Writes the current device/mute/volume choices (no-op without storage). */
  private saveSettings(): void {
    const storage = this.storage;
    if (storage === null || this.restoring) return;
    const settings: StoredAudioSettings = {
      version: 1,
      inputId: this.rememberedInputId,
      inputLabel: this.rememberedInputLabel,
      outputId: this.rememberedOutputId,
      outputLabel: this.rememberedOutputLabel,
      muted: this.isMuted,
      volume: this.level,
    };
    try {
      storage.setItem(AUDIO_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage full/unavailable: the session still works, just not remembered.
    }
  }

  /** Re-selects the remembered input/output once device names are known. */
  private async restoreSelection(): Promise<void> {
    this.restoring = true;
    try {
      if (this.outputId === '' && this.rememberedOutputId !== '') {
        const output = this.findOutput(this.rememberedOutputId, this.rememberedOutputLabel);
        if (output !== undefined) await this.selectOutput(output.id);
      }
      if (this.inputId === null && this.rememberedInputId !== null) {
        const input = this.findInput(this.rememberedInputId, this.rememberedInputLabel);
        if (input !== undefined) await this.selectInput(input.id);
      }
    } finally {
      this.restoring = false;
    }
    // The remembered choices survive a failed reopen; it may come back later.
    this.saveSettings();
  }

  /** Matches a stored input id, falling back to a unique label (ids can rotate). */
  private findInput(id: string, label: string): AudioDeviceInfo | undefined {
    const byId = this.inputList.find((d) => d.id === id);
    if (byId !== undefined) return byId;
    if (label === '') return undefined;
    const byLabel = this.inputList.filter((d) => d.label === label);
    return byLabel.length === 1 ? byLabel[0] : undefined;
  }

  /** Matches a stored output among the devices that are actually selectable. */
  private findOutput(id: string, label: string): AudioDeviceInfo | undefined {
    const selectable = this.outputs();
    const byId = selectable.find((d) => d.id === id);
    if (byId !== undefined) return byId;
    if (label === '') return undefined;
    const byLabel = selectable.filter((d) => d.label === label);
    return byLabel.length === 1 ? byLabel[0] : undefined;
  }

  /** Builds the context and the gain → output half of the graph on first use. */
  private ensureContext(): AudioContext {
    if (this.context !== null) return this.context;
    const options: AudioContextOptions = { latencyHint: 'interactive' };
    const context = this.options.createContext
      ? this.options.createContext(options)
      : new AudioContext(options);
    const gain = context.createGain();
    gain.gain.value = this.isMuted ? 0 : this.level;
    this.analysers = [0, 1].map(() => {
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      return analyser;
    });

    if (this.routing === 'element') {
      const destination = context.createMediaStreamDestination();
      gain.connect(destination);
      const element = this.options.createAudioElement
        ? this.options.createAudioElement()
        : document.createElement('audio');
      element.srcObject = destination.stream;
      this.audioElement = element;
    } else {
      gain.connect(context.destination);
    }
    this.context = context;
    this.gain = gain;
    void this.applySink();
    return context;
  }

  /**
   * Applies `outputId` to whichever node owns the sink. If the browser rejects
   * it (an output that is no longer granted, or has disappeared), switches to
   * the system default and says so, so the picker and the actual routing agree.
   * Returns whether the requested sink is in use.
   */
  private async applySink(): Promise<boolean> {
    try {
      await this.setSink(this.outputId);
      return true;
    } catch {
      if (this.outputId !== '') {
        this.outputId = '';
        try {
          await this.setSink('');
          this.options.onStatus('Could not use that output — using the system default output.');
        } catch {
          this.options.onStatus('Could not use that output or the system default output.');
        }
      } else {
        this.options.onStatus('Could not use the system default output.');
      }
      return false;
    }
  }

  private setSink(sinkId: string): Promise<void> {
    if (this.routing === 'context' && this.context !== null) {
      return (this.context as unknown as SinkCapable).setSinkId!(sinkId);
    }
    if (this.routing === 'element' && this.audioElement !== null) {
      return (this.audioElement as unknown as SinkCapable).setSinkId!(sinkId);
    }
    return Promise.resolve();
  }

  private applyGain(): void {
    if (this.gain !== null) this.gain.gain.value = this.isMuted ? 0 : this.level;
  }

  /**
   * Resumes the context (and the `<audio>` element) from a user gesture.
   * Not awaited: both promises stay pending while autoplay is blocked.
   */
  private resume(): void {
    this.context?.resume().catch(() => {});
    this.audioElement?.play().catch(() => {});
  }
}
