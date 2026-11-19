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

async function setup(page: Page): Promise<void> {
  await mockDevices(page, { outputs: [JUNO] });
  await page.goto('/');
  await page.getByTestId('connect-button').click();
  await page.getByTestId('output-picker').selectOption('o1');
}

/** Simulates dropping files on the playlist panel, in the given order. */
async function dropFiles(page: Page, files: TestFile[]): Promise<void> {
  await page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name));
    const panel = document.querySelector('[data-testid="drop-zone"]')!;
    panel.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}

const rowNames = (page: Page) => page.getByTestId('entry-name').allTextContents();
const sent = (page: Page) =>
  page.evaluate(() => (window as any).__mockMidi.sent as Array<{ bytes: number[] }>);
const clearSent = (page: Page) => page.evaluate(() => ((window as any).__mockMidi.sent.length = 0));

test.describe('T3 — transport and playlist', () => {
  test('10 files dropped at once all appear in drop order with durations (R1, R3)', async ({
    page,
  }) => {
    await setup(page);
    const files = Array.from({ length: 10 }, (_, i) => song(`song-${i + 1}.mid`, i + 1));
    await dropFiles(page, files);

    await expect(page.getByTestId('playlist-row')).toHaveCount(10);
    expect(await rowNames(page)).toEqual(files.map((f) => f.name.replace('.mid', '')));
    // The entry that plays next is highlighted as soon as files are added.
    await expect(page.getByTestId('playlist-row').first()).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('entry-duration').first()).toHaveText('0:01');
    await expect(page.getByTestId('entry-duration').last()).toHaveText('0:10');
  });

  test('rejects non-MIDI files with a status message', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [{ name: 'notes.txt', bytes: [1, 2, 3] }, song('ok.mid')]);

    await expect(page.getByTestId('playlist-row')).toHaveCount(1);
    await expect(page.getByTestId('status-region')).toContainText('Added 1 file.');
    await expect(page.getByTestId('status-region')).toContainText('notes.txt');
  });

  test('a corrupt file shows an error row and is skipped (R3)', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid', 0.3), { name: 'bad.mid', bytes: [1, 2, 3, 4] }, song('c.mid', 0.3)]);

    const rows = page.getByTestId('playlist-row');
    await expect(rows.nth(1)).toHaveAttribute('data-status', 'error');
    await expect(rows.nth(1).getByTestId('entry-status')).toHaveText('ERR');
    await expect(rows.nth(1).getByTestId('entry-status')).toHaveAttribute(
      'title',
      /Error:/,
    );
    // Healthy rows have no status text at all.
    await expect(rows.nth(0).getByTestId('entry-status')).toBeHidden();

    await page.getByTestId('play-button').click();
    await expect(rows.nth(2)).toHaveAttribute('aria-current', 'true', { timeout: 5000 });
  });

  test('reorders by drag and removes per row (R2)', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid'), song('b.mid'), song('c.mid')]);
    await expect(page.getByTestId('playlist-row')).toHaveCount(3);

    const rows = page.getByTestId('playlist-row');
    // HTML5 drag simulation needs both rows on screen; the page is taller than
    // the viewport, so scroll the panel into view first.
    await page.getByTestId('playlist-panel').scrollIntoViewIfNeeded();
    await rows.nth(0).dragTo(rows.nth(2), { targetPosition: { x: 20, y: 25 } });
    expect(await rowNames(page)).toEqual(['b', 'c', 'a']);
    // Dragging must not fall through to the row's click-to-select.
    await expect(page.getByTestId('playback-state')).toHaveText('Nothing playing.');

    await page.getByRole('button', { name: 'Remove c', exact: true }).click();
    expect(await rowNames(page)).toEqual(['b', 'a']);
    await expect(page.getByTestId('playback-state')).toHaveText('Nothing playing.');
  });

  test('Add files button accepts files from the picker', async ({ page }) => {
    await setup(page);
    await page.evaluate((bytes) => {
      const dt = new DataTransfer();
      for (const name of ['x.mid', 'y.midi']) dt.items.add(new File([new Uint8Array(bytes)], name));
      const input = document.querySelector<HTMLInputElement>('[data-testid="file-input"]')!;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, midiFile(2));
    expect(await rowNames(page)).toEqual(['x', 'y']);
  });

  test('pause releases every sounding note and sustain, and resume does not re-strike (R6)', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid', 10)]);
    await expect(page.getByTestId('entry-duration')).toHaveText('0:10');

    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
    await expect.poll(async () => (await sent(page)).length).toBeGreaterThan(0);

    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Paused');
    const messages = (await sent(page)).map((m) => m.bytes);
    expect(messages).toContainEqual([0x80, 60, 0]);
    expect(messages).toContainEqual([0xb0, 0x40, 0]);

    // Resume must not re-strike the held note.
    await clearSent(page);
    await page.getByTestId('play-button').click();
    await page.waitForTimeout(300);
    expect((await sent(page)).map((m) => m.bytes)).not.toContainEqual([0x90, 60, 100]);

  });

  test('stop releases every sounding note and sustain (R6)', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid', 10)]);
    await page.getByTestId('play-button').click();
    await expect.poll(async () => (await sent(page)).length).toBeGreaterThan(0);

    await clearSent(page);
    await page.getByTestId('stop-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Nothing playing.');
    const messages = (await sent(page)).map((m) => m.bytes);
    expect(messages).toContainEqual([0x80, 60, 0]);
    expect(messages).toContainEqual([0xb0, 0x40, 0]);
  });

  test('auto-advances to the next song and returns to stopped after the last (R7)', async ({
    page,
  }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid', 0.4), song('b.mid', 0.4)]);
    await expect(page.getByTestId('entry-duration').last()).toHaveText('0:00');

    await page.getByTestId('play-button').click();
    const rows = page.getByTestId('playlist-row');
    await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true', { timeout: 5000 });
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
    await expect(page.getByTestId('playback-state')).toHaveText('Nothing playing.', {
      timeout: 8000,
    });
    const strikes = (await sent(page)).filter((m) => m.bytes[0] === 0x90);
    expect(strikes).toHaveLength(2);
  });

  test('a single click selects a row without playing; double-click plays it', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid'), song('b.mid'), song('c.mid')]);
    const rows = page.getByTestId('playlist-row');
    await expect(rows).toHaveCount(3);

    await page.getByTestId('entry-name').nth(1).click();
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('current-title')).toHaveText('b');
    await expect(page.getByTestId('playback-state')).toHaveText('Nothing playing.');
    expect((await sent(page)).some((m) => m.bytes[0] === 0x90)).toBe(false);

    await page.getByTestId('entry-name').nth(1).dblclick();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-selected', 'true');

    await page.getByTestId('next-button').click();
    await expect(rows.nth(2)).toHaveAttribute('aria-current', 'true');
    await page.getByTestId('previous-button').click();
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');

    // While b is playing, a single click selects c but leaves the playing
    // entry, the title and the transport alone. The selection marker is the
    // dotted outline; the playing row keeps only its highlight.
    await page.getByTestId('entry-name').nth(2).click();
    await expect(rows.nth(2)).toHaveAttribute('data-selected', 'true');
    await expect(rows.nth(2)).not.toHaveAttribute('aria-current', 'true');
    expect(
      await rows.nth(2).evaluate((row) => getComputedStyle(row).outlineStyle),
    ).toBe('dashed');
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(rows.nth(1)).not.toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('current-title')).toHaveText('b');
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');

    // Double-click moves playback to the selected row: now it is both, so the
    // dotted selection outline sits over the playing highlight.
    await page.getByTestId('entry-name').nth(2).dblclick();
    await expect(rows.nth(2)).toHaveAttribute('aria-current', 'true');
    await expect(rows.nth(2)).toHaveAttribute('data-selected', 'true');
    expect(
      await rows.nth(2).evaluate((row) => getComputedStyle(row).outlineStyle),
    ).toBe('dashed');
    await expect(page.getByTestId('current-title')).toHaveText('c');
  });

  test('starting a song clears the Panic status line', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid')]);
    await expect(page.getByTestId('playlist-row')).toHaveCount(1);

    await page.getByTestId('panic-button').click();
    await expect(page.getByTestId('status-region')).toContainText('Panic: all notes off');

    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
    await expect(page.getByTestId('status-region')).toHaveText('');
  });

  test('runs the scheduler tick in a dedicated Worker', async ({ page }) => {
    const workers: string[] = [];
    page.on('worker', (worker) => workers.push(worker.url()));

    await setup(page);
    await dropFiles(page, [song('a.mid', 4)]);
    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');

    await expect.poll(() => workers.length).toBeGreaterThan(0);
    expect(workers.some((url) => url.includes('tickWorker'))).toBe(true);
  });

  test('progress and elapsed time update at least 10 times per second (R12)', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('long.mid', 20)]);
    await expect(page.getByTestId('entry-duration')).toHaveText('0:20');
    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
    await page.bringToFront();
    await page.waitForTimeout(500);

    const startText = await page.getByTestId('time-display').textContent();

    /*
     * The elapsed readout only changes 10 times a second (its finest unit is
     * 0.1 s), so counting its mutations sits exactly on the R12 threshold and
     * flakes on one dropped tick. The timeline fill is redrawn on every 50 ms
     * progress update, so measure that rate over 1.5 s and divide by the real
     * elapsed time; a 1 Hz or paused loop still fails, while ordinary CI
     * scheduling jitter no longer does.
     */
    const { updates, seconds } = await page.evaluate(
      () =>
        new Promise<{ updates: number; seconds: number }>((resolve) => {
          const fill = document.querySelector('[data-testid="timeline-fill"]') as HTMLElement;
          let updates = 0;
          let lastWidth = fill.style.width;
          const observer = new MutationObserver(() => {
            if (fill.style.width !== lastWidth) {
              lastWidth = fill.style.width;
              updates += 1;
            }
          });
          observer.observe(fill, { attributes: true, attributeFilter: ['style'] });
          const started = performance.now();
          setTimeout(() => {
            observer.disconnect();
            resolve({ updates, seconds: (performance.now() - started) / 1000 });
          }, 1500);
        }),
    );

    expect(updates / seconds).toBeGreaterThanOrEqual(10);
    // The elapsed readout advanced during the sample and still knows the total.
    expect(await page.getByTestId('time-display').textContent()).not.toBe(startText);
    await expect(page.getByTestId('time-display')).toContainText('/ 0:20');
  });

  test('keyboard: Space toggles play/pause, arrows skip, Esc panics', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid'), song('b.mid')]);
    await expect(page.getByTestId('playlist-row')).toHaveCount(2);
    await page.locator('body').click({ position: { x: 1, y: 1 } });

    await page.keyboard.press('Space');
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('playback-state')).toHaveText('Paused');

    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('current-title')).toHaveText('b');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('current-title')).toHaveText('a');

    await clearSent(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('playback-state')).toHaveText('Nothing playing.');
    const panic = (await sent(page)).filter((m) => m.bytes[0] >= 0xb0 && m.bytes[1] === 123);
    expect(panic).toHaveLength(16);
  });

  test('unplugging the output during playback stops the transport', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid', 10)]);
    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');

    await page.evaluate(() => (window as any).__mockMidi.removeOutput('o1'));

    await expect(page.getByTestId('playback-state')).toHaveText('Nothing playing.');
    await expect(page.getByTestId('status-region')).toContainText('disconnected');
  });

  test('the playlist and current entry survive a reload', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [song('a.mid', 5), song('b.mid', 7), song('c.mid', 9)]);
    await expect(page.getByTestId('entry-duration')).toHaveText(['0:05', '0:07', '0:09']);

    await page.getByTestId('entry-name').nth(1).click();
    await expect(page.getByTestId('playlist-row').nth(1)).toHaveAttribute('aria-current', 'true');
    await page.getByTestId('stop-button').click();

    // Saves are debounced and encode the file bytes; wait for the stored state.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('external-midi-player.playlist') ?? ''))
      .toContain('"durationSec":7');

    await page.reload();
    await page.getByTestId('connect-button').click();

    const rows = page.getByTestId('playlist-row');
    await expect(rows).toHaveCount(3);
    await expect(page.getByTestId('entry-name')).toHaveText(['a', 'b', 'c']);
    await expect(page.getByTestId('entry-duration')).toHaveText(['0:05', '0:07', '0:09']);
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('current-title')).toHaveText('b');
    await expect(page.getByTestId('playback-state')).toHaveText('Nothing playing.');
  });
});
