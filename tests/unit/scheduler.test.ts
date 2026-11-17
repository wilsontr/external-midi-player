import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scheduler } from '../../src/scheduler';
import type { ParsedMidiEvent } from '../../src/parser';

/** One captured `output.send` call: raw bytes and the Web Audio timestamp. */
interface SendRecord {
  bytes: number[];
  time: number;
}

function makeOutput() {
  const calls: SendRecord[] = [];
  const send = vi.fn((data: number[] | Uint8Array, timestamp?: number) => {
    calls.push({ bytes: Array.from(data as ArrayLike<number>), time: timestamp ?? 0 });
  });
  const output = {
    id: 'out',
    name: 'Test Out',
    manufacturer: 'Test',
    state: 'connected',
    send,
    clear: vi.fn(),
  } as unknown as MIDIOutput;
  return { output, calls };
}

/** Standard song used across the tests: two notes on two channels, one CC. */
const EVENTS: ParsedMidiEvent[] = [
  { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
  { type: 'control-change', time: 0.1, channel: 0, controller: 10, value: 64 },
  { type: 'note-off', time: 0.3, channel: 0, note: 60, velocity: 0 },
  { type: 'note-on', time: 0.4, channel: 1, note: 72, velocity: 90 },
  { type: 'note-off', time: 0.6, channel: 1, note: 72, velocity: 0 },
];
const DURATION = 0.6;

/**
 * Expected wall-clock times (ms, fake clock starts at 0): play() at t=0 sets
 * t0 = 100, so each event's timestamp is 100 + time*1000.
 */
const FULL_RUN: SendRecord[] = [
  { bytes: [0x90, 60, 100], time: 100 },
  { bytes: [0xb0, 10, 64], time: 200 },
  { bytes: [0x80, 60, 0], time: 400 },
  { bytes: [0x91, 72, 90], time: 500 },
  { bytes: [0x81, 72, 0], time: 700 },
];

describe('Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends every event exactly once, in order, with the correct Web Audio timestamp', () => {
    const { output, calls } = makeOutput();
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
    scheduler.play();
    vi.advanceTimersByTime(800);
    expect(calls).toEqual(FULL_RUN);
    expect(scheduler.isPlaying()).toBe(false);
  });

  it('only sends events that fall before now + lookahead', () => {
    const { output, calls } = makeOutput();
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
    scheduler.play();
    // At the 25 ms tick only t=0 and t=0.1 events are inside the window.
    vi.advanceTimersByTime(25);
    expect(calls).toEqual(FULL_RUN.slice(0, 2));
    // At 200 ms the t=0.3 event is still 200 ms out (boundary, not < now+200).
    vi.advanceTimersByTime(175);
    expect(calls).toEqual(FULL_RUN.slice(0, 2));
    // One tick later it is inside the window.
    vi.advanceTimersByTime(25);
    expect(calls).toEqual(FULL_RUN.slice(0, 3));
  });

  it('gives every send a future timestamp', () => {
    const nowAtSend: number[] = [];
    const send = vi.fn((data: number[] | Uint8Array, timestamp?: number) => {
      nowAtSend.push(performance.now());
    });
    const output = {
      id: 'out',
      name: 'Test Out',
      manufacturer: 'Test',
      state: 'connected',
      send,
    } as unknown as MIDIOutput;
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
    scheduler.play();
    vi.advanceTimersByTime(200);
    scheduler.pause(); // releases the still-sounding note
    scheduler.panic(); // includes the release + panic messages
    vi.advanceTimersByTime(100);
    for (let i = 0; i < nowAtSend.length; i++) {
      const sent = send.mock.calls[i] as unknown as [number[] | Uint8Array, number];
      expect(sent[1]).toBeGreaterThan(nowAtSend[i]);
    }
    expect(send).toHaveBeenCalled();
  });

  it('releases sounding notes on pause (note-off then CC64=0, just after the last queued event)', () => {
    const { output, calls } = makeOutput();
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
    scheduler.play();
    vi.advanceTimersByTime(100); // t=0 and t=0.1 events queued; note 60 still sounding
    scheduler.pause();
    // Release goes just after the last queued event (t=0.1 → wall 200), not after now (100).
    expect(calls).toEqual([
      { bytes: [0x90, 60, 100], time: 100 },
      { bytes: [0xb0, 10, 64], time: 200 },
      { bytes: [0x80, 60, 0], time: 201 },
      { bytes: [0xb0, 64, 0], time: 201 },
    ]);
    expect(scheduler.isPlaying()).toBe(false);
  });

  it('resumes from the offset without re-sending earlier events', () => {
    const { output, calls } = makeOutput();
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
    scheduler.play();
    vi.advanceTimersByTime(100);
    scheduler.pause();
    vi.advanceTimersByTime(50);
    scheduler.play(); // t0 re-anchored: 150 + 100 - 0 = 250
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([
      { bytes: [0x90, 60, 100], time: 100 },
      { bytes: [0xb0, 10, 64], time: 200 },
      { bytes: [0x80, 60, 0], time: 201 },
      { bytes: [0xb0, 64, 0], time: 201 },
      // Resumed events keep their song times under the new t0.
      { bytes: [0x80, 60, 0], time: 550 },
      { bytes: [0x91, 72, 90], time: 650 },
      { bytes: [0x81, 72, 0], time: 850 },
    ]);
    expect(scheduler.isPlaying()).toBe(false);
  });

  it('releases sounding notes on stop and restarts from the beginning', () => {
    const { output, calls } = makeOutput();
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
    scheduler.play();
    vi.advanceTimersByTime(100);
    scheduler.stop();
    expect(calls).toEqual([
      { bytes: [0x90, 60, 100], time: 100 },
      { bytes: [0xb0, 10, 64], time: 200 },
      { bytes: [0x80, 60, 0], time: 201 },
      { bytes: [0xb0, 64, 0], time: 201 },
    ]);
    expect(scheduler.position()).toBe(0);
    // Next play() starts the song over from event 0.
    scheduler.play();
    vi.advanceTimersByTime(800);
    expect(calls).toEqual([
      { bytes: [0x90, 60, 100], time: 100 },
      { bytes: [0xb0, 10, 64], time: 200 },
      { bytes: [0x80, 60, 0], time: 201 },
      { bytes: [0xb0, 64, 0], time: 201 },
      { bytes: [0x90, 60, 100], time: 200 },
      { bytes: [0xb0, 10, 64], time: 300 },
      { bytes: [0x80, 60, 0], time: 500 },
      { bytes: [0x91, 72, 90], time: 600 },
      { bytes: [0x81, 72, 0], time: 800 },
    ]);
  });

  it('fires onEnded exactly once, at the computed duration', () => {
    const { output, calls } = makeOutput();
    const endedAt: number[] = [];
    const onEnded = vi.fn(() => {
      endedAt.push(performance.now());
    });
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION, onEnded });
    scheduler.play();
    vi.advanceTimersByTime(800);
    expect(onEnded).toHaveBeenCalledTimes(1);
    // The song ends at t0 + duration, not earlier.
    expect(endedAt[0]).toBeGreaterThanOrEqual(700);
    expect(calls).toEqual(FULL_RUN);
    expect(scheduler.position()).toBe(0);
  });

  it('does not double-schedule when play() is called while playing', () => {
    const { output, calls } = makeOutput();
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
    scheduler.play();
    scheduler.play();
    vi.advanceTimersByTime(800);
    expect(calls).toEqual(FULL_RUN);
  });

  it('panic sends CC123, CC120, CC121 and CC64=0 on all 16 channels', () => {
    const { output, calls } = makeOutput();
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
    scheduler.panic();
    expect(calls.length).toBe(64);
    for (let channel = 0; channel < 16; channel++) {
      for (let i = 0; i < 4; i++) {
        const controller = [0x7b, 0x78, 0x79, 0x40][i];
        expect(calls[channel * 4 + i]).toEqual({ bytes: [0xb0 | channel, controller, 0], time: 1 });
      }
    }
  });

  it('panic while playing goes just after the last queued event', () => {
    const { output, calls } = makeOutput();
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
    scheduler.play();
    vi.advanceTimersByTime(25); // t=0 and t=0.1 events queued (last queued wall 200)
    scheduler.panic();
    // All 64 panic messages follow the last queued event (200), not now (25).
    const panicCalls = calls.slice(2);
    expect(panicCalls.length).toBe(64);
    for (const c of panicCalls) {
      expect(c.time).toBe(201);
    }
  });

  it('encodes program change, pitch bend and channel pressure bytes', () => {
    const events: ParsedMidiEvent[] = [
      { type: 'program-change', time: 0, channel: 2, program: 11 },
      { type: 'pitch-bend', time: 0.05, channel: 3, value: 12000 },
      { type: 'channel-pressure', time: 0.1, channel: 4, value: 100 },
    ];
    const { output, calls } = makeOutput();
    const scheduler = new Scheduler({ output, events, duration: 0.1 });
    scheduler.play();
    vi.advanceTimersByTime(300);
    expect(calls).toEqual([
      { bytes: [0xc2, 11], time: 100 },
      { bytes: [0xe3, 0x60, 0x5d], time: 150 }, // 12000 = 0x60 | 0x5d << 7
      { bytes: [0xd4, 100], time: 200 },
    ]);
  });

  it('clamps events that are already late when sent to the current time', () => {
    const events: ParsedMidiEvent[] = [
      { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
      { type: 'note-off', time: 0.15, channel: 0, note: 60, velocity: 0 },
    ];
    const { output, calls } = makeOutput();
    // A tick slower than the lookahead: both events are past due when the
    // first tick fires, so both are clamped to the tick's now — never a
    // past Web MIDI timestamp.
    const scheduler = new Scheduler({ output, events, duration: 0.15, tickMs: 300, lookaheadMs: 200 });
    scheduler.play();
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([
      { bytes: [0x90, 60, 100], time: 300 },
      { bytes: [0x80, 60, 0], time: 300 },
    ]);
  });

  it('reports the current song position', () => {
    const { output } = makeOutput();
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
    expect(scheduler.position()).toBe(0);
    scheduler.play();
    vi.advanceTimersByTime(100); // now = 100 = t0
    expect(scheduler.position()).toBe(0);
    vi.advanceTimersByTime(50);
    expect(scheduler.position()).toBe(0.05);
  });

  it('ends a long song at t0 + duration, independent of song length', () => {
    // Backs the R5 acceptance criterion for a 5-minute file: the end fires
    // exactly at the computed duration, not after a drift.
    const longEvents: ParsedMidiEvent[] = [
      { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
      { type: 'note-off', time: 299.9, channel: 0, note: 60, velocity: 0 },
    ];
    const { output, calls } = makeOutput();
    const endedAt: number[] = [];
    const onEnded = vi.fn(() => endedAt.push(performance.now()));
    const scheduler = new Scheduler({ output, events: longEvents, duration: 300, onEnded });
    scheduler.play();
    vi.advanceTimersByTime(300_500);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(endedAt[0]).toBe(300_100); // t0 (100) + 300 s, exactly
    expect(calls).toEqual([
      { bytes: [0x90, 60, 100], time: 100 },
      { bytes: [0x80, 60, 0], time: 300_000 },
    ]);
  });

  it('releases a note that the file never turns off, when the song ends', () => {
    // A truncated or sloppy file can end with an unpaired note-on. Clearing the
    // state without a note-off would leave that note stuck on the hardware.
    const events: ParsedMidiEvent[] = [
      { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
      { type: 'note-on', time: 0.2, channel: 2, note: 67, velocity: 80 },
      { type: 'note-off', time: 0.4, channel: 0, note: 60, velocity: 0 },
    ];
    const { output, calls } = makeOutput();
    const scheduler = new Scheduler({ output, events, duration: 0.4 });
    scheduler.play();
    vi.advanceTimersByTime(800);
    expect(calls).toEqual([
      { bytes: [0x90, 60, 100], time: 100 },
      { bytes: [0x92, 67, 80], time: 300 },
      { bytes: [0x80, 60, 0], time: 500 },
      // The hanging note 67 on channel 2 is released at the end of the song.
      { bytes: [0x82, 67, 0], time: 501 },
      { bytes: [0xb2, 64, 0], time: 501 },
    ]);
    expect(scheduler.isPlaying()).toBe(false);
  });

  it('dispose stops the tick loop without sending', () => {
    const { output, calls } = makeOutput();
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
    scheduler.play();
    vi.advanceTimersByTime(25);
    scheduler.dispose();
    const countAfterDispose = calls.length;
    vi.advanceTimersByTime(1000);
    expect(calls.length).toBe(countAfterDispose);
    expect(scheduler.isPlaying()).toBe(false);
  });
});
