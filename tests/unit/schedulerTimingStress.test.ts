/**
 * Playback timing stress (R5).
 *
 * The app cannot measure the OS/hardware clock, but it can prove that the
 * scheduler hands every message to `MIDIOutput.send` with the intended
 * future timestamp even when the 25 ms tick loop is delayed or jittery.
 *
 * These tests drive the captured interval callback manually against a fake
 * clock, so the jitter patterns are deterministic and a five-minute song
 * runs in milliseconds. They cover:
 *
 * - a dense song with every tick jittered but still inside the 200 ms
 *   look-ahead: timestamps stay exact, in order, and never in the past;
 * - a single tick stalled well past the look-ahead: lateness is bounded by
 *   (`gap - look-ahead`), no event is sent with a past timestamp, and the
 *   schedule recovers with zero drift afterwards;
 * - the end callback stays within one jittered tick of the computed duration.
 *
 * This is scheduler jitter, not hardware/OS scheduling latency: once a
 * message is handed over with a timestamp, the browser and device own it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../../src/scheduler';
import type { ParsedMidiEvent } from '../../src/parser';

interface SendRecord {
  bytes: number[];
  /** Timestamp handed to `MIDIOutput.send` (fake-clock ms). */
  time: number;
  /** Fake-clock time at the moment `send` was called. */
  at: number;
}

/** Mock output that records the fake-clock time as well as the timestamp. */
function makeOutput(now: () => number) {
  const calls: SendRecord[] = [];
  const output = {
    id: 'out',
    name: 'Stress Out',
    manufacturer: 'Test',
    state: 'connected',
    send: (data: ArrayLike<number>, timestamp?: number) => {
      calls.push({ bytes: Array.from(data), time: timestamp ?? 0, at: now() });
    },
  } as unknown as MIDIOutput;
  return { output, calls };
}

/** Deterministic LCG so a failing run can be reproduced exactly. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Mirrors `eventToBytes` in scheduler.ts for the expected sequence. */
function encode(e: ParsedMidiEvent): number[] {
  const ch = e.channel & 0x0f;
  switch (e.type) {
    case 'note-on':
      return [0x90 | ch, e.note & 0x7f, e.velocity & 0x7f];
    case 'note-off':
      return [0x80 | ch, e.note & 0x7f, e.velocity & 0x7f];
    case 'control-change':
      return [0xb0 | ch, e.controller & 0x7f, e.value & 0x7f];
    case 'program-change':
      return [0xc0 | ch, e.program & 0x7f];
    case 'pitch-bend':
      return [0xe0 | ch, e.value & 0x7f, (e.value >> 7) & 0x7f];
    case 'channel-pressure':
      return [0xd0 | ch, e.value & 0x7f];
  }
}

function sameBytes(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A dense, time-sorted song: a note-on/note-off pair every `stepMs`, plus a
 * controller every eighth step, spread across all 16 channels. At 10 ms over
 * five minutes this is ~64k events.
 */
function denseSong(durationSec: number, stepMs: number) {
  const events: ParsedMidiEvent[] = [];
  const stepSec = stepMs / 1000;
  const steps = Math.floor((durationSec * 1000) / stepMs);
  for (let i = 0; i < steps; i++) {
    const time = i * stepSec;
    const channel = i % 16;
    const note = 36 + (i % 60);
    events.push({ type: 'note-on', time, channel, note, velocity: 1 + (i % 127) });
    events.push({ type: 'note-off', time, channel, note, velocity: 0 });
    // Deliberately no controller on tick 0: a tick-0 setup is pre-rolled before
    // song time 0 (covered in scheduler.test.ts), and this test is about the
    // tick loop's jitter, which assumes everything starts at t0 = 100.
    if (i % 8 === 0 && i !== 0) {
      events.push({ type: 'control-change', time, channel, controller: 1 + (i % 120), value: i % 128 });
    }
  }
  const duration = events.length === 0 ? 0 : events[events.length - 1].time;
  return { events, duration };
}

/**
 * Replaces the global interval functions so the test can invoke the
 * scheduler's tick manually. Returns a `tick()` driver.
 */
function manualTicker(): () => void {
  let tick: (() => void) | null = null;
  vi.stubGlobal(
    'setInterval',
    vi.fn((callback: () => void) => {
      tick = callback;
      return 1;
    }),
  );
  vi.stubGlobal('clearInterval', vi.fn());
  return () => {
    if (tick === null) throw new Error('scheduler did not start its tick loop');
    tick();
  };
}

/** A song's wall-clock time for an event, given the fake clock's t0. */
const intended = (t0: number, event: ParsedMidiEvent): number => t0 + event.time * 1000;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Scheduler timing stress', () => {
  it('keeps timestamps exact for a dense five-minute song with jittery ticks inside the look-ahead', () => {
    const { events, duration } = denseSong(300, 10);
    let now = 0;
    const { output, calls } = makeOutput(() => now);
    let endedAt: number | null = null;
    const scheduler = new Scheduler({
      output,
      events,
      duration,
      clock: { now: () => now },
      onEnded: () => {
        endedAt = now;
      },
    });
    const tick = manualTicker();
    const nextGap = random(0x5eed);
    scheduler.play();

    // Every gap is 15–45 ms, well inside the 200 ms look-ahead. A tick can be
    // late, but the previous tick already covered the missing window.
    for (let ticks = 0; endedAt === null && ticks < 100_000; ticks++) {
      now += 15 + nextGap() * 30;
      tick();
    }

    const t0 = 100;
    expect(endedAt).not.toBeNull();
    expect(calls).toHaveLength(events.length);

    let maxLateness = 0;
    let firstBadIndex = -1;
    let monotonic = true;
    for (let i = 0; i < events.length; i++) {
      const call = calls[i];
      const target = intended(t0, events[i]);
      const late = call.time - target;
      if (late > maxLateness) maxLateness = late;
      if (i > 0 && call.time < calls[i - 1].time) monotonic = false;
      // A timestamp is never in the past at the moment it is sent.
      if (call.time < call.at - 1e-9) firstBadIndex = i;
      if (!sameBytes(call.bytes, encode(events[i]))) firstBadIndex = i;
      if (late < -1e-9) firstBadIndex = i; // never scheduled before its time
    }

    expect(firstBadIndex).toBe(-1);
    expect(monotonic).toBe(true);
    expect(maxLateness).toBeLessThan(1e-6);
    // The audible end is the last scheduled event, which is exact. The ended
    // callback fires on the next tick, so it is within one jittered gap.
    expect(endedAt! - (t0 + duration * 1000)).toBeLessThanOrEqual(45);
    expect(endedAt! - (t0 + duration * 1000)).toBeGreaterThanOrEqual(0);
    expect(scheduler.isPlaying()).toBe(false);
    expect(scheduler.position()).toBe(0);
  });

  it('bounds lateness after a tick stalls beyond the look-ahead and then recovers without drift', () => {
    const { events, duration } = denseSong(60, 10);
    let now = 0;
    const { output, calls } = makeOutput(() => now);
    let endedAt: number | null = null;
    const scheduler = new Scheduler({
      output,
      events,
      duration,
      clock: { now: () => now },
      onEnded: () => {
        endedAt = now;
      },
    });
    const tick = manualTicker();
    const nextGap = random(0xbeef);
    scheduler.play();

    // Normal, in-look-ahead jitter for ~5 s.
    while (now < 5_000) {
      now += 15 + nextGap() * 30;
      tick();
    }
    const beforeStall = calls.length;

    // 500 ms stall: 300 ms beyond the 200 ms look-ahead.
    const stallGap = 500;
    now += stallGap;
    tick();
    const afterStall = calls.length;

    // Resume normal jitter until the end.
    for (let ticks = 0; endedAt === null && ticks < 100_000; ticks++) {
      now += 15 + nextGap() * 30;
      tick();
    }

    const t0 = 100;
    const lookahead = 200;
    let maxLateness = 0;
    let lateCount = 0;
    let pastTimestamp = -1;
    for (let i = 0; i < events.length; i++) {
      const late = calls[i].time - intended(t0, events[i]);
      if (late > 1e-9) {
        lateCount += 1;
        if (late > maxLateness) maxLateness = late;
      }
      if (calls[i].time < calls[i].at - 1e-9) pastTimestamp = i;
    }

    expect(endedAt).not.toBeNull();
    expect(calls).toHaveLength(events.length);
    expect(lateCount).toBeGreaterThan(0); // the stall did miss events
    // The stall can delay only the events that were already due: at most
    // stallGap - lookahead, never an accumulated drift.
    expect(maxLateness).toBeLessThanOrEqual(stallGap - lookahead + 1);
    expect(pastTimestamp).toBe(-1);

    // All lateness is confined to the stall batch; everything after is exact.
    expect(afterStall).toBeGreaterThan(beforeStall);
    let lateInStall = 0;
    for (let i = beforeStall; i < afterStall; i++) {
      if (calls[i].time - intended(t0, events[i]) > 1e-9) lateInStall += 1;
    }
    expect(lateInStall).toBe(lateCount);
    let lateAfterStall = 0;
    for (let i = afterStall; i < events.length; i++) {
      if (calls[i].time - intended(t0, events[i]) > 1e-9) lateAfterStall += 1;
    }
    expect(lateAfterStall).toBe(0);
    expect(endedAt! - (t0 + duration * 1000)).toBeLessThanOrEqual(45);
  });
});
