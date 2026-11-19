import { describe, it, expect, vi } from 'vitest';
import {
  SYNTH_OUTPUT_ID,
  SYNTH_OUTPUT_NAME,
  SynthMidiOutput,
  audioTimeFor,
  type ScheduledMidiSink,
} from '../../src/synthOutput';

/** Records every message the adapter schedules, with its audio timestamp. */
function fakeSink(currentTime = 10): ScheduledMidiSink & {
  sent: Array<{ bytes: number[]; time: number }>;
} {
  const sent: Array<{ bytes: number[]; time: number }> = [];
  return {
    sent,
    get currentTime() {
      return currentTime;
    },
    sendMessage(bytes, channelOffset, options) {
      expect(channelOffset).toBe(0);
      sent.push({ bytes: Array.from(bytes), time: options.time });
    },
  };
}

describe('T7 — built-in synth output', () => {
  describe('audioTimeFor', () => {
    it('keeps a timestamp that is "now" on the audio clock', () => {
      // contextTime and wallNow are read together: the offset between the
      // clocks is the whole mapping.
      expect(audioTimeFor(5_000, 12.5, 5_000)).toBe(12.5);
    });

    it('places a future Web MIDI timestamp that far ahead of the audio clock', () => {
      // The scheduler sends 200 ms early; the synth must still see the offset.
      expect(audioTimeFor(5_200, 12.5, 5_000)).toBeCloseTo(12.7, 10);
    });

    it('places a past timestamp behind the audio clock', () => {
      expect(audioTimeFor(4_900, 12.5, 5_000)).toBeCloseTo(12.4, 10);
    });

    it('does not accumulate drift: the same wall time maps to the same audio time', () => {
      expect(audioTimeFor(9_999, 3.25, 1_000)).toBe(audioTimeFor(9_999, 3.25, 1_000));
    });
  });

  describe('SynthMidiOutput', () => {
    it('is a MIDIOutput the scheduler can be handed', () => {
      const output = new SynthMidiOutput(fakeSink(), () => 0);
      expect(output).toBeInstanceOf(EventTarget);
      expect(output.id).toBe(SYNTH_OUTPUT_ID);
      expect(output.name).toBe(SYNTH_OUTPUT_NAME);
      expect(output.type).toBe('output');
      expect(output.state).toBe('connected');
      expect(output.connection).toBe('open');
      expect(typeof output.send).toBe('function');
    });

    it('sends the message at its Web MIDI timestamp, on the audio clock', () => {
      const sink = fakeSink(20);
      const output = new SynthMidiOutput(sink, () => 1_000);

      output.send(Uint8Array.from([0x90, 60, 100]), 1_250);

      expect(sink.sent).toHaveLength(1);
      expect(sink.sent[0]!.bytes).toEqual([0x90, 60, 100]);
      expect(sink.sent[0]!.time).toBeCloseTo(20.25, 10);
    });

    it('sends immediately when Web MIDI gives no timestamp', () => {
      const sink = fakeSink(3.5);
      const output = new SynthMidiOutput(sink, () => 0);

      output.send([0x80, 60, 0]);

      expect(sink.sent[0]!.time).toBe(3.5);
    });

    it('accepts the plain arrays and typed arrays the scheduler builds', () => {
      const sink = fakeSink();
      const output = new SynthMidiOutput(sink, () => 0);

      output.send([0xc0, 5], 0);
      output.send(new Uint8Array([0xb0, 7, 100]), 0);

      expect(sink.sent.map((s) => s.bytes)).toEqual([
        [0xc0, 5],
        [0xb0, 7, 100],
      ]);
    });

    it('opens and closes without touching the engine', async () => {
      const sink = fakeSink();
      const output = new SynthMidiOutput(sink, () => 0);
      await expect(output.close()).resolves.toBe(output);
      expect(output.connection).toBe('closed');
      await expect(output.open()).resolves.toBe(output);
      expect(output.connection).toBe('open');
    });

    it('clear() is a no-op: pause/stop/panic send their own release', () => {
      const sink = fakeSink();
      const output = new SynthMidiOutput(sink, () => 0);
      expect(() => output.clear()).not.toThrow();
      expect(sink.sent).toHaveLength(0);
    });
  });
});
