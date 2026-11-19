import { test, expect, type Page } from '@playwright/test';
import { blankPlaylist, mockDevices } from './mocks';

/**
 * T21 — live per-channel note activity in the 16-part strip.
 *
 * The fixture is a format-0 SMF at 480 PPQ / 120 BPM (960 ticks per second):
 *
 * - channel 1: program 1 at 0; note 60 held 0.0–4.0 s; note 62 held 5.0–7.0 s
 * - channel 2: note 64 held 2.2–3.0 s
 * - channel 4: program 41 only (never lights)
 * - channel 10: a ~10 ms drum hit at 1.0 s
 */
const JUNO = { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' };

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  let value = n;
  while ((value >>= 7) > 0) out.unshift((value & 0x7f) | 0x80);
  return out;
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function smf(track: number[]): number[] {
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

/** Builds a track from absolute-tick messages (stable for equal ticks). */
function track(messages: Array<[number, number[]]>): number[] {
  const out: number[] = [];
  let last = 0;
  for (const [tick, bytes] of messages) {
    out.push(...vlq(tick - last), ...bytes);
    last = tick;
  }
  out.push(0x00, 0xff, 0x2f, 0x00);
  return out;
}

const s = (seconds: number) => Math.round(seconds * 960);

const activityFile = (): number[] =>
  smf(
    track([
      [0, [0xc0, 0]],
      [0, [0xc3, 40]],
      [0, [0x90, 60, 100]],
      [s(1), [0x99, 36, 110]],
      [s(1) + 10, [0x89, 36, 0]],
      [s(2.2), [0x91, 64, 90]],
      [s(3), [0x81, 64, 0]],
      [s(4), [0x80, 60, 0]],
      [s(5), [0x90, 62, 100]],
      [s(7), [0x80, 62, 0]],
    ]),
  );

async function setup(page: Page): Promise<void> {
  await blankPlaylist(page);
  await mockDevices(page, { outputs: [JUNO] });
  await page.goto('/');
  await page.getByTestId('connect-button').click();
  await page.getByTestId('output-picker').selectOption('o1');
  await page.evaluate((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'activity.mid'));
    const panel = document.querySelector('[data-testid="drop-zone"]')!;
    panel.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, activityFile());
  // Record every channel that is ever lit, so a 120 ms flash cannot be missed
  // between Playwright polls.
  await page.evaluate(() => {
    const seen = new Set<string>();
    (window as unknown as { __activeSeen: Set<string> }).__activeSeen = seen;
    new MutationObserver((records) => {
      for (const record of records) {
        const cell = record.target as HTMLElement;
        if (cell.dataset.active === 'true') seen.add(cell.dataset.channel!);
      }
    }).observe(document.querySelector('[data-testid="part-strip"]')!, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-active'],
    });
  });
}

const cell = (page: Page, channel: number) =>
  page.locator(`[data-testid="part-cell"][data-channel="${channel}"]`);

const activeCells = (page: Page) =>
  page
    .locator('[data-testid="part-cell"][data-active="true"]')
    .evaluateAll((cells) => cells.map((c) => Number(c.getAttribute('data-channel'))));

const seenChannels = (page: Page) =>
  page.evaluate(() =>
    [...(window as unknown as { __activeSeen: Set<string> }).__activeSeen].map(Number).sort((a, b) => a - b),
  );

/** WCAG contrast ratio of two computed `rgb()` colours. */
function contrastRatio(a: string, b: string): number {
  const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const resetSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __activeSeen: Set<string> }).__activeSeen.clear());

test.describe('T21 — live channel note activity', () => {
  test('lights the sounding channels, flashes a short drum hit and clears on pause and stop', async ({
    page,
  }) => {
    await setup(page);
    await expect(page.getByTestId('part-cell')).toHaveCount(16);
    expect(await activeCells(page)).toEqual([]);

    await page.getByTestId('play-button').click();
    await expect(cell(page, 1)).toHaveAttribute('data-active', 'true', { timeout: 3000 });
    await expect(cell(page, 1)).toHaveAttribute('aria-label', 'Channel 1, playing');
    await expect(cell(page, 4)).toHaveAttribute('data-used', 'true');
    await expect(cell(page, 4)).toHaveAttribute('aria-label', 'Channel 4, used by this song');

    // Active is a filled cell, distinct from the outlined used cell and idle
    // cell without relying on hue, with LCD ink contrast.
    const styles = await page.evaluate(() =>
      [1, 4, 5].map((channel) => {
        const el = document.querySelector(`[data-testid="part-cell"][data-channel="${channel}"]`)!;
        const cs = getComputedStyle(el);
        return { color: cs.color, background: cs.backgroundColor, shadow: cs.boxShadow };
      }),
    );
    const [active, used, idle] = styles;
    expect(active.background).not.toBe(used.background);
    expect(used.background).toBe(idle.background);
    expect(used.shadow).not.toBe(idle.shadow);
    expect(contrastRatio(active.color, active.background)).toBeGreaterThanOrEqual(4.5);

    // The ~10 ms hit on channel 10 is held visible, and channel 2 lights at 2.2 s.
    await expect.poll(() => seenChannels(page), { timeout: 5000 }).toEqual([1, 2, 10]);
    await expect(cell(page, 10)).toHaveAttribute('data-active', 'false');
    await expect(cell(page, 10)).toHaveAttribute('aria-label', 'Channel 10, used by this song');
    // Channel 2's note ends at 3 s, channel 1's at 4 s; channel 1 relights at 5 s.
    await expect(cell(page, 2)).toHaveAttribute('data-active', 'false', { timeout: 3000 });
    await expect(cell(page, 1)).toHaveAttribute('data-active', 'false', { timeout: 3000 });
    await expect(cell(page, 1)).toHaveAttribute('data-active', 'true', { timeout: 3000 });

    // Pause darkens at once; resume starts dark, since the held note began
    // before the resume point and is not re-struck.
    await page.getByTestId('play-button').click();
    expect(await activeCells(page)).toEqual([]);
    await resetSeen(page);
    await page.getByTestId('play-button').click();
    await page.waitForTimeout(500);
    expect(await seenChannels(page)).toEqual([]);

    // Stop clears; the program-only channel never lit.
    await page.getByTestId('stop-button').click();
    expect(await activeCells(page)).toEqual([]);
    await expect(cell(page, 1)).toHaveAttribute('aria-label', 'Channel 1');
    expect(await seenChannels(page)).not.toContain(4);
  });

  test('a seek leaves notes begun before the target dark and lights later ones', async ({
    page,
  }) => {
    await setup(page);
    await page.getByTestId('play-button').click();
    await expect(cell(page, 1)).toHaveAttribute('data-active', 'true', { timeout: 3000 });

    // Paused seek into channel 1's held note (0–4 s): stays dark.
    await page.getByTestId('play-button').click(); // pause
    const timeline = page.getByTestId('timeline');
    await timeline.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight'); // 2.0 s
    expect(await activeCells(page)).toEqual([]);

    // Resume at 2.0 s: channel 2's 2.2 s note lights, channel 1 stays dark.
    await resetSeen(page);
    await page.getByTestId('play-button').click();
    await expect(cell(page, 2)).toHaveAttribute('data-active', 'true', { timeout: 3000 });
    expect(await activeCells(page)).toEqual([2]);
    expect(await seenChannels(page)).toEqual([2]);

    // Backward seek while playing: the note at 0 s is at the target and lights.
    await timeline.focus();
    await page.keyboard.press('Home');
    await expect(cell(page, 1)).toHaveAttribute('data-active', 'true', { timeout: 3000 });
    expect(await activeCells(page)).toEqual([1]);

    // Forward seek to 3 s, inside channel 1's held note: dark at once and
    // until the next note-on at 5 s.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await activeCells(page)).toEqual([]);
    await resetSeen(page);
    await page.waitForTimeout(600);
    expect(await seenChannels(page)).toEqual([]);
    await expect(cell(page, 1)).toHaveAttribute('data-active', 'true', { timeout: 4000 });
  });

  test('keeps updating under prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setup(page);
    await page.getByTestId('play-button').click();
    await expect(cell(page, 1)).toHaveAttribute('data-active', 'true', { timeout: 3000 });
    await expect.poll(() => seenChannels(page), { timeout: 5000 }).toEqual([1, 2, 10]);
  });
});
