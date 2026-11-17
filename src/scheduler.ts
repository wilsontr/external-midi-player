/**
 * Look-ahead MIDI scheduler (ticket T2).
 *
 * Timing accuracy comes from handing every message to the browser with a
 * future Web Audio timestamp, not from JavaScript timers:
 *
 * - On play, `t0 = performance.now() + initialDelayMs − resumeOffset`.
 * - Every tick (25 ms) sends every not-yet-sent event whose time falls
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
 * Background tabs throttle `setInterval` to 1 s; the 200 ms look-ahead covers
 * short stalls, and moving the tick into a Worker is T5.
 */

import type { ParsedMidiEvent } from './parser';

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

export class Scheduler {
  private readonly output: MIDIOutput;
  private readonly events: ParsedMidiEvent[];
  private readonly duration: number;
  private readonly onEnded?: () => void;
  private readonly clock: SchedulerClock;
  private readonly tickMs: number;
  private readonly lookaheadMs: number;
  private readonly initialDelayMs: number;

  /** Wall-clock time (ms) at which song time 0 occurs, while playing. */
  private t0: number | null = null;
  /** Song position (ms) where playback was paused. */
  private pausedPositionMs = 0;
  /** Index of the next event to send. */
  private nextIndex = 0;
  /** Wall-clock time of the last message handed to the output. */
  private lastSentWall: number | null = null;
  /** Notes currently sounding, per channel. */
  private readonly sounding = new Map<number, Set<number>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SchedulerOptions) {
    this.output = options.output;
    this.events = options.events;
    this.duration = options.duration;
    this.onEnded = options.onEnded;
    this.clock = options.clock ?? performance;
    this.tickMs = options.tickMs ?? 25;
    this.lookaheadMs = options.lookaheadMs ?? 200;
    this.initialDelayMs = options.initialDelayMs ?? 100;
  }

  /**
   * Starts or resumes playback. On resume, `t0` is re-anchored with the
   * paused position as the resume offset, so events already sent are not
   * re-sent and notes held across the pause are not re-struck.
   */
  play(): void {
    if (this.timer !== null) {
      return;
    }
    const now = this.clock.now();
    this.t0 = now + this.initialDelayMs - this.pausedPositionMs;
    this.timer = setInterval(() => this.tick(), this.tickMs);
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
    this.pausedPositionMs = Math.max(0, now - t0);
    this.releaseSounding();
    this.stopTimer();
    this.t0 = null;
    this.lastSentWall = null;
    this.sounding.clear();
  }

  /**
   * Stops playback: releases sounding notes and resets the position to 0,
   * so the next play() starts the song from the beginning.
   */
  stop(): void {
    this.releaseSounding();
    this.stopTimer();
    this.t0 = null;
    this.pausedPositionMs = 0;
    this.nextIndex = 0;
    this.lastSentWall = null;
    this.sounding.clear();
  }

  /**
   * Panics (R8): sends CC123 (all notes off), CC120 (all sound off),
   * CC121 (reset all controllers) and CC64 = 0 on all 16 channels, to recover
   * hardware that is stuck.
   */
  panic(): void {
    const wall = this.releaseWall();
    for (let channel = 0; channel < 16; channel++) {
      for (const controller of PANIC_RESET_CONTROLLERS) {
        this.output.send(Uint8Array.from([0xb0 | channel, controller, 0]), wall);
      }
    }
    this.lastSentWall = wall;
    this.sounding.clear();
  }

  /**
   * Stops the tick loop and resets internal state without sending messages.
   * Send a release via stop() or panic() first if the hardware needs one.
   */
  dispose(): void {
    this.stopTimer();
    this.t0 = null;
    this.pausedPositionMs = 0;
    this.nextIndex = 0;
    this.lastSentWall = null;
    this.sounding.clear();
  }

  /** True while the song is playing. */
  isPlaying(): boolean {
    return this.t0 !== null;
  }

  /** Current song position in seconds. */
  position(): number {
    if (this.t0 !== null) {
      return Math.max(0, (this.clock.now() - this.t0) / 1000);
    }
    return this.pausedPositionMs / 1000;
  }

  /** One tick: send every event that falls inside the look-ahead window. */
  private tick(): void {
    const t0 = this.t0;
    if (t0 === null) {
      return;
    }
    const now = this.clock.now();
    const horizon = now + this.lookaheadMs;
    while (this.nextIndex < this.events.length) {
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
    // The scheduled tail has finished once the last event's wall time has
    // passed — the song ends at its computed duration. Release anything still
    // sounding first: a file can end with an unpaired note-on, and clearing
    // the map without a note-off would leave that note stuck on the hardware.
    if (this.nextIndex >= this.events.length && now >= t0 + this.duration * 1000) {
      this.releaseSounding();
      this.stopTimer();
      this.t0 = null;
      this.pausedPositionMs = 0;
      this.nextIndex = 0;
      this.lastSentWall = null;
      this.sounding.clear();
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
    } else if (e.type === 'note-off') {
      const notes = this.sounding.get(e.channel);
      if (notes !== undefined) {
        notes.delete(e.note);
        if (notes.size === 0) {
          this.sounding.delete(e.channel);
        }
      }
    }
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
    for (const [channel, notes] of this.sounding) {
      const ch = channel & 0x0f;
      for (const note of notes) {
        this.output.send(Uint8Array.from([0x80 | ch, note & 0x7f, 0]), wall);
      }
      this.output.send(Uint8Array.from([0xb0 | ch, 0x40, 0]), wall);
    }
    this.lastSentWall = wall;
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
