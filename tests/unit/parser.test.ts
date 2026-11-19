import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseMidiData,
  parseSongForPlayback,
  isMidiFileName,
  clearSongCache,
  programAt,
  summarizeInstruments,
  gmInstrumentName,
  GM_INSTRUMENTS,
  ParseError,
  decodeMidiText,
  METADATA_MAX_VALUES,
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
  /** Raw meta event; 0xFF and the length are added by the builder. */
  meta?: { type: number; data: number[] };
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
      } else if (e.meta !== undefined) {
        body.push(0xff, e.meta.type, ...vlq(e.meta.data.length), ...e.meta.data);
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

describe('decodeMidiText (T20)', () => {
  const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
  // 並木学
  const SHIFT_JIS_NAMIKI = [0x95, 0xc0, 0x96, 0xd8, 0x8a, 0x77];
  const EUC_JP_NAMIKI = [0xca, 0xc2, 0xcc, 0xda, 0xb3, 0xd8];
  const ISO_2022_JP_NAMIKI = [
    0x1b, 0x24, 0x42, 0x4a, 0x42, 0x4c, 0x5a, 0x33, 0x58, 0x1b, 0x28, 0x42,
  ];
  const UTF8_NAMIKI = [0xe4, 0xb8, 0xa6, 0xe6, 0x9c, 0xa8, 0xe5, 0xad, 0xa6];

  it('decodes plain ASCII and strips NULs', () => {
    expect(decodeMidiText('Track 1')).toEqual({ text: 'Track 1', encoding: 'ascii' });
    expect(decodeMidiText(Uint8Array.from([0x41, 0x00, 0x42]))).toEqual({
      text: 'AB',
      encoding: 'ascii',
    });
  });

  it('decodes UTF-8 Japanese and a UTF-8 BOM', () => {
    expect(decodeMidiText(Uint8Array.from(UTF8_NAMIKI))).toEqual({
      text: '並木学',
      encoding: 'utf-8',
    });
    expect(decodeMidiText(Uint8Array.from([0xef, 0xbb, 0xbf, ...UTF8_NAMIKI]))).toEqual({
      text: '並木学',
      encoding: 'utf-8',
    });
  });

  it('decodes Shift_JIS, including the bytes midi-file hands over as Latin-1', () => {
    const latin1 = String.fromCharCode(...SHIFT_JIS_NAMIKI);
    expect(decodeMidiText(latin1)).toEqual({ text: '並木学', encoding: 'shift_jis' });
  });

  it('decodes EUC-JP even though the same bytes are valid half-width Shift_JIS', () => {
    expect(decodeMidiText(Uint8Array.from(EUC_JP_NAMIKI))).toEqual({
      text: '並木学',
      encoding: 'euc-jp',
    });
  });

  it('decodes ISO-2022-JP before the ASCII/UTF-8 checks swallow its escape bytes', () => {
    expect(decodeMidiText(Uint8Array.from(ISO_2022_JP_NAMIKI))).toEqual({
      text: '並木学',
      encoding: 'iso-2022-jp',
    });
  });

  it('keeps a lone copyright byte as Windows-1252 rather than half-width katakana', () => {
    const bytes = Uint8Array.from([...ascii('Copyright '), 0xa9, ...ascii(' 2004')]);
    expect(decodeMidiText(bytes)).toEqual({
      text: 'Copyright © 2004',
      encoding: 'windows-1252',
    });
  });

  it('falls back to Windows-1252 for bytes no Japanese candidate qualifies', () => {
    expect(decodeMidiText(Uint8Array.from([0x80, 0x81, 0xff])).encoding).toBe('windows-1252');
  });

  it('normalises controls and NFC without losing tabs or newlines', () => {
    const decoded = decodeMidiText('@DRUID:\t\tjh696my0069\u0081\r\n');
    expect(decoded.text).toBe('@DRUID:\t\tjh696my0069');
    expect(decoded.encoding).toBe('windows-1252');
  });
});

describe('song metadata (T20)', () => {
  const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
  const SHIFT_JIS_NAMIKI = [0x95, 0xc0, 0x96, 0xd8, 0x8a, 0x77];
  const name = (data: number[], d = 0) => ({ d, meta: { type: 0x03, data } });
  const text = (data: number[], d = 0) => ({ d, meta: { type: 0x01, data } });
  const copyright = (data: number[], d = 0) => ({ d, meta: { type: 0x02, data } });

  it('collects all three text fields with track indices, decodes them and keeps them out of playback', () => {
    const bytes = buildMidi(1, 480, [
      [
        name(SHIFT_JIS_NAMIKI),
        copyright([...ascii('Copyright '), 0xa9, ...ascii(' 2004')]),
        text(ascii('@DRUID:\t\tjh696my0069')),
        { d: 0, tempo: 500_000 },
        { d: 0, noteOn: [0, 60, 100] },
        { d: 480, noteOff: [0, 60, 0] },
      ],
      [
        name(ascii('Piano')),
        text(ascii('second track')),
        { d: 0, noteOn: [1, 64, 100] },
        { d: 480, noteOff: [1, 64, 0] },
      ],
    ]);
    const song = parseMidiData(bytes);

    expect(song.metadata).toEqual({
      trackNames: [
        { track: 0, text: '並木学' },
        { track: 1, text: 'Piano' },
      ],
      textEvents: [
        { track: 0, text: '@DRUID:\t\tjh696my0069' },
        { track: 1, text: 'second track' },
      ],
      copyrights: [{ track: 0, text: 'Copyright © 2004' }],
      title: '並木学',
      truncated: false,
    });
    expect(song.duration).toBe(0.5);
    expect(song.events.map((event) => event.type)).toEqual([
      'note-on',
      'note-on',
      'note-off',
      'note-off',
    ]);
  });

  it('uses track 0’s name, and an unusable track-0 name suppresses later tracks', () => {
    const titleFor = (tracks: RawEventSpec[][]): string | null =>
      parseMidiData(buildMidi(1, 480, tracks)).metadata.title;

    expect(titleFor([[name(ascii('untitled'))], [name(ascii('Voice 2'))]])).toBeNull();
    expect(titleFor([[name(ascii('  UNTITLED  '))], [name(ascii('Voice 2'))]])).toBeNull();
    expect(titleFor([[name(ascii(''))], [name(ascii('Voice 2'))]])).toBeNull();
    expect(titleFor([[name(ascii('Track 1'))]])).toBe('Track 1');
    expect(titleFor([[name(ascii('  Real\n Title  '))]])).toBe('Real Title');
    expect(titleFor([[name(ascii('untitled'))], [name(ascii('Real Title'))]])).toBeNull();
  });

  it('ignores every track after the first when the first has no Track Name', () => {
    const bytes = buildMidi(1, 480, [
      [{ d: 0, noteOn: [0, 60, 100] }],
      [name(ascii('Chemical Plant')), { d: 0, noteOff: [0, 60, 0] }],
      [name(ascii('Sonic the Hedgehog 2')), { d: 0, noteOn: [1, 60, 100] }],
    ]);
    const song = parseMidiData(bytes);
    expect(song.metadata.title).toBeNull();
    // The viewer still lists every track's Track Name, including the ignored ones.
    expect(song.metadata.trackNames).toEqual([
      { track: 1, text: 'Chemical Plant' },
      { track: 2, text: 'Sonic the Hedgehog 2' },
    ]);
  });

  it('caps retained values without changing the title', () => {
    const events = Array.from({ length: METADATA_MAX_VALUES + 5 }, (_, index) =>
      name(ascii(`Name ${index}`)),
    );
    const song = parseMidiData(buildMidi(1, 480, [events]));
    expect(song.metadata.trackNames).toHaveLength(METADATA_MAX_VALUES);
    expect(song.metadata.truncated).toBe(true);
    expect(song.metadata.title).toBe('Name 0');
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

describe('summarizeInstruments', () => {
  it('lists used channels in ascending order, with the default program when none is sent', () => {
    const bytes = buildMidi(0, 60, [
      [
        { d: 0, noteOn: [2, 60, 100] },
        { d: 10, noteOff: [2, 60, 0] },
        { d: 0, noteOn: [0, 62, 100] },
        { d: 10, noteOff: [0, 62, 0] },
      ],
    ]);
    const song = parseMidiData(bytes);
    expect(summarizeInstruments(song)).toEqual([
      { channel: 0, programs: [{ program: 0, bankMsb: null, bankLsb: null, fromFile: false, time: 0 }] },
      { channel: 2, programs: [{ program: 0, bankMsb: null, bankLsb: null, fromFile: false, time: 0 }] },
    ]);
  });

  it('records bank select and program history, collapsing consecutive duplicates', () => {
    const bytes = buildMidi(0, 60, [
      [
        { d: 0, cc: [1, 0, 2] },
        { d: 0, cc: [1, 32, 1] },
        { d: 0, program: [1, 40] },
        { d: 0, program: [1, 40] },
        { d: 0, program: [1, 41] },
        { d: 0, program: [1, 40] },
        { d: 1, noteOn: [1, 60, 100] },
        { d: 1, noteOff: [1, 60, 0] },
      ],
    ]);
    const song = parseMidiData(bytes);
    expect(summarizeInstruments(song)).toEqual([
      {
        channel: 1,
        programs: [
          { program: 40, bankMsb: 2, bankLsb: 1, fromFile: true, time: 0 },
          { program: 41, bankMsb: 2, bankLsb: 1, fromFile: true, time: 0 },
          { program: 40, bankMsb: 2, bankLsb: 1, fromFile: true, time: 0 },
        ],
      },
    ]);
  });

  it('counts a channel that only carries a program change', () => {
    const bytes = buildMidi(0, 60, [[{ d: 0, program: [9, 0] }]]);
    expect(summarizeInstruments(parseMidiData(bytes))).toEqual([
      { channel: 9, programs: [{ program: 0, bankMsb: null, bankLsb: null, fromFile: true, time: 0 }] },
    ]);
  });

  it('reports the program in effect at a position', () => {
    // 60 PPQ at 120 BPM: 120 ticks = one second.
    const bytes = buildMidi(0, 60, [
      [
        { d: 0, program: [0, 40] },
        { d: 120, program: [0, 50] },
        { d: 120, program: [0, 60] },
        { d: 0, noteOn: [0, 60, 100] },
      ],
    ]);
    const [channel] = summarizeInstruments(parseMidiData(bytes));
    expect(channel.programs.map((p) => p.time)).toEqual([0, 1, 2]);
    expect(programAt(channel, 0).program).toBe(40);
    expect(programAt(channel, 0.9).program).toBe(40);
    expect(programAt(channel, 1).program).toBe(50);
    expect(programAt(channel, 1.9).program).toBe(50);
    expect(programAt(channel, 2).program).toBe(60);
    expect(programAt(channel, 99).program).toBe(60);
  });

  it('reports the MIDI default before a channel has selected a program', () => {
    const bytes = buildMidi(0, 60, [
      [
        { d: 0, noteOn: [2, 60, 100] },
        { d: 10, noteOff: [2, 60, 0] },
        { d: 110, program: [2, 42] },
      ],
    ]);
    const [channel] = summarizeInstruments(parseMidiData(bytes));
    expect(programAt(channel, 0)).toMatchObject({ program: 0, fromFile: false });
    expect(programAt(channel, 0.9)).toMatchObject({ program: 0, fromFile: false });
    expect(programAt(channel, 1)).toMatchObject({ program: 42, fromFile: true, time: 1 });
  });

  it('returns no channels for a file with only tempo events', () => {
    const bytes = buildMidi(0, 60, [[{ d: 0, tempo: 500_000 }]]);
    expect(summarizeInstruments(parseMidiData(bytes))).toEqual([]);
  });

  it('names GM programs, including both ends of the table', () => {
    expect(GM_INSTRUMENTS).toHaveLength(128);
    expect(gmInstrumentName(0)).toBe('Acoustic Grand Piano');
    expect(gmInstrumentName(40)).toBe('Violin');
    expect(gmInstrumentName(127)).toBe('Gunshot');
    expect(gmInstrumentName(-1)).toBe('Program 0');
  });
});
