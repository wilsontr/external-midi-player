/**
 * Look-ahead MIDI scheduler (ticket T2).
 *
 * Timing accuracy comes from handing every message to the browser with a
 * future Web Audio timestamp, not from JavaScript timers:
 *
 * - On play, `t0 = performance.now() + initialDelayMs − resumeOffset`.
 * - A fresh start pre-rolls the file's tick-0 setup (program/bank changes,
 *   controllers, pitch bend and channel pressure) ahead of `t0`, spread across
 *   a short start lead. Files often front-load a full multi-part state dump on
 *   the first tick, and MIDI is a serial line: batching that with the first
 *   chord makes the opening sound late, rolled and clipped, and old modules
 *   stall while loading the patches (see `DEFAULT_START_LEAD_MS` below).
 * - Every tick (25 ms, driven by a dedicated Worker timer with a
 *   `setInterval` fallback) sends every not-yet-sent event whose time falls
 *   before `now + lookaheadMs` via `output.send(bytes, t0 + eventTimeMs)` —
 *   always a future timestamp.
 * - Sounding notes are tracked per channel so pause, stop and panic can
 *   release them with a note-off plus CC64 = 0, sent just after the last
 *   queued event (messages already handed to the browser cannot be
 *   cancelled, so the look-ahead bounds the overhang).
 * - When the cursor passes the last event and the scheduled tail has been
 *   delivered, `onEnded` fires — the song ends within a tick of its computed
 *   duration.
 *
 * Background tabs throttle page timers; the Worker keeps the tick running and
 * the 200 ms look-ahead absorbs short stalls. Sends that throw (the output
 * vanished mid-song) stop the scheduler and surface the failure instead of
 * leaving an uncaught interval error.
 */

import type { ParsedMidiEvent } from './parser';
import { createSchedulerTimer, type SchedulerTimer } from './workerTimer';

/** Injectable clock (tests use a fake one). */
export interface SchedulerClock {
  now(): number;
}

export interface SchedulerOptions {
  /** Destination for the MIDI messages. */
  output: MIDIOutput;
  /** Flat, time-sorted event list from the parser. */
  events: ParsedMidiEvent[];
  /** Song duration in seconds (time of the last event). */
  duration: number;
  /** Fired once after the last scheduled event has been delivered. */
  onEnded?: () => void;
  /** Injectable for tests. Defaults to `performance`. */
  clock?: SchedulerClock;
  /** Milliseconds between ticks. Default 25. */
  tickMs?: number;
  /** How far ahead (ms) events are scheduled. Default 200. */
  lookaheadMs?: number;
  /** Delay between play() and the first scheduled time. Default 100 ms. */
  initialDelayMs?: number;
  /** Delay after a seek's state messages before the first event plays. Default 20 ms. */
  seekLeadMs?: number;
  /**
   * Minimum time (ms) from the first tick-0 setup message to song time 0 on a
   * fresh start. The setup is spread across it and its last 100 ms are left
   * clear. Default 250 ms; 0 keeps only the serial floor and the settle.
   */
  startLeadMs?: number;
  /** Injectable tick timer. Defaults to a Worker timer with an interval fallback. */
  createTimer?: () => SchedulerTimer;
  /** Called when a `MIDIOutput.send` throws (the output vanished mid-song). */
  onError?: (message: string) => void;
}

/** Encodes one parsed event as raw MIDI bytes for `MIDIOutput.send`. */
function eventToBytes(e: ParsedMidiEvent): Uint8Array {
  const ch = e.channel & 0x0f;
  switch (e.type) {
    case 'note-on':
      return Uint8Array.from([0x90 | ch, e.note & 0x7f, e.velocity & 0x7f]);
    case 'note-off':
      return Uint8Array.from([0x80 | ch, e.note & 0x7f, e.velocity & 0x7f]);
    case 'control-change':
      return Uint8Array.from([0xb0 | ch, e.controller & 0x7f, e.value & 0x7f]);
    case 'program-change':
      return Uint8Array.from([0xc0 | ch, e.program & 0x7f]);
    case 'pitch-bend':
      return Uint8Array.from([0xe0 | ch, e.value & 0x7f, (e.value >> 7) & 0x7f]);
    case 'channel-pressure':
      return Uint8Array.from([0xd0 | ch, e.value & 0x7f]);
  }
}

/** CC123 all notes off, CC120 all sound off, CC121 reset all controllers, CC64 sustain off. */
const PANIC_RESET_CONTROLLERS = [0x7b, 0x78, 0x79, 0x40];

/**
 * Start-of-song setup pre-roll.
 *
 * A file that opens with a 16-part setup often has dozens of program changes
 * and controllers on tick 0. Sent at one timestamp they reach a DIN MIDI
 * port as one burst, and the line is serial at 31.25 kbps (a 3-byte message
 * takes 0.96 ms), so the first chord can take ~100 ms to come out — by which
 * time the file's first note-offs are already due. Sending that state ahead
 * of song time 0 lets the wire drain before the first note.
 *
 * Messages are never closer together than 1.25 ms (the 0.96 ms a 3-byte
 * message needs, plus a little margin). A small setup is spread across the
 * start lead below, which also gives a receiver that stalls on patch loads
 * time to keep up.
 */
const PRE_ROLL_MESSAGE_MS = 1.25;
/**
 * Minimum time from the first pre-roll message to song time 0.
 *
 * A program change makes an older module load a patch (and its effect
 * algorithm); nine of them at once can keep a 1990s sound module busy for
 * tens of milliseconds, and while it is busy its MIDI receive handling
 * stalls, so the first notes jitter. The setup is spread across this lead
 * and the tail of it is left clear, which gives the receiver time per
 * message and time to settle before the first note. Software synths do not
 * care; a quarter of a second is a small price for a clean start on DIN.
 */
const DEFAULT_START_LEAD_MS = 250;
/** Clear air after the last pre-roll message, inside the start lead. */
const START_SETTLE_MS = 100;

/** True for the channel events that configure a part rather than strike a note. */
function isSetupEvent(e: ParsedMidiEvent): boolean {
  return e.type !== 'note-on' && e.type !== 'note-off';
}

/** The MIDI state a channel has reached by the seek target. */
interface ChannelState {
  program?: number;
  controllers: Map<number, number>;
  pitch?: number;
  pressure?: number;
}

export class Scheduler {
  private readonly output: MIDIOutput;
  private readonly events: ParsedMidiEvent[];
  private readonly duration: number;
  private readonly onEnded?: () => void;
  private readonly clock: SchedulerClock;
  private readonly tickMs: number;
  private readonly lookaheadMs: number;
  private readonly initialDelayMs: number;
  private readonly seekLeadMs: number;
  private readonly startLeadMs: number;
  private readonly createTimer: () => SchedulerTimer;
  private readonly onError?: (message: string) => void;

  /** Wall-clock time (ms) at which song time 0 occurs, while playing. */
  private t0: number | null = null;
  /** Song position (ms) where playback was paused. */
  private pausedPositionMs = 0;
  /**
   * The position a seek landed on, reported until the re-anchored clock
   * catches up (a seek re-anchors after the old look-ahead tail).
   */
  private floorPositionMs = 0;
  /** True between play() and stop()/end/dispose; a stopped seek is ignored. */
  private started = false;
  /** Wall time a paused seek's target state must be followed by before resuming. */
  private resumeAnchorMs: number | null = null;
  /** Index of the next event to send. */
  private nextIndex = 0;
  /** Wall-clock time of the last message handed to the output. */
  private lastSentWall: number | null = null;
  /** Notes currently sounding, per channel. */
  private readonly sounding = new Map<number, Set<number>>();
  /**
   * Indices of tick-0 setup events already handed over by the start pre-roll.
   * The tick loop skips them; they are cleared as it passes them.
   */
  private readonly preRoll = new Set<number>();
  private timer: SchedulerTimer | null = null;

  constructor(options: SchedulerOptions) {
    this.output = options.output;
    this.events = options.events;
    this.duration = options.duration;
    this.onEnded = options.onEnded;
    this.clock = options.clock ?? performance;
    this.tickMs = options.tickMs ?? 25;
    this.lookaheadMs = options.lookaheadMs ?? 200;
    this.initialDelayMs = options.initialDelayMs ?? 100;
    this.seekLeadMs = options.seekLeadMs ?? 20;
    this.startLeadMs = Math.max(0, options.startLeadMs ?? DEFAULT_START_LEAD_MS);
    this.createTimer = options.createTimer ?? createSchedulerTimer;
    this.onError = options.onError;
  }

  /**
   * Starts or resumes playback. On resume, `t0` is re-anchored with the
   * paused position as the resume offset, so events already sent are not
   * re-sent and notes held across the pause are not re-struck.
   *
   * `startAtMs` (an absolute wall-clock time) anchors song time 0 for a song
   * that must begin only after an earlier scheduler's panic has taken effect —
   * a track switch. Without it, playback starts after `initialDelayMs`.
   *
   * A fresh start first sends the file's tick-0 setup ahead of `t0` (see
   * `PRE_ROLL_MESSAGE_MS`), so an opening full-part state dump cannot crowd
   * the first chord off the serial MIDI line.
   */
  play(startAtMs?: number): void {
    if (this.t0 !== null) {
      return;
    }
    this.started = true;
    const now = this.clock.now();
    // Resuming (or resuming a paused seek) has no setup to re-send: the state
    // was already delivered before the pause or by the seek.
    const fresh =
      this.resumeAnchorMs === null && this.pausedPositionMs === 0 && this.nextIndex === 0;
    const setup = fresh ? this.tickZeroSetup() : [];
    if (startAtMs !== undefined) {
      const anchor = this.anchorStart(Math.max(startAtMs, now), now, setup);
      if (anchor === null) return; // the pre-roll's send threw; onError fired
      this.t0 = anchor;
    } else if (this.resumeAnchorMs !== null) {
      // Resume from a paused seek: let the target state (program/controllers)
      // go out before the first note, unless that anchor has already passed.
      const anchor =
        this.resumeAnchorMs > now ? this.resumeAnchorMs : now + this.initialDelayMs;
      this.t0 = anchor - this.pausedPositionMs;
    } else {
      const anchor = this.anchorStart(now + this.initialDelayMs, now, setup);
      if (anchor === null) return; // the pre-roll's send threw; onError fired
      this.t0 = anchor - this.pausedPositionMs;
    }
    this.resumeAnchorMs = null;
    this.ensureTimer().start(this.tickMs, () => this.tick());
  }

  /**
   * Anchors song time 0 at `base`, after handing over the tick-0 setup if
   * there is any. Returns `null` when that send threw (the scheduler is then
   * reset and `onError` has fired, so no timer is started).
   */
  private anchorStart(base: number, now: number, setup: number[]): number | null {
    if (this.preRoll.size > 0) {
      // A previous start's pre-roll is still unconsumed (play() without a tick
      // in between); never send it twice.
      this.preRoll.clear();
    }
    const start = Math.max(base, now);
    if (setup.length === 0) {
      return start;
    }
    // Spread the setup across the lead, but never faster than the serial
    // floor; if it does not fit, the lead grows and t0 moves with it. The
    // last START_SETTLE_MS of the lead stays clear for the receiver to finish
    // loading the patches.
    const serialSpan = (setup.length - 1) * PRE_ROLL_MESSAGE_MS;
    const lead = Math.max(this.startLeadMs, serialSpan + START_SETTLE_MS);
    const step = setup.length > 1 ? (lead - START_SETTLE_MS) / (setup.length - 1) : 0;
    let wall = start;
    try {
      for (const index of setup) {
        this.output.send(eventToBytes(this.events[index]), wall);
        this.preRoll.add(index);
        wall += step;
      }
    } catch (err) {
      this.clearPlaybackState();
      this.onError?.(err instanceof Error ? err.message : String(err));
      return null;
    }
    const lastSetupWall = setup.length > 1 ? start + (setup.length - 1) * step : start;
    if (this.lastSentWall === null || lastSetupWall > this.lastSentWall) {
      this.lastSentWall = lastSetupWall;
    }
    return start + lead;
  }

  /** Indices of the setup events at tick 0, in file order, for the pre-roll. */
  private tickZeroSetup(): number[] {
    const indices: number[] = [];
    for (let i = this.nextIndex; i < this.events.length; i++) {
      const e = this.events[i];
      if (e.time > 0) break;
      if (isSetupEvent(e)) indices.push(i);
    }
    return indices;
  }

  /** Resets transport state without sending anything (start failed). */
  private clearPlaybackState(): void {
    this.disposeTimer();
    this.preRoll.clear();
    this.t0 = null;
    this.started = false;
    this.resumeAnchorMs = null;
    this.pausedPositionMs = 0;
    this.floorPositionMs = 0;
    this.nextIndex = 0;
    this.lastSentWall = null;
    this.sounding.clear();
  }

  /**
   * Pauses playback: saves the position and releases every sounding note
   * (note-off plus CC64 = 0) just after the last queued event.
   */
  pause(): void {
    const t0 = this.t0;
    if (t0 === null) {
      return;
    }
    const now = this.clock.now();
    // Use the reported position so a pause during a seek's re-anchor lead
    // keeps the position the user seeked to instead of stepping backwards.
    this.pausedPositionMs = Math.max(0, Math.max(this.floorPositionMs, now - t0));
    this.releaseSounding();
    // Resume after the release tail (which a seek can push into the future),
    // never before the normal start delay.
    const tail = Math.max(this.lastSentWall ?? now, now);
    this.resumeAnchorMs = Math.max(now + this.initialDelayMs, tail + this.seekLeadMs);
    // Keep the timer for resume; only a full stop/end/dispose releases it.
    // `lastSentWall` is kept so a paused seek knows where the delivered tail ends.
    this.stopTimer();
    this.t0 = null;
    this.sounding.clear();
  }

  /**
   * Stops playback: releases sounding notes and resets the position to 0,
   * so the next play() starts the song from the beginning.
   *
   * Returns the wall-clock time of the last message handed to the output (or
   * `now` when there was none), so a caller that starts another song right
   * away can anchor it after the old queue's tail.
   */
  stop(): number | null {
    this.releaseSounding();
    const tail = this.lastSentWall;
    const now = this.clock.now();
    this.disposeTimer();
    this.t0 = null;
    this.started = false;
    this.resumeAnchorMs = null;
    this.pausedPositionMs = 0;
    this.floorPositionMs = 0;
    this.nextIndex = 0;
    this.lastSentWall = null;
    this.sounding.clear();
    this.preRoll.clear();
    return tail === null ? now : Math.max(tail, now);
  }

  /**
   * Panics (R8): sends CC123 (all notes off), CC120 (all sound off),
   * CC121 (reset all controllers) and CC64 = 0 on all 16 channels, to recover
   * hardware that is stuck.
   */
  panic(): number {
    const wall = this.releaseWall();
    for (let channel = 0; channel < 16; channel++) {
      for (const controller of PANIC_RESET_CONTROLLERS) {
        this.output.send(Uint8Array.from([0xb0 | channel, controller, 0]), wall);
      }
    }
    this.lastSentWall = wall;
    this.sounding.clear();
    return wall;
  }

  /**
   * Stops the tick loop and resets internal state without sending messages.
   * Send a release via stop() or panic() first if the hardware needs one.
   */
  dispose(): void {
    this.disposeTimer();
    this.t0 = null;
    this.started = false;
    this.resumeAnchorMs = null;
    this.pausedPositionMs = 0;
    this.floorPositionMs = 0;
    this.nextIndex = 0;
    this.lastSentWall = null;
    this.sounding.clear();
    this.preRoll.clear();
  }

  /**
   * Index of the next event the tick loop will send (T21: a resume skips the
   * events already handed over inside the look-ahead before the pause).
   */
  cursorIndex(): number {
    return this.nextIndex;
  }

  /** True while the song is playing. */
  isPlaying(): boolean {
    return this.t0 !== null;
  }

  /** Current song position in seconds. */
  position(): number {
    if (this.t0 !== null) {
      return Math.max(this.floorPositionMs, this.clock.now() - this.t0) / 1000;
    }
    return this.pausedPositionMs / 1000;
  }

  /**
   * Seeks to `positionSec`, clamped to the song (`0..duration`).
   *
   * While playing, the look-ahead queue cannot be cancelled, so nothing new is
   * sent until the old tail has been delivered:
   *
   * 1. sounding notes are released just after the last queued event,
   * 2. the MIDI state at the target — program/bank changes, controllers
   *    (volume, pan, expression, sustain, …), pitch bend and channel pressure —
   *    is re-sent just after that,
   * 3. the event cursor jumps to the first event at/after the target and the
   *    clock is re-anchored so playback resumes from the target.
   *
   * While paused the position and cursor move and the target state is sent,
   * but no notes play; `play()` resumes from the target. While stopped (never
   * started, or after stop/end of song) a seek is ignored: a stopped song
   * always restarts at 0, which is the documented policy.
   */
  seek(positionSec: number): void {
    if (!Number.isFinite(positionSec)) return;
    const now = this.clock.now();
    const targetMs = Math.min(Math.max(0, positionSec * 1000), this.duration * 1000);
    if (this.t0 === null) {
      if (!this.started) return;
      // Paused: move the resume point and bring the hardware to the target
      // state, so resuming sounds as if the song had reached it.
      const stateWall = Math.max(this.lastSentWall ?? now, now) + 1;
      this.sendStateAt(stateWall, targetMs);
      this.pausedPositionMs = targetMs;
      this.floorPositionMs = targetMs;
      this.resumeAnchorMs = stateWall + this.seekLeadMs;
      this.nextIndex = this.firstIndexAtOrAfter(targetMs);
      return;
    }
    // Playing: release the old notes, then send the target state after the
    // delivered tail, then re-anchor so the next event lands after both.
    this.releaseSounding();
    const stateWall = Math.max(this.lastSentWall ?? now, now) + 1;
    this.sendStateAt(stateWall, targetMs);
    this.sounding.clear();
    this.nextIndex = this.firstIndexAtOrAfter(targetMs);
    this.floorPositionMs = targetMs;
    this.t0 = stateWall + this.seekLeadMs - targetMs;
  }

  /** One tick: send every event that falls inside the look-ahead window. */
  private tick(): void {
    const t0 = this.t0;
    if (t0 === null) {
      return;
    }
    const now = this.clock.now();
    const horizon = now + this.lookaheadMs;
    try {
      while (this.nextIndex < this.events.length) {
        // Tick-0 setup was already handed over ahead of t0 by the start
        // pre-roll; skip it here so it is never sent twice.
        if (this.preRoll.delete(this.nextIndex)) {
          this.nextIndex += 1;
          continue;
        }
        const e = this.events[this.nextIndex];
        const wall = t0 + e.time * 1000;
        if (wall >= horizon) {
          break;
        }
        // Web MIDI timestamps cannot be in the past; with a slow tick an event
        // may already be late when it is sent — clamp to now so it fires
        // immediately instead of with a past timestamp.
        this.sendEvent(e, wall < now ? now : wall);
        this.nextIndex += 1;
      }
    } catch (err) {
      // The output disappeared mid-song (or the browser rejected the send).
      // A release would likely throw too, so stop without sending, release the
      // worker and report instead of leaving an uncaught interval error.
      this.disposeTimer();
      this.t0 = null;
      this.started = false;
      this.resumeAnchorMs = null;
      this.pausedPositionMs = 0;
      this.floorPositionMs = 0;
      this.nextIndex = 0;
      this.lastSentWall = null;
      this.sounding.clear();
      this.preRoll.clear();
      this.onError?.(err instanceof Error ? err.message : String(err));
      return;
    }
    // The scheduled tail has finished once the last event's wall time has
    // passed — the song ends at its computed duration. Release anything still
    // sounding first: a file can end with an unpaired note-on, and clearing
    // the map without a note-off would leave that note stuck on the hardware.
    if (this.nextIndex >= this.events.length && now >= t0 + this.duration * 1000) {
      this.releaseSounding();
      this.disposeTimer();
      this.t0 = null;
      this.started = false;
      this.resumeAnchorMs = null;
      this.pausedPositionMs = 0;
      this.floorPositionMs = 0;
      this.nextIndex = 0;
      this.lastSentWall = null;
      this.sounding.clear();
      this.preRoll.clear();
      this.onEnded?.();
    }
  }

  /** Sends one event at its wall-clock time and tracks it if it is a note. */
  private sendEvent(e: ParsedMidiEvent, wall: number): void {
    this.output.send(eventToBytes(e), wall);
    if (this.lastSentWall === null || wall > this.lastSentWall) {
      this.lastSentWall = wall;
    }
    if (e.type === 'note-on' && e.velocity > 0) {
      let notes = this.sounding.get(e.channel);
      if (notes === undefined) {
        notes = new Set();
        this.sounding.set(e.channel, notes);
      }
      notes.add(e.note);
    } else if (e.type === 'note-off' || e.type === 'note-on') {
      // A note-on with velocity 0 is a note-off (the same rule T21's
      // activity tracker uses), so both notions of "sounding" agree.
      const notes = this.sounding.get(e.channel);
      if (notes !== undefined) {
        notes.delete(e.note);
        if (notes.size === 0) {
          this.sounding.delete(e.channel);
        }
      }
    }
  }

  /** Index of the first event at/after `targetMs` (events are time-sorted). */
  private firstIndexAtOrAfter(targetMs: number): number {
    const epsilon = 1e-6;
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].time * 1000 >= targetMs - epsilon) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /**
   * Sends the MIDI state that the song's events have established by
   * `targetMs`, all at `wall`: the latest program change, bank select (CC0 /
   * CC32), every controller, pitch bend and channel pressure. Notes that began
   * before the target are deliberately not re-struck.
   */
  private sendStateAt(wall: number, targetMs: number): void {
    const epsilon = 1e-6;
    const channels = new Map<number, ChannelState>();
    for (const e of this.events) {
      if (e.time * 1000 >= targetMs - epsilon) break;
      let state = channels.get(e.channel);
      if (state === undefined) {
        state = { controllers: new Map() };
        channels.set(e.channel, state);
      }
      switch (e.type) {
        case 'program-change':
          state.program = e.program;
          break;
        case 'control-change':
          state.controllers.set(e.controller, e.value);
          break;
        case 'pitch-bend':
          state.pitch = e.value;
          break;
        case 'channel-pressure':
          state.pressure = e.value;
          break;
        default:
          break;
      }
    }
    let sent = false;
    const send = (bytes: number[]): void => {
      this.output.send(Uint8Array.from(bytes), wall);
      sent = true;
    };
    for (const [channel, state] of [...channels].sort((a, b) => a[0] - b[0])) {
      const ch = channel & 0x0f;
      const bankMsb = state.controllers.get(0);
      const bankLsb = state.controllers.get(32);
      if (bankMsb !== undefined) send([0xb0 | ch, 0, bankMsb & 0x7f]);
      if (bankLsb !== undefined) send([0xb0 | ch, 32, bankLsb & 0x7f]);
      if (state.program !== undefined) send([0xc0 | ch, state.program & 0x7f]);
      for (const controller of [...state.controllers.keys()].sort((a, b) => a - b)) {
        if (controller === 0 || controller === 32) continue;
        send([0xb0 | ch, controller & 0x7f, state.controllers.get(controller)! & 0x7f]);
      }
      if (state.pitch !== undefined) {
        send([0xe0 | ch, state.pitch & 0x7f, (state.pitch >> 7) & 0x7f]);
      }
      if (state.pressure !== undefined) send([0xd0 | ch, state.pressure & 0x7f]);
    }
    if (sent) this.lastSentWall = Math.max(this.lastSentWall ?? wall, wall);
  }

  /** Wall-clock time just after the last queued event (always ≥ now). */
  private releaseWall(): number {
    const now = this.clock.now();
    const last = this.lastSentWall;
    return Math.max(last === null ? now : last, now) + 1;
  }

  /**
   * Releases every sounding note: note-off for each, then CC64 = 0 (sustain
   * off) on that channel, all just after the last queued event.
   */
  private releaseSounding(): void {
    if (this.sounding.size === 0) {
      return;
    }
    const wall = this.releaseWall();
    try {
      for (const [channel, notes] of this.sounding) {
        const ch = channel & 0x0f;
        for (const note of notes) {
          this.output.send(Uint8Array.from([0x80 | ch, note & 0x7f, 0]), wall);
        }
        this.output.send(Uint8Array.from([0xb0 | ch, 0x40, 0]), wall);
      }
    } catch {
      // The output vanished; there is nothing more to send. The caller still
      // clears the sounding state so a later reconnect does not retry it.
    }
    this.lastSentWall = wall;
  }

  private ensureTimer(): SchedulerTimer {
    if (this.timer === null) this.timer = this.createTimer();
    return this.timer;
  }

  /** Stops ticking but keeps the timer for a possible resume. */
  private stopTimer(): void {
    this.timer?.stop();
  }

  /** Stops and releases the timer (full stop, end of song, dispose). */
  private disposeTimer(): void {
    this.timer?.dispose();
    this.timer = null;
  }
}
