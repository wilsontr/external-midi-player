import { test, expect, type Page } from '@playwright/test';
import { mockDevices } from './mocks';

const JUNO = { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' };

/** Full-range pointer travel, mirroring KNOB_TRAVEL_PX in `ui.ts`. */
const TRAVEL_PX = 120;

const volumeSlider = (page: Page) => page.getByTestId('volume-slider');
const volumeText = (page: Page) => page.getByTestId('volume-text');
const knob = (page: Page) => page.getByTestId('volume-knob');

async function setup(page: Page): Promise<void> {
  await mockDevices(page, { outputs: [JUNO] });
  await page.goto('/');
  await page.getByTestId('connect-button').click();
}

/** Sets the level the way the keyboard/AT path does, so a drag starts known. */
async function setVolume(page: Page, percent: number): Promise<void> {
  await volumeSlider(page).fill(String(percent));
  await expect(volumeText(page)).toHaveText(`${percent}%`);
}

/**
 * The knob's centre in whole pixels. Every pointer delta is then an exact
 * integer, so the expected percentages do not depend on how the browser
 * rounds a fractional `clientY`.
 */
async function knobCentre(page: Page): Promise<{ x: number; y: number }> {
  await knob(page).scrollIntoViewIfNeeded();
  const box = await knob(page).boundingBox();
  if (!box) throw new Error('the volume knob is not laid out');
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
}

/** The knob's rendered rotation in degrees, read off its computed transform. */
async function knobAngle(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="volume-knob"]')!;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return Math.round((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI);
  });
}

/**
 * Presses on the knob and glides the pointer `dyPx` (negative = up), then
 * releases. Every distance is a multiple of the 10 steps, so each intermediate
 * pointer position is also a whole pixel.
 */
async function dragKnob(
  page: Page,
  dyPx: number,
  { shift = false }: { shift?: boolean } = {},
): Promise<void> {
  expect(Math.abs(dyPx) % 10).toBe(0);
  const { x, y } = await knobCentre(page);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dyPx, { steps: 10 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

test.describe('T19 — Ableton-style volume knob drag', () => {
  test('the level follows the vertical delta from the press, not the pointer', async ({
    page,
  }) => {
    await setup(page);
    await setVolume(page, 50);

    // Pressing low on the knob must not snap the level to the pointer
    // position: a native range drag would jump to ~20% here.
    const { x, y } = await knobCentre(page);
    await page.mouse.move(x, y + 25);
    await page.mouse.down();
    await expect(volumeText(page)).toHaveText('50%');
    await page.mouse.up();

    // Up increases: 30 of the 120 px travel is 25 percentage points.
    await dragKnob(page, -30);
    await expect(volumeText(page)).toHaveText('75%');

    // Down decreases from the value the previous drag left.
    await dragKnob(page, 60);
    await expect(volumeText(page)).toHaveText('25%');
  });

  test('a full-height drag covers the whole range and clamps at both ends', async ({
    page,
  }) => {
    await setup(page);
    await setVolume(page, 0);

    await dragKnob(page, -TRAVEL_PX);
    await expect(volumeText(page)).toHaveText('100%');

    // Winding past the end stays at the end rather than storing an overflow.
    await dragKnob(page, -60);
    await expect(volumeText(page)).toHaveText('100%');

    await dragKnob(page, 200);
    await expect(volumeText(page)).toHaveText('0%');

    await dragKnob(page, 60);
    await expect(volumeText(page)).toHaveText('0%');
  });

  test('Shift-drag trims at about a quarter of the speed', async ({ page }) => {
    await setup(page);
    await setVolume(page, 50);

    await dragKnob(page, -40);
    await expect(volumeText(page)).toHaveText('83%');

    await setVolume(page, 50);
    await dragKnob(page, -40, { shift: true });
    await expect(volumeText(page)).toHaveText('58%');

    // A quarter of the plain 33-point step, within the 1-point rounding.
    expect(83 - 50).toBeGreaterThan((58 - 50) * 3.5);
  });

  test('horizontal movement alone leaves the level untouched', async ({ page }) => {
    await setup(page);
    await setVolume(page, 40);

    const { x, y } = await knobCentre(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 150, y, { steps: 10 });
    await expect(volumeText(page)).toHaveText('40%');
    await page.mouse.move(x - 150, y, { steps: 10 });
    await expect(volumeText(page)).toHaveText('40%');
    await page.mouse.up();
    await expect(volumeText(page)).toHaveText('40%');
  });

  test('a drag that leaves the knob keeps tracking until release', async ({
    page,
  }) => {
    await setup(page);
    await setVolume(page, 20);

    const { x, y } = await knobCentre(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    // Pointer capture: the gesture continues far outside the 90 px knob.
    await page.mouse.move(x + 300, y - 60, { steps: 10 });
    await expect(volumeText(page)).toHaveText('70%');

    await page.mouse.up();
    // Released: further pointer movement is no longer a drag.
    await page.mouse.move(x + 300, y - 120, { steps: 10 });
    await expect(volumeText(page)).toHaveText('70%');
  });

  test('a secondary button does not start a drag', async ({ page }) => {
    await setup(page);
    await setVolume(page, 50);

    const { x, y } = await knobCentre(page);
    await page.mouse.move(x, y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(x, y - 60, { steps: 10 });
    await page.mouse.up({ button: 'right' });
    await expect(volumeText(page)).toHaveText('50%');
  });

  test('clicking the knob focuses the control and the keys still work', async ({
    page,
  }) => {
    await setup(page);
    await setVolume(page, 50);

    const { x, y } = await knobCentre(page);
    await page.mouse.click(x, y);
    await expect(volumeSlider(page)).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(volumeText(page)).toHaveText('51%');
    await page.keyboard.press('Home');
    await expect(volumeText(page)).toHaveText('0%');
    await page.keyboard.press('End');
    await expect(volumeText(page)).toHaveText('100%');
  });

  test('the knob keeps its label, focus ring and keyboard tab stop', async ({
    page,
  }) => {
    // No Connect click, so focus starts at the top of the document exactly as
    // in the tab-order test (device-access.spec.ts).
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');

    const control = page.getByRole('slider', { name: 'Volume' });
    await expect(control).toBeVisible();

    // The documented tab order is unchanged: the Volume control follows the
    // Info panel's toggle, the two font-credit links and the GitHub link.
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
    const outline = await knob(page).evaluate(
      (el) => getComputedStyle(el).outlineStyle,
    );
    expect(outline).not.toBe('none');

    await page.keyboard.press('ArrowLeft');
    await expect(volumeText(page)).toHaveText('99%');
  });

  test('rotation, readout, gain and stored volume all follow the drag', async ({
    page,
  }) => {
    await setup(page);
    // Capture an input so the monitor's gain node exists to assert against.
    await page.getByTestId('audio-input-picker').selectOption('in1');
    await page.getByTestId('mute-button').click();
    await expect(page.getByTestId('mute-button')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await setVolume(page, 50);
    const before = await knobAngle(page);

    await dragKnob(page, -30);
    await expect(volumeText(page)).toHaveText('75%');
    expect(await knobAngle(page)).toBeGreaterThan(before);
    expect(
      await page.evaluate(
        () => (window as any).__mockAudio.gain.gain.value,
      ),
    ).toBe(0.75);
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem('external-midi-player.audio'),
        ),
      )
      .toContain('"volume":0.75');
    // The drag changes the level only: mute stays off and routing is untouched.
    await expect(page.getByTestId('mute-button')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('dragging selects no text and scrolls nothing, including at 360 px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 720 });
    await setup(page);
    await setVolume(page, 50);

    // The mechanism that makes the gesture touch-safe: the wrap owns the
    // pointer (so `touch-action: none` is scoped to the knob) and the input
    // no longer sees pointer events.
    expect(
      await page
        .locator('.knob-wrap')
        .evaluate((el) => getComputedStyle(el).touchAction),
    ).toBe('none');
    expect(
      await volumeSlider(page).evaluate((el) => getComputedStyle(el).pointerEvents),
    ).toBe('none');

    const before = await page.evaluate(() => window.scrollY);
    const { x, y } = await knobCentre(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 120, y - 40, { steps: 10 });
    await expect(volumeText(page)).toHaveText('83%');
    await page.mouse.up();

    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      '',
    );
    expect(await page.evaluate(() => document.body.classList.contains('knob-dragging'))).toBe(
      false,
    );
  });
});
