import { test, expect, type Page } from '@playwright/test';
import { mockDevices } from './mocks';

const JUNO = { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' };

/**
 * Format-0 SMF at 480 PPQ / 120 BPM (960 ticks per second): optional setup
 * channel events at tick 0, then one note held for `seconds`.
 */
function midiFile(seconds: number, note = 60, setup: number[] = []): number[] {
  const ticks = Math.round(seconds * 960);
  const vlq = (n: number): number[] => {
    const out = [n & 0x7f];
    while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
    return out;
  };
  const track = [
    ...setup,
    0x00,
    0x90,
    note,
    100,
    ...vlq(ticks),
    0x80,
    note,
    0,
    0x00,
    0xff,
    0x2f,
    0x00,
  ];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return [
    ...[0x4d, 0x54, 0x68, 0x64],
    ...u32(6),
    0,
    0,
    0,
    1,
    0x01,
    0xe0,
    ...[0x4d, 0x54, 0x72, 0x6b],
    ...u32(track.length),
    ...track,
  ];
}

interface TestFile {
  name: string;
  bytes: number[];
}

const song = (name: string, seconds = 5, setup: number[] = []): TestFile => ({
  name,
  bytes: midiFile(seconds, 60, setup),
});

async function setup(page: Page): Promise<void> {
  await mockDevices(page, { outputs: [JUNO] });
  await page.goto('/');
  await page.getByTestId('connect-button').click();
  await page.getByTestId('output-picker').selectOption('o1');
}

/** Drops files on the playlist; used for bulk setup, not for the button tests. */
async function dropFiles(page: Page, files: TestFile[]): Promise<void> {
  await page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name));
    const panel = document.querySelector('[data-testid="drop-zone"]')!;
    panel.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}

/**
 * Drives a real file chooser: the "+" and "Load files" buttons must open one.
 * Node's Buffer is read off `globalThis` so this test file needs no @types/node.
 */
const nodeBuffer = (
  globalThis as unknown as { Buffer: { from(data: Uint8Array): unknown } }
).Buffer;

async function pickFiles(page: Page, buttonTestId: string, files: TestFile[]): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId(buttonTestId).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(
    files.map((f) => ({
      name: f.name,
      mimeType: 'audio/midi',
      buffer: nodeBuffer.from(new Uint8Array(f.bytes)) as never,
    })),
  );
}

const rowNames = (page: Page) => page.getByTestId('entry-name').allTextContents();
const rowNumbers = (page: Page) => page.getByTestId('entry-number').allTextContents();
const storedPlaylist = (page: Page) =>
  page.evaluate(() => localStorage.getItem('external-midi-player.playlist') ?? '');
const sent = (page: Page) =>
  page.evaluate(
    () =>
      (window as any).__mockMidi.sent as Array<{ bytes: number[]; timestamp?: number }>,
  );
const clearSent = (page: Page) => page.evaluate(() => ((window as any).__mockMidi.sent.length = 0));

/** Clicks (or drags to) a fraction of the timeline bar. */
async function seekToFraction(page: Page, fraction: number): Promise<void> {
  const box = await page.getByTestId('timeline').boundingBox();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + box!.width * 0.1, y);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * fraction, y, { steps: 5 });
  await page.mouse.up();
}

const ariaNow = async (page: Page): Promise<number> =>
  Number(await page.getByTestId('timeline').getAttribute('aria-valuenow'));

test.describe('T8 — playlist controls, numbering and persistence', () => {
  test('"+" opens the picker with the accessible name "Add files" and appends', async ({
    page,
  }) => {
    await setup(page);
    const add = page.getByTestId('add-files-button');
    await expect(add).toHaveAccessibleName('Add files');
    await expect(add).toHaveAttribute('title', 'Add files');

    await pickFiles(page, 'add-files-button', [song('a.mid', 3)]);
    await expect(page.getByTestId('playlist-row')).toHaveCount(1);

    await pickFiles(page, 'add-files-button', [song('b.mid', 4), song('c.mid', 5)]);
    await expect(page.getByTestId('playlist-row')).toHaveCount(3);
    expect(await rowNames(page)).toEqual(['a', 'b', 'c']);
    expect(await rowNumbers(page)).toEqual(['1', '2', '3']);

    // The picker's value is reset, so the same file can be chosen again.
    await pickFiles(page, 'add-files-button', [song('a.mid', 3)]);
    await expect(page.getByTestId('playlist-row')).toHaveCount(4);
  });

  test('"Load files" replaces the playlist, persists it, and survives a reload', async ({
    page,
  }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid', 3), song('b.mid', 4)]);
    await expect(page.getByTestId('playlist-row')).toHaveCount(2);

    await pickFiles(page, 'load-files-button', [song('x.mid', 5), song('y.mid', 6)]);

    const rows = page.getByTestId('playlist-row');
    await expect(rows).toHaveCount(2);
    expect(await rowNames(page)).toEqual(['x', 'y']);
    expect(await rowNumbers(page)).toEqual(['1', '2']);
    await expect(page.getByTestId('status-region')).toContainText('playlist replaced');
    await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
    await expect.poll(storedPlaylist.bind(null, page)).toContain('"durationSec":5');

    await page.reload();
    await expect(page.getByTestId('playlist-row')).toHaveCount(2);
    expect(await rowNames(page)).toEqual(['x', 'y']);
    expect(await rowNumbers(page)).toEqual(['1', '2']);
    await expect(page.getByTestId('playlist-row').nth(0)).toHaveAttribute('aria-current', 'true');
  });

  test('Load with nothing valid keeps the playlist; Clear empties and persists it', async ({
    page,
  }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid', 3), song('b.mid', 4)]);
    await expect(page.getByTestId('playlist-row')).toHaveCount(2);

    await pickFiles(page, 'load-files-button', [{ name: 'notes.txt', bytes: [1, 2, 3] }]);
    await expect(page.getByTestId('playlist-row')).toHaveCount(2);
    expect(await rowNames(page)).toEqual(['a', 'b']);
    await expect(page.getByTestId('status-region')).toContainText('notes.txt');
    await expect(page.getByTestId('status-region')).toContainText('Playlist unchanged');

    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
    await page.getByTestId('clear-playlist-button').click();

    await expect(page.getByTestId('playlist-row')).toHaveCount(0);
    await expect(page.getByTestId('playlist-empty')).toBeVisible();
    await expect(page.getByTestId('playback-state')).toHaveText('Nothing playing.');
    await expect(page.getByTestId('current-title')).toHaveText('No song selected.');
    await expect.poll(storedPlaylist.bind(null, page)).toContain('"entries":[]');

    await page.reload();
    await expect(page.getByTestId('playlist-row')).toHaveCount(0);
    await expect(page.getByTestId('playlist-empty')).toBeVisible();
  });

  test('rows are numbered 1..N after add, remove, reorder and reload', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid'), song('b.mid'), song('c.mid')]);
    await expect(page.getByTestId('playlist-row')).toHaveCount(3);
    expect(await rowNumbers(page)).toEqual(['1', '2', '3']);

    await page.getByRole('button', { name: 'Remove b', exact: true }).click();
    expect(await rowNames(page)).toEqual(['a', 'c']);
    expect(await rowNumbers(page)).toEqual(['1', '2']);

    await page.getByRole('button', { name: 'Move down a', exact: true }).click();
    expect(await rowNames(page)).toEqual(['c', 'a']);
    expect(await rowNumbers(page)).toEqual(['1', '2']);

    // The reorder's debounced write must land before the reload.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem('external-midi-player.playlist');
          if (raw === null) return '';
          try {
            const parsed = JSON.parse(raw) as { entries: Array<{ fileName: string }> };
            return parsed.entries.map((e) => e.fileName).join(',');
          } catch {
            return '';
          }
        }),
      )
      .toBe('c.mid,a.mid');
    await page.reload();
    expect(await rowNames(page)).toEqual(['c', 'a']);
    expect(await rowNumbers(page)).toEqual(['1', '2']);
  });
});

test.describe('T11 — rack layout', () => {
  test('units span the rack at ≥ 960 px with their strips side by side', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await setup(page);

    const [front, monitor, lcd, keypad, quickstart, expansion] = await Promise.all(
      ['header', 'monitor-panel', 'playback-panel', 'keypad', 'quickstart', 'expansion-unit'].map(
        (id) => page.getByTestId(id).boundingBox(),
      ),
    );

    // Quick start above the rack, then unit 1, then unit 2; both units span
    // the rack at the same left edge and width.
    expect(front!.y).toBeGreaterThan(quickstart!.y + quickstart!.height);
    expect(expansion!.y).toBeGreaterThan(front!.y + front!.height);
    expect(Math.abs(expansion!.x - front!.x)).toBeLessThan(1);
    expect(Math.abs(expansion!.width - front!.width)).toBeLessThan(1);

    // Inside unit 1: monitor strip | LCD | keypad, side by side.
    expect(monitor!.y).toBe(lcd!.y);
    expect(monitor!.x + monitor!.width).toBeLessThanOrEqual(lcd!.x);
    expect(lcd!.x + lcd!.width).toBeLessThanOrEqual(keypad!.x);
    expect(keypad!.y).toBeGreaterThan(lcd!.y);
    expect(keypad!.width).toBeGreaterThan(200);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(1024);
  });

  test('expansion unit: song list beside the part map and audio routing', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await setup(page);
    await dropFiles(page, [song('a.mid', 3), song('b.mid', 4)]);

    const [songs, partMap, routing] = await Promise.all(
      ['playlist-panel', 'instruments-panel', 'routing-panel'].map((id) =>
        page.getByTestId(id).boundingBox(),
      ),
    );

    // Song list on the left (≈ 60%), part map + routing stacked on the right.
    expect(songs!.x + songs!.width).toBeLessThan(partMap!.x);
    expect(Math.abs(routing!.x - partMap!.x)).toBeLessThan(1);
    expect(routing!.y).toBeGreaterThan(partMap!.y + partMap!.height / 2);
  });

  test('a populated playlist fits a 360 px viewport without horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await setup(page);
    await dropFiles(page, [
      song('a-very-long-song-name-that-should-wrap.mid', 3),
      song('b.mid', 4),
    ]);
    await expect(page.getByTestId('playlist-row')).toHaveCount(2);
    expect(await rowNumbers(page)).toEqual(['1', '2']);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
  });

  test('stacks in one column below 960 px without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await setup(page);

    const [monitor, lcd, keypad, songs, partMap] = await Promise.all(
      ['monitor-panel', 'playback-panel', 'keypad', 'playlist-panel', 'instruments-panel'].map(
        (id) => page.getByTestId(id).boundingBox(),
      ),
    );
    for (const box of [lcd, keypad, songs, partMap]) expect(box!.x).toBe(monitor!.x);
    expect(lcd!.y).toBeGreaterThan(monitor!.y + monitor!.height / 2);
    expect(keypad!.y).toBeGreaterThan(lcd!.y + lcd!.height / 2);
    expect(songs!.y).toBeGreaterThan(keypad!.y);
    expect(partMap!.y).toBeGreaterThan(songs!.y + songs!.height / 2);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(900);

    // Keyboard access is not lost in the narrow layout: the Quick start
    // disclosure is the first Tab stop, with unit 1 after it.
    await page.reload();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('quickstart-toggle')).toBeFocused();
  });
});

test.describe('T8 — timeline seeking', () => {
  test('commits on release, restores the MIDI state and leaves no hanging notes', async ({
    page,
  }) => {
    await setup(page);
    // A program change, volume and pan at the top, then a 20 s note.
    await dropFiles(page, [
      song('long.mid', 20, [0x00, 0xc0, 5, 0x00, 0xb0, 7, 100, 0x00, 0xb0, 10, 64]),
    ]);
    const timeline = page.getByTestId('timeline');
    await expect(timeline).toHaveAttribute('aria-disabled', 'true');

    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
    await expect(timeline).toHaveAttribute('aria-disabled', 'false');
    await page.waitForTimeout(300);

    // Drag to the middle: the display previews, but nothing is committed until release.
    await clearSent(page);
    const box = (await timeline.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, y, { steps: 5 });
    await expect(page.getByTestId('time-display')).toContainText(/0:(09|10)\./);
    expect((await sent(page)).length).toBe(0);
    await page.mouse.up();

    await expect.poll(() => ariaNow(page)).toBeGreaterThan(8);
    const position = await ariaNow(page);
    expect(position).toBeLessThanOrEqual(13);
    await expect(page.getByTestId('time-display')).toContainText('/ 0:20');

    // The old note is released (note-off + sustain off) and the state at the
    // target is re-sent; the song keeps playing rather than stopping.
    await expect.poll(async () => (await sent(page)).length).toBeGreaterThan(0);
    const messages = (await sent(page)).map((m) => m.bytes);
    expect(messages).toContainEqual([0x80, 60, 0]);
    expect(messages).toContainEqual([0xb0, 0x40, 0]);
    expect(messages).toContainEqual([0xc0, 5]);
    expect(messages).toContainEqual([0xb0, 7, 100]);
    expect(messages).toContainEqual([0xb0, 10, 64]);
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
  });

  test('seeks while paused, stays paused and resumes from the target', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('long.mid', 20)]);
    const timeline = page.getByTestId('timeline');

    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
    await page.waitForTimeout(300);
    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Paused');

    await clearSent(page);
    await seekToFraction(page, 0.5);
    await expect(page.getByTestId('playback-state')).toHaveText('Paused');
    const pausedAt = await ariaNow(page);
    expect(pausedAt).toBeGreaterThan(8);
    // Seeking while paused plays no notes.
    expect((await sent(page)).some((m) => m.bytes[0] === 0x90)).toBe(false);

    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
    await expect.poll(() => ariaNow(page)).toBeGreaterThan(8);
    await expect(page.getByTestId('time-display')).toContainText('/ 0:20');
  });

  test('keyboard Home/End/Page/arrows seek when the timeline has focus', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('long.mid', 20)]);
    const timeline = page.getByTestId('timeline');

    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
    await page.waitForTimeout(200);
    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Paused');

    await timeline.focus();
    await page.keyboard.press('End');
    expect(await ariaNow(page)).toBe(20);
    await page.keyboard.press('Home');
    expect(await ariaNow(page)).toBe(0);
    await page.keyboard.press('PageUp');
    expect(await ariaNow(page)).toBe(10);
    await page.keyboard.press('ArrowRight');
    expect(await ariaNow(page)).toBe(11);
    await page.keyboard.press('ArrowLeft');
    expect(await ariaNow(page)).toBe(10);
    // The arrows seeked the timeline, not the playlist.
    await expect(page.getByTestId('playback-state')).toHaveText('Paused');
    await expect(page.getByTestId('current-title')).toHaveText('long');
  });

  test('is disabled while stopped and seeks only while playing or paused', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid', 10)]);
    const timeline = page.getByTestId('timeline');

    await expect(timeline).toHaveAttribute('aria-disabled', 'true');
    await expect(timeline).toHaveAttribute('tabindex', '-1');

    await page.getByTestId('play-button').click();
    await expect(timeline).toHaveAttribute('aria-disabled', 'false');
    await expect(timeline).toHaveAttribute('tabindex', '0');

    await page.getByTestId('stop-button').click();
    await expect(timeline).toHaveAttribute('aria-disabled', 'true');
    // The elapsed display is back at the start.
    await expect(page.getByTestId('time-display')).toHaveText('0:00.0 / 0:10');
  });
});

test.describe('T8 — Panic before switching tracks', () => {
  test('sends the full Panic after the old tail and starts the new track after it', async ({
    page,
  }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid', 10), song('b.mid', 10)]);
    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
    await page.waitForTimeout(300);
    expect((await sent(page)).some((m) => m.bytes[0] === 0x90)).toBe(true);

    await clearSent(page);
    await page.getByTestId('next-button').click();
    await expect(page.getByTestId('current-title')).toHaveText('b');

    await expect
      .poll(async () => (await sent(page)).some((m) => m.bytes[0] === 0x90))
      .toBe(true);
    const messages = await sent(page);
    const panic = messages.filter(
      (m) => m.bytes[0] >= 0xb0 && m.bytes[0] <= 0xbf && m.bytes[1] === 123,
    );
    expect(panic).toHaveLength(16);
    const lastPanic = panic[panic.length - 1];
    const newNote = messages.find((m) => m.bytes[0] === 0x90);
    expect(newNote).toBeDefined();
    // The new song's first note must be timestamped after the Panic.
    expect(newNote!.timestamp!).toBeGreaterThan(lastPanic.timestamp!);
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
  });
});

test.describe('T8 — startup mute policy', () => {
  test('a fresh profile starts muted; later visits restore the saved mute state', async ({
    page,
  }) => {
    await setup(page);
    const mute = page.getByTestId('mute-button');
    // First visit, no stored audio settings: muted (feedback safety, R10).
    await expect(mute).toHaveAttribute('aria-pressed', 'true');

    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'false');

    await page.reload();
    // A later visit restores the saved setting instead of forcing mute.
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('connect-button').click();
    await expect(page.getByTestId('status-region')).toContainText('Microphone access granted');
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
  });
});
