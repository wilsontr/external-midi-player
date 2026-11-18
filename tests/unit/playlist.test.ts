import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  M3U_MAX_LINES,
  PLAYLIST_STORAGE_KEY,
  PlaylistPlayer,
  buildM3u,
  createEntry,
  emptyPlaylist,
  isPlaylistFileName,
  matchM3u,
  nextReadyId,
  parseM3u,
  playlistReducer,
  previousReadyId,
  type PlaylistEntry,
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

describe('M3U playlist files (T10)', () => {
  const entryList = (...names: string[]): PlaylistEntry[] => stateWith(...names).entries;
  const withDurations = (...durations: Array<number | undefined>): PlaylistEntry[] => {
    const entries = entryList(...durations.map((_, i) => `song-${i + 1}.mid`));
    let s: PlaylistState = { entries, currentId: entries[0]?.id ?? null };
    entries.forEach((entry, index) => {
      const durationSec = durations[index];
      if (durationSec !== undefined) {
        s = playlistReducer(s, { type: 'parsed', id: entry.id, durationSec });
      }
    });
    return s.entries;
  };

  const picked = (name: string, relativePath?: string): File => {
    const f = file(name);
    if (relativePath !== undefined) {
      Object.defineProperty(f, 'webkitRelativePath', { value: relativePath });
    }
    return f;
  };

  it('recognises the two playlist extensions', () => {
    expect(isPlaylistFileName('list.m3u')).toBe(true);
    expect(isPlaylistFileName('LIST.M3U8')).toBe(true);
    expect(isPlaylistFileName('list.mid')).toBe(false);
    expect(isPlaylistFileName('list.m3u.bak')).toBe(false);
  });

  it('writes the header, EXTINF durations and file names in order', () => {
    const text = buildM3u(entryList('a.mid', 'b.midi'));
    expect(text).toBe(
      '#EXTM3U\n' +
        '#EXTINF:-1,a\n' +
        'a.mid\n' +
        '#EXTINF:-1,b\n' +
        'b.midi\n',
    );
  });

  it('rounds known durations, writes -1 for unknown ones and includes error rows', () => {
    let s: PlaylistState = { entries: withDurations(12.6, undefined), currentId: null };
    s = playlistReducer(s, { type: 'failed', id: s.entries[1].id, error: 'unreadable' });
    expect(buildM3u(s.entries)).toContain('#EXTINF:13,song-1');
    expect(buildM3u(s.entries)).toContain('#EXTINF:-1,song-2');
  });

  it('keeps commas, spaces and non-ASCII names, and strips line breaks', () => {
    const entries = entryList('héllo, wörld.mid', 'a b.mid');
    const text = buildM3u(entries);
    expect(text).toContain('#EXTINF:-1,héllo, wörld\nhéllo, wörld.mid\n');
    expect(text).toContain('#EXTINF:-1,a b\na b.mid\n');

    const multiline = createEntry(new File([new Uint8Array([0])], 'line\nbreak.mid'));
    expect(buildM3u([multiline])).toContain('#EXTINF:-1,line break\nline break.mid\n');
  });

  it('writes only the header for an empty playlist', () => {
    expect(buildM3u([])).toBe('#EXTM3U\n');
  });

  it('parses BOM, CRLF, comments, EXTINF titles and quoted Windows paths', () => {
    const result = parseM3u(
      '\uFEFF#EXTM3U\r\n' +
        '\r\n' +
        '# a comment\r\n' +
        '#EXTINF:12.4,First song\r\n' +
        '"C:\\Music\\One.MID"\r\n' +
        '#EXT-X-EXTRA:ignored\r\n' +
        '#EXTINF:-1,Second\r\n' +
        './sub/two.midi\r\n',
    );
    expect(result.error).toBeUndefined();
    expect(result.unsupported).toEqual([]);
    expect(result.tracks).toEqual([
      { reference: 'C:\\Music\\One.MID', title: 'First song', durationSec: 12.4 },
      { reference: './sub/two.midi', title: 'Second', durationSec: undefined },
    ]);
  });

  it('accepts an EXTINF without a title or with a malformed duration', () => {
    const noTitle = parseM3u('#EXTINF:5\nsong.mid\n').tracks[0];
    expect(noTitle.durationSec).toBe(5);
    expect(noTitle.title).toBeUndefined();

    const badDuration = parseM3u('#EXTINF:oops,Title\nsong.mid\n').tracks[0];
    expect(badDuration.durationSec).toBeUndefined();
    expect(badDuration.title).toBe('Title');
  });

  it('strips file:// references and reports URLs and non-MIDI files', () => {
    const result = parseM3u(
      '#EXTM3U\n' +
        'file:///C:/Music/a.mid\n' +
        'https://example.com/b.mid\n' +
        'rtsp://example.com/c.mid\n' +
        'notes.txt\n' +
        'song.midi\n',
    );
    expect(result.tracks.map((t) => t.reference)).toEqual(['C:/Music/a.mid', 'song.midi']);
    expect(result.unsupported).toEqual([
      'https://example.com/b.mid',
      'rtsp://example.com/c.mid',
      'notes.txt',
    ]);
  });

  it('rejects a playlist over the size or line cap', () => {
    expect(parseM3u('x'.repeat(1_000_001)).error).toContain('too large');
    const manyLines = Array.from({ length: M3U_MAX_LINES + 1 }, () => '#').join('\n');
    expect(parseM3u(manyLines).error).toContain('too many lines');
  });

  it('matches by case-insensitive base name and keeps M3U order', () => {
    const files = [picked('B.MID'), picked('a.midi')];
    const { tracks } = parseM3u('#EXTM3U\na.midi\nb.mid\n');
    const match = matchM3u(tracks, files);
    expect(match.files.map((f) => f.name)).toEqual(['a.midi', 'B.MID']);
    expect(match.missing).toEqual([]);
    expect(match.extra).toEqual([]);
  });

  it('prefers an exact relative path over a duplicate base name', () => {
    const files = [
      picked('song.mid', 'Disc 1/song.mid'),
      picked('song.mid', 'Disc 2/song.mid'),
    ];
    const { tracks } = parseM3u('Disc 2/song.mid\nDisc 1/song.mid\n');
    const match = matchM3u(tracks, files);
    expect(match.files.map((f) => f.webkitRelativePath)).toEqual([
      'Disc 2/song.mid',
      'Disc 1/song.mid',
    ]);
    expect(match.ambiguous).toEqual([]);
  });

  it('matches Windows and file:// references by base name', () => {
    const files = [picked('a.mid')];
    const { tracks } = parseM3u('C:\\Music\\a.mid\nfile:///C:/Other/a.mid\n');
    const match = matchM3u(tracks, files);
    expect(match.files).toEqual([files[0], files[0]]);
    expect(match.missing).toEqual([]);
    expect(match.extra).toEqual([]);
  });

  it('normalises Unicode and case when matching', () => {
    const files = [picked('Café.mid')];
    const { tracks } = parseM3u('CAFE\u0301.MID\n');
    expect(matchM3u(tracks, files).files).toEqual([files[0]]);
  });

  it('reports missing references, extra selections and duplicate names', () => {
    const files = [picked('a.mid'), picked('extra.mid'), picked('song.mid'), picked('song.mid')];
    const { tracks } = parseM3u('a.mid\nmissing.mid\nsong.mid\nsong.mid\n');
    const match = matchM3u(tracks, files);
    expect(match.files).toEqual([files[0], files[2], files[3]]);
    expect(match.missing).toEqual(['missing.mid']);
    expect(match.extra).toEqual([files[1]]);
    expect(match.ambiguous).toEqual(['song.mid']);
  });

  it('reuses one file when the playlist lists it more than once', () => {
    const files = [picked('song.mid')];
    const { tracks } = parseM3u('song.mid\nsong.mid\n');
    const match = matchM3u(tracks, files);
    expect(match.files).toEqual([files[0], files[0]]);
    expect(match.extra).toEqual([]);
    expect(match.ambiguous).toEqual([]);
    expect(match.fromPlaylist).toBe(0);
  });

  it('falls back to files already in the playlist when nothing is selected', () => {
    const existing = [picked('b.mid'), picked('a.mid')];
    const { tracks } = parseM3u('a.mid\nb.mid\nmissing.mid\n');
    const match = matchM3u(tracks, [], existing);
    expect(match.files).toEqual([existing[1], existing[0]]);
    expect(match.fromPlaylist).toBe(2);
    expect(match.missing).toEqual(['missing.mid']);
    // Existing playlist files are not "extra": the list is replaced, not merged.
    expect(match.extra).toEqual([]);
  });

  it('prefers a selected file over an existing playlist file', () => {
    const selected = [picked('a.mid')];
    const existing = [picked('a.mid')];
    const { tracks } = parseM3u('a.mid\n');
    const match = matchM3u(tracks, selected, existing);
    expect(match.files).toEqual(selected);
    expect(match.fromPlaylist).toBe(0);
    expect(match.ambiguous).toEqual([]);
    expect(match.extra).toEqual([]);
  });

  it('mixes selected files with files already in the playlist', () => {
    const selected = [picked('a.mid')];
    const existing = [picked('b.mid')];
    const { tracks } = parseM3u('a.mid\nb.mid\n');
    const match = matchM3u(tracks, selected, existing);
    expect(match.files).toEqual([selected[0], existing[0]]);
    expect(match.fromPlaylist).toBe(1);
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

  it('loads an M3U selection in playlist order and persists it', async () => {
    player.add([file('old.mid')]);
    await flush();
    player.play();
    await flush();

    const selected = [file('b.mid'), file('a.mid')];
    const { tracks } = parseM3u('#EXTM3U\n#EXTINF:2,a\na.mid\n#EXTINF:1,b\nb.mid\n');
    const matched = matchM3u(tracks, selected);
    expect(matched.files.map((f) => f.name)).toEqual(['a.mid', 'b.mid']);

    expect(player.load(matched.files)).toEqual({ added: 2, rejected: [] });
    expect(player.playlist.entries.map((e) => e.name)).toEqual(['a', 'b']);
    expect(player.currentEntry()?.name).toBe('a');
    expect(player.state).toBe('stopped');

    await flush();
    await player.flushPersistence();
    expect(makePlayer().playlist.entries.map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('reloads an M3U from the files already in the playlist', async () => {
    player.add([file('a.mid'), file('b.mid')]);
    await flush();

    const existing = player.playlist.entries.map((e) => e.file);
    const { tracks } = parseM3u('#EXTM3U\nb.mid\na.mid\n');
    const matched = matchM3u(tracks, [], existing);
    expect(matched.files.map((f) => f.name)).toEqual(['b.mid', 'a.mid']);
    expect(matched.fromPlaylist).toBe(2);

    player.load(matched.files);
    expect(player.playlist.entries.map((e) => e.name)).toEqual(['b', 'a']);
    expect(player.currentEntry()?.name).toBe('b');
  });

  it('keeps the existing playlist when an M3U selection matches nothing', () => {
    player.add([file('a.mid')]);
    const before = player.playlist.entries.map((e) => e.id);
    const { tracks } = parseM3u('missing.mid\n');
    const matched = matchM3u(tracks, [file('other.mid')]);
    expect(matched.files).toEqual([]);

    const result = player.load(matched.files);
    expect(result).toEqual({ added: 0, rejected: [] });
    expect(player.playlist.entries.map((e) => e.id)).toEqual(before);
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

  const instrumentSong = (program = 0): ParseResult => ({
    status: 'ok',
    song: {
      events: [
        { type: 'program-change', time: 0, channel: 0, program },
        { type: 'program-change', time: 0, channel: 1, program: 40 },
        { type: 'note-on', time: 0, channel: 0, note: 60, velocity: 100 },
        { type: 'note-off', time: 1, channel: 0, note: 60, velocity: 0 },
      ],
      duration: 10,
      tempos: [],
    },
  });

  /** Program numbers per channel while ready, or the state name otherwise. */
  const channelSummary = () => {
    const state = player.instrumentsState();
    return state.status === 'ready'
      ? state.channels.map((c) => c.programs.map((p) => p.program))
      : state.status;
  };

  it('summarizes only the song that is playing', async () => {
    parseFile = async () => instrumentSong();
    player.add([file('a.mid')]);
    await flush();
    // The background duration parse must not load the card.
    expect(player.instrumentsState()).toEqual({ status: 'none' });

    player.play();
    expect(player.instrumentsState()).toEqual({ status: 'loading' });
    await flush();
    expect(player.instrumentsState().status).toBe('ready');
    expect(channelSummary()).toEqual([
      [0],
      [40],
    ]);

    player.pause();
    expect(player.instrumentsState().status).toBe('ready');
    player.seek(1);
    expect(player.instrumentsState().status).toBe('ready');

    player.stop();
    expect(player.instrumentsState()).toEqual({ status: 'none' });
  });

  it('swaps the summary when another song starts and clears it after the last song', async () => {
    parseFile = async (f) => instrumentSong(f.name.startsWith('b') ? 33 : 0);
    player.add([file('a.mid'), file('b.mid')]);
    await flush();
    player.play();
    await flush();
    expect(channelSummary()).toEqual([
      [0],
      [40],
    ]);

    player.next();
    expect(player.instrumentsState()).toEqual({ status: 'loading' });
    await flush();
    expect(channelSummary()).toEqual([
      [33],
      [40],
    ]);

    schedulers[schedulers.length - 1].options.onEnded!();
    expect(player.instrumentsState()).toEqual({ status: 'none' });
    expect(player.state).toBe('stopped');
  });

  it('clears the summary when the playing file fails to parse', async () => {
    player.add([file('a.mid')]);
    await flush();
    parseFile = async () => ({ status: 'error', message: 'broken' });
    player.play();
    await flush();
    expect(player.instrumentsState()).toEqual({ status: 'none' });
    expect(player.state).toBe('stopped');
  });

  it('clears the summary when the output is lost', async () => {
    parseFile = async () => instrumentSong();
    player.add([file('a.mid')]);
    player.play();
    await flush();
    expect(player.instrumentsState().status).toBe('ready');

    player.outputLost();
    expect(player.instrumentsState()).toEqual({ status: 'none' });
  });
});
