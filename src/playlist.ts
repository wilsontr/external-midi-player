/**
 * Playlist and transport (ticket T3).
 *
 * Two parts, both DOM-independent:
 *
 * - A pure reducer over the in-memory entry list (add, remove, reorder,
 *   duration/error updates, current entry) plus helpers that pick the next or
 *   previous `ready` entry, skipping `error` entries.
 * - `PlaylistPlayer`, the transport state machine (`stopped` | `playing` |
 *   `paused`) that wraps the look-ahead scheduler: play/pause/resume/stop/
 *   next/previous, panic, auto-advance with a fixed gap, and the background
 *   duration parse. See the design doc, "Transport" and "Playlist".
 */

import {
  isMidiFileName,
  parseSongForPlayback,
  summarizeInstruments,
  type ChannelInstrument,
  type ParseResult,
} from './parser';
import { Scheduler, type SchedulerOptions } from './scheduler';

export interface PlaylistEntry {
  id: string;
  file: File;
  /** File name without its extension. */
  name: string;
  /** Filled in by the background parse. */
  durationSec?: number;
  status: 'ready' | 'error';
  error?: string;
}

/** The slice of `localStorage` the playlist needs (injectable for tests). */
export type PlaylistStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const PLAYLIST_STORAGE_KEY = 'external-midi-player.playlist';

interface StoredEntry {
  id: string;
  /** Original file name, extension included. */
  fileName: string;
  /** File bytes, base64-encoded. */
  data: string;
  durationSec?: number;
  status: 'ready' | 'error';
  error?: string;
}

interface StoredPlaylist {
  version: 1;
  currentId: string | null;
  entries: StoredEntry[];
}

export interface PlaylistState {
  entries: PlaylistEntry[];
  /** The highlighted entry: the one playing, or the one that plays next. */
  currentId: string | null;
}

export type PlaylistAction =
  | { type: 'add'; entries: PlaylistEntry[] }
  /** Replaces the whole list ("Load files"); an empty list clears it. */
  | { type: 'replace'; entries: PlaylistEntry[] }
  | { type: 'remove'; id: string }
  /** Moves the entry so it ends up at `toIndex` of the resulting list. */
  | { type: 'move'; id: string; toIndex: number }
  | { type: 'setCurrent'; id: string | null }
  | { type: 'parsed'; id: string; durationSec: number }
  | { type: 'failed'; id: string; error: string };

export const emptyPlaylist: PlaylistState = { entries: [], currentId: null };

function resolveStorage(): PlaylistStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Sandboxed iframe / storage disabled: persistence is best-effort.
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function entryName(fileName: string): string {
  return fileName.replace(/\.[^./\\]*$/, '');
}

/** Rebuilds a playlist entry from its stored form; null when it is malformed. */
function storedToEntry(value: unknown): PlaylistEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const stored = value as Partial<StoredEntry>;
  if (
    typeof stored.id !== 'string' ||
    typeof stored.fileName !== 'string' ||
    typeof stored.data !== 'string' ||
    (stored.status !== 'ready' && stored.status !== 'error')
  ) {
    return null;
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToBytes(stored.data);
  } catch {
    return null;
  }
  const file = new File([bytes], stored.fileName, { type: 'audio/midi' });
  return {
    id: stored.id,
    file,
    name: entryName(stored.fileName),
    durationSec: typeof stored.durationSec === 'number' ? stored.durationSec : undefined,
    status: stored.status,
    error: typeof stored.error === 'string' ? stored.error : undefined,
  };
}

function isStoredPlaylist(value: unknown): value is StoredPlaylist {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && Array.isArray(candidate.entries);
}

/** Creates an entry for a file; the status is `ready` until a parse fails. */
export function createEntry(file: File): PlaylistEntry {
  return {
    id: crypto.randomUUID(),
    file,
    name: entryName(file.name),
    status: 'ready',
  };
}

// ---------------------------------------------------------------------------
// M3U save / load (T10)
// ---------------------------------------------------------------------------

/**
 * Limits for an imported playlist. M3U is untrusted text from disk, so the
 * parser refuses anything pathological instead of building thousands of rows.
 */
export const M3U_MAX_BYTES = 1_000_000;
export const M3U_MAX_LINES = 10_000;

/** One file reference read from an M3U, with its optional EXTINF metadata. */
export interface M3uTrack {
  /** The path exactly as written in the file (after quote/scheme cleanup). */
  reference: string;
  title?: string;
  durationSec?: number;
}

export interface M3uParseResult {
  tracks: M3uTrack[];
  /** URL and non-MIDI references, reported rather than fetched or loaded. */
  unsupported: string[];
  /** Set when the file is over the size or line cap; `tracks` is then empty. */
  error?: string;
}

export interface M3uMatch {
  /** Files in M3U order; repeated references reuse the same File. */
  files: File[];
  /** References with no selected file, in M3U order, de-duplicated. */
  missing: string[];
  /** Selected files the playlist never referenced. */
  extra: File[];
  /** Base names that resolved between several selected files. */
  ambiguous: string[];
  /** How many references were satisfied by `fallbackFiles` (the current playlist). */
  fromPlaylist: number;
}

/** True for the two playlist extensions accepted by Load playlist. */
export function isPlaylistFileName(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.m3u') || n.endsWith('.m3u8');
}

/** Removes line breaks from a value that is written onto one M3U line. */
function m3uLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Serializes the playlist as M3U8 text: `#EXTM3U`, then an `#EXTINF` and the
 * file name for each entry, in order. A browser keeps no path for a `File`,
 * so the reference is the base file name — loading therefore needs the files
 * themselves as well.
 */
export function buildM3u(entries: PlaylistEntry[]): string {
  const lines = ['#EXTM3U'];
  for (const entry of entries) {
    const seconds =
      entry.durationSec !== undefined && Number.isFinite(entry.durationSec)
        ? Math.round(entry.durationSec)
        : -1;
    lines.push(`#EXTINF:${seconds},${m3uLine(entry.name || entry.file.name)}`);
    lines.push(m3uLine(entry.file.name));
  }
  return `${lines.join('\n')}\n`;
}

/** Scheme prefixes that mean "a remote resource", which this app never fetches. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** `C:` / `c:/` is a Windows path, not a scheme. */
const WINDOWS_DRIVE = /^[a-z]:/i;

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Parses M3U/M3U8 text. Tolerates a BOM, CRLF/LF, blank lines, comments, an
 * optional `#EXTM3U`, EXTINF with or without a title, and quoted or Windows
 * paths. URL and non-MIDI references are collected in `unsupported`; the app
 * never fetches a reference.
 */
export function parseM3u(text: string): M3uParseResult {
  if (text.length > M3U_MAX_BYTES) {
    return {
      tracks: [],
      unsupported: [],
      error: 'playlist file is too large (over 1 MB)',
    };
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  if (lines.length > M3U_MAX_LINES) {
    return {
      tracks: [],
      unsupported: [],
      error: `playlist file has too many lines (over ${M3U_MAX_LINES})`,
    };
  }

  const tracks: M3uTrack[] = [];
  const unsupported: string[] = [];
  let pending: Pick<M3uTrack, 'title' | 'durationSec'> = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      if (/^#EXTINF:/i.test(line)) {
        const info = line.slice(line.indexOf(':') + 1);
        const comma = info.indexOf(',');
        const lengthText = (comma >= 0 ? info.slice(0, comma) : info).trim();
        const title = comma >= 0 ? info.slice(comma + 1).trim() : '';
        const seconds = Number.parseFloat(lengthText);
        pending = {
          durationSec: Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined,
          title: title === '' ? undefined : title,
        };
      }
      // #EXTM3U, #EXT-X-* and every other comment carry no local file.
      continue;
    }

    let reference = stripQuotes(line);
    if (reference === '') continue;
    if (/^file:\/{2,}/i.test(reference)) {
      reference = reference.replace(/^file:\/{2,}/i, '');
      // file:///C:/Music/a.mid → C:/Music/a.mid
      if (/^\/[a-z]:/i.test(reference)) reference = reference.slice(1);
      try {
        reference = decodeURIComponent(reference);
      } catch {
        // A malformed escape is left as written; matching still uses the file name.
      }
    } else if (URL_SCHEME.test(reference) && !WINDOWS_DRIVE.test(reference)) {
      unsupported.push(line);
      pending = {};
      continue;
    }

    const base = reference.replace(/\\/g, '/').split('/').pop() ?? '';
    if (!isMidiFileName(base)) {
      unsupported.push(line);
      pending = {};
      continue;
    }
    tracks.push({ reference, ...pending });
    pending = {};
  }

  return { tracks, unsupported };
}

function normalizedPath(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
}

function fileNameOf(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * Resolves parsed references to selected files. An exact `webkitRelativePath`
 * match wins; otherwise the base name is compared case-insensitively (NFC),
 * so a playlist exported on one machine loads from a plain file picker on the
 * next. Duplicate base names are assigned in selection order and reported.
 *
 * `fallbackFiles` are the files already in the playlist. They are tried only
 * when the selection has no match, so re-loading a playlist saved in this
 * session works without picking the MIDI files again; they are never reported
 * as `extra` (the playlist is replaced, not merged).
 */
export function matchM3u(
  tracks: M3uTrack[],
  files: File[],
  fallbackFiles: File[] = [],
): M3uMatch {
  const used = new Set<number>();
  const fallbackUsed = new Set<number>();
  const matched: File[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  let fromPlaylist = 0;
  const paths = files.map((f) => normalizedPath(f.webkitRelativePath || f.name));
  const bases = files.map((f) => f.name.normalize('NFC').toLowerCase());
  const fallbackPaths = fallbackFiles.map((f) =>
    normalizedPath(f.webkitRelativePath || f.name),
  );
  const fallbackBases = fallbackFiles.map((f) => f.name.normalize('NFC').toLowerCase());

  const candidatesIn = (
    reference: string,
    base: string,
    group: File[],
    groupPaths: string[],
    groupBases: string[],
  ): number[] => {
    const byPath: number[] = [];
    group.forEach((_, index) => {
      if (groupPaths[index] === reference) byPath.push(index);
    });
    if (byPath.length > 0) return byPath;
    const byBase: number[] = [];
    group.forEach((_, index) => {
      if (groupBases[index] === base) byBase.push(index);
    });
    return byBase;
  };

  for (const track of tracks) {
    const reference = normalizedPath(track.reference);
    const base = fileNameOf(track.reference).normalize('NFC').toLowerCase();

    let candidates = candidatesIn(reference, base, files, paths, bases);
    let group = files;
    let groupUsed = used;
    let usingFallback = false;
    if (candidates.length === 0 && fallbackFiles.length > 0) {
      candidates = candidatesIn(reference, base, fallbackFiles, fallbackPaths, fallbackBases);
      group = fallbackFiles;
      groupUsed = fallbackUsed;
      usingFallback = true;
    }
    if (candidates.length === 0) {
      if (!missing.includes(track.reference)) missing.push(track.reference);
      continue;
    }
    if (candidates.length > 1) {
      const name = fileNameOf(track.reference);
      if (!ambiguous.includes(name)) ambiguous.push(name);
    }
    // Spread duplicate references over duplicate files; a single file is
    // reused when the playlist lists it more than once.
    const pick = candidates.find((index) => !groupUsed.has(index)) ?? candidates[0];
    groupUsed.add(pick);
    matched.push(group[pick]);
    if (usingFallback) fromPlaylist += 1;
  }

  return {
    files: matched,
    missing,
    extra: files.filter((_, index) => !used.has(index)),
    ambiguous,
    fromPlaylist,
  };
}

export function playlistReducer(state: PlaylistState, action: PlaylistAction): PlaylistState {
  switch (action.type) {
    case 'add': {
      if (action.entries.length === 0) return state;
      const entries = [...state.entries, ...action.entries];
      // `currentId` is "the one playing, or the one that plays next", so a list
      // that had nothing current gets its first playable entry highlighted.
      const currentId =
        state.currentId !== null && entries.some((e) => e.id === state.currentId)
          ? state.currentId
          : (entries.find((e) => e.status === 'ready')?.id ?? null);
      return { entries, currentId };
    }
    case 'replace': {
      const entries = action.entries;
      if (entries.length === 0) {
        return state.entries.length === 0 ? state : emptyPlaylist;
      }
      return { entries, currentId: entries.find((e) => e.status === 'ready')?.id ?? null };
    }
    case 'remove': {
      const index = state.entries.findIndex((e) => e.id === action.id);
      if (index < 0) return state;
      const entries = state.entries.filter((e) => e.id !== action.id);
      return {
        entries,
        // Removing the current entry moves the highlight to whatever plays next.
        currentId:
          state.currentId === action.id ? neighborReadyId(entries, index) : state.currentId,
      };
    }
    case 'move': {
      const from = state.entries.findIndex((e) => e.id === action.id);
      if (from < 0) return state;
      const entries = state.entries.slice();
      const [entry] = entries.splice(from, 1);
      const to = Math.max(0, Math.min(action.toIndex, entries.length));
      if (to === from) return state;
      entries.splice(to, 0, entry);
      return { ...state, entries };
    }
    case 'setCurrent':
      return state.currentId === action.id ? state : { ...state, currentId: action.id };
    case 'parsed':
      return updateEntry(state, action.id, { durationSec: action.durationSec });
    case 'failed': {
      const updated = updateEntry(state, action.id, { status: 'error', error: action.error });
      if (updated === state || state.currentId !== action.id) return updated;
      // The highlighted entry just turned out to be unplayable: move the
      // highlight to the next ready entry so "plays next" stays truthful.
      const index = updated.entries.findIndex((e) => e.id === action.id);
      if (index < 0) return updated;
      return { ...updated, currentId: neighborReadyId(updated.entries, index) };
    }
  }
}

/**
 * The nearest `ready` entry at or after `index` (the position the removed entry
 * used to hold), falling back to the nearest one before it.
 */
function neighborReadyId(entries: PlaylistEntry[], index: number): string | null {
  for (let i = index; i < entries.length; i++) {
    if (entries[i].status === 'ready') return entries[i].id;
  }
  for (let i = index - 1; i >= 0; i--) {
    if (entries[i].status === 'ready') return entries[i].id;
  }
  return null;
}

/** Turns an unexpected parse rejection into a user-visible failure. */
function parseFailure(err: unknown): ParseResult {
  return { status: 'error', message: err instanceof Error ? err.message : String(err) };
}

function updateEntry(
  state: PlaylistState,
  id: string,
  patch: Partial<PlaylistEntry>,
): PlaylistState {
  if (!state.entries.some((e) => e.id === id)) return state;
  return { ...state, entries: state.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
}

/** First `ready` entry in the list, or null. */
export function firstReadyId(state: PlaylistState): string | null {
  return state.entries.find((e) => e.status === 'ready')?.id ?? null;
}

/**
 * The next `ready` entry after `afterId` (error entries are skipped). With
 * no `afterId` (or one no longer in the list) it is the first `ready` entry.
 */
export function nextReadyId(state: PlaylistState, afterId: string | null): string | null {
  const from = afterId === null ? -1 : state.entries.findIndex((e) => e.id === afterId);
  for (let i = from + 1; i < state.entries.length; i++) {
    if (state.entries[i].status === 'ready') return state.entries[i].id;
  }
  return null;
}

/** The nearest `ready` entry before `beforeId`, or null when there is none. */
export function previousReadyId(state: PlaylistState, beforeId: string | null): string | null {
  const from = beforeId === null ? -1 : state.entries.findIndex((e) => e.id === beforeId);
  for (let i = from - 1; i >= 0; i--) {
    if (state.entries[i].status === 'ready') return state.entries[i].id;
  }
  return null;
}

export type PlayerState = 'stopped' | 'playing' | 'paused';

/**
 * The instrument summary of the song currently playing. Deliberately not tied
 * to the highlighted playlist entry: the card follows playback only.
 */
export type InstrumentsState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; channels: ChannelInstrument[] };

/** The slice of `Scheduler` the transport uses (injectable for tests). */
export type TransportScheduler = Pick<
  Scheduler,
  'play' | 'pause' | 'stop' | 'panic' | 'dispose' | 'position' | 'seek'
>;

export interface PlaylistPlayerOptions {
  /** The currently selected MIDI output, if any. */
  getOutput: () => MIDIOutput | null;
  /** Fired after any change to the playlist, current entry or player state. */
  onChange: () => void;
  /** User-visible status (funnels into the single aria-live region). */
  onStatus: (message: string) => void;
  /** Injectable for tests. Defaults to `parseSongForPlayback`. */
  parse?: (file: File) => Promise<ParseResult>;
  /** Injectable for tests. Defaults to `new Scheduler(options)`. */
  createScheduler?: (options: SchedulerOptions) => TransportScheduler;
  /** Gap between songs so external synths finish their release tails. Default 1000 ms. */
  gapMs?: number;
  /** Gap after a track-switch Panic before the new song starts. Default 50 ms. */
  switchGapMs?: number;
  /** Storage for the playlist + current entry. Defaults to `localStorage`. */
  storage?: PlaylistStorage;
}

/** Transport state machine over the playlist; see the file header. */
export class PlaylistPlayer {
  private list: PlaylistState = emptyPlaylist;
  private playerState: PlayerState = 'stopped';
  private instruments: InstrumentsState = { status: 'none' };
  private scheduler: TransportScheduler | null = null;
  /** Bumped by every transition that must abort an in-flight song load. */
  private loadToken = 0;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly parseQueue: string[] = [];
  private parsing = false;
  private readonly storage: PlaylistStorage | null;
  /** Base64 of each entry's bytes, so repeated saves do not re-read the files. */
  private readonly fileData = new Map<string, string>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistRevision = 0;
  private persistPromise: Promise<void> = Promise.resolve();
  private persistFailed = false;
  /** True while the store held no usable playlist when the player was built. */
  private storeWasFresh = false;
  /** Set by any user action on the list, so seeding never overrides one. */
  private touched = false;
  /** Set by the first `seed()`, so a second call is a no-op. */
  private seedAttempted = false;

  private readonly options: PlaylistPlayerOptions;
  private readonly parse: (file: File) => Promise<ParseResult>;
  private readonly createScheduler: (options: SchedulerOptions) => TransportScheduler;
  private readonly gapMs: number;
  private readonly switchGapMs: number;

  constructor(options: PlaylistPlayerOptions) {
    this.options = options;
    this.parse = options.parse ?? parseSongForPlayback;
    this.createScheduler = options.createScheduler ?? ((o) => new Scheduler(o));
    this.gapMs = options.gapMs ?? 1000;
    this.switchGapMs = options.switchGapMs ?? 50;
    this.storage = options.storage ?? resolveStorage();
    this.restore();
  }

  get state(): PlayerState {
    return this.playerState;
  }

  get playlist(): PlaylistState {
    return this.list;
  }

  currentEntry(): PlaylistEntry | null {
    return this.list.entries.find((e) => e.id === this.list.currentId) ?? null;
  }

  /** Song position in seconds (0 while loading or in the gap between songs). */
  position(): number {
    return this.scheduler?.position() ?? 0;
  }

  /** The channels and instruments of the song currently playing. */
  instrumentsState(): InstrumentsState {
    return this.instruments;
  }

  /** Waits for any pending playlist write (tests, and a best-effort pagehide flush). */
  async flushPersistence(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persistPromise = this.persistNow();
    }
    await this.persistPromise;
  }

  /**
   * True while the bundled sample song (T12) may still fill the playlist: the
   * store held nothing when the player was built, the user has not touched the
   * list, nothing has been seeded yet, and the list is still empty.
   *
   * Emptiness alone is not enough — Clear playlist leaves `entries: []` — which
   * is why the store key, not the list, decides.
   */
  needsSeed(): boolean {
    return (
      this.storeWasFresh &&
      !this.touched &&
      !this.seedAttempted &&
      this.list.entries.length === 0
    );
  }

  /**
   * Seeds the bundled sample through the same path as `add()`, so it gets a
   * normal id, name and background duration parse, becomes current (the first
   * ready entry) and is persisted like any other row. Returns false, with no
   * side effects, when the store is not fresh, the user got there first, or
   * the file does not look like a MIDI file.
   */
  seed(file: File): boolean {
    if (!this.needsSeed() || !isMidiFileName(file.name)) return false;
    this.seedAttempted = true;
    this.touched = true;
    const entry = createEntry(file);
    this.dispatch({ type: 'add', entries: [entry] });
    this.parseQueue.push(entry.id);
    void this.pumpParseQueue();
    return true;
  }

  /**
   * Adds files in the order given. Files without a .mid/.midi extension are
   * rejected; their names are returned. Durations are parsed in the
   * background, one file at a time.
   */
  add(files: File[]): { added: number; rejected: string[] } {
    this.touched = true;
    const accepted = files.filter((f) => isMidiFileName(f.name));
    const rejected = files.filter((f) => !isMidiFileName(f.name)).map((f) => f.name);
    if (accepted.length > 0) {
      const entries = accepted.map(createEntry);
      this.dispatch({ type: 'add', entries });
      this.parseQueue.push(...entries.map((e) => e.id));
      void this.pumpParseQueue();
    }
    return { added: accepted.length, rejected };
  }

  /**
   * Replaces the playlist with the selected files (the "Load files" action).
   * Playback stops first. Non-MIDI files are rejected; if no valid file is
   * selected the existing playlist is kept unchanged. The first ready entry
   * (the first new entry) becomes the current one.
   */
  load(files: File[]): { added: number; rejected: string[] } {
    this.touched = true;
    const accepted = files.filter((f) => isMidiFileName(f.name));
    const rejected = files.filter((f) => !isMidiFileName(f.name)).map((f) => f.name);
    if (accepted.length === 0) return { added: 0, rejected };
    this.stop();
    this.parseQueue.length = 0;
    this.fileData.clear();
    const entries = accepted.map(createEntry);
    this.dispatch({ type: 'replace', entries });
    this.parseQueue.push(...entries.map((e) => e.id));
    void this.pumpParseQueue();
    return { added: accepted.length, rejected };
  }

  /** Stops playback and empties the playlist, persisting the empty list. */
  clear(): void {
    this.touched = true;
    this.stop();
    this.parseQueue.length = 0;
    this.fileData.clear();
    this.dispatch({ type: 'replace', entries: [] });
  }

  /**
   * Seeks within the current song. Ignored while stopped: the timeline is
   * live only while playing or paused, and a stopped song always restarts
   * from 0 (documented in T8 and the design doc).
   */
  seek(positionSec: number): void {
    if (this.playerState === 'stopped' || this.scheduler === null) return;
    try {
      this.scheduler.seek(positionSec);
    } catch (err) {
      this.outputLost();
      this.options.onStatus(
        `MIDI output failed — playback stopped (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }

  remove(id: string): void {
    this.touched = true;
    if (this.playerState !== 'stopped' && this.list.currentId === id) {
      this.stop();
    }
    this.dispatch({ type: 'remove', id });
  }

  move(id: string, toIndex: number): void {
    this.touched = true;
    this.dispatch({ type: 'move', id, toIndex });
  }

  /** Play from stopped (current or first entry), or resume from paused. */
  play(): void {
    if (this.playerState === 'playing') return;
    if (this.playerState === 'paused' && this.scheduler !== null) {
      this.scheduler.play();
      this.setState('playing');
      return;
    }
    const current = this.currentEntry();
    const target =
      current?.status === 'ready'
        ? current.id
        : (nextReadyId(this.list, this.list.currentId) ?? firstReadyId(this.list));
    if (target === null) {
      this.options.onStatus(
        this.list.entries.length === 0
          ? 'Add a MIDI file to the playlist to play.'
          : 'No playable songs: every entry in the playlist failed to load.',
      );
      return;
    }
    void this.start(target);
  }

  togglePlay(): void {
    if (this.playerState === 'playing') this.pause();
    else this.play();
  }

  /** Pauses; held notes are released and not re-struck on resume. */
  pause(): void {
    if (this.playerState !== 'playing') return;
    this.cancelPending();
    this.scheduler?.pause();
    // Pausing while the song is still loading aborts that load, so there is
    // no current song to describe.
    if (this.scheduler === null) this.setInstruments({ status: 'none' });
    this.setState('paused');
  }

  /** Stops, releases every sounding note and resets the position to 0. */
  stop(): void {
    this.cancelPending();
    this.releaseScheduler();
    this.setInstruments({ status: 'none' });
    this.setState('stopped');
  }

  /** Plays the next `ready` entry; stops at the end of the list. */
  next(): void {
    this.jumpTo(nextReadyId(this.list, this.list.currentId), false);
  }

  /** Plays the previous `ready` entry, or restarts the current one at the top. */
  previous(): void {
    this.jumpTo(previousReadyId(this.list, this.list.currentId), true);
  }

  /**
   * Makes an entry the one Play will start, without starting it (the
   * single-click path while stopped).
   *
   * While playing or paused `currentId` names the song on the wire, so moving
   * it would make the highlight (and the LCD title, part map and auto-advance)
   * disagree with what is sounding; the UI keeps a separate, view-only
   * selection outline in those states instead. Error rows are not selectable.
   * Returns true when the next-to-play entry moved.
   */
  selectEntry(id: string): boolean {
    if (this.playerState !== 'stopped') return false;
    const entry = this.list.entries.find((e) => e.id === id);
    if (!entry || entry.status !== 'ready' || this.list.currentId === id) return false;
    this.dispatch({ type: 'setCurrent', id });
    return true;
  }

  /** Plays an entry from the start (double-click, or its Play key). */
  playEntry(id: string): void {
    const entry = this.list.entries.find((e) => e.id === id);
    if (!entry) return;
    if (entry.status === 'error') {
      this.options.onStatus(`${entry.name}: ${entry.error ?? 'cannot be played'}`);
      return;
    }
    void this.start(id);
  }

  /**
   * Stops playback and sends all-notes-off / all-sound-off / reset-controllers
   * / sustain-off on every channel. The panic goes out before the stop so it
   * is timestamped after the last queued event.
   */
  panic(): void {
    try {
      if (this.scheduler !== null) {
        this.scheduler.panic();
      } else {
        const output = this.options.getOutput();
        if (output !== null) {
          this.createScheduler({ output, events: [], duration: 0 }).panic();
        }
      }
    } catch {
      // The output is gone; nothing left to silence.
    }
    this.stop();
  }

  /**
   * The selected output disconnected: stop without sending (the device is
   * gone, so a release would throw).
   */
  outputLost(): void {
    this.cancelPending();
    this.scheduler?.dispose();
    this.scheduler = null;
    this.setInstruments({ status: 'none' });
    this.setState('stopped');
  }

  private jumpTo(target: string | null, restartWhenNone: boolean): void {
    const id = target ?? (restartWhenNone ? this.list.currentId : null);
    if (this.playerState === 'playing') {
      if (id === null) this.stop();
      else void this.start(id);
      return;
    }
    if (this.playerState === 'paused' && id !== null && id !== this.list.currentId) {
      // A paused track switch gets the same full Panic (R8) as a playing one;
      // the new entry is then selected and stays paused/stopped.
      this.panic();
    } else {
      this.stop();
    }
    if (id !== null) this.dispatch({ type: 'setCurrent', id });
  }

  /** Loads and starts one song from the top. */
  private async start(id: string): Promise<void> {
    const entry = this.list.entries.find((e) => e.id === id);
    if (!entry) return;
    const output = this.options.getOutput();
    if (output === null) {
      this.options.onStatus('Select a MIDI output first.');
      return;
    }
    this.cancelPending();
    // Switching from a playing or paused track: Panic (CC123/120/121 and
    // CC64 = 0 on all 16 channels) goes out after the old queue's tail, and
    // the new song is anchored after the panic so none of its notes are cut
    // off. Restarting the same entry only releases (no Panic), also after the
    // old tail. From stopped there is nothing to release.
    let startAt: number | undefined;
    const previous = this.scheduler;
    if (previous !== null) {
      const switching = this.playerState !== 'stopped' && this.list.currentId !== id;
      try {
        if (switching) {
          startAt = previous.panic() + this.switchGapMs;
        } else if (this.playerState !== 'stopped') {
          const tail = previous.stop();
          if (tail !== null) startAt = tail + this.switchGapMs;
        }
      } catch {
        // The output vanished; the new song's own send/parse will surface it.
      } finally {
        previous.dispose();
        this.scheduler = null;
      }
    }
    const token = ++this.loadToken;
    this.dispatch({ type: 'setCurrent', id });
    this.setState('playing');
    this.setInstruments({ status: 'loading' });

    let result: ParseResult;
    try {
      result = await this.parse(entry.file);
    } catch (err) {
      // A throwing parse must not leave the transport stuck in `playing`.
      result = parseFailure(err);
    }
    if (token !== this.loadToken) return;
    if (result.status === 'error') {
      this.setInstruments({ status: 'none' });
      this.dispatch({ type: 'failed', id, error: result.message });
      this.options.onStatus(`${entry.name}: ${result.message}`);
      const following = nextReadyId(this.list, id);
      if (following === null) this.stop();
      else void this.start(following);
      return;
    }
    this.dispatch({ type: 'parsed', id, durationSec: result.song.duration });
    this.setInstruments({ status: 'ready', channels: summarizeInstruments(result.song) });
    const scheduler = this.createScheduler({
      output,
      events: result.song.events,
      duration: result.song.duration,
      onEnded: () => this.handleEnded(scheduler),
      // A send can throw if the device disappears mid-song; stop cleanly and
      // report through the single aria-live region.
      onError: (message) => {
        this.outputLost();
        this.options.onStatus(`MIDI output failed — playback stopped (${message}).`);
      },
    });
    this.scheduler = scheduler;
    scheduler.play(startAt);
  }

  private handleEnded(ended: TransportScheduler): void {
    if (this.scheduler !== ended) return;
    this.scheduler = null;
    const following = nextReadyId(this.list, this.list.currentId);
    if (following === null) {
      this.setInstruments({ status: 'none' });
      this.setState('stopped');
      return;
    }
    // Stays `playing` through the gap; the next entry is highlighted already.
    this.dispatch({ type: 'setCurrent', id: following });
    this.setInstruments({ status: 'loading' });
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      void this.start(following);
    }, this.gapMs);
  }

  /** Aborts an in-flight load and any pending auto-advance. */
  private cancelPending(): void {
    this.loadToken += 1;
    if (this.gapTimer !== null) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  private releaseScheduler(): void {
    const scheduler = this.scheduler;
    this.scheduler = null;
    if (scheduler === null) return;
    try {
      scheduler.stop();
    } catch {
      scheduler.dispose();
    }
  }

  private async pumpParseQueue(): Promise<void> {
    if (this.parsing) return;
    this.parsing = true;
    try {
      while (this.parseQueue.length > 0) {
        const id = this.parseQueue.shift()!;
        const entry = this.list.entries.find((e) => e.id === id);
        if (!entry || entry.status === 'error' || entry.durationSec !== undefined) continue;
        let result: ParseResult;
        try {
          result = await this.parse(entry.file);
        } catch (err) {
          // One unreadable file must not wedge the queue for the rest.
          result = parseFailure(err);
        }
        if (!this.list.entries.some((e) => e.id === id)) continue;
        if (result.status === 'ok') {
          this.dispatch({ type: 'parsed', id, durationSec: result.song.duration });
        } else {
          this.dispatch({ type: 'failed', id, error: result.message });
          this.options.onStatus(`${entry.name}: ${result.message}`);
        }
      }
    } finally {
      this.parsing = false;
    }
  }

  private dispatch(action: PlaylistAction): void {
    const next = playlistReducer(this.list, action);
    if (next !== this.list) {
      this.list = next;
      this.schedulePersist();
      this.options.onChange();
    }
  }

  /** Reads the stored playlist into `this.list`; never fires `onChange`. */
  private restore(): void {
    // "Fresh" means "never written", not "empty": every way of failing to read
    // a usable playlist counts, so a corrupt payload is replaced like absent
    // data already is (see the first-run sample, T12).
    this.storeWasFresh = true;
    if (this.storage === null) return;
    let raw: string | null;
    try {
      raw = this.storage.getItem(PLAYLIST_STORAGE_KEY);
    } catch {
      return;
    }
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isStoredPlaylist(parsed)) return;
    // A readable payload — even `entries: []`, which is what Clear playlist
    // leaves — means the store has been initialised. Never seed over it.
    this.storeWasFresh = false;

    const entries: PlaylistEntry[] = [];
    for (const stored of parsed.entries) {
      const entry = storedToEntry(stored);
      if (entry === null) continue;
      entries.push(entry);
      this.fileData.set(entry.id, stored.data);
    }
    if (entries.length === 0) return;

    const savedCurrent = typeof parsed.currentId === 'string' ? parsed.currentId : null;
    const current = entries.find((e) => e.id === savedCurrent && e.status === 'ready');
    this.list = {
      entries,
      currentId: current?.id ?? firstReadyId({ entries, currentId: null }),
    };
    for (const entry of entries) {
      if (entry.status === 'ready' && entry.durationSec === undefined) this.parseQueue.push(entry.id);
    }
    void this.pumpParseQueue();
  }

  private schedulePersist(): void {
    if (this.storage === null) return;
    this.persistRevision += 1;
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistPromise = this.persistNow();
    }, 0);
  }

  private async persistNow(): Promise<void> {
    const storage = this.storage;
    if (storage === null) return;
    const revision = this.persistRevision;
    const entries = this.list.entries;
    const stored: StoredEntry[] = [];
    try {
      for (const entry of entries) {
        let data = this.fileData.get(entry.id);
        if (data === undefined) {
          data = bytesToBase64(new Uint8Array(await entry.file.arrayBuffer()));
          this.fileData.set(entry.id, data);
        }
        stored.push({
          id: entry.id,
          fileName: entry.file.name,
          data,
          durationSec: entry.durationSec,
          status: entry.status,
          error: entry.error,
        });
      }
    } catch {
      this.reportPersistFailure();
      return;
    }
    if (revision !== this.persistRevision) {
      // The playlist changed while the files were being read; save the newer state.
      this.schedulePersist();
      return;
    }
    try {
      const payload: StoredPlaylist = { version: 1, currentId: this.list.currentId, entries: stored };
      storage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      this.reportPersistFailure();
    }
    const live = new Set(entries.map((e) => e.id));
    for (const id of this.fileData.keys()) {
      if (!live.has(id)) this.fileData.delete(id);
    }
  }

  private reportPersistFailure(): void {
    if (this.persistFailed) return;
    this.persistFailed = true;
    this.options.onStatus('Could not save the playlist in this browser (storage full or unavailable).');
  }

  private setState(state: PlayerState): void {
    if (this.playerState === state) return;
    this.playerState = state;
    this.options.onChange();
  }

  /** Replaces the playing song's instrument summary and re-renders once. */
  private setInstruments(state: InstrumentsState): void {
    this.instruments = state;
    this.options.onChange();
  }
}
