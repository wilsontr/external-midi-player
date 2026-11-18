import { test, expect, type Page } from '@playwright/test';
import { mockDevices } from './mocks';

const JUNO = { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' };

/** Format-0 SMF at 480 PPQ / 120 BPM (960 ticks per second) with one note. */
function midiFile(seconds: number, note = 60): number[] {
  const ticks = Math.round(seconds * 960);
  const vlq = (n: number): number[] => {
    const out = [n & 0x7f];
    while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
    return out;
  };
  const track = [0x00, 0x90, note, 100, ...vlq(ticks), 0x80, note, 0, 0x00, 0xff, 0x2f, 0x00];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return [
    ...[0x4d, 0x54, 0x68, 0x64], ...u32(6), 0, 0, 0, 1, 0x01, 0xe0,
    ...[0x4d, 0x54, 0x72, 0x6b], ...u32(track.length), ...track,
  ];
}

interface TestFile {
  name: string;
  bytes: number[];
}

const song = (name: string, seconds = 5): TestFile => ({ name, bytes: midiFile(seconds) });
const playlistFile = (name: string, text: string): TestFile => ({
  name,
  bytes: Array.from(new TextEncoder().encode(text)),
});

/** Node's Buffer is read off `globalThis` so this file needs no @types/node. */
const nodeBuffer = (
  globalThis as unknown as { Buffer: { from(data: Uint8Array | string): unknown } }
).Buffer;

async function setup(page: Page): Promise<void> {
  await mockDevices(page, { outputs: [JUNO] });
  await page.goto('/');
  await page.getByTestId('connect-button').click();
  await page.getByTestId('output-picker').selectOption('o1');
}

async function dropFiles(page: Page, files: TestFile[]): Promise<void> {
  await page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name));
    const panel = document.querySelector('[data-testid="drop-zone"]')!;
    panel.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}

/** Picks a playlist plus MIDI files through the hidden Load playlist input. */
async function pickPlaylistFiles(page: Page, files: TestFile[]): Promise<void> {
  await page.getByTestId('playlist-file-input').setInputFiles(
    files.map((f) => ({
      name: f.name,
      mimeType: f.name.toLowerCase().endsWith('.mid') || f.name.toLowerCase().endsWith('.midi')
        ? 'audio/midi'
        : 'audio/x-mpegurl',
      buffer: nodeBuffer.from(new Uint8Array(f.bytes)) as never,
    })),
  );
}

const rowNames = (page: Page) => page.getByTestId('entry-name').allTextContents();
const storedPlaylist = (page: Page) =>
  page.evaluate(() => localStorage.getItem('external-midi-player.playlist') ?? '');

/**
 * Captures the Blob passed to the download link, so the saved M3U text can be
 * asserted without reading a file from Node (and its types).
 */
async function captureSavedBlob(page: Page): Promise<void> {
  await page.evaluate(() => {
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      (window as unknown as { __savedPlaylistBlob?: Blob }).__savedPlaylistBlob =
        object as Blob;
      return original(object);
    };
  });
}

const savedText = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const blob = (window as unknown as { __savedPlaylistBlob?: Blob }).__savedPlaylistBlob;
    return blob ? blob.text() : '';
  });

test.describe('T10 — M3U playlist saving and loading', () => {
  test('Save is disabled when empty and downloads the order and durations as M3U8', async ({
    page,
  }) => {
    await setup(page);
    const save = page.getByTestId('save-playlist-button');
    await expect(save).toBeDisabled();

    await dropFiles(page, [song('a.mid', 5), song('b.mid', 7)]);
    await expect(page.getByTestId('entry-duration')).toHaveText(['0:05', '0:07']);
    await expect(save).toBeEnabled();

    await captureSavedBlob(page);
    const downloadPromise = page.waitForEvent('download');
    await save.click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('midi-playlist.m3u8');
    expect(await savedText(page)).toBe(
      '#EXTM3U\n' +
        '#EXTINF:5,a\n' +
        'a.mid\n' +
        '#EXTINF:7,b\n' +
        'b.mid\n',
    );
    await expect(page.getByTestId('status-region')).toContainText('Saved 2 entries');
  });

  test('Load replaces the playlist in M3U order, stops playback and survives a reload', async ({
    page,
  }) => {
    await setup(page);
    await dropFiles(page, [song('old.mid', 3)]);
    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');

    await pickPlaylistFiles(page, [
      playlistFile(
        'list.m3u8',
        '#EXTM3U\n#EXTINF:7,b\nb.mid\n#EXTINF:5,a\na.mid\n',
      ),
      song('a.mid', 5),
      song('b.mid', 7),
    ]);

    const rows = page.getByTestId('playlist-row');
    await expect(rows).toHaveCount(2);
    expect(await rowNames(page)).toEqual(['b', 'a']);
    await expect(page.getByTestId('entry-number')).toHaveText(['1', '2']);
    await expect(page.getByTestId('entry-duration')).toHaveText(['0:07', '0:05']);
    await expect(page.getByTestId('playback-state')).toHaveText('Nothing playing.');
    await expect(rows.first()).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('current-title')).toHaveText('b');
    await expect(page.getByTestId('status-region')).toContainText('Loaded 2 of 2 entries');
    await expect(page.getByTestId('status-region')).toContainText('playlist replaced');

    await expect.poll(() => storedPlaylist(page)).toContain('"fileName":"b.mid"');
    await page.reload();
    await page.getByTestId('connect-button').click();

    await expect(page.getByTestId('playlist-row')).toHaveCount(2);
    expect(await rowNames(page)).toEqual(['b', 'a']);
    await expect(page.getByTestId('entry-duration')).toHaveText(['0:07', '0:05']);
    await expect(page.getByTestId('playlist-row').first()).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test('reports missing, unsupported and extra files, and loads the matched subset', async ({
    page,
  }) => {
    await setup(page);
    await dropFiles(page, [song('keep.mid', 3)]);
    await expect(page.getByTestId('playlist-row')).toHaveCount(1);

    await pickPlaylistFiles(page, [
      playlistFile(
        'list.m3u',
        '#EXTM3U\n#EXTINF:5,a\na.mid\nmissing.mid\nhttps://example.com/remote.mid\nnotes.txt\n',
      ),
      song('a.mid', 5),
      song('extra.mid', 2),
    ]);

    await expect(page.getByTestId('playlist-row')).toHaveCount(1);
    expect(await rowNames(page)).toEqual(['a']);
    await expect(page.getByTestId('entry-duration')).toHaveText('0:05');

    const status = page.getByTestId('status-region');
    await expect(status).toContainText('Loaded 1 of 2 entries');
    await expect(status).toContainText('Not found in the selection or playlist: missing.mid');
    await expect(status).toContainText('Skipped unsupported');
    await expect(status).toContainText('https://example.com/remote.mid');
    await expect(status).toContainText('notes.txt');
    await expect(status).toContainText('Ignored 1 selected file not in the playlist: extra.mid');
  });

  test('loads a saved playlist using the files already in the playlist', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid', 5), song('b.mid', 7), song('c.mid', 9)]);
    await expect(page.getByTestId('entry-duration')).toHaveText(['0:05', '0:07', '0:09']);

    // Select only the playlist; its files are already loaded, so no second
    // selection should be required.
    await pickPlaylistFiles(page, [
      playlistFile(
        'midi-playlist.m3u8',
        '#EXTM3U\n#EXTINF:9,c\nc.mid\n#EXTINF:5,a\na.mid\n',
      ),
    ]);

    const rows = page.getByTestId('playlist-row');
    await expect(rows).toHaveCount(2);
    expect(await rowNames(page)).toEqual(['c', 'a']);
    await expect(page.getByTestId('entry-duration')).toHaveText(['0:09', '0:05']);
    await expect(rows.first()).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('status-region')).toContainText('Loaded 2 of 2 entries');
    await expect(page.getByTestId('status-region')).toContainText(
      'Used 2 files already in the playlist',
    );
    await expect(page.getByTestId('status-region')).not.toContainText('without its MIDI files');
    await expect(page.getByTestId('status-region')).not.toContainText('Playlist unchanged');
  });

  test('an unmatched playlist leaves the playlist unchanged', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('keep.mid', 4)]);
    await expect(page.getByTestId('playlist-row')).toHaveCount(1);

    await pickPlaylistFiles(page, [
      playlistFile('list.m3u', '#EXTM3U\ngone.mid\n'),
      song('other.mid', 2),
    ]);

    await expect(page.getByTestId('status-region')).toContainText(
      'No files from list.m3u matched the selection or the current playlist',
    );
    await expect(page.getByTestId('status-region')).toContainText('gone.mid');
    await expect(page.getByTestId('status-region')).toContainText('Playlist unchanged');
    await expect(page.getByTestId('playlist-row')).toHaveCount(1);
    expect(await rowNames(page)).toEqual(['keep']);
    await expect(page.getByTestId('playlist-row')).toHaveAttribute('aria-current', 'true');
  });

  test('a playlist selected on an empty playlist asks for its MIDI files', async ({ page }) => {
    await setup(page);

    await pickPlaylistFiles(page, [playlistFile('list.m3u', '#EXTM3U\na.mid\n')]);

    const status = page.getByTestId('status-region');
    await expect(status).toContainText('list.m3u was selected without its MIDI files');
    await expect(status).toContainText('Not found in the selection or playlist: a.mid');
    await expect(status).toContainText('Select the playlist together with its .mid files');
    await expect(status).toContainText('Playlist unchanged');
    await expect(page.getByTestId('playlist-row')).toHaveCount(0);
  });

  test('dropping a playlist with files loads it; dropping MIDI files still appends', async ({
    page,
  }) => {
    await setup(page);
    await dropFiles(page, [
      playlistFile('dropped.m3u', '#EXTM3U\nb.mid\na.mid\n'),
      song('a.mid', 5),
      song('b.mid', 7),
    ]);

    await expect(page.getByTestId('playlist-row')).toHaveCount(2);
    expect(await rowNames(page)).toEqual(['b', 'a']);
    await expect(page.getByTestId('entry-duration')).toHaveText(['0:07', '0:05']);

    await dropFiles(page, [song('c.mid', 9)]);
    expect(await rowNames(page)).toEqual(['b', 'a', 'c']);
    await expect(page.getByTestId('status-region')).toContainText('Added 1 file');
  });
  test('the playlist file controls fit 360 px and are keyboard reachable', async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await dropFiles(page, [song('a.mid', 5)]);

    const save = page.getByTestId('save-playlist-button');
    const load = page.getByTestId('load-playlist-button');
    await expect(save).toBeVisible();
    await expect(load).toBeVisible();
    await save.focus();
    await expect(save).toBeFocused();
    await load.focus();
    await expect(load).toBeFocused();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
  });
});
