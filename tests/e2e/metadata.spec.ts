import { test, expect, type Page } from '@playwright/test';
import { blankPlaylist, mockDevices } from './mocks';

const JUNO = { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' };
const STORAGE_KEY = 'external-midi-player.playlist';

/** Node's Buffer is read off `globalThis` so this file needs no @types/node. */
const nodeBuffer = (
  globalThis as unknown as { Buffer: { from(data: Uint8Array): unknown } }
).Buffer;

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  let value = n;
  while ((value >>= 7) > 0) out.unshift((value & 0x7f) | 0x80);
  return out;
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (text: string): number[] =>
  Array.from(text, (char) => char.charCodeAt(0) & 0xff);

/** A meta event at the current position (delta 0). */
function meta(type: number, data: number[]): number[] {
  return [0x00, 0xff, type, ...vlq(data.length), ...data];
}

/** One held note, so the file has a duration and can be played. */
function notes(seconds = 8, channel = 0): number[] {
  const ticks = Math.round(seconds * 960);
  return [
    0x00,
    0x90 | channel,
    60,
    100,
    ...vlq(ticks),
    0x80 | channel,
    60,
    0,
  ];
}

/** Format-1 SMF at 480 PPQ / 120 BPM; every track gets an end-of-track. */
function smf(tracks: number[][]): number[] {
  const chunks: number[] = [];
  for (const track of tracks) {
    const body = [...track, 0x00, 0xff, 0x2f, 0x00];
    chunks.push(
      0x4d,
      0x54,
      0x72,
      0x6b, // MTrk
      ...u32(body.length),
      ...body,
    );
  }
  return [
    0x4d,
    0x54,
    0x68,
    0x64, // MThd
    ...u32(6),
    0,
    1,
    (tracks.length >> 8) & 255,
    tracks.length & 255,
    0x01,
    0xe0,
    ...chunks,
  ];
}

interface TestFile {
  name: string;
  bytes: number[];
}

/** Track 0 carries a Shift_JIS title, a copyright and a Text Event. */
function japaneseFile(): TestFile {
  // "Battle Garegga " + Shift_JIS 並木学.
  const title = [...ascii('Battle Garegga '), 0x95, 0xc0, 0x96, 0xd8, 0x8a, 0x77];
  return {
    name: 'bgaregga1.mid',
    bytes: smf([
      [
        ...meta(0x03, title),
        ...meta(0x02, ascii('(C)RAIZING')),
        ...meta(0x01, ascii('@DRUID:\t\tjh696my0069')),
        ...meta(0x01, ascii('@ROLL_TYPE:\t\twelte-red')),
      ],
      notes(8, 0),
    ]),
  };
}

const titleOfJapaneseFile = 'Battle Garegga 並木学';

async function setup(page: Page): Promise<void> {
  await blankPlaylist(page);
  await mockDevices(page, { outputs: [JUNO] });
  await page.goto('/');
  await page.getByTestId('connect-button').click();
  await page.getByTestId('output-picker').selectOption('o1');
}

async function addFiles(page: Page, files: TestFile[]): Promise<void> {
  await page.getByTestId('file-input').setInputFiles(
    files.map((file) => ({
      name: file.name,
      mimeType: 'audio/midi',
      buffer: nodeBuffer.from(new Uint8Array(file.bytes)) as never,
    })),
  );
}

const row = (page: Page, index = 0) => page.getByTestId('playlist-row').nth(index);
const rowName = (page: Page, index = 0) => page.getByTestId('entry-name').nth(index);
const metadataButton = (page: Page, index = 0) =>
  row(page, index).getByTestId('metadata-button');
const dialog = (page: Page) => page.getByTestId('metadata-dialog');

test.describe('T20 — track metadata titles and viewer', () => {
  test('shows the decoded Track Name and lists all three metadata fields', async ({ page }) => {
    await setup(page);
    await addFiles(page, [japaneseFile()]);

    await expect(rowName(page)).toHaveText(titleOfJapaneseFile);
    await expect(page.getByTestId('current-title')).toHaveText(titleOfJapaneseFile);
    await expect(row(page)).toHaveAttribute('aria-current', 'true');

    await metadataButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute('aria-labelledby', 'metadata-title');
    await expect(page.locator('#metadata-title')).toHaveText(titleOfJapaneseFile);
    await expect(page.getByTestId('metadata-filename')).toHaveText('bgaregga1.mid');

    const trackNames = page.getByTestId('metadata-track-names');
    await expect(trackNames).toContainText('Track 1');
    await expect(trackNames).toContainText(titleOfJapaneseFile);
    await expect(page.getByTestId('metadata-text-events')).toContainText(
      '@DRUID:\t\tjh696my0069',
    );
    await expect(page.getByTestId('metadata-text-events')).toContainText(
      '@ROLL_TYPE:\t\twelte-red',
    );
    await expect(page.getByTestId('metadata-copyrights')).toContainText('(C)RAIZING');
    await expect(page.getByTestId('metadata-empty-text-events')).toBeHidden();
    const columnGap = await page
      .getByTestId('metadata-track-names')
      .locator('li')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).columnGap));
    expect(columnGap).toBeGreaterThanOrEqual(24);

    await page.getByTestId('metadata-close').click();
    await expect(dialog(page)).toBeHidden();
    await expect(metadataButton(page)).toBeFocused();
  });

  test('uses only the first track\'s name and otherwise keeps the filename', async ({
    page,
  }) => {
    await setup(page);
    await addFiles(page, [
      {
        name: 'green-brinstar.mid',
        bytes: smf([
          [...meta(0x03, ascii('untitled'))],
          [...meta(0x03, ascii('Voice 2'))],
          notes(8, 0),
        ]),
      },
      {
        name: 'sonic-2.mid',
        bytes: smf([
          notes(8, 0),
          [...meta(0x03, ascii('Chemical Plant'))],
        ]),
      },
    ]);

    await expect(rowName(page, 0)).toHaveText('green-brinstar');
    // Track 1 has no Track Name, so the later "Chemical Plant" is ignored.
    await expect(rowName(page, 1)).toHaveText('sonic-2');

    // The viewer still shows the literal "untitled" value; only the title falls back.
    await metadataButton(page, 0).click();
    await expect(page.getByTestId('metadata-track-names')).toContainText('untitled');
    await expect(page.getByTestId('metadata-track-names')).toContainText('Voice 2');
    await expect(page.getByTestId('metadata-empty-copyrights')).toBeVisible();
    await page.getByTestId('metadata-close').click();
    await expect(dialog(page)).toBeHidden();
  });

  test('Escape closes the viewer without panicking and leaves playback running', async ({
    page,
  }) => {
    await setup(page);
    await addFiles(page, [japaneseFile()]);
    await expect(rowName(page)).toHaveText(titleOfJapaneseFile);

    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveAttribute('data-state', 'playing');

    await metadataButton(page).click();
    await expect(dialog(page)).toBeVisible();
    // Opening the viewer must not pause the transport.
    await expect(page.getByTestId('playback-state')).toHaveAttribute('data-state', 'playing');

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(metadataButton(page)).toBeFocused();
    await expect(page.getByTestId('status-region')).not.toContainText('Panic');
    await expect(page.getByTestId('playback-state')).toHaveAttribute('data-state', 'playing');
    const sent = await page.evaluate(() =>
      (window as unknown as { __mockMidi: { sent: Array<{ bytes: number[] }> } }).__mockMidi.sent.map(
        (message) => message.bytes,
      ),
    );
    expect(sent.some((bytes) => bytes[0] === 0xfb)).toBe(false);
  });

  test('the backdrop closes the viewer and transport shortcuts stay inert while it is open', async ({
    page,
  }) => {
    await setup(page);
    await addFiles(page, [japaneseFile()]);
    await expect(rowName(page)).toHaveText(titleOfJapaneseFile);
    const current = await page.getByTestId('current-title').textContent();

    await metadataButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId('current-title')).toHaveText(current!);
    await expect(page.getByTestId('playback-state')).toHaveAttribute('data-state', 'stopped');

    await page.mouse.click(5, 5);
    await expect(dialog(page)).toBeHidden();
    await expect(metadataButton(page)).toBeFocused();
  });

  test('renders Text Events as text, never as HTML', async ({ page }) => {
    await setup(page);
    await addFiles(page, [
      {
        name: 'literal.mid',
        bytes: smf([
          [...meta(0x03, ascii('Literal Test'))],
          [...meta(0x01, ascii('<img src=x onerror="window.__pwned=1">'))],
          notes(8),
        ]),
      },
    ]);
    await expect(rowName(page)).toHaveText('Literal Test');
    await metadataButton(page).click();
    await expect(page.getByTestId('metadata-text-events')).toContainText(
      '<img src=x onerror="window.__pwned=1">',
    );
    await expect(dialog(page).locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
  });

  test('persists the title and metadata across a reload', async ({ page }) => {
    await setup(page);
    await addFiles(page, [japaneseFile()]);
    await expect(rowName(page)).toHaveText(titleOfJapaneseFile);

    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          if (raw === null) return null;
          const payload = JSON.parse(raw) as {
            entries?: Array<{ metadata?: { title?: string | null } }>;
          };
          return payload.entries?.[0]?.metadata?.title ?? null;
        }, STORAGE_KEY),
      )
      .toBe(titleOfJapaneseFile);

    await page.reload();
    await expect(rowName(page)).toHaveText(titleOfJapaneseFile);
    await metadataButton(page).click();
    await expect(page.getByTestId('metadata-text-events')).toContainText(
      '@DRUID:\t\tjh696my0069',
    );
    await page.getByTestId('metadata-close').click();
  });

  test('writes the Track Name to EXTINF but keeps the file name as the M3U path', async ({
    page,
  }) => {
    await setup(page);
    await addFiles(page, [japaneseFile()]);
    await expect(rowName(page)).toHaveText(titleOfJapaneseFile);

    await page.evaluate(() => {
      const original = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (object: Blob | MediaSource) => {
        (window as unknown as { __savedPlaylistBlob?: Blob }).__savedPlaylistBlob =
          object as Blob;
        return original(object);
      };
    });
    await page.getByTestId('save-playlist-button').click();
    const text = await page.evaluate(async () => {
      const blob = (window as unknown as { __savedPlaylistBlob?: Blob })
        .__savedPlaylistBlob;
      return blob ? blob.text() : '';
    });
    expect(text).toContain(`#EXTINF:8,${titleOfJapaneseFile}`);
    expect(text).toContain('\nbgaregga1.mid\n');
  });

  test('fits the LCD viewer at 360 px without horizontal page scroll', async ({ page }) => {
    await setup(page);
    const longTitle =
      'A Very Long Track Name That Must Wrap At Three Hundred And Sixty Pixels Without Overflowing';
    const manyTextEvents = Array.from({ length: 24 }, (_, index) =>
      meta(0x01, ascii(`Line ${index + 1}: ${'x'.repeat(72)}`)),
    );
    await addFiles(page, [
      {
        name: 'wide.mid',
        bytes: smf([
          [...meta(0x03, ascii(longTitle)), ...manyTextEvents.flat()],
          notes(8),
        ]),
      },
    ]);
    await expect(rowName(page)).toHaveText(longTitle);

    await page.setViewportSize({ width: 360, height: 800 });
    await metadataButton(page).click();
    await expect(dialog(page)).toBeVisible();
    const titleMetrics = await page.getByTestId('current-title').evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        clamp: Number.parseInt(style.webkitLineClamp, 10),
        height: el.clientHeight,
        lineHeight: Number.parseFloat(style.lineHeight),
      };
    });
    expect(titleMetrics.clamp).toBe(2);
    expect(titleMetrics.height).toBeLessThanOrEqual(titleMetrics.lineHeight * 2 + 1);

    const box = await dialog(page).boundingBox();
    expect(box).not.toBeNull();
    const narrowGap = await page
      .getByTestId('metadata-track-names')
      .locator('li')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).columnGap));
    expect(narrowGap).toBeGreaterThanOrEqual(18);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360.5);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page.getByTestId('metadata-close').click();
  });
});

test.describe('T22 — faceplate and Info panel polish', () => {
  test('the Info key opens the playing song\'s metadata and is a no-op when stopped', async ({
    page,
  }) => {
    await setup(page);
    await addFiles(page, [japaneseFile()]);
    await expect(rowName(page)).toHaveText(titleOfJapaneseFile);

    const info = page.getByTestId('info-button');
    await expect(info).toHaveText('Info');
    // Nothing playing: the key does nothing.
    await info.click();
    await expect(dialog(page)).toBeHidden();

    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveAttribute('data-state', 'playing');
    await info.click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('#metadata-title')).toHaveText(titleOfJapaneseFile);
    await expect(page.getByTestId('metadata-filename')).toHaveText('bgaregga1.mid');
    await page.getByTestId('metadata-close').click();
    await expect(dialog(page)).toBeHidden();

    // Paused still counts as the current song.
    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('playback-state')).toHaveAttribute('data-state', 'paused');
    await info.click();
    await expect(dialog(page)).toBeVisible();
    await page.getByTestId('metadata-close').click();

    await page.getByTestId('stop-button').click();
    await info.click();
    await expect(dialog(page)).toBeHidden();
  });

  test('the Info key sits right of Connect devices, flush with Panic', async ({ page }) => {
    await setup(page);
    const [info, panic, connect] = await Promise.all([
      page.getByTestId('info-button').boundingBox(),
      page.getByTestId('panic-button').boundingBox(),
      page.getByTestId('connect-button').boundingBox(),
    ]);
    expect(Math.abs(info!.x + info!.width - (panic!.x + panic!.width))).toBeLessThan(1);
    expect(info!.x).toBeGreaterThan(connect!.x + connect!.width);
    expect(Math.abs(info!.y - connect!.y)).toBeLessThan(1);
  });

  test('the status line stays on one line and ellipsizes long messages', async ({ page }) => {
    await setup(page);
    const status = page.getByTestId('status-region');
    await expect(status).toHaveText('Connected. Microphone access granted.');
    const style = await status.evaluate((el) => {
      const cs = getComputedStyle(el);
      return [cs.whiteSpace, cs.textOverflow, cs.overflow];
    });
    expect(style).toEqual(['nowrap', 'ellipsis', 'hidden']);

    const long = Array.from({ length: 12 }, (_, i) => `not-a-midi-file-${i}.txt`);
    await page.getByTestId('file-input').setInputFiles(
      long.map((name) => ({
        name,
        mimeType: 'text/plain',
        buffer: nodeBuffer.from(new Uint8Array([1])) as never,
      })),
    );
    await expect(status).toContainText('Rejected 12 files');
    await expect(status).toHaveAttribute('title', /not-a-midi-file-11\.txt/);
    const { lineHeight, height, clipped } = await status.evaluate((el) => ({
      lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      height: el.getBoundingClientRect().height,
      clipped: el.scrollWidth > el.clientWidth,
    }));
    expect(clipped).toBe(true);
    expect(height).toBeLessThan(lineHeight * 1.5);
  });

  test('the Info panel credits the player and links to GitHub', async ({ page }) => {
    await setup(page);
    await expect(page.locator('#quickstart-heading')).toHaveText('Info');
    await expect(page.getByTestId('quickstart-toggle')).toHaveText('Hide info');

    const credit = page.getByTestId('player-credit');
    await expect(credit).toHaveText('Player by Trevor Wilson');
    const lcdCredit = page.locator('.font-credit', { hasText: 'LCD font' });
    expect((await credit.boundingBox())!.y).toBeLessThan((await lcdCredit.boundingBox())!.y);

    const shortcutsSize = await page
      .getByTestId('quickstart-shortcuts')
      .evaluate((el) => getComputedStyle(el).fontSize);
    const howToSize = await page.getByTestId('how-to').evaluate((el) => getComputedStyle(el).fontSize);
    expect(shortcutsSize).toBe(howToSize);

    const github = page.getByTestId('github-link');
    await expect(github).toHaveAttribute('href', 'https://github.com/wilsontr/external-midi-player');
    await expect(github).toHaveAccessibleName('Source on GitHub');
    const [link, panel] = await Promise.all([
      github.boundingBox(),
      page.getByTestId('quickstart').boundingBox(),
    ]);
    // Lower-right corner of the panel.
    expect(link!.x + link!.width).toBeGreaterThan(panel!.x + panel!.width - 40);
    expect(link!.y + link!.height).toBeGreaterThan(panel!.y + panel!.height - 40);
  });
});
