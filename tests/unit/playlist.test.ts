import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PlaylistPlayer,
  createEntry,
  emptyPlaylist,
  nextReadyId,
  playlistReducer,
  previousReadyId,
  type PlaylistState,
  type TransportScheduler,
} from '../../src/playlist';
import type { ParseResult } from '../../src/parser';
import type { SchedulerOptions } from '../../src/scheduler';

const file = (name: string) => new File([new Uint8Array([0])], name);

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

  it('removes an entry and clears the current id when it was current', () => {
    let s = stateWith('a.mid', 'b.mid');
    const [a, b] = s.entries;
    s = playlistReducer(s, { type: 'setCurrent', id: a.id });
    expect(playlistReducer(s, { type: 'remove', id: b.id }).currentId).toBe(a.id);
    const removed = playlistReducer(s, { type: 'remove', id: a.id });
    expect(names(removed)).toEqual(['b']);
    expect(removed.currentId).toBeNull();
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

  const parse = async (f: File): Promise<ParseResult> =>
    f.name.startsWith('bad')
      ? { status: 'error', message: 'not a MIDI file' }
      : { status: 'ok', song: { events: [], duration: 10, tempos: [] } };

  const flush = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    schedulers = [];
    statuses = [];
    outputAvailable = true;
    player = new PlaylistPlayer({
      getOutput: () => (outputAvailable ? output : null),
      onChange: () => {},
      onStatus: (m) => statuses.push(m),
      parse,
      createScheduler: (options) => {
        const calls: string[] = [];
        const fake: FakeScheduler = {
          options,
          calls,
          play: () => calls.push('play'),
          pause: () => calls.push('pause'),
          stop: () => calls.push('stop'),
          panic: () => calls.push('panic'),
          dispose: () => calls.push('dispose'),
          position: () => 0,
        };
        schedulers.push(fake);
        return fake;
      },
    });
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
    player.next();
    await flush();
    expect(currentName()).toBe('b');
    player.previous();
    await flush();
    expect(currentName()).toBe('a');
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
});
