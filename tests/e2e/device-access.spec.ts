import { test, expect } from '@playwright/test';
import { mockDevices } from './mocks';

const JUNO = { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' };
const MONOPOD = { id: 'o2', name: 'Monopod', manufacturer: 'Korg' };

test.describe('T1 — scaffold and device access', () => {
  test('shows an unsupported-browser notice when Web MIDI is missing', async ({ page }) => {
    await mockDevices(page, { noRequest: true });
    await page.goto('/');

    await expect(page.getByTestId('unsupported-notice')).toBeVisible();
    await expect(page.getByTestId('connect-button')).toBeDisabled();
    // The single aria-live region must carry the same message (T5).
    await expect(page.getByTestId('status-region')).toContainText('does not support Web MIDI');
  });

  test('"Connect devices" triggers both the MIDI and microphone permission prompts', async ({
    page,
  }) => {
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');

    await page.getByTestId('connect-button').click();

    const status = page.getByTestId('status-region');
    await expect(status).toContainText('Microphone access granted');
    await expect(status).toContainText('Connected');
    const calls = await page.evaluate(() => (window as any).__mockMidi.calls);
    expect(calls.midi).toBe(1);
    expect(calls.mic).toBe(1);
  });

  test('lists MIDI outputs labelled with name and manufacturer', async ({ page }) => {
    await mockDevices(page, { outputs: [JUNO, MONOPOD] });
    await page.goto('/');

    await page.getByTestId('connect-button').click();

    const picker = page.getByTestId('output-picker');
    await expect(picker).toContainText('Juno-106 (Roland)');
    await expect(picker).toContainText('Monopod (Korg)');
  });

  test('a hot-plugged output appears in the picker within 1 s (R4)', async ({ page }) => {
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');
    await page.getByTestId('connect-button').click();

    await page.evaluate(() => (window as any).__mockMidi.addOutput('o2', 'Monopod', 'Korg'));

    await expect(page.getByTestId('output-picker').locator('option[value="o2"]')).toHaveCount(
      1,
      { timeout: 1000 },
    );
  });

  test('an unplugged output is removed from the picker within 1 s (R4)', async ({ page }) => {
    await mockDevices(page, { outputs: [JUNO, MONOPOD] });
    await page.goto('/');
    await page.getByTestId('connect-button').click();

    await page.evaluate(() => (window as any).__mockMidi.removeOutput('o2'));

    await expect(page.getByTestId('output-picker').locator('option[value="o2"]')).toHaveCount(0, {
      timeout: 1000,
    });
  });

  test('unplugging the selected output stops playback and warns', async ({ page }) => {
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');
    await page.getByTestId('connect-button').click();
    await page.getByTestId('output-picker').selectOption('o1');

    await page.evaluate(() => (window as any).__mockMidi.removeOutput('o1'));

    await expect(page.getByTestId('status-region')).toContainText('disconnected');
    await expect(page.getByTestId('playback-state')).toHaveText('Nothing playing.');
  });

  test('reselects the previously chosen output after a reload (by name)', async ({ page }) => {
    await mockDevices(page, { outputs: [JUNO, MONOPOD] });
    await page.goto('/');
    await page.getByTestId('connect-button').click();
    await page.getByTestId('output-picker').selectOption('o1');

    await page.reload();
    await page.getByTestId('connect-button').click();

    await expect(page.getByTestId('output-picker')).toHaveValue('o1');
  });

  test('offers a retry after a cancelled permission prompt', async ({ page }) => {
    await mockDevices(page, { failRequest: true });
    await page.goto('/');

    await page.getByTestId('connect-button').click();

    await expect(page.getByTestId('status-region')).toContainText('denied or cancelled');
    await expect(page.getByTestId('retry-button')).toBeVisible();
  });

  test('explains the Firefox add-on prompt before the first connect', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'firefox', 'Firefox only');
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');

    await expect(page.getByTestId('firefox-onboarding')).toBeVisible();
  });

  test('prints the getting-started steps above the player', async ({ page }) => {
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');

    const howTo = page.getByTestId('how-to');
    await expect(howTo).toBeVisible();
    await expect(howTo.locator('li')).toHaveCount(6);
    await expect(howTo).toContainText('Allow MIDI and microphone access');

    const [titleBox, quickstartBox, unitBox, howToBox, connectBox, expansionBox] =
      await Promise.all([
        page.getByRole('heading', { level: 1 }).boundingBox(),
        page.getByTestId('quickstart').boundingBox(),
        page.getByTestId('header').boundingBox(),
        howTo.boundingBox(),
        page.getByTestId('connect-button').boundingBox(),
        page.getByTestId('expansion-unit').boundingBox(),
      ]);
    // Quick start is printed above the rack; brand and Connect devices live in
    // the front unit below it.
    expect(howToBox!.y).toBeGreaterThan(quickstartBox!.y);
    expect(unitBox!.y).toBeGreaterThan(quickstartBox!.y + quickstartBox!.height);
    expect(titleBox!.y).toBeGreaterThan(unitBox!.y);
    expect(connectBox!.y + connectBox!.height).toBeLessThanOrEqual(unitBox!.y + unitBox!.height);
    expect(expansionBox!.y).toBeGreaterThan(unitBox!.y + unitBox!.height);
  });

  test('layout fits a 360 px viewport with the units and their internals stacked', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);

    const ids = ['monitor-panel', 'playback-panel', 'keypad', 'playlist-panel', 'instruments-panel'];
    const boxes = await Promise.all(ids.map((id) => page.getByTestId(id).boundingBox()));
    for (const box of boxes) expect(box!.x).toBe(boxes[0]!.x);
    // Inside unit 1: monitor strip, LCD, keypad, one after another.
    expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height / 2);
    expect(boxes[2]!.y).toBeGreaterThan(boxes[1]!.y + boxes[1]!.height / 2);
    // Unit 2 stacks the song list above the part map.
    expect(boxes[3]!.y).toBeGreaterThan(boxes[2]!.y);
    expect(boxes[4]!.y).toBeGreaterThan(boxes[3]!.y + boxes[3]!.height / 2);
  });

  test('is keyboard accessible and follows the documented tab order', async ({ page }) => {
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');

    // The printed Info panel is first: its disclosure button, then the two
    // font-credit links and the GitHub link. Then unit 1: volume, mute, MIDI output, audio
    // input/output, transport.
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('quickstart-toggle')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('.font-credit a').first()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('.font-credit a').nth(1)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('github-link')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('volume-slider')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('mute-button')).toBeFocused();

    // Connect so the MIDI output picker is enabled, then walk backwards from
    // the last key of unit 1.
    await page.getByTestId('connect-button').click();
    await expect(page.getByTestId('status-region')).toContainText('Connected');
    await page.getByTestId('connect-button').focus();

    const backwards = [
      'panic-button',
      'stop-button',
      'next-button',
      'play-button',
      'previous-button',
      'audio-output-picker',
      'audio-input-picker',
      'output-picker',
    ];
    for (const id of backwards) {
      await page.keyboard.press('Shift+Tab');
      await expect(page.getByTestId(id)).toBeFocused();
    }
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('mute-button')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('volume-slider')).toBeFocused();

    await page.getByTestId('connect-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('status-region')).toContainText('Connected');
  });
});
