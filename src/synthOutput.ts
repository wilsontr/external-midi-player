/**
 * Built-in software synth output (ticket T7), powered by SpessaSynth.
 *
 * The app's playback path is unchanged: the scheduler still calls
 * `output.send(bytes, futureTimestamp)` on a future Web MIDI timestamp. This
 * module supplies one more `MIDIOutput` that renders those bytes locally
 * instead of writing them to a MIDI port, and the picker offers it alongside
 * the hardware devices.
 *
 * Timing. Web MIDI timestamps are `DOMHighResTimeStamp`s (`performance.now()`
 * timeline); SpessaSynth wants an `AudioContext` time. `audioTimeFor` converts
 * one to the other, sampling both clocks on every send so the mapping cannot
 * drift, and SpessaSynth's processor keeps the resulting messages in a queue
 * ordered by that audio time, applying each one at the right sample frame.
 * Note timing therefore never goes through a JS timer — the same rule the
 * hardware path follows (R5).
 *
 * The SoundFont is the bundled GeneralUser GS (SF3) and is fetched once, on
 * first selection: about 8.4 MB, too large to pay for on every page load and
 * far too large to persist in `localStorage`.
 */

import type { WorkletSynthesizer } from "spessasynth_lib";
// The AudioWorklet processor and the SoundFont ship as static assets. Both are
// imported with `?url`, so Vite emits them with a base-aware, content-hashed
// URL: the build works from a GitHub Pages subpath (T6) and neither file can
// go stale in a cache.
import processorUrl from "spessasynth_lib/dist/spessasynth_processor.min.js?url";
import soundBankUrl from "./assets/GeneralUserGS.sf3?url";

export const SYNTH_OUTPUT_ID = "builtin-synth";
export const SYNTH_OUTPUT_NAME = "SpessaSynth (built-in)";

/** The part of the synthesizer the MIDI adapter needs (injectable for tests). */
export interface ScheduledMidiSink {
  /** The connected `AudioContext`'s time, in seconds. */
  readonly currentTime: number;
  sendMessage(
    bytes: Iterable<number>,
    channelOffset: number,
    options: { time: number },
  ): void;
}

/**
 * Maps a Web MIDI timestamp to the audio clock.
 *
 * `contextTime` and `wallNow` must be read back to back at the moment of
 * sending: the offset between the clocks is then whatever it is, and every
 * message is placed relative to it. Reading both clocks per message (rather
 * than fixing an offset at the start of the song) keeps the error bounded by
 * one measurement — tens of microseconds for `performance.now`, one render
 * quantum for `AudioContext.currentTime` — instead of letting it accumulate
 * over a long song.
 */
export function audioTimeFor(
  wallMs: number,
  contextTime: number,
  wallNow: number,
): number {
  return contextTime + (wallMs - wallNow) / 1000;
}

/**
 * A Web MIDI `MIDIOutput` whose messages are rendered by the built-in synth.
 *
 * It is a real `EventTarget` with the full `MIDIOutput` surface because the
 * scheduler types its destination as `MIDIOutput`; only `send` does any work.
 */
export class SynthMidiOutput extends EventTarget implements MIDIOutput {
  readonly id = SYNTH_OUTPUT_ID;
  readonly name = SYNTH_OUTPUT_NAME;
  readonly manufacturer = "External MIDI Player";
  readonly type: MIDIPortType = "output";
  readonly version = "1";
  state: MIDIPortDeviceState = "connected";
  connection: MIDIPortConnectionState = "open";
  onstatechange: ((this: MIDIPort, ev: MIDIConnectionEvent) => unknown) | null =
    null;

  constructor(
    private readonly sink: ScheduledMidiSink,
    /** Injectable clock, so tests do not depend on wall time. */
    private readonly clock: () => number = () => performance.now(),
    /**
     * Called before each message so the owner can nudge a suspended
     * `AudioContext` back to running. Chrome only starts audio after a user
     * gesture, and the first real click may land well after the SoundFont
     * finished loading.
     */
    private readonly wake: () => void = () => {},
  ) {
    super();
  }

  /** Renders one message, scheduled at its Web MIDI timestamp. */
  send(data: Iterable<number>, timestamp?: DOMHighResTimeStamp): void {
    this.wake();
    const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
    const when =
      timestamp === undefined
        ? this.sink.currentTime
        : audioTimeFor(timestamp, this.sink.currentTime, this.clock());
    this.sink.sendMessage(bytes, 0, { time: when });
  }

  /**
   * Web MIDI's `clear()` drops pending messages from the port's queue. The
   * queue lives inside SpessaSynth's processor and cannot be reached from
   * here; the scheduler never relies on it (pause, stop and panic send an
   * explicit release), so this is intentionally a no-op.
   */
  clear(): void {}

  open(): Promise<MIDIPort> {
    this.connection = "open";
    return Promise.resolve(this);
  }

  close(): Promise<MIDIPort> {
    this.connection = "closed";
    return Promise.resolve(this);
  }
}

export interface SoftwareSynthOptions {
  /** Every user-visible status message funnels through here (single aria-live region). */
  onStatus: (message: string) => void;
}

/**
 * Owns the audio context, the synthesizer and the bundled SoundFont, and
 * exposes the synth as an output the picker can offer.
 *
 * Loading is explicit (`prepare`), never at startup: the SoundFont is only
 * fetched when the user actually picks the built-in synth. `selectedOutput`
 * stays null until that has succeeded, so playback can never start against a
 * half-loaded instrument.
 */
export class SoftwareSynth {
  private context: AudioContext | null = null;
  private synth: WorkletSynthesizer | null = null;
  private output: SynthMidiOutput | null = null;
  private loading: Promise<void> | null = null;
  private selected = false;

  constructor(private readonly options: SoftwareSynthOptions) {}

  /** AudioWorklet support is what the synth needs; everything else is optional. */
  get supported(): boolean {
    return (
      typeof AudioContext !== "undefined" &&
      typeof AudioWorkletNode !== "undefined" &&
      "audioWorklet" in AudioContext.prototype
    );
  }

  isSelected(): boolean {
    return this.selected;
  }

  selectedId(): string | null {
    return this.selected ? SYNTH_OUTPUT_ID : null;
  }

  /** The output to play through, or null until the SoundFont has loaded. */
  selectedOutput(): MIDIOutput | null {
    return this.selected ? this.output : null;
  }

  select(): void {
    this.selected = true;
  }

  deselect(): void {
    this.selected = false;
  }

  /**
   * Creates the context, loads the worklet and the SoundFont. Must be called
   * from a user gesture (the browser will not start an audio context
   * otherwise) and is idempotent: a second call reuses the same promise.
   */
  async prepare(): Promise<void> {
    if (this.output !== null) return;
    if (this.loading === null) {
      this.loading = this.load().catch((error: unknown) => {
        // Allow a retry after a failure (a missing asset, a blocked worklet).
        this.loading = null;
        this.teardown();
        throw error;
      });
    }
    return this.loading;
  }

  private async load(): Promise<void> {
    // Constructing the context inside the caller's gesture is what lets it
    // start running without a second click.
    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    await context.audioWorklet.addModule(processorUrl);
    // Loaded on demand: the library is only downloaded by visitors who
    // actually pick the built-in synth, and this module stays importable
    // outside a browser (the unit tests never touch the engine).
    const { WorkletSynthesizer } = await import("spessasynth_lib");
    const synth = new WorkletSynthesizer(context);
    this.synth = synth;
    await synth.isReady;

    const response = await fetch(soundBankUrl);
    if (!response.ok) {
      throw new Error(`SoundFont request failed (${response.status}).`);
    }
    const bank = await response.arrayBuffer();
    await synth.soundBankManager.addSoundBank(bank, "generaluser-gs");
    synth.connect(context.destination);
    await context.resume();
    this.output = new SynthMidiOutput(synth, () => performance.now(), () => {
      if (context.state !== "running") void context.resume();
    });
  }

  /** Releases the audio graph; the next `prepare` starts a fresh one. */
  dispose(): void {
    this.teardown();
    this.loading = null;
  }

  private teardown(): void {
    this.output = null;
    try {
      this.synth?.destroy();
    } catch {
      // A destroyed or blocked core must not break page teardown.
    }
    this.synth = null;
    const context = this.context;
    this.context = null;
    if (context !== null) void context.close().catch(() => {});
  }
}
