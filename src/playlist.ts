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

import { isMidiFileName, parseSongForPlayback, type ParseResult } from './parser';
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

export interface PlaylistState {
  entries: PlaylistEntry[];
  /** The highlighted entry: the one playing, or the one that plays next. */
  currentId: string | null;
}

export type PlaylistAction =
  | { type: 'add'; entries: PlaylistEntry[] }
  | { type: 'remove'; id: string }
  /** Moves the entry so it ends up at `toIndex` of the resulting list. */
  | { type: 'move'; id: string; toIndex: number }
  | { type: 'setCurrent'; id: string | null }
  | { type: 'parsed'; id: string; durationSec: number }
  | { type: 'failed'; id: string; error: string };

export const emptyPlaylist: PlaylistState = { entries: [], currentId: null };

/** Creates an entry for a file; the status is `ready` until a parse fails. */
export function createEntry(file: File): PlaylistEntry {
  return {
    id: crypto.randomUUID(),
    file,
    name: file.name.replace(/\.[^./\\]*$/, ''),
    status: 'ready',
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
    case 'failed':
      return updateEntry(state, action.id, { status: 'error', error: action.error });
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

/** The slice of `Scheduler` the transport uses (injectable for tests). */
export type TransportScheduler = Pick<
  Scheduler,
  'play' | 'pause' | 'stop' | 'panic' | 'dispose' | 'position'
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
}

/** Transport state machine over the playlist; see the file header. */
export class PlaylistPlayer {
  private list: PlaylistState = emptyPlaylist;
  private playerState: PlayerState = 'stopped';
  private scheduler: TransportScheduler | null = null;
  /** Bumped by every transition that must abort an in-flight song load. */
  private loadToken = 0;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly parseQueue: string[] = [];
  private parsing = false;

  private readonly options: PlaylistPlayerOptions;
  private readonly parse: (file: File) => Promise<ParseResult>;
  private readonly createScheduler: (options: SchedulerOptions) => TransportScheduler;
  private readonly gapMs: number;

  constructor(options: PlaylistPlayerOptions) {
    this.options = options;
    this.parse = options.parse ?? parseSongForPlayback;
    this.createScheduler = options.createScheduler ?? ((o) => new Scheduler(o));
    this.gapMs = options.gapMs ?? 1000;
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

  /**
   * Adds files in the order given. Files without a .mid/.midi extension are
   * rejected; their names are returned. Durations are parsed in the
   * background, one file at a time.
   */
  add(files: File[]): { added: number; rejected: string[] } {
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

  remove(id: string): void {
    if (this.playerState !== 'stopped' && this.list.currentId === id) {
      this.stop();
    }
    this.dispatch({ type: 'remove', id });
  }

  move(id: string, toIndex: number): void {
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
    this.setState('paused');
  }

  /** Stops, releases every sounding note and resets the position to 0. */
  stop(): void {
    this.cancelPending();
    this.releaseScheduler();
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

  /** Plays an entry from the start (double-click). */
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
    this.setState('stopped');
  }

  private jumpTo(target: string | null, restartWhenNone: boolean): void {
    const id = target ?? (restartWhenNone ? this.list.currentId : null);
    if (this.playerState === 'playing') {
      if (id === null) this.stop();
      else void this.start(id);
      return;
    }
    this.stop();
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
    this.releaseScheduler();
    const token = ++this.loadToken;
    this.dispatch({ type: 'setCurrent', id });
    this.setState('playing');

    let result: ParseResult;
    try {
      result = await this.parse(entry.file);
    } catch (err) {
      // A throwing parse must not leave the transport stuck in `playing`.
      result = parseFailure(err);
    }
    if (token !== this.loadToken) return;
    if (result.status === 'error') {
      this.dispatch({ type: 'failed', id, error: result.message });
      this.options.onStatus(`${entry.name}: ${result.message}`);
      const following = nextReadyId(this.list, id);
      if (following === null) this.stop();
      else void this.start(following);
      return;
    }
    this.dispatch({ type: 'parsed', id, durationSec: result.song.duration });
    const scheduler = this.createScheduler({
      output,
      events: result.song.events,
      duration: result.song.duration,
      onEnded: () => this.handleEnded(scheduler),
    });
    this.scheduler = scheduler;
    scheduler.play();
  }

  private handleEnded(ended: TransportScheduler): void {
    if (this.scheduler !== ended) return;
    this.scheduler = null;
    const following = nextReadyId(this.list, this.list.currentId);
    if (following === null) {
      this.setState('stopped');
      return;
    }
    // Stays `playing` through the gap; the next entry is highlighted already.
    this.dispatch({ type: 'setCurrent', id: following });
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
      this.options.onChange();
    }
  }

  private setState(state: PlayerState): void {
    if (this.playerState === state) return;
    this.playerState = state;
    this.options.onChange();
  }
}
