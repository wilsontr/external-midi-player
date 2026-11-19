import { test, expect, type Page } from '@playwright/test';
import { mockDevices } from './mocks';

const JUNO = { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' };
const SAMPLE = "Debussy - Poissons d'or";

const rows = (page: Page) => page.getByTestId('playlist-row');
const status = (page: Page) => page.getByTestId('status-region');

/** Waits for the seeded row: the fetch and the seed are async. */
async function waitForSample(page: Page): Promise<void> {
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId('entry-name')).toHaveText(SAMPLE);
}

/**
 * Counts real asset downloads (the dev server also requests a `?import&url`
 * module wrapper, which is not the file).
 */
function trackSampleRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('debussy-poissons-dor') && url.search === '') {
      urls.push(request.url());
    }
  });
  return urls;
}

/**
 * Captures the Blob handed to the download link, so the saved M3U can be read
 * without touching the filesystem.
 */
async function captureSavedBlob(page: Page): Promise<void> {
  await page.evaluate(() => {
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      (window as unknown as { __saved?: Blob }).__saved = object as Blob;
      return original(object);
    };
  });
}

const savedText = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const blob = (window as unknown as { __saved?: Blob }).__saved;
    return blob ? blob.text() : '';
  });

/** Smallest playable SMF: one note held for a second at 120 BPM. */
function midiFile(): number[] {
  const vlq = (n: number): number[] => {
    const out = [n & 0x7f];
    while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
    return out;
  };
  const track = [
    0x00, 0x90, 60, 100,
    ...vlq(960),
    0x80, 60, 0, 0x00, 0xff, 0x2f, 0x00,
  ];
  const u32 = (n: number) => [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
  ];
  return [
    ...[0x4d, 0x54, 0x68, 0x64], ...u32(6), 0, 0, 0, 1, 0x01, 0xe0,
    ...[0x4d, 0x54, 0x72, 0x6b], ...u32(track.length), ...track,
  ];
}

async function dropFile(page: Page, name = 'mine.mid'): Promise<void> {
  const bytes = midiFile();
  await page.evaluate(
    ({ fileName, data }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(data)], fileName));
      document.querySelector('[data-testid="drop-zone"]')!.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    },
    { fileName: name, data: bytes },
  );
}

test.describe('T12 — first-run sample song', () => {
  test('a never-written store starts with the sample, current and stopped', async ({
    page,
  }) => {
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');
    await waitForSample(page);

    // The row is current (it plays next) and its duration fills in from the
    // ordinary background parse.
    await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('entry-duration')).toHaveText('3:19');
    await expect(page.getByTestId('playback-state')).toHaveAttribute(
      'data-state',
      'stopped',
    );
    // Success is silent: the startup status line is untouched.
    await expect(status(page)).toHaveText('Devices not connected');
    expect(await page.evaluate(() => localStorage.getItem('external-midi-player.playlist'))).toContain(
      'Debussy - Poissons d\'or',
    );
  });

  test('the sample plays, shows its channels and is saved like any other row', async ({
    page,
  }) => {
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');
    await waitForSample(page);
    await page.getByTestId('connect-button').click();
    await page.getByTestId('output-picker').selectOption('o1');

    await page.getByTestId('play-button').click();
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as any).__mockMidi.sent.length as number,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    await expect(page.getByTestId('playback-state')).toHaveAttribute(
      'data-state',
      'playing',
    );

    // Channels 2 and 3 of the file (1-based). Both carry an explicit program
    // change (program 1, Acoustic Grand Piano) in this file, so neither is on
    // the implicit default — the default path is covered by the unit tests.
    const cards = page.getByTestId('instrument-row');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText('Channel 2');
    await expect(cards.nth(0)).toContainText('Acoustic Grand Piano · program 1');
    await expect(cards.nth(1)).toContainText('Channel 3');
    await expect(cards.nth(1)).toContainText('Acoustic Grand Piano · program 1');
    await expect(cards.nth(1)).not.toContainText('(default)');

    // Save playlist exports it like any other entry.
    await captureSavedBlob(page);
    const download = page.waitForEvent('download');
    await page.getByTestId('save-playlist-button').click();
    await download;
    expect(await savedText(page)).toContain(
      "#EXTINF:199,Debussy - Poissons d'or",
    );
  });

  test('a reload restores it from storage without fetching the asset again', async ({
    page,
  }) => {
    const requests = trackSampleRequests(page);
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');
    await waitForSample(page);
    expect(requests).toHaveLength(1);

    await page.reload();
    await waitForSample(page);
    await expect(page.getByTestId('entry-duration')).toHaveText('3:19');
    expect(requests).toHaveLength(1);
  });

  test('Clear playlist is sticky, and so is removing the row', async ({ page }) => {
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');
    await waitForSample(page);

    await page.getByTestId('clear-playlist-button').click();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId('playlist-empty')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('external-midi-player.playlist')),
      )
      .toContain('"entries":[]');

    await page.reload();
    await expect(page.getByTestId('playlist-empty')).toBeVisible();
    await expect(rows(page)).toHaveCount(0);

    // Removing the row persists an empty list too.
    await page.evaluate(() =>
      localStorage.removeItem('external-midi-player.playlist'),
    );
    await page.reload();
    await waitForSample(page);
    await page
      .getByTestId('playlist-row')
      .getByRole('button', { name: /Remove/ })
      .click();
    await expect(rows(page)).toHaveCount(0);
    // The write is debounced by a tick; let it land before reloading.
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('external-midi-player.playlist')),
      )
      .toContain('"entries":[]');
    await page.reload();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId('playlist-empty')).toBeVisible();
  });

  test('files added while the asset is still loading win', async ({ page }) => {
    // Hold the real asset request so the user can act first.
    await page.route(
      /debussy-poissons-dor[^?]*\.mid$/,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
      },
    );
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');
    await dropFile(page);
    await expect(rows(page)).toHaveCount(1);

    // The seed's fetch resolves after this; it must not insert a second row.
    await page.waitForTimeout(2000);
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId('entry-name')).toHaveText('mine');
    await expect(status(page)).toContainText('Added 1 file');
  });

  test('a missing asset reports one line and leaves the app usable', async ({
    page,
  }) => {
    await page.route(/debussy-poissons-dor[^?]*\.mid$/, (route) =>
      route.fulfill({ status: 404, body: '' }),
    );
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');

    await expect(status(page)).toHaveText(
      'Could not load the sample song — add files to start.',
    );
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId('playlist-empty')).toBeVisible();

    // Everything else still works.
    await page.getByTestId('connect-button').click();
    await expect(page.getByTestId('output-picker')).toContainText('Juno-106');
    await dropFile(page);
    await expect(rows(page)).toHaveCount(1);
  });

  test('at 360 px the long sample name truncates instead of overflowing', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 720 });
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');
    await waitForSample(page);

    const name = page.getByTestId('entry-name').first();
    const { scrollWidth, clientWidth } = await name.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    // Ellipsised: the text is wider than the box it is allowed to use.
    expect(scrollWidth).toBeGreaterThan(clientWidth);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    // The empty state still fits.
    await page.getByTestId('clear-playlist-button').click();
    await expect(page.getByTestId('playlist-empty')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
  });
});
