import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseMidiData,
  parseSongForPlayback,
  isMidiFileName,
  clearSongCache,
  ParseError,
  type ParsedMidiEvent,
  type MidiFileLike,
} from '../../src/parser';

/** Minimal hand-built Standard MIDI File writer for test fixtures. */

function vlq(n: number): number[] {
  const out: number[] = [];
  let v = n;
  out.push(v & 0x7f);
  v >>= 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

interface RawEventSpec {
  /** Delta ticks from the previous event. */
  d: number;
  /** Raw event bytes (used for running-status fixtures). */
  raw?: number[];
  noteOn?: [channel: number, note: number, velocity: number];
  noteOff?: [channel: number, note: number, velocity: number];
  cc?: [channel: number, controller: number, value: number];
  program?: [channel: number, program: number];
  /** channel, low byte, high byte. */
  pitch?: [channel: number, lo: number, hi: number];
  pressure?: [channel: number, value: number];
  tempo?: number;
}

function buildMidi(format: 0 | 1 | 2, ppq: number, tracks: RawEventSpec[][]): Uint8Array<ArrayBuffer> {
  const trackChunks: number[] = [];
  for (const track of tracks) {
    const body: number[] = [];
    for (const e of track) {
      body.push(...vlq(e.d));
      if (e.raw !== undefined) {
        body.push(...e.raw);
      } else if (e.noteOn !== undefined) {
        const [ch, note, vel] = e.noteOn;
        body.push(0x90 | ch, note, vel);
      } else if (e.noteOff !== undefined) {
        const [ch, note, vel] = e.noteOff;
        body.push(0x80 | ch, note, vel);
      } else if (e.cc !== undefined) {
        const [ch, ctrl, val] = e.cc;
        body.push(0xb0 | ch, ctrl, val);
      } else if (e.program !== undefined) {
        const [ch, prog] = e.program;
        body.push(0xc0 | ch, prog);
      } else if (e.pitch !== undefined) {
        const [ch, lo, hi] = e.pitch;
        body.push(0xe0 | ch, lo, hi);
      } else if (e.pressure !== undefined) {
        const [ch, val] = e.pressure;
        body.push(0xd0 | ch, val);
      } else if (e.tempo !== undefined) {
        body.push(0xff, 0x51, 0x03, (e.tempo >> 16) & 0xff, (e.tempo >> 8) & 0xff, e.tempo & 0xff);
      } else {
        throw new Error('unhandled event spec');
      }
    }
    body.push(0x00, 0xff, 0x2f, 0x00); // end of track
    const len = body.length;
    trackChunks.push(
      0x4d, 0x54, 0x72, 0x6b, // "MTrk"
      (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
      ...body,
    );
  }
  return Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0, 0, 0, 6,
    (format >> 8) & 0xff, format & 0xff,
    (tracks.length >> 8) & 0xff, tracks.length & 0xff,
    (ppq >> 8) & 0xff, ppq & 0xff,
    ...trackChunks,
  ]);
}

/** 120 BPM — the MIDI default tempo. */
const TEMPO_120 = { d: 0, tempo: 500_000 };

/** A file as the parser reads it. */
function fakeFile(name: string, bytes: Uint8Array<ArrayBuffer>): MidiFileLike {
  return {
    name,
    size: bytes.length,
    lastModified: 123,
    arrayBuffer: async () => bytes.buffer,
  };
}

describe('parseMidiData', () => {
  it('parses a format 0 file into a flat, time-sorted event list with times in seconds', () => {
    const bytes = buildMidi(0, 60, [
      [
        TEMPO_120,
        { d: 0, program: [0, 0] },
        { d: 0, noteOn: [0, 60, 100] },
        { d: 48, noteOn: [0, 64, 100] },
        { d: 0, cc: [0, 64, 127] },
        { d: 48, noteOff: [0, 60, 0] },
        { d: 24, pitch: [0, 0x60, 0x5d] }, // raw 12000
        { d: 24, pressure: [0, 100] },
        { d: 48, noteOff: [0, 64, 0] },
      ],
    ]);
    const song = parseMidiData(bytes);
    const expected: ParsedMidiEvent[] = [
      { type: 'program-change', time: 0, channel: 0, program: 0 },
      { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
      { type: 'note-on', time: 0.4, channel: 0, note: 64, velocity: 100 },
      { type: 'control-change', time: 0.4, channel: 0, controller: 64, value: 127 },
      { type: 'note-off', time: 0.8, channel: 0, note: 60, velocity: 0 },
      { type: 'pitch-bend', time: 1, channel: 0, value: 12000 },
      { type: 'channel-pressure', time: 1.2, channel: 0, value: 100 },
      { type: 'note-off', time: 1.6, channel: 0, note: 64, velocity: 0 },
    ];
    expect(song.events).toEqual(expected);
    expect(song.duration).toBe(1.6);
    expect(song.tempos).toEqual([{ time: 0, bpm: 120 }]);
  });

  it('parses a format 1 file and applies tempo changes to later tracks', () => {
    const bytes = buildMidi(1, 60, [
      [
        TEMPO_120,
        { d: 0, noteOn: [0, 60, 100] },
        { d: 48, noteOff: [0, 60, 0] },
      ],
      [
        { d: 96, tempo: 1_000_000 }, // 60 BPM, mid-song
        { d: 0, noteOn: [1, 72, 100] },
        { d: 96, noteOff: [1, 72, 0] },
      ],
    ]);
    const song = parseMidiData(bytes);
    // The last event's time is 0.8 + 1.6; assert it with a float-tolerant check.
    expect(song.events.slice(0, 3)).toEqual([
      { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
      { type: 'note-off', time: 0.4, channel: 0, note: 60, velocity: 0 },
      { type: 'note-on', time: 0.8, channel: 1, note: 72, velocity: 100 },
    ]);
    expect(song.events[3]).toMatchObject({
      type: 'note-off',
      channel: 1,
      note: 72,
      velocity: 0,
    });
    expect(song.events[3].time).toBeCloseTo(2.4);
    expect(song.duration).toBeCloseTo(2.4);
    expect(song.tempos).toEqual([{ time: 0, bpm: 120 }, { time: 0.8, bpm: 60 }]);
  });

  it('resolves running status (repeated event types without a status byte)', () => {
    const bytes = buildMidi(0, 60, [
      [
        TEMPO_120,
        { d: 0, raw: [0x90, 60, 100] },
        { d: 12, raw: [62, 100] }, // running status: note-on ch 0
        { d: 12, raw: [0x80, 60, 0] },
        { d: 12, raw: [62, 0] }, // running status: note-off ch 0
      ],
    ]);
    const song = parseMidiData(bytes);
    const expected: ParsedMidiEvent[] = [
      { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
      { type: 'note-on', time: 0.1, channel: 0, note: 62, velocity: 100 },
      { type: 'note-off', time: 0.2, channel: 0, note: 60, velocity: 0 },
      { type: 'note-off', time: 0.3, channel: 0, note: 62, velocity: 0 },
    ];
    expect(song.events).toEqual(expected);
    expect(song.duration).toBe(0.3);
  });

  it('keeps overlapping notes on one channel in order', () => {
    const bytes = buildMidi(0, 60, [
      [
        TEMPO_120,
        { d: 0, noteOn: [0, 60, 100] },
        { d: 12, noteOn: [0, 60, 100] }, // same note re-triggered
        { d: 12, noteOff: [0, 60, 64] },
        { d: 12, noteOff: [0, 60, 0] },
      ],
    ]);
    const song = parseMidiData(bytes);
    expect(song.events).toEqual([
      { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
      { type: 'note-on', time: 0.1, channel: 0, note: 60, velocity: 100 },
      { type: 'note-off', time: 0.2, channel: 0, note: 60, velocity: 64 },
      { type: 'note-off', time: 0.3, channel: 0, note: 60, velocity: 0 },
    ]);
  });

  it('treats a 0x9n note-on with velocity 0 as a note-off', () => {
    const bytes = buildMidi(0, 60, [[TEMPO_120, { d: 0, raw: [0x90, 60, 0] }]]);
    const song = parseMidiData(bytes);
    expect(song.events).toEqual([{ type: 'note-off', time: 0, channel: 0, note: 60, velocity: 0 }]);
  });

  it('keeps the original channel numbers', () => {
    const bytes = buildMidi(0, 60, [
      [
        TEMPO_120,
        { d: 0, noteOn: [0, 60, 100] },
        { d: 0, noteOn: [9, 61, 100] },
        { d: 0, noteOn: [15, 62, 100] },
      ],
    ]);
    const song = parseMidiData(bytes);
    expect(song.events.map((e) => e.channel)).toEqual([0, 9, 15]);
  });

  it('uses the 120 BPM default when the file gives no tempo', () => {
    const bytes = buildMidi(0, 60, [[{ d: 0, noteOn: [0, 60, 100] }, { d: 12, noteOff: [0, 60, 0] }]]);
    const song = parseMidiData(bytes);
    expect(song.events).toEqual([
      { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
      { type: 'note-off', time: 0.1, channel: 0, note: 60, velocity: 0 },
    ]);
    expect(song.tempos).toEqual([]);
  });

  it('rejects a file without an MThd header', () => {
    expect(() => parseMidiData(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])))
      .toThrow(ParseError);
    expect(() => parseMidiData(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])))
      .toThrow('missing "MThd" header');
  });

  it('rejects a truncated file', () => {
    const bytes = buildMidi(0, 60, [[TEMPO_120]]).slice(0, 10);
    expect(() => parseMidiData(bytes)).toThrow('File too small');
  });

  it('rejects a header that is too short', () => {
    const bytes = buildMidi(0, 60, [[TEMPO_120]]);
    bytes[4] = 0;
    bytes[5] = 0;
    bytes[6] = 0;
    bytes[7] = 5;
    expect(() => parseMidiData(bytes)).toThrow('Invalid MIDI header length');
  });

  it('accepts a header longer than 6 bytes', () => {
    // Some writers append bytes to the header chunk; the underlying parser
    // skips them, so rejecting these would refuse otherwise playable files.
    const track = [
      0x00, 0x90, 60, 100, // note-on
      0x30, 0x80, 60, 0, // note-off at tick 48
      0x00, 0xff, 0x2f, 0x00, // end of track
    ];
    const bytes = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 8, // MThd, length 8
      0, 0, 0, 1, 0, 60, 0, 0, // format 0, 1 track, 60 ppq, 2 padding bytes
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length,
      ...track,
    ]);
    const song = parseMidiData(bytes);
    expect(song.events).toEqual([
      { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
      { type: 'note-off', time: 0.4, channel: 0, note: 60, velocity: 0 },
    ]);
  });

  it('reports a single tempo per tick, keeping the one that takes effect', () => {
    const bytes = buildMidi(0, 60, [
      [
        TEMPO_120,
        { d: 48, tempo: 1_000_000 },
        { d: 0, tempo: 2_000_000 }, // same tick: this one wins
        { d: 48, noteOn: [0, 60, 100] },
      ],
    ]);
    const song = parseMidiData(bytes);
    expect(song.tempos).toHaveLength(2);
    expect(song.tempos[1]).toEqual({ time: 0.4, bpm: 30 });
  });

  it('rejects a track with an unrecognised event type', () => {
    const bytes = buildMidi(0, 60, [[TEMPO_120, { d: 0, raw: [0xf3, 0x00, 0x00] }]]);
    expect(() => parseMidiData(bytes)).toThrow('Cannot parse MIDI file');
  });

  it('rejects a track that ends mid-varint', () => {
    // A delta varint with its continuation bit set, with nothing after it.
    const body = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x80];
    const bytes = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 0x3c,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, body.length,
      ...body,
    ]);
    expect(() => parseMidiData(bytes)).toThrow('Cannot parse MIDI file');
  });

  it('rejects a zero tempo', () => {
    const bytes = buildMidi(0, 60, [[{ d: 0, tempo: 0 }]]);
    expect(() => parseMidiData(bytes)).toThrow('Invalid tempo');
  });
});

describe('isMidiFileName', () => {
  it('accepts .mid and .midi in any case', () => {
    expect(isMidiFileName('song.mid')).toBe(true);
    expect(isMidiFileName('Song.MID')).toBe(true);
    expect(isMidiFileName('song.midi')).toBe(true);
    expect(isMidiFileName('song.MIdi')).toBe(true);
  });

  it('rejects other names', () => {
    expect(isMidiFileName('song')).toBe(false);
    expect(isMidiFileName('song.txt')).toBe(false);
    expect(isMidiFileName('song.mid.txt')).toBe(false);
    expect(isMidiFileName('song.mid1')).toBe(false);
  });
});

describe('parseSongForPlayback', () => {
  beforeEach(() => {
    clearSongCache();
  });

  it('parses a valid file without throwing', async () => {
    const bytes = buildMidi(0, 60, [[TEMPO_120, { d: 0, noteOn: [0, 60, 100] }, { d: 12, noteOff: [0, 60, 0] }]]);
    const result = await parseSongForPlayback(fakeFile('song.mid', bytes));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.song.events).toHaveLength(2);
    }
  });

  it('caches the last parsed song (same object on replay)', async () => {
    const bytes = buildMidi(0, 60, [[TEMPO_120, { d: 0, noteOn: [0, 60, 100] }]]);
    const first = await parseSongForPlayback(fakeFile('song.mid', bytes));
    const second = await parseSongForPlayback(fakeFile('song.mid', bytes));
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    if (first.status === 'ok' && second.status === 'ok') {
      expect(second.song).toBe(first.song);
    }
  });

  it('re-parses a different file', async () => {
    const a = buildMidi(0, 60, [[TEMPO_120, { d: 0, noteOn: [0, 60, 100] }]]);
    const b = buildMidi(0, 60, [[TEMPO_120, { d: 0, noteOn: [0, 60, 100] }, { d: 12, noteOff: [0, 60, 0] }]]);
    const first = await parseSongForPlayback(fakeFile('a.mid', a));
    const second = await parseSongForPlayback(fakeFile('b.mid', b));
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    if (first.status === 'ok' && second.status === 'ok') {
      expect(second.song).not.toBe(first.song);
    }
  });

  it('returns an error result for a non-MIDI extension', async () => {
    const result = await parseSongForPlayback(fakeFile('song.txt', buildMidi(0, 60, [[TEMPO_120]])));
    expect(result).toEqual({ status: 'error', message: 'Not a MIDI file: expected a .mid or .midi file' });
  });

  it('returns an error result for a corrupt file (no throw)', async () => {
    const result = await parseSongForPlayback(fakeFile('bad.mid', Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])));
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('MThd');
    }
  });

  it('does not cache a read failure, so a retry can succeed', async () => {
    const bytes = buildMidi(0, 60, [[TEMPO_120, { d: 0, noteOn: [0, 60, 100] }]]);
    let calls = 0;
    const flaky: MidiFileLike = {
      name: 'flaky.mid',
      size: bytes.length,
      lastModified: 1,
      arrayBuffer: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('disk exploded');
        }
        return bytes.buffer;
      },
    };
    const first = await parseSongForPlayback(flaky);
    expect(first).toEqual({ status: 'error', message: 'Could not read file' });
    const second = await parseSongForPlayback(flaky);
    expect(second.status).toBe('ok');
  });
});
