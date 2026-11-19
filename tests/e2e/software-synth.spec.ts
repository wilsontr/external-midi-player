import { test, expect, type Page } from '@playwright/test';
import { blankPlaylist, mockDevices } from './mocks';

const JUNO = { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' };

/** Format-0 SMF at 480 PPQ / 120 BPM (960 ticks per second), one held note. */
function midiFile(seconds: number): number[] {
  const ticks = Math.round(seconds * 960);
  const vlq = (n: number): number[] => {
    const out = [n & 0x7f];
    while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
    return out;
  };
  const track = [
    0x00, 0xc0, 0, 0x00, 0x90, 60, 100,
    ...vlq(ticks),
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

/**
 * Web MIDI is mocked (no hardware), but the real `AudioContext` is left in
 * place: the whole point of T7 is the AudioWorklet engine. Two analysers are
 * spliced into the graph:
 *
 * - `__synthProbe.analysers[0]` taps the synth's own output (before the
 *   monitor gain), so a test can tell "the engine is rendering" from
 *   "something is audible";
 * - `__outputProbe.analyser` taps what goes to the speakers (after the monitor
 *   gain): the `AudioContext` destination on Chrome, or the `<audio>` path's
 *   `MediaStreamAudioDestinationNode` on Firefox (T24).
 */
async function setup(page: Page): Promise<void> {
  await blankPlaylist(page);
  await mockDevices(page, { outputs: [JUNO], mockAudio: false });
  await page.addInitScript(() => {
    const probe = (window as any).__synthProbe = { analysers: [], worklets: 0 } as {
      analysers: AnalyserNode[];
      worklets: number;
    };
    const outputProbe = (window as any).__outputProbe = { analyser: null } as {
      analyser: AnalyserNode | null;
    };

    const originalConnect = AudioNode.prototype.connect as any;
    (AudioNode.prototype as any).connect = function (
      this: AudioNode,
      destination: any,
      ...rest: any[]
    ) {
      // Tap whatever is connected to the speakers: the monitor's gain node
      // reaches `AudioContext.destination` on Chrome and a
      // `MediaStreamAudioDestinationNode` (the `<audio>` path) on Firefox.
      const isOutput =
        destination instanceof AudioDestinationNode ||
        (typeof MediaStreamAudioDestinationNode !== 'undefined' &&
          destination instanceof MediaStreamAudioDestinationNode);
      if (isOutput) {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 2048;
        originalConnect.call(this, analyser);
        originalConnect.call(analyser, destination);
        outputProbe.analyser = analyser;
        return destination;
      }
      return originalConnect.call(this, destination, ...rest);
    };

    const Original = (window as any).AudioWorkletNode;
    class TeeWorkletNode extends Original {
      constructor(context: AudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        probe.worklets += 1;
        this.connect = ((destination: AudioNode, ...rest: unknown[]) => {
          const analyser = context.createAnalyser();
          analyser.fftSize = 2048;
          Original.prototype.connect.call(this, analyser);
          probe.analysers.push(analyser);
          analyser.connect(destination, ...(rest as []));
          return destination;
        }) as typeof this.connect;
      }
    }
    (window as any).AudioWorkletNode = TeeWorkletNode;
  });
  await page.goto('/');
}

/** Root-mean-square of the synth's own output (pre-monitor), 0 when silent. */
async function rms(page: Page): Promise<number> {
  return page.evaluate(() => {
    const analyser = (window as any).__synthProbe.analysers[0] as
      | AnalyserNode
      | undefined;
    if (!analyser) return -1;
    const buffer = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (const value of buffer) sum += value * value;
    return Math.sqrt(sum / buffer.length);
  });
}

/** Root-mean-square of what reaches the destination (post monitor gain). */
async function outputRms(page: Page): Promise<number> {
  return page.evaluate(() => {
    const analyser = (window as any).__outputProbe.analyser as
      | AnalyserNode
      | null;
    if (!analyser) return -1;
    const buffer = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (const value of buffer) sum += value * value;
    return Math.sqrt(sum / buffer.length);
  });
}

const status = (page: Page) => page.getByTestId('status-region');

/**
 * Presses a transport key with Enter.
 *
 * The keypad sits on the bottom edge of the faceplate. In this environment
 * headless Firefox reserves a strip at the bottom of the window once a real
 * `AudioContext` is running (an autoplay notice), and coordinate clicks there
 * never reach the page; the keyboard path is the same control and is part of
 * T1's tab order, so it is the honest way to press Play here.
 */
async function pressTransport(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).press('Enter');
}
const picker = (page: Page) => page.getByTestId('output-picker');

async function unmute(page: Page): Promise<void> {
  const mute = page.getByTestId('mute-button');
  if ((await mute.getAttribute('aria-pressed')) === 'true') await mute.click();
  await expect(mute).toHaveAttribute('aria-pressed', 'false');
}

async function selectSynth(page: Page): Promise<void> {
  await picker(page).selectOption('builtin-synth');
  await expect(status(page)).toContainText('SpessaSynth ready', {
    timeout: 30_000,
  });
  // The synth plays through the monitor bus (T24) and a fresh profile starts
  // muted (R10), so tests that expect sound unmute first.
  await unmute(page);
}

async function dropFile(page: Page, seconds = 4): Promise<void> {
  await page.evaluate((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'tone.mid'));
    document.querySelector('[data-testid="drop-zone"]')!.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  }, midiFile(seconds));
  await expect(status(page)).toContainText('Added 1 file');
}

test.describe('T7 — built-in software synth', () => {
  test('is offered without asking for any permission', async ({ page }) => {
    await mockDevices(page, { outputs: [], mockAudio: false });
    await page.goto('/');

    await expect(picker(page)).toBeEnabled();
    await expect(picker(page).locator('option[value="builtin-synth"]')).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).__mockMidi.calls.midi)).toBe(0);
  });

  test('loads the bundled SoundFont once and reports when it is ready', async ({
    page,
  }) => {
    const banks: string[] = [];
    page.on('request', (request) => {
      // The dev server also requests the module wrapper (`...?import&url`);
      // only the real binary fetch counts.
      const url = new URL(request.url());
      if (url.pathname.endsWith('.sf3') && url.search === '') {
        banks.push(request.url());
      }
    });
    await setup(page);
    await selectSynth(page);

    expect(banks).toHaveLength(1);
    expect(banks[0]).toMatch(/\.sf3/);
    await expect(picker(page)).toHaveValue('builtin-synth');
    await expect(page.getByTestId('connect-led')).toHaveAttribute(
      'data-state',
      'connected',
    );

    // Loading is one-off: switching away and back reuses the engine.
    await picker(page).selectOption('');
    await picker(page).selectOption('builtin-synth');
    await expect(status(page)).toContainText('SpessaSynth ready');
    expect(banks).toHaveLength(1);
  });

  test('plays the playlist audibly and Stop silences it', async ({ page }) => {
    await setup(page);
    await selectSynth(page);
    await dropFile(page);

    await pressTransport(page, 'play-button');
    // What reaches the destination, i.e. after the monitor gain (T24).
    await expect
      .poll(() => outputRms(page), { timeout: 10_000 })
      .toBeGreaterThan(0.005);

    await pressTransport(page, 'stop-button');
    await expect(page.getByTestId('playback-state')).toHaveAttribute(
      'data-state',
      'stopped',
    );
    await expect
      .poll(() => outputRms(page), { timeout: 5_000 })
      .toBeLessThan(0.002);
  });

  test('a fresh profile starts muted, says so, and the Mute key makes the synth audible', async ({
    page,
  }) => {
    await setup(page);
    // Pick the synth without the helper's unmute.
    await picker(page).selectOption('builtin-synth');
    await expect(status(page)).toContainText('The audio monitor is muted', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('mute-button')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await dropFile(page);

    await pressTransport(page, 'play-button');
    // The engine is rendering...
    await expect.poll(() => rms(page), { timeout: 10_000 }).toBeGreaterThan(0.005);
    // ...but the monitor gain keeps it off the speakers.
    expect(await outputRms(page)).toBeLessThan(0.002);

    await page.getByTestId('mute-button').click();
    await expect
      .poll(() => outputRms(page), { timeout: 5_000 })
      .toBeGreaterThan(0.005);
  });

  test('the monitor strip mutes and meters the built-in synth', async ({ page }) => {
    await setup(page);
    await selectSynth(page);
    await dropFile(page);

    await pressTransport(page, 'play-button');
    await expect
      .poll(() => outputRms(page), { timeout: 10_000 })
      .toBeGreaterThan(0.005);

    // The VU reads the synth's output while it plays.
    const meter = page.getByTestId('meter');
    await expect(meter).not.toHaveAttribute(
      'aria-valuetext',
      'Left −∞ dBFS, Right −∞ dBFS',
    );

    // Mute silences the speakers but not the engine or the pre-gain meter.
    await page.getByTestId('mute-button').click();
    await expect
      .poll(() => outputRms(page), { timeout: 5_000 })
      .toBeLessThan(0.002);
    expect(await rms(page)).toBeGreaterThan(0.005);
    await expect(meter).not.toHaveAttribute(
      'aria-valuetext',
      'Left −∞ dBFS, Right −∞ dBFS',
    );

    // The volume knob attenuates it too: zero is silent, full is audible.
    await page.getByTestId('mute-button').click();
    await expect
      .poll(() => outputRms(page), { timeout: 5_000 })
      .toBeGreaterThan(0.005);
    await page.getByTestId('volume-slider').fill('0');
    await expect
      .poll(() => outputRms(page), { timeout: 5_000 })
      .toBeLessThan(0.002);
    await page.getByTestId('volume-slider').fill('100');
    await expect
      .poll(() => outputRms(page), { timeout: 5_000 })
      .toBeGreaterThan(0.005);
  });

  test('Pause releases the sounding notes on the synth too', async ({ page }) => {
    await setup(page);
    await selectSynth(page);
    await dropFile(page, 20);

    await pressTransport(page, 'play-button');
    await expect.poll(() => rms(page), { timeout: 10_000 }).toBeGreaterThan(0.005);

    // Pause sends a note-off (plus CC64 = 0) after the queued tail.
    await pressTransport(page, 'play-button');
    await expect.poll(() => rms(page), { timeout: 5_000 }).toBeLessThan(0.002);
    await expect(page.getByTestId('playback-state')).toHaveAttribute(
      'data-state',
      'paused',
    );
  });

  test('connecting devices hands playback back to the remembered hardware', async ({
    page,
  }) => {
    // A profile that used the Juno before: Connect reselects it by name.
    await page.addInitScript(() => {
      localStorage.setItem('external-midi-player.selected-output', 'Juno-106');
      // The mic is not part of this test; deny it so Connect cannot hang on a
      // permission prompt while the real AudioContext stays available.
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
      });
    });
    await setup(page);
    await selectSynth(page);

    await page.getByTestId('connect-button').click();
    // The picker shows the hardware again...
    await expect(picker(page)).toHaveValue('o1');
    await expect(page.getByTestId('connect-led')).toHaveAttribute(
      'data-state',
      'connected',
    );

    // ...and the notes must go there, not to the synth that was playing before.
    await dropFile(page);
    await pressTransport(page, 'play-button');
    await expect
      .poll(() => page.evaluate(() => (window as any).__mockMidi.sent.length), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
  });

  test('Panic silences the synth like it silences hardware', async ({ page }) => {
    await setup(page);
    await selectSynth(page);
    await dropFile(page, 20);

    await pressTransport(page, 'play-button');
    await expect.poll(() => rms(page), { timeout: 10_000 }).toBeGreaterThan(0.005);

    // Esc is the Panic shortcut: CC123/120/121 and CC64 = 0 on all channels.
    await page.keyboard.press('Escape');
    await expect(status(page)).toContainText('Panic: all notes off');
    await expect.poll(() => rms(page), { timeout: 5_000 }).toBeLessThan(0.002);
  });

  test('a missing SoundFont is reported once and leaves the app usable', async ({
    page,
  }) => {
    await page.route('**/*.sf3', (route) => route.fulfill({ status: 404, body: '' }));
    await setup(page);

    await picker(page).selectOption('builtin-synth');
    await expect(status(page)).toContainText('could not start', { timeout: 30_000 });
    await expect(status(page)).toContainText('404');
    await expect(picker(page)).toHaveValue('');

    // The rest of the player still works.
    await dropFile(page);
    await expect(picker(page)).toBeEnabled();
  });
});
