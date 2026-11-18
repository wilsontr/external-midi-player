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

  test('shows the getting-started steps between the title and Connect devices', async ({ page }) => {
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');

    const howTo = page.getByTestId('how-to');
    await expect(howTo).toBeVisible();
    await expect(howTo.locator('li')).toHaveCount(6);
    await expect(howTo).toContainText('Allow MIDI and microphone access');

    const [titleBox, howToBox, buttonBox] = await Promise.all([
      page.getByRole('heading', { level: 1 }).boundingBox(),
      howTo.boundingBox(),
      page.getByTestId('connect-button').boundingBox(),
    ]);
    expect(howToBox!.y).toBeGreaterThan(titleBox!.y);
    expect(buttonBox!.y).toBeGreaterThan(howToBox!.y);
  });

  test('layout fits a 360 px viewport with the panels stacked', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);

    const testIds = ['monitor-panel', 'instruments-panel', 'playback-panel', 'playlist-panel'];
    const boxes = await Promise.all(
      testIds.map((id) => page.getByTestId(id).boundingBox()),
    );
    expect(boxes[0]!.x).toBe(boxes[1]!.x);
    expect(boxes[1]!.x).toBe(boxes[2]!.x);
    expect(boxes[2]!.x).toBe(boxes[3]!.x);
    expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height / 2);
    expect(boxes[2]!.y).toBeGreaterThan(boxes[1]!.y + boxes[1]!.height / 2);
    expect(boxes[3]!.y).toBeGreaterThan(boxes[2]!.y + boxes[2]!.height / 2);
  });

  test('is keyboard accessible', async ({ page }) => {
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');

    await page.keyboard.press('Tab');
    await expect(page.getByTestId('connect-button')).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('status-region')).toContainText('Connected');

    // DOM order is header, monitor, instruments, playback, playlist, so the
    // monitor's input picker is the next stop after the header.
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('audio-input-picker')).toBeFocused();
  });
});
