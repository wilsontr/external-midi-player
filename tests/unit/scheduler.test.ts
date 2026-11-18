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
    // Resume is anchored after the released tail (201 + 20 = 221), not at
    // now + 100, so the pause's release cannot cut off the resumed notes.
    scheduler.play(); // t0 = 221 - 0 = 221
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([
      { bytes: [0x90, 60, 100], time: 100 },
      { bytes: [0xb0, 10, 64], time: 200 },
      { bytes: [0x80, 60, 0], time: 201 },
      { bytes: [0xb0, 64, 0], time: 201 },
      // Resumed events keep their song times under the new t0.
      { bytes: [0x80, 60, 0], time: 521 },
      { bytes: [0x91, 72, 90], time: 621 },
      { bytes: [0x81, 72, 0], time: 821 },
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
    // The program change is tick-0 setup, so it is pre-rolled ahead of t0.
    // The default 250 ms start lead puts song time 0 at 350, and the later
    // events keep their offsets from there.
    expect(calls).toEqual([
      { bytes: [0xc2, 11], time: 100 },
      { bytes: [0xe3, 0x60, 0x5d], time: 400 }, // 12000 = 0x60 | 0x5d << 7
      { bytes: [0xd4, 100], time: 450 },
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

  it('starts the tick timer on play, keeps it across pause and disposes it on stop', () => {
    const timer = { start: vi.fn(), stop: vi.fn(), dispose: vi.fn() };
    const { output } = makeOutput();
    const scheduler = new Scheduler({
      output,
      events: EVENTS,
      duration: DURATION,
      createTimer: () => timer,
    });

    scheduler.play();
    expect(timer.start).toHaveBeenCalledTimes(1);
    expect(timer.start.mock.calls[0][0]).toBe(25);

    scheduler.pause();
    expect(timer.stop).toHaveBeenCalledTimes(1);
    expect(timer.dispose).not.toHaveBeenCalled();

    scheduler.play(); // resume reuses the same timer
    expect(timer.start).toHaveBeenCalledTimes(2);

    scheduler.stop();
    expect(timer.dispose).toHaveBeenCalledTimes(1);
  });

  it('anchors play() at an explicit wall time for a track switch', () => {
    const { output, calls } = makeOutput();
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
    scheduler.play(500);
    vi.advanceTimersByTime(1200);
    expect(calls).toEqual(
      FULL_RUN.map((call) => ({ ...call, time: call.time + 400 })),
    );
  });

  it('reports the panic and stop walls so the next song can start after them', () => {
    const { output } = makeOutput();
    const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
    scheduler.play();
    vi.advanceTimersByTime(100);
    // The last queued event is at wall 200 (t=0.1); the panic sits just after.
    expect(scheduler.panic()).toBe(201);
    scheduler.dispose();

    const second = new Scheduler({ output, events: EVENTS, duration: DURATION });
    second.play();
    vi.advanceTimersByTime(100);
    // t0 is now 200, so the queued CC sits at 300 and the release follows it.
    expect(second.stop()).toBe(301);
  });

  describe('start pre-roll', () => {
    // Song time 0 is at least the 250 ms start lead after the first setup
    // message, or later when the messages cannot fit at the 1.25 ms serial
    // floor before the lead's 100 ms settle tail.
    const preRollEnd = (count: number): number =>
      100 + Math.max(250, (count - 1) * 1.25 + 100);

    it('sends tick-0 setup ahead of t0 and leaves the notes at t0', () => {
      const events: ParsedMidiEvent[] = [
        { type: 'program-change', time: 0, channel: 0, program: 62 },
        { type: 'note-on', time: 0, channel: 0, note: 72, velocity: 127 },
        { type: 'program-change', time: 0, channel: 1, program: 62 },
        { type: 'note-on', time: 0, channel: 1, note: 72, velocity: 127 },
      ];
      const { output, calls } = makeOutput();
      const scheduler = new Scheduler({ output, events, duration: 1 });
      scheduler.play();
      // The setup goes out from play() itself, one slot apart, before t0.
      // Two messages spread evenly across the lead, 150 ms apart.
      expect(calls).toEqual([
        { bytes: [0xc0, 62], time: 100 },
        { bytes: [0xc1, 62], time: 250 },
      ]);
      vi.advanceTimersByTime(200);
      // The first tick must not re-send the setup; both note-ons share t0.
      expect(calls.slice(2)).toEqual([
        { bytes: [0x90, 72, 127], time: preRollEnd(2) },
        { bytes: [0x91, 72, 127], time: preRollEnd(2) },
      ]);
    });

    it('pre-rolls a 16-part opening dump and keeps the chord on one timestamp', () => {
      // The shape of Gunstar Heroes' first tick: a program change and several
      // controllers per part, then one note per part, all at tick 0.
      const events: ParsedMidiEvent[] = [];
      for (let channel = 0; channel < 16; channel++) {
        events.push({ type: 'program-change', time: 0, channel, program: 62 });
        events.push({ type: 'control-change', time: 0, channel, controller: 7, value: 100 });
        events.push({ type: 'note-on', time: 0, channel, note: 60 + channel, velocity: 100 });
      }
      const { output, calls } = makeOutput();
      const scheduler = new Scheduler({ output, events, duration: 1 });
      scheduler.play();
      expect(calls).toHaveLength(32); // only setup, handed over before t0
      // Spread across the 150 ms between the lead's start and its settle tail.
      const step = 150 / 31;
      for (let i = 0; i < calls.length; i++) {
        expect(calls[i].time).toBeCloseTo(100 + i * step, 9);
      }
      const t0 = preRollEnd(32);
      vi.advanceTimersByTime(200);
      const notes = calls.filter((call) => (call.bytes[0] & 0xf0) === 0x90);
      expect(notes).toHaveLength(16);
      expect(notes.every((call) => call.time === t0)).toBe(true);
    });

    it('spreads the setup across a longer configured start lead', () => {
      const events: ParsedMidiEvent[] = [
        { type: 'program-change', time: 0, channel: 0, program: 5 },
        { type: 'control-change', time: 0, channel: 0, controller: 7, value: 100 },
        { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
      ];
      const { output, calls } = makeOutput();
      const scheduler = new Scheduler({ output, events, duration: 1, startLeadMs: 500 });
      scheduler.play();
      // Lead 500, settle 100: the two messages sit 400 ms apart and t0 = 600.
      expect(calls).toEqual([
        { bytes: [0xc0, 5], time: 100 },
        { bytes: [0xb0, 7, 100], time: 500 },
      ]);
      vi.advanceTimersByTime(425);
      expect(calls[2]).toEqual({ bytes: [0x90, 60, 100], time: 600 });
    });

    it('reports the last spread setup message so a following start waits for it', () => {
      const events: ParsedMidiEvent[] = [
        { type: 'program-change', time: 0, channel: 0, program: 5 },
        { type: 'control-change', time: 0, channel: 0, controller: 7, value: 100 },
        { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
      ];
      const { output } = makeOutput();
      const scheduler = new Scheduler({ output, events, duration: 1 });
      scheduler.play();
      // The second setup message is at 250 (the default lead's tail), not at
      // the 101.25 serial-span position.
      expect(scheduler.stop()).toBe(250);
    });

    it('keeps a plain note-first file on the 100 ms lead', () => {
      const events: ParsedMidiEvent[] = [
        { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
        { type: 'note-off', time: 0.1, channel: 0, note: 60, velocity: 0 },
      ];
      const { output, calls } = makeOutput();
      const scheduler = new Scheduler({ output, events, duration: 0.1 });
      scheduler.play();
      expect(calls).toEqual([]);
      vi.advanceTimersByTime(25);
      expect(calls[0]).toEqual({ bytes: [0x90, 60, 100], time: 100 });
    });

    it('does not repeat the pre-roll on resume', () => {
      const events: ParsedMidiEvent[] = [
        { type: 'program-change', time: 0, channel: 0, program: 5 },
        { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
        { type: 'note-off', time: 1, channel: 0, note: 60, velocity: 0 },
      ];
      const { output, calls } = makeOutput();
      const scheduler = new Scheduler({ output, events, duration: 1 });
      scheduler.play();
      vi.advanceTimersByTime(100);
      scheduler.pause();
      vi.advanceTimersByTime(50);
      scheduler.play();
      vi.advanceTimersByTime(1000);
      expect(calls.filter((call) => call.bytes[0] === 0xc0)).toHaveLength(1);
    });

    it('anchors an explicit start after its pre-roll for a track switch', () => {
      const events: ParsedMidiEvent[] = [
        { type: 'control-change', time: 0, channel: 0, controller: 7, value: 100 },
        { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
      ];
      const { output, calls } = makeOutput();
      const scheduler = new Scheduler({ output, events, duration: 1 });
      scheduler.play(500);
      expect(calls).toEqual([{ bytes: [0xb0, 7, 100], time: 500 }]);
      vi.advanceTimersByTime(600);
      expect(calls[1]).toEqual({ bytes: [0x90, 60, 100], time: 750 });
    });

    it('reports a failed pre-roll send and leaves the transport stopped', () => {
      const output = {
        id: 'out',
        name: 'Gone Out',
        manufacturer: 'Test',
        state: 'disconnected',
        send: vi.fn(() => {
          throw new Error('device gone');
        }),
      } as unknown as MIDIOutput;
      const errors: string[] = [];
      const scheduler = new Scheduler({
        output,
        events: [
          { type: 'program-change', time: 0, channel: 0, program: 5 },
          { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
        ],
        duration: 1,
        onError: (message) => errors.push(message),
      });
      expect(() => scheduler.play()).not.toThrow();
      expect(errors).toEqual(['device gone']);
      expect(scheduler.isPlaying()).toBe(false);
      expect(scheduler.position()).toBe(0);
      expect(() => scheduler.pause()).not.toThrow();
    });
  });

  describe('seek', () => {
    const SEEK_EVENTS: ParsedMidiEvent[] = [
      { type: 'program-change', time: 0, channel: 0, program: 5 },
      { type: 'control-change', time: 0, channel: 0, controller: 0, value: 3 },
      { type: 'control-change', time: 0, channel: 0, controller: 32, value: 1 },
      { type: 'control-change', time: 0.1, channel: 0, controller: 7, value: 100 },
      { type: 'pitch-bend', time: 0.1, channel: 1, value: 1000 },
      { type: 'channel-pressure', time: 0.2, channel: 2, value: 50 },
      { type: 'note-on', time: 0.2, channel: 0, note: 60, velocity: 100 },
      { type: 'control-change', time: 0.4, channel: 0, controller: 64, value: 127 },
      { type: 'note-off', time: 1, channel: 0, note: 60, velocity: 0 },
      { type: 'note-on', time: 1.5, channel: 0, note: 64, velocity: 80 },
      { type: 'note-off', time: 2, channel: 0, note: 64, velocity: 0 },
    ];

    // The three tick-0 setup events are spread across the default 250 ms
    // start lead (which ends at 350), then the events keep their offsets.
    const T0 = 350;
    const INITIAL: SendRecord[] = [
      { bytes: [0xc0, 5], time: 100 },
      { bytes: [0xb0, 0, 3], time: 175 },
      { bytes: [0xb0, 32, 1], time: 250 },
      { bytes: [0xb0, 7, 100], time: T0 + 100 },
      { bytes: [0xe1, 0x68, 0x07], time: T0 + 100 },
      { bytes: [0xd2, 50], time: T0 + 200 },
      { bytes: [0x90, 60, 100], time: T0 + 200 },
    ];

    it('releases the old notes, restores the MIDI state at the target and continues from it', () => {
      const { output, calls } = makeOutput();
      const scheduler = new Scheduler({ output, events: SEEK_EVENTS, duration: 2 });
      scheduler.play();
      vi.advanceTimersByTime(400); // past t0, through the note-on at 0.2 s
      expect(calls).toEqual(INITIAL);
      expect(scheduler.position()).toBe(0.05);

      scheduler.seek(1.2);
      expect(scheduler.position()).toBe(1.2);

      vi.advanceTimersByTime(1000);
      expect(calls).toEqual([
        ...INITIAL,
        // Release the sounding note after the delivered tail (T0 + 200).
        { bytes: [0x80, 60, 0], time: T0 + 201 },
        { bytes: [0xb0, 64, 0], time: T0 + 201 },
        // The state the channels had reached by 1.2 s, after the release.
        { bytes: [0xb0, 0, 3], time: T0 + 202 },
        { bytes: [0xb0, 32, 1], time: T0 + 202 },
        { bytes: [0xc0, 5], time: T0 + 202 },
        { bytes: [0xb0, 7, 100], time: T0 + 202 },
        { bytes: [0xb0, 64, 127], time: T0 + 202 },
        { bytes: [0xe1, 0x68, 0x07], time: T0 + 202 },
        { bytes: [0xd2, 50], time: T0 + 202 },
        // Notes before the target are not re-struck; playback resumes at 1.5 s.
        { bytes: [0x90, 64, 80], time: T0 + 522 },
        { bytes: [0x80, 64, 0], time: T0 + 1022 },
      ]);
      expect(scheduler.isPlaying()).toBe(false);
    });

    it('seeks while paused, stays paused, and resumes from the target after the state', () => {
      const { output, calls } = makeOutput();
      const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
      scheduler.play();
      vi.advanceTimersByTime(100);
      scheduler.pause();
      expect(scheduler.isPlaying()).toBe(false);

      scheduler.seek(0.4);
      expect(scheduler.position()).toBe(0.4);
      expect(scheduler.isPlaying()).toBe(false);
      expect(calls.slice(-1)).toEqual([{ bytes: [0xb0, 10, 64], time: 202 }]);

      vi.advanceTimersByTime(50);
      scheduler.play();
      vi.advanceTimersByTime(600);
      expect(calls).toEqual([
        { bytes: [0x90, 60, 100], time: 100 },
        { bytes: [0xb0, 10, 64], time: 200 },
        { bytes: [0x80, 60, 0], time: 201 },
        { bytes: [0xb0, 64, 0], time: 201 },
        // Target state goes out while paused; the resume note follows it.
        { bytes: [0xb0, 10, 64], time: 202 },
        { bytes: [0x91, 72, 90], time: 222 },
        { bytes: [0x81, 72, 0], time: 422 },
      ]);
    });

    it('clamps to the song and ignores a seek while stopped', () => {
      const { output, calls } = makeOutput();
      const scheduler = new Scheduler({ output, events: EVENTS, duration: DURATION });
      scheduler.seek(0.3);
      expect(scheduler.position()).toBe(0);
      vi.advanceTimersByTime(100);

      scheduler.play();
      vi.advanceTimersByTime(25);
      scheduler.seek(-5);
      expect(scheduler.position()).toBe(0);
      scheduler.seek(99);
      expect(scheduler.position()).toBe(DURATION);

      const ended = vi.fn();
      const endScheduler = new Scheduler({
        output,
        events: EVENTS,
        duration: DURATION,
        onEnded: ended,
      });
      endScheduler.play();
      vi.advanceTimersByTime(25);
      endScheduler.seek(99);
      expect(endScheduler.position()).toBe(DURATION);
      vi.advanceTimersByTime(300);
      expect(ended).toHaveBeenCalledTimes(1);
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('stops cleanly and reports when output.send throws', () => {
    const output = {
      id: 'out',
      name: 'Gone Out',
      manufacturer: 'Test',
      state: 'disconnected',
      send: vi.fn(() => {
        throw new Error('device gone');
      }),
    } as unknown as MIDIOutput;
    const errors: string[] = [];
    const scheduler = new Scheduler({
      output,
      events: EVENTS,
      duration: DURATION,
      onError: (message) => errors.push(message),
    });

    scheduler.play();
    expect(() => vi.advanceTimersByTime(25)).not.toThrow();

    expect(errors).toEqual(['device gone']);
    expect(scheduler.isPlaying()).toBe(false);
  });
});
