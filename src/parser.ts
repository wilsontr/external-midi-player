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
 * `midi-file` is not listed in package.json: it arrives transitively as
 * `@tonejs/midi`'s own parser dependency (`^1.2.2`, the version whose event
 * types this module consumes). Nothing here is added to the dependency list;
 * if `@tonejs/midi` ever drops or re-ranges that dependency, promote
 * `midi-file` to a direct dependency at the same minor.
 *
 * The tempo map (ticks → seconds) is built directly from the file's setTempo
 * events using the MIDI default of 500000 µs/beat (120 BPM) where the file
 * gives no tempo. This mirrors the semantics of @tonejs/midi's Header while
 * staying a single O(n) pass (the high-level `Midi` constructor pairs notes in
 * O(n²), which can stall the UI on large files).
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

/** A parsed song: flat time-sorted events, duration, and the tempo map. */
export interface ParsedSong {
  /** Flat, time-sorted event list (file order is preserved for equal times). */
  events: ParsedMidiEvent[];
  /** Time of the last event in seconds (0 for a song with no events). */
  duration: number;
  /** Tempo changes in file order: time in seconds, bpm. */
  tempos: Array<{ time: number; bpm: number }>;
}

/** Thrown when a MIDI file cannot be parsed. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
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
 * Walks every track, collecting channel events (with absolute ticks) and
 * setTempo points. Tempo is global in Standard MIDI Files, so points are
 * taken from all tracks (format 1 files may keep them on a dedicated track).
 * Meta events other than tempo, polyphonic aftertouch, SysEx and end-of-track
 * are dropped, per the ticket.
 */
function collectEvents(raw: MidiData): { events: RawEvent[]; tempos: TempoPoint[] } {
  const events: RawEvent[] = [];
  const tempos: TempoPoint[] = [];
  for (const track of raw.tracks) {
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
        default:
          break;
      }
    }
  }
  return { events, tempos };
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

  const { events, tempos } = collectEvents(raw);
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

  return { events: songEvents, duration, tempos: temposOut };
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
