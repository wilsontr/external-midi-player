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
    0x00, 0x90, 60, 100,
    ...vlq(ticks), 0x80, 60, 0,
    0x00, 0xff, 0x2f, 0x00,
  ];
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

const program = (channel: number, value: number): number[] => [0x00, 0xc0 | channel, value];

/** Programs on channels 1, 2 and 10, so the part strip has three lit cells. */
const layered = (name: string, seconds = 60): TestFile => ({
  name,
  bytes: midiFile(seconds, [...program(0, 0), ...program(1, 40), ...program(9, 0)]),
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

/** The knob's rendered rotation in degrees, read off its computed transform. */
async function knobAngle(page: Page): Promise<number> {
  return page.evaluate(() => {
    const knob = document.querySelector('[data-testid="volume-knob"]')!;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(knob).transform);
    return Math.round((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI);
  });
}

const instrumentRows = (page: Page) => page.getByTestId('instrument-row');
const litParts = (page: Page) =>
  page
    .locator('[data-testid="part-cell"][data-used="true"]')
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('data-channel')));

function rgbChannels(value: string): number[] {
  return (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
}

/** WCAG relative-luminance contrast ratio for two rgb() triples. */
function contrastRatio(a: string, b: string): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgb: number[]): number =>
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const [hi, lo] = [luminance(rgbChannels(a)), luminance(rgbChannels(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test.describe('T11 — half-rack faceplate', () => {
  test('the volume knob turns with the range input and with arrow keys', async ({ page }) => {
    await setup(page);
    const slider = page.getByTestId('volume-slider');
    await expect(slider).toBeVisible();

    await slider.fill('100');
    await expect.poll(() => knobAngle(page)).toBe(135);

    await slider.fill('0');
    await expect.poll(() => knobAngle(page)).toBe(-135);

    await slider.focus();
    await page.keyboard.press('ArrowRight');
    expect(await knobAngle(page)).toBeGreaterThan(-135);
    await expect(page.getByTestId('volume-text')).toHaveText('1%');
  });

  test('the mute key is latching and its red LED follows aria-pressed', async ({ page }) => {
    await setup(page);
    const mute = page.getByTestId('mute-button');
    const led = page.getByTestId('mute-led');

    // A fresh profile starts muted (T8 policy), so the LED is lit.
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    await expect(led).toHaveAttribute('data-lit', 'true');

    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
    await expect(led).toHaveAttribute('data-lit', 'false');

    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    await expect(led).toHaveAttribute('data-lit', 'true');
  });

  test('the clip LED replaces the CLIP text and lights on a hot peak', async ({ page }) => {
    await setup(page);
    await page.getByTestId('audio-input-picker').selectOption('in1');

    const clip = page.getByTestId('clip-indicator');
    await expect(clip).toBeHidden();
    // It is the red top segment of the left ladder, not a CLIP text badge.
    expect(
      await clip.evaluate((led) => led.closest('.ladder')?.getAttribute('data-testid')),
    ).toBe('meter-left');
    await expect(page.getByTestId('monitor-panel')).not.toContainText('CLIP');

    await page.evaluate(() => ((window as any).__mockAudio.level = [0.95, 0.1]));
    await expect(clip).toBeVisible();
  });

  test('the part strip marks exactly the Instruments channels and clears on stop', async ({
    page,
  }) => {
    await setup(page);
    await dropFiles(page, [layered('layered.mid')]);
    await page.getByTestId('play-button').click();
    await expect(instrumentRows(page)).toHaveCount(3);

    const rowChannels = await instrumentRows(page).evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-channel')),
    );
    expect((await litParts(page)).sort()).toEqual([...rowChannels].sort());
    expect(await page.getByTestId('part-cell').count()).toBe(16);

    // Static: the strip changes only when the playing song changes.
    const stripBefore = await page.getByTestId('part-strip').innerHTML();
    await page.waitForTimeout(700);
    expect(await page.getByTestId('part-strip').innerHTML()).toBe(stripBefore);

    await page.getByTestId('stop-button').click();
    await expect.poll(() => litParts(page)).toEqual([]);
  });

  test('the play key LED is green while playing and amber while paused', async ({ page }) => {
    await setup(page);
    await dropFiles(page, [layered('layered.mid')]);
    const play = page.getByTestId('play-button');
    const led = page.getByTestId('play-led');
    const ledColor = (): Promise<string> =>
      led.evaluate((el) => getComputedStyle(el).backgroundColor);

    await play.click();
    await expect(page.getByTestId('playback-state')).toHaveText('Playing');
    await expect(led).toHaveAttribute('data-state', 'playing');
    expect(rgbChannels(await ledColor())).toEqual([77, 224, 122]);

    await play.click(); // pause
    await expect(page.getByTestId('playback-state')).toHaveText('Paused');
    await expect(led).toHaveAttribute('data-state', 'paused');
    expect(rgbChannels(await ledColor())).toEqual([255, 176, 0]);

    await page.getByTestId('stop-button').click();
    await expect(led).toHaveAttribute('data-state', 'stopped');
    expect(rgbChannels(await ledColor())).toEqual([32, 35, 41]);
  });

  test('silk labels use Helvetica Neue and the LCDs use the self-hosted pixel font', async ({
    page,
  }) => {
    await setup(page);

    const silk = await page
      .getByTestId('monitor-panel')
      .locator('.silk-label')
      .first()
      .evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          family: style.fontFamily,
          size: parseFloat(style.fontSize),
          transform: style.textTransform,
          spacing: style.letterSpacing,
          weight: style.fontWeight,
        };
      });
    expect(silk.family).toMatch(/^"?Helvetica Neue"?, Helvetica, Arial, sans-serif$/);
    expect(silk.size).toBeGreaterThanOrEqual(11);
    expect(silk.transform).toBe('uppercase');
    // Every Helvetica Neue faceplate style is regular weight and untracked
    // (`letter-spacing: 0` computes to `normal` in Chromium).
    expect(silk.spacing === 'normal' || parseFloat(silk.spacing) === 0).toBe(true);
    expect(Number(silk.weight)).toBe(400);

    const lcd = await page.getByTestId('current-title').evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        family: style.fontFamily,
        size: parseFloat(style.fontSize),
        synthesis: style.fontSynthesis,
      };
    });
    expect(lcd.family).toMatch(/^"?Graph 35 Pix"?, "?Courier New"?, monospace$/);
    expect(lcd.size % 8).toBe(0);
    expect(lcd.synthesis).toBe('none');

    const loaded = await page.evaluate(() =>
      document.fonts.ready.then(() => document.fonts.check('16px "Graph 35 Pix"')),
    );
    expect(loaded).toBe(true);
  });

  test('keeps one aria-live region, on the playback LCD bottom line', async ({ page }) => {
    await setup(page);
    await expect(page.locator('[aria-live]')).toHaveCount(1);
    await expect(page.getByTestId('status-region')).toHaveAttribute('aria-live', 'polite');

    const [lcd, status] = await Promise.all([
      page.getByTestId('playback-panel').locator('.lcd-main').boundingBox(),
      page.getByTestId('status-region').boundingBox(),
    ]);
    expect(status!.y).toBeGreaterThan(lcd!.y + lcd!.height / 2);
    expect(status!.y + status!.height).toBeLessThanOrEqual(lcd!.y + lcd!.height + 1);
  });

  test('LCD ink meets 4.5:1 on the LCD background', async ({ page }) => {
    await setup(page);
    const [ink, background] = await page.getByTestId('current-title').evaluate((el) => [
      getComputedStyle(el).color,
      getComputedStyle(el.closest('.lcd')!).backgroundColor,
    ]);
    expect(contrastRatio(ink, background)).toBeGreaterThanOrEqual(4.5);
  });

  test('monitor controls share a centre line and transport keys sit level', async ({ page }) => {
    await setup(page);

    const centres = await Promise.all(
      ['[data-testid="volume-knob"]', '[data-testid="mute-button"]', '.meter'].map((selector) =>
        page.locator(selector).evaluate((el) => {
          const box = el.getBoundingClientRect();
          return box.left + box.width / 2;
        }),
      ),
    );
    // Mute is centred under the knob and over the LED ladders.
    for (const centre of centres) expect(Math.abs(centre - centres[0]!)).toBeLessThan(1);

    const boxes = await page
      .locator('[data-testid="keypad"] .key-cell > button')
      .evaluateAll((buttons) =>
        buttons.map((el) => {
          const box = el.getBoundingClientRect();
          return { top: box.top, bottom: box.top + box.height };
        }),
      );
    expect(boxes).toHaveLength(5);
    // The play key's LED occupies the space above it, so it no longer pushes
    // that key down: all four first-row buttons share a top and bottom edge.
    for (const index of [0, 2, 3]) {
      expect(boxes[1]!.top).toBeCloseTo(boxes[index]!.top, 0);
      expect(boxes[1]!.bottom).toBeCloseTo(boxes[index]!.bottom, 0);
    }

    const [led, play] = await Promise.all([
      page.getByTestId('play-led').boundingBox(),
      page.getByTestId('play-button').boundingBox(),
    ]);
    expect(led!.y + led!.height).toBeLessThanOrEqual(play!.y);
  });

  test('dropping anywhere on the expansion unit still adds files', async ({ page }) => {
    await setup(page);
    await page.evaluate((files) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name));
      const target = document.querySelector('[data-testid="routing-panel"]')!;
      target.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    }, [layered('dropped.mid', 5)]);

    await expect(page.getByTestId('playlist-row')).toHaveCount(1);
    await expect(page.getByTestId('entry-name')).toHaveText('dropped');
  });
});
