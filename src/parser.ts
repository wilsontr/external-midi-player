/**
 * MIDI file parsing (ticket T2).
 *
 * Parses Standard MIDI Files (format 0 and 1) into a flat, time-sorted event
 * list with times in seconds, ready for the scheduler.
 *
 * Events come from `parseMidi` in `midi-file` — the same parser that
 * `@tonejs/midi` wraps — because the high-level `Track` API loses the
 * per-event channel (a track's channel is just its last note-on), discards
 * program-change history and channel pressure, and pairs notes (dropping
 * unpaired note-ons). The raw event stream keeps everything the ticket
 * requires: note-on, note-off, control change, program change, pitch bend and
 * channel pressure, each with its original channel, with running status
 * already resolved.
 *
 * `midi-file` is a declared runtime dependency (`^1.2.4`) alongside
 * `@tonejs/midi`, which pins the same parser version, so npm dedupes them to a
 * single copy. Depending on it directly keeps the parser version that this
 * module's event types are written against under this project's control rather
 * than at the mercy of `@tonejs/midi`'s dependency range.
 *
 * The tempo map (ticks → seconds) is built directly from the file's setTempo
 * events using the MIDI default of 500000 µs/beat (120 BPM) where the file
 * gives no tempo. This mirrors the semantics of @tonejs/midi's Header while
 * staying a single O(n) pass (the high-level `Midi` constructor pairs notes in
 * O(n²), which can stall the UI on large files).
 *
 * The three SMF text metas (Track Name, Text Event, Copyright Notice) are
 * decoded separately for the metadata viewer (T20), including Japanese
 * encodings, and never enter the playback event list.
 *
 * Files are validated on the way in: a missing "MThd" header, an unsupported
 * time division, or any parse failure surfaces as a `ParseError` — never an
 * uncaught throw from the underlying parser.
 */

import { parseMidi, type MidiData } from 'midi-file';

/** A single channel event with its time in seconds and original channel. */
export type ParsedMidiEvent =
  | { type: 'note-on'; time: number; channel: number; note: number; velocity: number }
  | { type: 'note-off'; time: number; channel: number; note: number; velocity: number }
  | { type: 'control-change'; time: number; channel: number; controller: number; value: number }
  | { type: 'program-change'; time: number; channel: number; program: number }
  | { type: 'pitch-bend'; time: number; channel: number; value: number }
  | { type: 'channel-pressure'; time: number; channel: number; value: number };

/** A parsed song: flat time-sorted events, duration, tempo map and metadata. */
export interface ParsedSong {
  /** Flat, time-sorted event list (file order is preserved for equal times). */
  events: ParsedMidiEvent[];
  /** Time of the last event in seconds (0 for a song with no events). */
  duration: number;
  /** Tempo changes in file order: time in seconds, bpm. */
  tempos: Array<{ time: number; bpm: number }>;
  /** The file's Track Name, Text Event and Copyright Notice values (T20). */
  metadata: SongMetadata;
}

/** Encodings SMF text can plausibly use, in the order the detector tries them. */
export type MidiTextEncoding =
  | 'ascii'
  | 'utf-8'
  | 'shift_jis'
  | 'euc-jp'
  | 'iso-2022-jp'
  | 'windows-1252';

/** One decoded text meta value and the 0-based MTrk chunk it came from. */
export interface MidiTextValue {
  /** 0-based MTrk index; the viewer shows it 1-based. */
  track: number;
  /** Decoded, NUL-stripped and NFC-normalised text. */
  text: string;
}

/** Text metadata retained from a song, plus the title resolved from it. */
export interface SongMetadata {
  /** Every non-empty Track Name value, in file order. */
  trackNames: MidiTextValue[];
  /** Every non-empty Text Event value, in file order. */
  textEvents: MidiTextValue[];
  /** Every non-empty Copyright Notice value, in file order. */
  copyrights: MidiTextValue[];
  /** A usable Track Name for the song, or null when the file has none. */
  title: string | null;
  /** True when the retention cap dropped values. */
  truncated: boolean;
}

/** Result of decoding one SMF text value. */
export interface DecodedMidiText {
  text: string;
  encoding: MidiTextEncoding;
}

/** Most values retained per metadata field (T20). */
export const METADATA_MAX_VALUES = 256;

/** Total characters of metadata text retained per song (T20). */
export const METADATA_MAX_CHARS = 16_000;

/** Thrown when a MIDI file cannot be parsed. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * Decoders are stateless and safe to reuse; keeping one per (label, fatal)
 * avoids rebuilding them for every text event in a long file.
 */
const textDecoders = new Map<string, TextDecoder>();

function getDecoder(label: string, fatal = false): TextDecoder {
  const key = `${label}\u0000${fatal ? 'fatal' : 'loose'}`;
  let decoder = textDecoders.get(key);
  if (decoder === undefined) {
    decoder = new TextDecoder(label, { fatal });
    textDecoders.set(key, decoder);
  }
  return decoder;
}

/** Decodes `bytes` with `label`, returning null instead of throwing. */
function tryDecode(bytes: Uint8Array, label: string): string | null {
  try {
    return getDecoder(label, true).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * True when the bytes look like ISO-2022-JP: an ESC followed by `$` or `(`.
 * ISO-2022-JP is 7-bit, so it would otherwise pass the UTF-8/ASCII checks.
 */
function hasIso2022JpEscape(bytes: Uint8Array): boolean {
  for (let i = 0; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0x1b && (bytes[i + 1] === 0x24 || bytes[i + 1] === 0x28)) {
      return true;
    }
  }
  return false;
}

/**
 * True for the Japanese characters this detector treats as evidence of a
 * Japanese encoding. Half-width katakana is deliberately excluded: a single
 * 0xA9 is also Windows-1252 `©`, and a lone Latin-1 byte must not tip a
 * Western copyright line into Shift_JIS.
 */
function isJapaneseCharacter(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) || // CJK punctuation (ideographic space, 〜)
    (cp >= 0x3040 && cp <= 0x309f) || // hiragana
    (cp >= 0x30a0 && cp <= 0x30ff) || // katakana
    (cp >= 0x31f0 && cp <= 0x31ff) || // katakana phonetic extensions
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xff00 && cp <= 0xff60) || // full-width forms (not half-width kana)
    (cp >= 0xffe0 && cp <= 0xffef)
  );
}

/** Scores a candidate by Japanese content, penalising control characters. */
function japaneseScore(text: string): number {
  let score = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (isJapaneseCharacter(cp)) score += 1;
    else if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a) || (cp >= 0x7f && cp <= 0x9f)) {
      score -= 2;
    }
  }
  return score;
}

/**
 * Cleans a decoded value for display: normalises line endings, strips NULs,
 * turns C0/C1 controls into spaces, normalises to NFC and trims. Tabs and
 * newlines survive because Stanford-style Text Events are tab-separated.
 */
function cleanMetadataText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .normalize('NFC')
    .trim();
}

/**
 * Decodes one SMF text value (T20).
 *
 * `midi-file` 1.2.4 reads meta text with `String.fromCharCode`, i.e. Latin-1,
 * so a string coming from that parser can be turned back into the exact
 * original bytes. This module also accepts raw bytes directly, which keeps the
 * detector testable without constructing a whole MIDI file.
 *
 * Detection order: UTF-8 BOM, ISO-2022-JP escapes, plain ASCII, valid UTF-8,
 * then Shift_JIS/EUC-JP scored by their Japanese content, and finally
 * Windows-1252. The Japanese candidates must contain at least one non-half-width
 * Japanese character to win; otherwise Western text such as `Copyright © 2004`
 * is kept as Windows-1252 rather than decoded as half-width katakana.
 */
export function decodeMidiText(raw: string | Uint8Array): DecodedMidiText {
  let bytes: Uint8Array;
  if (typeof raw === 'string') {
    bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0) & 0xff);
  } else {
    bytes = raw;
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return {
      text: cleanMetadataText(getDecoder('utf-8').decode(bytes.subarray(3))),
      encoding: 'utf-8',
    };
  }

  if (hasIso2022JpEscape(bytes)) {
    const text = tryDecode(bytes, 'iso-2022-jp');
    if (text !== null) {
      return { text: cleanMetadataText(text), encoding: 'iso-2022-jp' };
    }
  }

  if (bytes.every((byte) => byte < 0x80)) {
    return {
      text: cleanMetadataText(getDecoder('utf-8').decode(bytes)),
      encoding: 'ascii',
    };
  }

  const utf8 = tryDecode(bytes, 'utf-8');
  if (utf8 !== null) {
    return { text: cleanMetadataText(utf8), encoding: 'utf-8' };
  }

  const shiftJis = tryDecode(bytes, 'shift_jis');
  const eucJp = tryDecode(bytes, 'euc-jp');
  const shiftJisScore = shiftJis === null ? 0 : japaneseScore(shiftJis);
  const eucJpScore = eucJp === null ? 0 : japaneseScore(eucJp);

  if (eucJpScore > shiftJisScore && eucJpScore > 0 && eucJp !== null) {
    return { text: cleanMetadataText(eucJp), encoding: 'euc-jp' };
  }
  if (shiftJisScore > 0 && shiftJis !== null) {
    return { text: cleanMetadataText(shiftJis), encoding: 'shift_jis' };
  }

  return {
    text: cleanMetadataText(getDecoder('windows-1252').decode(bytes)),
    encoding: 'windows-1252',
  };
}

/** The title a Track Name list yields; see the track-0 rule in `collectEvents`. */
function resolveMetadataTitle(
  trackNames: MidiTextValue[],
  trackZeroNamed: boolean,
): string | null {
  // If track 0 carries a Track Name, that is the sequence name. An unusable
  // one (`untitled`) means "no title", never an instrument track's name.
  // If track 0 has none at all, use the first usable name in file order.
  const candidates = trackZeroNamed
    ? trackNames.filter((value) => value.track === 0)
    : trackNames;
  for (const value of candidates) {
    const title = value.text.replace(/\s+/g, ' ').trim();
    if (title !== '' && title.toLowerCase() !== 'untitled') return title;
  }
  return null;
}

/**
 * Applies the retention cap after the title has been resolved, so a dropped
 * list entry can never change the displayed title. The three lists share one
 * character budget; values are kept in file order until it runs out.
 */
function capMetadata(
  trackNames: MidiTextValue[],
  textEvents: MidiTextValue[],
  copyrights: MidiTextValue[],
  title: string | null,
): SongMetadata {
  let remaining = METADATA_MAX_CHARS;
  let truncated = false;
  const cap = (values: MidiTextValue[]): MidiTextValue[] => {
    const kept: MidiTextValue[] = [];
    for (const value of values) {
      if (kept.length >= METADATA_MAX_VALUES || value.text.length > remaining) {
        truncated = true;
        continue;
      }
      kept.push(value);
      remaining -= value.text.length;
    }
    return kept;
  };
  return {
    trackNames: cap(trackNames),
    textEvents: cap(textEvents),
    copyrights: cap(copyrights),
    title,
    truncated,
  };
}

/** One program selected on a channel, with the bank in effect at that moment. */
export interface ChannelProgram {
  /** MIDI program number, 0–127 (display 1-based). */
  program: number;
  /** Bank-select MSB (CC0), or null when the file never sent it. */
  bankMsb: number | null;
  /** Bank-select LSB (CC32), or null when the file never sent it. */
  bankLsb: number | null;
  /** False for the implicit default program 0 of a channel with no program change. */
  fromFile: boolean;
  /** Song time (seconds) of the program change; 0 for the implicit default. */
  time: number;
}

/** The instrument history of one channel in a song. */
export interface ChannelInstrument {
  /** MIDI channel, 0–15 (display 1-based). */
  channel: number;
  /** Programs in file order, consecutive duplicates collapsed. */
  programs: ChannelProgram[];
}

/** General MIDI Level 1 program names, indexed by program number (0–127). */
export const GM_INSTRUMENTS = [
  'Acoustic Grand Piano',
  'Bright Acoustic Piano',
  'Electric Grand Piano',
  'Honky-tonk Piano',
  'Electric Piano 1',
  'Electric Piano 2',
  'Harpsichord',
  'Clavinet',
  'Celesta',
  'Glockenspiel',
  'Music Box',
  'Vibraphone',
  'Marimba',
  'Xylophone',
  'Tubular Bells',
  'Dulcimer',
  'Drawbar Organ',
  'Percussive Organ',
  'Rock Organ',
  'Church Organ',
  'Reed Organ',
  'Accordion',
  'Harmonica',
  'Tango Accordion',
  'Acoustic Guitar (nylon)',
  'Acoustic Guitar (steel)',
  'Electric Guitar (jazz)',
  'Electric Guitar (clean)',
  'Electric Guitar (muted)',
  'Overdriven Guitar',
  'Distortion Guitar',
  'Guitar Harmonics',
  'Acoustic Bass',
  'Electric Bass (finger)',
  'Electric Bass (pick)',
  'Fretless Bass',
  'Slap Bass 1',
  'Slap Bass 2',
  'Synth Bass 1',
  'Synth Bass 2',
  'Violin',
  'Viola',
  'Cello',
  'Contrabass',
  'Tremolo Strings',
  'Pizzicato Strings',
  'Orchestral Harp',
  'Timpani',
  'String Ensemble 1',
  'String Ensemble 2',
  'Synth Strings 1',
  'Synth Strings 2',
  'Choir Aahs',
  'Voice Oohs',
  'Synth Voice',
  'Orchestra Hit',
  'Trumpet',
  'Trombone',
  'Tuba',
  'Muted Trumpet',
  'French Horn',
  'Brass Section',
  'Synth Brass 1',
  'Synth Brass 2',
  'Soprano Sax',
  'Alto Sax',
  'Tenor Sax',
  'Baritone Sax',
  'Oboe',
  'English Horn',
  'Bassoon',
  'Clarinet',
  'Piccolo',
  'Flute',
  'Recorder',
  'Pan Flute',
  'Blown Bottle',
  'Shakuhachi',
  'Whistle',
  'Ocarina',
  'Lead 1 (square)',
  'Lead 2 (sawtooth)',
  'Lead 3 (calliope)',
  'Lead 4 (chiff)',
  'Lead 5 (charang)',
  'Lead 6 (voice)',
  'Lead 7 (fifths)',
  'Lead 8 (bass + lead)',
  'Pad 1 (new age)',
  'Pad 2 (warm)',
  'Pad 3 (polysynth)',
  'Pad 4 (choir)',
  'Pad 5 (bowed)',
  'Pad 6 (metallic)',
  'Pad 7 (halo)',
  'Pad 8 (sweep)',
  'FX 1 (rain)',
  'FX 2 (soundtrack)',
  'FX 3 (crystal)',
  'FX 4 (atmosphere)',
  'FX 5 (brightness)',
  'FX 6 (goblins)',
  'FX 7 (echoes)',
  'FX 8 (sci-fi)',
  'Sitar',
  'Banjo',
  'Shamisen',
  'Koto',
  'Kalimba',
  'Bag pipe',
  'Fiddle',
  'Shanai',
  'Tinkle Bell',
  'Agogo',
  'Steel Drums',
  'Woodblock',
  'Taiko Drum',
  'Melodic Tom',
  'Synth Drum',
  'Reverse Cymbal',
  'Guitar Fret Noise',
  'Breath Noise',
  'Seashore',
  'Bird Tweet',
  'Telephone Ring',
  'Helicopter',
  'Applause',
  'Gunshot',
] as const;

/** The General MIDI name for a program number, with a numeric fallback. */
export function gmInstrumentName(program: number): string {
  return GM_INSTRUMENTS[program] ?? `Program ${program + 1}`;
}

/**
 * Lists the channels used by a song and the instruments (program changes) the
 * file selects on each, in ascending channel order.
 *
 * A channel counts as used when it carries any channel-voice event, so a
 * program change alone is enough. Consecutive repeats of the same program and
 * bank are collapsed; a return to an earlier program (A → B → A) is kept.
 * Channels with no program change report the MIDI default, program 0.
 *
 * This is a read-only summary over the parsed events: it does not change the
 * song and keeps no reference to the event list.
 */
export function summarizeInstruments(song: ParsedSong): ChannelInstrument[] {
  const used = new Set<number>();
  const banks = new Map<number, { msb: number | null; lsb: number | null }>();
  const programs = new Map<number, ChannelProgram[]>();

  for (const event of song.events) {
    const channel = event.channel;
    used.add(channel);

    if (event.type === 'control-change') {
      const bank = banks.get(channel) ?? { msb: null, lsb: null };
      if (event.controller === 0) bank.msb = event.value;
      else if (event.controller === 32) bank.lsb = event.value;
      banks.set(channel, bank);
      continue;
    }
    if (event.type !== 'program-change') continue;

    const bank = banks.get(channel) ?? { msb: null, lsb: null };
    const list = programs.get(channel) ?? [];
    const last = list[list.length - 1];
    if (
      last !== undefined &&
      last.program === event.program &&
      last.bankMsb === bank.msb &&
      last.bankLsb === bank.lsb
    ) {
      continue;
    }
    list.push({
      program: event.program,
      bankMsb: bank.msb,
      bankLsb: bank.lsb,
      fromFile: true,
      time: event.time,
    });
    programs.set(channel, list);
  }

  return [...used]
    .sort((a, b) => a - b)
    .map((channel) => ({
      channel,
      programs: programs.get(channel) ?? [
        { program: 0, bankMsb: null, bankLsb: null, fromFile: false, time: 0 },
      ],
    }));
}

/**
 * The program in effect on a channel at `positionSec` (the latest program
 * change at or before it), or the MIDI default before the channel's first
 * change. Program entries are in time order, so the scan stops as soon as it
 * passes the position.
 */
export function programAt(channel: ChannelInstrument, positionSec: number): ChannelProgram {
  let current: ChannelProgram | null = null;
  for (const program of channel.programs) {
    if (program.time > positionSec + 1e-9) break;
    current = program;
  }
  return (
    current ?? { program: 0, bankMsb: null, bankLsb: null, fromFile: false, time: 0 }
  );
}

/** MIDI default tempo when the file gives none: 120 BPM. */
const DEFAULT_US_PER_BEAT = 500_000;

type RawEvent =
  | { ticks: number; channel: number; kind: 'note-on'; note: number; velocity: number }
  | { ticks: number; channel: number; kind: 'note-off'; note: number; velocity: number }
  | { ticks: number; channel: number; kind: 'controller'; controller: number; value: number }
  | { ticks: number; channel: number; kind: 'program'; program: number }
  | { ticks: number; channel: number; kind: 'pitch'; value: number }
  | { ticks: number; channel: number; kind: 'pressure'; value: number };

interface TempoPoint {
  ticks: number;
  usPerBeat: number;
}

/** A tempo segment: `usPerBeat` applies from `startTicks` until the next segment. */
interface TempoSegment {
  startTicks: number;
  startSeconds: number;
  usPerBeat: number;
}

/**
 * Walks every track, collecting channel events (with absolute ticks),
 * setTempo points and the three text metas T20 displays. Tempo is global in
 * Standard MIDI Files, so points are taken from all tracks (format 1 files may
 * keep them on a dedicated track). Other meta events, polyphonic aftertouch,
 * SysEx and end-of-track are dropped for playback, as before.
 */
function collectEvents(raw: MidiData): {
  events: RawEvent[];
  tempos: TempoPoint[];
  metadata: SongMetadata;
} {
  const events: RawEvent[] = [];
  const tempos: TempoPoint[] = [];
  const trackNames: MidiTextValue[] = [];
  const textEvents: MidiTextValue[] = [];
  const copyrights: MidiTextValue[] = [];
  // Track 0's Track Name is the sequence name. A present-but-unusable one
  // must suppress the track-1 fallback, so remember the event itself rather
  // than only the non-empty values retained for display.
  let trackZeroNamed = false;

  const textValue = (track: number, rawText: string): MidiTextValue | null => {
    const decoded = decodeMidiText(rawText);
    return decoded.text === '' ? null : { track, text: decoded.text };
  };

  for (let trackIndex = 0; trackIndex < raw.tracks.length; trackIndex += 1) {
    const track = raw.tracks[trackIndex];
    let ticks = 0;
    for (const e of track) {
      ticks += e.deltaTime;
      switch (e.type) {
        case 'noteOn':
          events.push({ ticks, channel: e.channel, kind: 'note-on', note: e.noteNumber, velocity: e.velocity });
          break;
        case 'noteOff':
          events.push({ ticks, channel: e.channel, kind: 'note-off', note: e.noteNumber, velocity: e.velocity });
          break;
        case 'controller':
          events.push({ ticks, channel: e.channel, kind: 'controller', controller: e.controllerType, value: e.value });
          break;
        case 'programChange':
          events.push({ ticks, channel: e.channel, kind: 'program', program: e.programNumber });
          break;
        case 'pitchBend':
          // midi-file reports pitch bend signed (-8192..8191); store raw 0..16383.
          events.push({ ticks, channel: e.channel, kind: 'pitch', value: e.value + 8192 });
          break;
        case 'channelAftertouch':
          events.push({ ticks, channel: e.channel, kind: 'pressure', value: e.amount });
          break;
        case 'setTempo':
          tempos.push({ ticks, usPerBeat: e.microsecondsPerBeat });
          break;
        case 'trackName': {
          if (trackIndex === 0) trackZeroNamed = true;
          const value = textValue(trackIndex, e.text);
          if (value !== null) trackNames.push(value);
          break;
        }
        case 'text': {
          const value = textValue(trackIndex, e.text);
          if (value !== null) textEvents.push(value);
          break;
        }
        case 'copyrightNotice': {
          const value = textValue(trackIndex, e.text);
          if (value !== null) copyrights.push(value);
          break;
        }
        default:
          break;
      }
    }
  }

  const title = resolveMetadataTitle(trackNames, trackZeroNamed);
  return {
    events,
    tempos,
    metadata: capMetadata(trackNames, textEvents, copyrights, title),
  };
}

/**
 * Sorts tempo points by tick and keeps only the last point when several land
 * on the same tick (the later point wins, matching @tonejs/midi's binary-search
 * semantics, so a shadowed point never appears in the public tempo list).
 */
function normalizeTempoPoints(tempos: TempoPoint[]): TempoPoint[] {
  const points: TempoPoint[] = [];
  for (const p of [...tempos].sort((a, b) => a.ticks - b.ticks)) {
    const last = points[points.length - 1];
    if (last !== undefined && last.ticks === p.ticks) {
      points[points.length - 1] = p;
    } else {
      points.push(p);
    }
  }
  return points;
}

/**
 * Builds tempo segments from normalized points, with precomputed start times,
 * so ticks → seconds is an O(log n) lookup.
 */
function buildTempoSegments(points: TempoPoint[], ppq: number): TempoSegment[] {
  const segments: TempoSegment[] = [];
  let ticks = 0;
  let seconds = 0;
  let usPerBeat = DEFAULT_US_PER_BEAT;
  for (const p of points) {
    seconds += ((p.ticks - ticks) / ppq) * (usPerBeat / 1e6);
    ticks = p.ticks;
    usPerBeat = p.usPerBeat;
    segments.push({ startTicks: ticks, startSeconds: seconds, usPerBeat });
  }
  return segments;
}

/** Converts absolute ticks to seconds using the precomputed tempo segments. */
function ticksToSeconds(ticks: number, segments: TempoSegment[], ppq: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].startTicks <= ticks) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx === -1) {
    return (ticks / ppq) * (DEFAULT_US_PER_BEAT / 1e6);
  }
  const seg = segments[idx];
  return seg.startSeconds + ((ticks - seg.startTicks) / ppq) * (seg.usPerBeat / 1e6);
}

/**
 * Parses a Standard MIDI File (format 0 or 1) into a flat, time-sorted event
 * list with times in seconds.
 *
 * @throws {ParseError} if the file is not a readable MIDI file.
 */
export function parseMidiData(buffer: ArrayBuffer | Uint8Array): ParsedSong {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 14) {
    throw new ParseError('File too small to be a MIDI file');
  }
  if (bytes[0] !== 0x4d || bytes[1] !== 0x54 || bytes[2] !== 0x68 || bytes[3] !== 0x64) {
    throw new ParseError('Not a MIDI file: missing "MThd" header');
  }
  const headerLength = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
  // The spec fixes the header at 6 bytes; some writers append extra bytes and
  // the underlying parser skips them, so accept >= 6 and reject only a header
  // too short to be readable.
  if (headerLength < 6) {
    throw new ParseError('Invalid MIDI header length');
  }

  let raw: MidiData;
  try {
    raw = parseMidi(bytes);
  } catch (err) {
    throw new ParseError(`Cannot parse MIDI file: ${err instanceof Error ? err.message : String(err)}`);
  }

  const ppq = raw.header.ticksPerBeat;
  if (ppq === undefined || ppq <= 0) {
    throw new ParseError('Unsupported MIDI time division (SMPTE time is not supported)');
  }

  const { events, tempos, metadata } = collectEvents(raw);
  const points = normalizeTempoPoints(tempos);
  for (const p of points) {
    if (p.usPerBeat <= 0) {
      throw new ParseError('Invalid tempo: 0 microseconds per beat');
    }
  }

  // Stable sort: events at the same tick keep file order.
  events.sort((a, b) => a.ticks - b.ticks);
  const segments = buildTempoSegments(points, ppq);
  const songEvents: ParsedMidiEvent[] = events.map((e) => {
    const time = ticksToSeconds(e.ticks, segments, ppq);
    const channel = e.channel & 0x0f;
    switch (e.kind) {
      case 'note-on':
        return { type: 'note-on', time, channel, note: e.note, velocity: e.velocity };
      case 'note-off':
        return { type: 'note-off', time, channel, note: e.note, velocity: e.velocity };
      case 'controller':
        return { type: 'control-change', time, channel, controller: e.controller, value: e.value };
      case 'program':
        return { type: 'program-change', time, channel, program: e.program };
      case 'pitch':
        return { type: 'pitch-bend', time, channel, value: e.value };
      case 'pressure':
        return { type: 'channel-pressure', time, channel, value: e.value };
    }
  });

  // Duration is the time of the last event, so reuse the mapped time instead
  // of running the tempo lookup again.
  const duration = songEvents.length === 0 ? 0 : songEvents[songEvents.length - 1].time;
  const temposOut = points.map((p) => ({
    time: ticksToSeconds(p.ticks, segments, ppq),
    bpm: 60_000_000 / p.usPerBeat,
  }));

  return { events: songEvents, duration, tempos: temposOut, metadata };
}

/** True when the file name has a .mid or .midi extension (case-insensitive). */
export function isMidiFileName(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.mid') || n.endsWith('.midi');
}

/** A file as read from a file input: enough of `File` for the parser. */
export interface MidiFileLike {
  name: string;
  size?: number;
  lastModified?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Outcome of a parse-at-playback: a song, or a human-readable error. */
export type ParseResult = { status: 'ok'; song: ParsedSong } | { status: 'error'; message: string };

/** Last parsed song cache (keyed by name + size + lastModified). */
let lastParse: { key: string; result: ParseResult } | null = null;

/**
 * Parses a song right before playback (not when it is added) and caches the
 * last parsed result so replaying the same file skips the parse.
 *
 * Never throws: extension and parse failures come back as `{ status: 'error' }`
 * so the caller can mark the entry as an error instead of stalling the UI.
 * Read failures (e.g. a disconnected drive) are not cached, so a retry can
 * succeed.
 */
export async function parseSongForPlayback(file: MidiFileLike): Promise<ParseResult> {
  const key = `${file.name}\u0000${file.size ?? ''}\u0000${file.lastModified ?? ''}`;
  if (lastParse !== null && lastParse.key === key) {
    return lastParse.result;
  }
  if (!isMidiFileName(file.name)) {
    const result: ParseResult = {
      status: 'error',
      message: `Not a MIDI file: expected a .mid or .midi file`,
    };
    lastParse = { key, result };
    return result;
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return { status: 'error', message: 'Could not read file' };
  }

  try {
    const song = parseMidiData(buffer);
    const result: ParseResult = { status: 'ok', song };
    lastParse = { key, result };
    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const result: ParseResult = {
      status: 'error',
      message: err instanceof ParseError ? err.message : `Unknown parse error: ${detail}`,
    };
    lastParse = { key, result };
    return result;
  }
}

/** Clears the last-parsed-song cache (used by tests and when the playlist changes). */
export function clearSongCache(): void {
  lastParse = null;
}
