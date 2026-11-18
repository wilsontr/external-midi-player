import { test, expect, type Page } from '@playwright/test';
import { mockDevices } from './mocks';

const JUNO = { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' };

/**
 * Format-0 SMF at 480 PPQ / 120 BPM (960 ticks per second): raw channel
 * setup bytes at tick 0, then one note held for `seconds`.
 */
function midiFile(seconds: number, setup: number[] = []): number[] {
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
    60,
    100,
    ...vlq(ticks),
    0x80,
    60,
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

const program = (channel: number, value: number): number[] => [0x00, 0xc0 | channel, value];

/** Programs on channels 1, 2 and 10 (the GM drum channel). */
const layered = (name: string, seconds = 60): TestFile => ({
  name,
  bytes: midiFile(seconds, [
    ...program(0, 0),
    ...program(1, 40),
    ...program(9, 0),
  ]),
});

/** A different instrument layout, so a track switch is visible in the card. */
const bassAndStrings = (name: string, seconds = 60): TestFile => ({
  name,
  bytes: midiFile(seconds, [...program(0, 33), ...program(2, 33), ...program(3, 48)]),
});

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

const instrumentsPanel = (page: Page) => page.getByTestId('instruments-panel');
const instrumentRows = (page: Page) => page.getByTestId('instrument-row');

test.describe('T9 — instruments card', () => {
  test('shows the playing file’s channels and instruments, and clears on stop', async ({
    page,
  }) => {
    await setup(page);
    await dropFiles(page, [layered('layered.mid')]);

    const panel = instrumentsPanel(page);
    await expect(panel).toHaveAccessibleName('Instruments');
    await expect(page.getByTestId('instruments-empty')).toHaveText(
      'Play a song to see its MIDI channels and instruments.',
    );
    await expect(page.getByTestId('instrument-list')).toBeHidden();
    await expect(page.getByTestId('instruments-caption')).toBeHidden();

    await page.getByTestId('play-button').click();
    await expect(instrumentRows(page)).toHaveCount(3);
    await expect(page.getByTestId('instruments-caption')).toHaveText('layered');

    const rows = instrumentRows(page);
    await expect(rows.nth(0)).toContainText('Channel 1');
    await expect(rows.nth(0)).toContainText('Acoustic Grand Piano · program 1');
    await expect(rows.nth(1)).toContainText('Channel 2');
    await expect(rows.nth(1)).toContainText('Violin · program 41');
    await expect(rows.nth(2)).toContainText('Channel 10');
    await expect(rows.nth(2)).toContainText('Drums · kit 1');

    // Pausing keeps the current song described.
    await page.getByTestId('play-button').click();
    await expect(instrumentRows(page)).toHaveCount(3);

    // Stop clears it, because no file is playing.
    await page.getByTestId('stop-button').click();
    await expect(page.getByTestId('instrument-list')).toBeHidden();
    await expect(page.getByTestId('instruments-empty')).toHaveText(
      'Play a song to see its MIDI channels and instruments.',
    );
  });

  test('follows the playing file when the track changes', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [layered('first.mid'), bassAndStrings('second.mid')]);
    await page.getByTestId('play-button').click();
    await expect(instrumentRows(page)).toHaveCount(3);
    await expect(instrumentRows(page).nth(0)).toContainText('Acoustic Grand Piano');

    await page.getByTestId('next-button').click();
    await expect(instrumentRows(page)).toHaveCount(3);
    await expect(page.getByTestId('instruments-caption')).toHaveText('second');
    await expect(instrumentRows(page).nth(0)).toContainText('Channel 1');
    await expect(instrumentRows(page).nth(0)).toContainText('Electric Bass (finger) · program 34');
    await expect(instrumentRows(page).nth(1)).toContainText('Channel 3');
    await expect(instrumentRows(page).nth(2)).toContainText('Channel 4');
    await expect(instrumentRows(page).nth(2)).toContainText('String Ensemble 1 · program 49');
  });

  test('does not change while the song plays or pauses', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [layered('static.mid')]);
    await page.getByTestId('play-button').click();
    await expect(instrumentRows(page)).toHaveCount(3);

    const panel = instrumentsPanel(page);
    const before = await panel.innerHTML();
    await page.waitForTimeout(500);
    expect(await panel.innerHTML()).toBe(before);

    await page.getByTestId('play-button').click(); // pause
    expect(await panel.innerHTML()).toBe(before);
    expect(await panel.locator('[aria-current]').count()).toBe(0);
  });

  test('the part map sits beside the song list in the expansion unit', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await setup(page);
    await dropFiles(
      page,
      Array.from({ length: 10 }, (_, i) => layered(`set-${i + 1}.mid`)),
    );
    await page.getByTestId('play-button').click();
    await expect(instrumentRows(page)).toHaveCount(3);

    const [songs, partMap, routing] = await Promise.all(
      ['playlist-panel', 'instruments-panel', 'routing-panel'].map((id) =>
        page.getByTestId(id).boundingBox(),
      ),
    );

    // Song list on the left, part map above audio routing on the right; a long
    // playlist no longer stretches the part map across a shared grid row.
    expect(partMap!.x).toBeGreaterThan(songs!.x + songs!.width);
    expect(Math.abs(routing!.x - partMap!.x)).toBeLessThan(1);
    expect(routing!.y).toBeGreaterThan(partMap!.y + partMap!.height / 2);
    await expect(instrumentsPanel(page)).toBeVisible();

    await page.setViewportSize({ width: 360, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(instrumentsPanel(page)).toBeVisible();
    await expect(instrumentRows(page).nth(1)).toContainText('Violin');
  });
});
