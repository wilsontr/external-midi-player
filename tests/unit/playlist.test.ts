import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PLAYLIST_STORAGE_KEY,
  PlaylistPlayer,
  createEntry,
  emptyPlaylist,
  nextReadyId,
  playlistReducer,
  previousReadyId,
  type PlaylistState,
  type PlaylistStorage,
  type TransportScheduler,
} from '../../src/playlist';
import type { ParseResult } from '../../src/parser';
import type { SchedulerOptions } from '../../src/scheduler';

const file = (name: string) => new File([new Uint8Array([0])], name);

function memoryStorage(initial: Record<string, string> = {}): PlaylistStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function stateWith(...names: string[]): PlaylistState {
  return playlistReducer(emptyPlaylist, { type: 'add', entries: names.map((n) => createEntry(file(n))) });
}

const last = <T,>(items: T[]): T => items[items.length - 1];
const names = (s: PlaylistState) => s.entries.map((e) => e.name);

describe('playlistReducer', () => {
  it('adds entries in the order given, named without extension', () => {
    const s = stateWith('a.mid', 'b.MIDI', 'c.final.mid');
    expect(names(s)).toEqual(['a', 'b', 'c.final']);
    expect(s.entries.every((e) => e.status === 'ready')).toBe(true);
    const more = playlistReducer(s, { type: 'add', entries: [createEntry(file('d.mid'))] });
    expect(names(more)).toEqual(['a', 'b', 'c.final', 'd']);
  });

  it('highlights the entry that plays next as entries are added and removed', () => {
    let s = stateWith('a.mid', 'b.mid', 'c.mid');
    const [a, b, c] = s.entries;
    // A list that had nothing current highlights its first playable entry.
    expect(s.currentId).toBe(a.id);

    // Removing a non-current entry leaves the highlight alone.
    expect(playlistReducer(s, { type: 'remove', id: c.id }).currentId).toBe(a.id);

    // Removing the current entry moves the highlight to the next ready one.
    s = playlistReducer(s, { type: 'setCurrent', id: b.id });
    const afterB = playlistReducer(s, { type: 'remove', id: b.id });
    expect(names(afterB)).toEqual(['a', 'c']);
    expect(afterB.currentId).toBe(c.id);

    // ... and to the nearest previous ready one when the current entry was last.
    s = playlistReducer(s, { type: 'setCurrent', id: c.id });
    expect(playlistReducer(s, { type: 'remove', id: c.id }).currentId).toBe(b.id);
  });

  it('skips error entries when re-selecting after a removal', () => {
    let s = stateWith('a.mid', 'bad.mid', 'c.mid');
    const [a, bad, c] = s.entries;
    s = playlistReducer(s, { type: 'failed', id: bad.id, error: 'x' });
    expect(s.currentId).toBe(a.id);
    expect(playlistReducer(s, { type: 'remove', id: a.id }).currentId).toBe(c.id);

    // Nothing playable left: no highlight.
    let onlyBad = playlistReducer(s, { type: 'remove', id: a.id });
    onlyBad = playlistReducer(onlyBad, { type: 'remove', id: c.id });
    expect(names(onlyBad)).toEqual(['bad']);
    expect(onlyBad.currentId).toBeNull();
  });

  it('replaces the whole list (Load) and clears it (Clear)', () => {
    let s = stateWith('a.mid', 'b.mid');
    s = playlistReducer(s, { type: 'setCurrent', id: s.entries[1].id });
    const replaced = playlistReducer(s, {
      type: 'replace',
      entries: [createEntry(file('x.mid')), createEntry(file('y.mid'))],
    });
    expect(names(replaced)).toEqual(['x', 'y']);
    expect(replaced.currentId).toBe(replaced.entries[0].id);

    const cleared = playlistReducer(replaced, { type: 'replace', entries: [] });
    expect(cleared.entries).toEqual([]);
    expect(cleared.currentId).toBeNull();
  });

  it('moves an entry to the target index and keeps the current entry by id', () => {
    let s = stateWith('a.mid', 'b.mid', 'c.mid', 'd.mid');
    s = playlistReducer(s, { type: 'setCurrent', id: s.entries[0].id });
    const [a, , c] = s.entries;
    const moved = playlistReducer(s, { type: 'move', id: a.id, toIndex: 2 });
    expect(names(moved)).toEqual(['b', 'c', 'a', 'd']);
    expect(moved.currentId).toBe(a.id);
    expect(names(playlistReducer(moved, { type: 'move', id: c.id, toIndex: 0 }))).toEqual([
      'c',
      'b',
      'a',
      'd',
    ]);
    expect(last(playlistReducer(s, { type: 'move', id: a.id, toIndex: 99 }).entries)).toBe(a);
  });

  it('marks failed entries as errors and records parsed durations', () => {
    let s = stateWith('a.mid', 'b.mid');
    s = playlistReducer(s, { type: 'parsed', id: s.entries[0].id, durationSec: 12.5 });
    s = playlistReducer(s, { type: 'failed', id: s.entries[1].id, error: 'bad header' });
    expect(s.entries[0].durationSec).toBe(12.5);
    expect(s.entries[1]).toMatchObject({ status: 'error', error: 'bad header' });
  });

  it('moves the highlight off a failed current entry to the next ready one', () => {
    let s = stateWith('bad.mid', 'good.mid');
    const [bad, good] = s.entries;
    expect(s.currentId).toBe(bad.id);
    s = playlistReducer(s, { type: 'failed', id: bad.id, error: 'not a MIDI file' });
    expect(s.currentId).toBe(good.id);

    // With nothing playable left, there is no highlight.
    s = playlistReducer(s, { type: 'failed', id: good.id, error: 'gone' });
    expect(s.currentId).toBeNull();
  });

  it('auto-advance helpers skip error entries', () => {
    let s = stateWith('a.mid', 'b.mid', 'c.mid', 'd.mid');
    const [a, b, c, d] = s.entries;
    s = playlistReducer(s, { type: 'failed', id: b.id, error: 'x' });
    s = playlistReducer(s, { type: 'failed', id: c.id, error: 'x' });
    expect(nextReadyId(s, a.id)).toBe(d.id);
    expect(nextReadyId(s, d.id)).toBeNull();
    expect(nextReadyId(s, null)).toBe(a.id);
    expect(previousReadyId(s, d.id)).toBe(a.id);
    expect(previousReadyId(s, a.id)).toBeNull();
  });
});

describe('PlaylistPlayer', () => {
  interface FakeScheduler extends TransportScheduler {
    options: SchedulerOptions;
    calls: string[];
  }
  let schedulers: FakeScheduler[];
  let player: PlaylistPlayer;
  let statuses: string[];
  const output = { id: 'o', send: vi.fn() } as unknown as MIDIOutput;
  let outputAvailable: boolean;
  /** Swapped by tests that need a failing parse. */
  let parseFile: (f: File) => Promise<ParseResult>;
  let storage: PlaylistStorage;
  /** Wall time the fake scheduler reports from panic()/stop(). */
  let panicWall: number;
  let stopTail: number | null;

  const parse = async (f: File): Promise<ParseResult> =>
    f.name.startsWith('bad')
      ? { status: 'error', message: 'not a MIDI file' }
      : { status: 'ok', song: { events: [], duration: 10, tempos: [] } };

  const flush = () => vi.advanceTimersByTimeAsync(0);

  const makePlayer = (store: PlaylistStorage = storage): PlaylistPlayer =>
    new PlaylistPlayer({
      getOutput: () => (outputAvailable ? output : null),
      onChange: () => {},
      onStatus: (m) => statuses.push(m),
      parse: (f) => parseFile(f),
      createScheduler: (options) => {
        const calls: string[] = [];
        const fake: FakeScheduler = {
          options,
          calls,
          play: (startAt?: number) =>
            calls.push(startAt === undefined ? 'play' : `play@${startAt}`),
          pause: () => calls.push('pause'),
          stop: () => {
            calls.push('stop');
            return stopTail;
          },
          panic: () => {
            calls.push('panic');
            return panicWall;
          },
          dispose: () => calls.push('dispose'),
          position: () => 0,
          seek: (position: number) => calls.push(`seek:${position}`),
        };
        schedulers.push(fake);
        return fake;
      },
      storage: store,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    schedulers = [];
    statuses = [];
    outputAvailable = true;
    parseFile = parse;
    storage = memoryStorage();
    panicWall = 100;
    stopTail = null;
    player = makePlayer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const currentName = () => player.currentEntry()?.name;

  it('rejects non-MIDI files and fills durations in the background', async () => {
    const result = player.add([file('a.mid'), file('notes.txt'), file('b.midi')]);
    expect(result).toEqual({ added: 2, rejected: ['notes.txt'] });
    await flush();
    expect(player.playlist.entries.map((e) => e.durationSec)).toEqual([10, 10]);
  });

  it('shows a corrupt file as an error row with a status message', async () => {
    player.add([file('bad.mid')]);
    await flush();
    expect(player.playlist.entries[0]).toMatchObject({ status: 'error', error: 'not a MIDI file' });
    expect(last(statuses)).toContain('bad');
  });

  it('plays, pauses, resumes and stops through the scheduler', async () => {
    player.add([file('a.mid')]);
    player.play();
    await flush();
    expect(player.state).toBe('playing');
    player.pause();
    expect(player.state).toBe('paused');
    player.play();
    expect(player.state).toBe('playing');
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0].calls).toEqual(['play', 'pause', 'play']);
    player.stop();
    expect(player.state).toBe('stopped');
    expect(last(schedulers[0].calls)).toBe('stop');
  });

  it('refuses to play without an output', async () => {
    player.add([file('a.mid')]);
    outputAvailable = false;
    player.play();
    await flush();
    expect(player.state).toBe('stopped');
    expect(last(statuses)).toContain('output');
  });

  it('highlights the entry that plays next as entries are added and removed', () => {
    player.add([file('a.mid'), file('b.mid')]);
    expect(currentName()).toBe('a');
    const [a, b] = player.playlist.entries;
    player.remove(a.id);
    expect(currentName()).toBe('b');
    player.remove(b.id);
    expect(player.currentEntry()).toBeNull();
  });

  it('turns a parse rejection into an error row instead of wedging the queue', async () => {
    parseFile = async () => {
      throw new Error('disk gone');
    };
    player.add([file('a.mid'), file('b.mid')]);
    await flush();
    // Both files rejected by the background parse; the queue kept draining.
    expect(player.playlist.entries.map((e) => e.status)).toEqual(['error', 'error']);
    expect(player.playlist.entries[0].error).toBe('disk gone');

    player.play();
    await flush();
    expect(player.state).toBe('stopped');
    expect(schedulers).toHaveLength(0);
    expect(last(statuses)).toContain('No playable songs');
  });

  it('stops cleanly when the parse rejects as the song starts', async () => {
    player.add([file('a.mid')]);
    await flush();
    expect(player.playlist.entries[0].status).toBe('ready');

    parseFile = async () => {
      throw new Error('stream closed');
    };
    player.play();
    await flush();
    expect(player.playlist.entries[0]).toMatchObject({ status: 'error', error: 'stream closed' });
    expect(player.state).toBe('stopped');
    expect(schedulers).toHaveLength(0);
  });

  it('auto-advances after a 1 s gap, skipping error entries, and stops after the last song', async () => {
    player.add([file('a.mid'), file('bad.mid'), file('c.mid')]);
    await flush();
    player.play();
    await flush();
    expect(currentName()).toBe('a');

    schedulers[0].options.onEnded!();
    expect(player.state).toBe('playing');
    // bad.mid was already marked as an error by the background parse.
    expect(currentName()).toBe('c');
    expect(schedulers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(schedulers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(schedulers).toHaveLength(2);

    schedulers[1].options.onEnded!();
    expect(player.state).toBe('stopped');
    expect(schedulers).toHaveLength(2);
  });

  it('pausing during the gap cancels the auto-advance; resume plays the next song', async () => {
    player.add([file('a.mid'), file('b.mid')]);
    player.play();
    await flush();
    schedulers[0].options.onEnded!();
    player.pause();
    await vi.advanceTimersByTimeAsync(2000);
    expect(player.state).toBe('paused');
    expect(schedulers).toHaveLength(1);
    player.play();
    await flush();
    expect(player.state).toBe('playing');
    expect(currentName()).toBe('b');
    expect(schedulers).toHaveLength(2);
  });

  it('removing the playing entry stops playback; reordering keeps it playing', async () => {
    player.add([file('a.mid'), file('b.mid')]);
    const [a, b] = player.playlist.entries;
    player.play();
    await flush();
    player.move(a.id, 1);
    expect(player.state).toBe('playing');
    expect(currentName()).toBe('a');
    player.remove(b.id);
    expect(player.state).toBe('playing');
    player.remove(a.id);
    expect(player.state).toBe('stopped');
    expect(last(schedulers[0].calls)).toBe('stop');
  });

  it('next/previous move through ready entries and stop at the end of the list', async () => {
    player.add([file('a.mid'), file('b.mid')]);
    player.play();
    await flush();
    const first = schedulers[0];
    player.next();
    await flush();
    expect(currentName()).toBe('b');
    // Switching songs panics the old scheduler instead of a plain release.
    expect(first.calls).toContain('panic');
    expect(first.calls).toContain('dispose');
    const second = schedulers[1];
    player.previous();
    await flush();
    expect(currentName()).toBe('a');
    expect(second.calls).toContain('panic');
    player.next();
    await flush();
    player.next();
    expect(player.state).toBe('stopped');
  });

  it('an output disconnect stops without sending anything', async () => {
    player.add([file('a.mid')]);
    player.play();
    await flush();
    player.outputLost();
    expect(player.state).toBe('stopped');
    expect(schedulers[0].calls).toEqual(['play', 'dispose']);
  });

  it('panic sends the panic before stopping, even with nothing playing', async () => {
    player.add([file('a.mid')]);
    player.play();
    await flush();
    player.panic();
    expect(schedulers[0].calls).toEqual(['play', 'panic', 'stop']);
    expect(player.state).toBe('stopped');
    player.panic();
    expect(last(schedulers)!.calls).toEqual(['panic']);
  });

  it('saves the playlist and current entry and restores them on the next visit', async () => {
    player.add([file('a.mid'), file('b.mid')]);
    await flush();
    player.play();
    await flush();
    player.next();
    await flush();
    expect(currentName()).toBe('b');
    await player.flushPersistence();

    const restored = makePlayer();
    expect(restored.playlist.entries.map((e) => e.name)).toEqual(['a', 'b']);
    expect(restored.playlist.entries.map((e) => e.durationSec)).toEqual([10, 10]);
    expect(restored.currentEntry()?.name).toBe('b');
    expect(restored.state).toBe('stopped');
  });

  it('restores entries whose duration was saved, without re-parsing them', async () => {
    player.add([file('a.mid')]);
    await flush();
    await player.flushPersistence();

    parseFile = async () => {
      throw new Error('should not parse a restored duration');
    };
    const restored = makePlayer();
    await flush();
    expect(restored.playlist.entries[0]).toMatchObject({ name: 'a', durationSec: 10 });
    expect(restored.playlist.entries[0].status).toBe('ready');
  });

  it('ignores corrupt stored data and keeps working when storage rejects writes', async () => {
    storage = memoryStorage({ [PLAYLIST_STORAGE_KEY]: '{not json' });
    const corrupt = makePlayer();
    expect(corrupt.playlist.entries).toEqual([]);

    const failing = makePlayer({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    });
    failing.add([file('a.mid')]);
    await flush();
    await failing.flushPersistence();
    expect(failing.playlist.entries).toHaveLength(1);
    expect(last(statuses)).toContain('Could not save the playlist');
  });

  it('stops and reports when the scheduler reports a send error', async () => {
    player.add([file('a.mid')]);
    await flush();
    player.play();
    await flush();

    schedulers[0].options.onError?.('device gone');

    expect(player.state).toBe('stopped');
    expect(last(statuses)).toContain('MIDI output failed');
  });

  it('loads files as a replacement, stopping playback and rejecting non-MIDI', async () => {
    player.add([file('a.mid'), file('b.mid')]);
    await flush();
    player.play();
    await flush();

    const result = player.load([file('x.mid'), file('notes.txt')]);
    expect(result).toEqual({ added: 1, rejected: ['notes.txt'] });
    expect(player.playlist.entries.map((e) => e.name)).toEqual(['x']);
    expect(player.currentEntry()?.name).toBe('x');
    expect(player.state).toBe('stopped');
    expect(last(schedulers[0].calls)).toBe('stop');

    await flush();
    expect(player.playlist.entries[0].durationSec).toBe(10);
    await player.flushPersistence();
    expect(makePlayer().playlist.entries.map((e) => e.name)).toEqual(['x']);
  });

  it('keeps the existing playlist when Load selects nothing valid', () => {
    player.add([file('a.mid')]);
    const before = player.playlist.entries.map((e) => e.id);
    expect(player.load([file('notes.txt')])).toEqual({ added: 0, rejected: ['notes.txt'] });
    expect(player.playlist.entries.map((e) => e.id)).toEqual(before);
    expect(player.state).toBe('stopped');
  });

  it('clears the playlist, stops playback and persists the empty list', async () => {
    player.add([file('a.mid')]);
    await flush();
    player.play();
    await flush();

    player.clear();
    expect(player.playlist.entries).toEqual([]);
    expect(player.currentEntry()).toBeNull();
    expect(player.state).toBe('stopped');
    expect(last(schedulers[0].calls)).toBe('stop');

    await player.flushPersistence();
    expect(storage.getItem(PLAYLIST_STORAGE_KEY)).toContain('"entries":[]');
    expect(makePlayer().playlist.entries).toEqual([]);
  });

  it('forwards seeks while playing or paused and ignores them while stopped', async () => {
    player.add([file('a.mid')]);
    await flush();

    player.seek(1); // stopped: no scheduler and no seek
    expect(schedulers).toHaveLength(0);

    player.play();
    await flush();
    player.seek(3);
    expect(schedulers[0].calls).toContain('seek:3');

    player.pause();
    player.seek(4);
    expect(schedulers[0].calls).toContain('seek:4');

    player.stop();
    const count = schedulers[0].calls.length;
    player.seek(1);
    expect(schedulers[0].calls).toHaveLength(count);
  });

  it('sends a Panic before starting a different track while playing', async () => {
    player.add([file('a.mid'), file('b.mid')]);
    await flush();
    player.play();
    await flush();
    expect(schedulers).toHaveLength(1);

    panicWall = 500;
    player.next();
    await flush();

    expect(schedulers[0].calls).toEqual(['play', 'panic', 'dispose']);
    // The new song is anchored after the Panic (plus the switch gap).
    expect(schedulers[1].calls).toEqual(['play@550']);
    expect(currentName()).toBe('b');
    expect(player.state).toBe('playing');
  });

  it('panics for a paused track switch but not when starting from stopped', async () => {
    player.add([file('a.mid'), file('b.mid')]);
    await flush();
    player.play();
    await flush();
    player.pause();
    panicWall = 900;

    player.playEntry(player.playlist.entries[1].id);
    await flush();
    expect(schedulers[0].calls).toEqual(['play', 'pause', 'panic', 'dispose']);
    expect(schedulers[1].calls).toEqual(['play@950']);

    player.stop();
    const count = schedulers.length;
    player.playEntry(player.playlist.entries[0].id);
    await flush();
    expect(schedulers[count].calls).toEqual(['play']);
  });

  it('restarts the same entry without a Panic but after the released tail', async () => {
    player.add([file('a.mid')]);
    await flush();
    player.play();
    await flush();

    stopTail = 700;
    player.playEntry(player.playlist.entries[0].id);
    await flush();
    expect(schedulers[0].calls).toEqual(['play', 'stop', 'dispose']);
    expect(schedulers[1].calls).toEqual(['play@750']);
  });
});
