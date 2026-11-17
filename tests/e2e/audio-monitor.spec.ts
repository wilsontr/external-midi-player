import { test, expect, type Page } from '@playwright/test';
import { mockDevices, type AudioMockOptions } from './mocks';

const JUNO = { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' };

async function setup(page: Page, audio: AudioMockOptions = {}): Promise<void> {
  await mockDevices(page, { outputs: [JUNO], audio });
  await page.goto('/');
  await page.getByTestId('connect-button').click();
  await expect(page.getByTestId('status-region')).toContainText('Microphone access granted');
}

const audioMock = <T>(page: Page, fn: string): Promise<T> =>
  page.evaluate((f) => new Function('m', `return ${f}`)((window as any).__mockAudio), fn);

test.describe('T4 — audio monitoring', () => {
  test('pickers are disabled until permission is granted, then show device names', async ({
    page,
  }) => {
    await mockDevices(page, { outputs: [JUNO] });
    await page.goto('/');
    await expect(page.getByTestId('audio-input-picker')).toBeDisabled();

    await page.getByTestId('connect-button').click();

    const input = page.getByTestId('audio-input-picker');
    await expect(input).toBeEnabled();
    await expect(input).toContainText('Studio Interface');
    await expect(input).toContainText('Built-in Microphone');
    await expect(page.getByTestId('audio-output-picker')).toContainText('Laptop Speakers');
    await expect(page.getByTestId('audio-output-picker')).toContainText('System default');
  });

  test('captures with voice processing off, starts muted, and mute/volume drive the gain', async ({
    page,
  }) => {
    await setup(page);
    await page.getByTestId('audio-input-picker').selectOption('in1');

    await expect.poll(() => audioMock<number>(page, 'm.constraints.length')).toBe(1);
    const constraints = await audioMock<any>(page, 'm.constraints[0]');
    expect(constraints.audio).toMatchObject({
      deviceId: { exact: 'in1' },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
    });
    expect(await audioMock(page, 'm.ctxOptions')).toEqual({ latencyHint: 'interactive' });

    const mute = page.getByTestId('mute-button');
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    expect(await audioMock(page, 'm.gain.gain.value')).toBe(0);

    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
    expect(await audioMock(page, 'm.gain.gain.value')).toBe(1);

    await page.getByTestId('volume-slider').fill('50');
    await expect(page.getByTestId('volume-text')).toHaveText('50%');
    expect(await audioMock(page, 'm.gain.gain.value')).toBe(0.5);

    await mute.click();
    expect(await audioMock(page, 'm.gain.gain.value')).toBe(0);
  });

  test('the meter shows peak dBFS (even while muted) and a clip indicator above −1 dBFS', async ({
    page,
  }) => {
    await setup(page);
    await page.getByTestId('audio-input-picker').selectOption('in1');
    await expect(page.getByTestId('meter-text')).toHaveText('L −∞ · R −∞ dBFS');

    await page.evaluate(() => ((window as any).__mockAudio.level = [0.5, 0.25]));
    await expect(page.getByTestId('meter-text')).toHaveText('L −6.0 · R −12.0 dBFS');
    await expect(page.getByTestId('clip-indicator')).toBeHidden();

    await page.evaluate(() => ((window as any).__mockAudio.level = [0.95, 0.1]));
    await expect(page.getByTestId('clip-indicator')).toBeVisible();
  });

  test('shows the browser latency as baseLatency + outputLatency', async ({ page }) => {
    await setup(page);
    await expect(page.getByTestId('latency-readout')).toHaveText('Browser latency: —');
    await page.getByTestId('audio-input-picker').selectOption('in1');
    await expect(page.getByTestId('latency-readout')).toContainText('30.0 ms');
  });

  test('switching input stops the old tracks first', async ({ page }) => {
    await setup(page);
    const picker = page.getByTestId('audio-input-picker');
    await picker.selectOption('in1');
    await expect.poll(() => audioMock<number>(page, 'm.constraints.length')).toBe(1);
    const stoppedBefore = await audioMock<number>(page, 'm.stopped');

    await picker.selectOption('in2');

    await expect.poll(() => audioMock<number>(page, 'm.constraints.length')).toBe(2);
    expect(await audioMock<number>(page, 'm.stopped')).toBeGreaterThan(stoppedBefore);
  });

  test('Chrome path: the output is chosen with AudioContext.setSinkId', async ({ page }) => {
    await setup(page, { contextSinkId: true });
    await page.getByTestId('audio-input-picker').selectOption('in1');
    await page.getByTestId('audio-output-picker').selectOption('out2');
    await expect.poll(() => audioMock<string[]>(page, 'm.contextSinks')).toContain('out2');
  });

  test('Firefox path: only granted outputs are listed and picked with <audio>.setSinkId', async ({
    page,
  }) => {
    await setup(page, {
      contextSinkId: false,
      selectAudioOutput: { id: 'usb-dac', label: 'USB DAC' },
    });
    await page.getByTestId('audio-input-picker').selectOption('in1');

    // Enumerated outputs cannot be used with setSinkId until granted.
    await expect(page.getByTestId('audio-output-picker').locator('option')).toHaveCount(1);
    await page.getByTestId('grant-output-button').click();

    await expect(page.getByTestId('audio-output-picker').locator('option')).toHaveCount(2);
    await expect(page.getByTestId('audio-output-picker')).toHaveValue('usb-dac');
    await expect.poll(() => audioMock<string[]>(page, 'm.elementSinks')).toContain('usb-dac');
    expect(await audioMock<string[]>(page, 'm.contextSinks')).toEqual([]);
  });

  test('a failed input selection resets the picker and stops monitoring', async ({ page }) => {
    await setup(page, { failInputs: ['in2'] });
    const picker = page.getByTestId('audio-input-picker');
    await page.evaluate(() => ((window as any).__mockAudio.level = [0.5, 0.5]));

    await picker.selectOption('in1');
    await expect(page.getByTestId('meter-text')).toHaveText('L −6.0 · R −6.0 dBFS');

    await picker.selectOption('in2');

    await expect(page.getByTestId('status-region')).toContainText('Could not open the selected audio input');
    await expect(picker).toHaveValue('');
    await expect(page.getByTestId('meter-text')).toHaveText('L −∞ · R −∞ dBFS');

    // The next working device starts monitoring again.
    await picker.selectOption('in1');
    await expect(page.getByTestId('meter-text')).toHaveText('L −6.0 · R −6.0 dBFS');
  });

  test('falls back to the system default when the chosen output is rejected', async ({ page }) => {
    await setup(page, { failSinkIds: ['out2'] });
    await page.getByTestId('audio-input-picker').selectOption('in1');
    await expect.poll(() => audioMock<number>(page, 'm.constraints.length')).toBe(1);

    await page.getByTestId('audio-output-picker').selectOption('out2');

    await expect(page.getByTestId('status-region')).toContainText('system default');
    await expect(page.getByTestId('audio-output-picker')).toHaveValue('');
    const sinks = await audioMock<string[]>(page, 'm.contextSinks');
    expect(sinks[sinks.length - 1]).toBe('');
  });

  test('falls back to the system default with a note when no output can be chosen', async ({
    page,
  }) => {
    await setup(page, { contextSinkId: false, elementSinkId: false });
    await expect(page.getByTestId('audio-output-row')).toBeHidden();
    await expect(page.getByTestId('audio-output-note')).toBeVisible();
    await expect(page.getByTestId('audio-output-note')).toContainText('system default');
  });

  test('hot-plugging an audio device refreshes both pickers within 1 s', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      const m = (window as any).__mockAudio;
      m.setDevices(
        [...[{ id: 'in1', label: 'Studio Interface', groupId: 'g1' }], { id: 'in3', label: 'USB Mic', groupId: 'g3' }],
        [{ id: 'out1', label: 'Studio Interface', groupId: 'g1' }, { id: 'out3', label: 'Headphones', groupId: 'g3' }],
      );
    });

    await expect(page.getByTestId('audio-input-picker')).toContainText('USB Mic', { timeout: 1000 });
    await expect(page.getByTestId('audio-input-picker')).not.toContainText('Built-in Microphone');
    await expect(page.getByTestId('audio-output-picker')).toContainText('Headphones');
    await expect(page.getByTestId('audio-output-picker')).not.toContainText('Laptop Speakers');
  });

  test('unplugging the selected input stops monitoring and says so', async ({ page }) => {
    await setup(page);
    await page.getByTestId('audio-input-picker').selectOption('in2');
    await expect.poll(() => audioMock<number>(page, 'm.constraints.length')).toBe(1);
    await page.evaluate(() => {
      (window as any).__mockAudio.level = [0.5, 0.5];
      (window as any).__mockAudio.setDevices(
        [{ id: 'in1', label: 'Studio Interface', groupId: 'g1' }],
        [{ id: 'out1', label: 'Studio Interface', groupId: 'g1' }],
      );
    });

    await expect(page.getByTestId('status-region')).toContainText('input disconnected');
    await expect(page.getByTestId('audio-input-picker')).toHaveValue('');
    await expect(page.getByTestId('meter-text')).toHaveText('L −∞ · R −∞ dBFS');
  });

  test('warns when the input and output are the same device', async ({ page }) => {
    await setup(page);
    await page.getByTestId('audio-input-picker').selectOption('in1');
    await page.getByTestId('audio-output-picker').selectOption('out2');
    await expect(page.getByTestId('feedback-warning')).toBeHidden();

    await page.getByTestId('audio-output-picker').selectOption('out1');

    await expect(page.getByTestId('feedback-warning')).toBeVisible();
    await expect(page.getByTestId('status-region')).toContainText('same device');
  });

  test('audio devices, mute and volume survive a reload', async ({ page }) => {
    await setup(page);
    await page.getByTestId('audio-input-picker').selectOption('in1');
    await page.getByTestId('audio-output-picker').selectOption('out2');
    await page.getByTestId('mute-button').click();
    await page.getByTestId('volume-slider').fill('40');
    await expect(page.getByTestId('volume-text')).toHaveText('40%');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('external-midi-player.audio') ?? ''))
      .toContain('"inputId":"in1"');

    await page.reload();
    await page.getByTestId('connect-button').click();
    await expect(page.getByTestId('status-region')).toContainText('Microphone access granted');

    await expect(page.getByTestId('audio-input-picker')).toHaveValue('in1');
    await expect(page.getByTestId('audio-output-picker')).toHaveValue('out2');
    await expect(page.getByTestId('mute-button')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('volume-text')).toHaveText('40%');
    // The saved input is actually captured again (one capture request after reload).
    await expect.poll(() => audioMock<number>(page, 'm.constraints.length')).toBe(1);
    expect(await audioMock<number>(page, 'm.gain.gain.value')).toBe(0.4);
  });
});
