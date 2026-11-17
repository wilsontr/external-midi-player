import type { Page } from '@playwright/test';

/**
 * Installs Web MIDI + getUserMedia mocks before the app code runs.
 *
 * Exposes `window.__mockMidi` on the page:
 *   - `calls.midi` / `calls.mic`: how many times each permission API was hit
 *   - `sent`: every `output.send(bytes, timestamp)` call, across all outputs
 *   - `addOutput(id, name, manufacturer)` / `removeOutput(id)`:
 *     mutate the device map and fire `onstatechange`, exactly like a
 *     hot-plug event (R4)
 */
export interface MidiMockOptions {
  outputs?: Array<{ id: string; name: string; manufacturer: string }>;
  /** requestMIDIAccess rejects (permission prompt cancelled/denied). */
  failRequest?: boolean;
  /** navigator.requestMIDIAccess is absent (unsupported browser). */
  noRequest?: boolean;
}

export async function mockDevices(
  page: Page,
  options: MidiMockOptions = {},
): Promise<void> {
  const { outputs = [], failRequest = false, noRequest = false } = options;
  await page.addInitScript(
    ({ outputs, failRequest, noRequest }) => {
      const make = (id: string, name: string, manufacturer: string) => ({
        id,
        name,
        manufacturer,
        state: 'connected',
        longName: '',
        send: (data: ArrayLike<number>, timestamp?: number) => {
          (window as any).__mockMidi.sent.push({ bytes: Array.from(data), timestamp });
        },
      });
      const outputsMap = new Map(
        outputs.map((o) => [o.id, make(o.id, o.name, o.manufacturer)] as const),
      );
      const access = {
        outputs: outputsMap,
        inputs: new Map(),
        onstatechange: null as null | (() => void),
      };
      (window as any).__mockMidi = {
        calls: { midi: 0, mic: 0 },
        sent: [] as Array<{ bytes: number[]; timestamp?: number }>,
        addOutput(id: string, name: string, manufacturer: string) {
          outputsMap.set(id, make(id, name, manufacturer));
          access.onstatechange?.();
        },
        removeOutput(id: string) {
          outputsMap.delete(id);
          access.onstatechange?.();
        },
      };

      const nav = navigator as any;
      const define = (value: unknown) =>
        Object.defineProperty(nav, 'requestMIDIAccess', {
          configurable: true,
          value,
        });
      if (noRequest) {
        define(undefined);
      } else if (failRequest) {
        define(() => {
          (window as any).__mockMidi.calls.midi += 1;
          return Promise.reject(new Error('NotAllowedError'));
        });
      } else {
        define(() => {
          (window as any).__mockMidi.calls.midi += 1;
          return Promise.resolve(access);
        });
      }
      Object.defineProperty(nav, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: () => {
            (window as any).__mockMidi.calls.mic += 1;
            return Promise.resolve({ getTracks: () => [], stop: () => {} });
          },
        },
      });
    },
    { outputs, failRequest, noRequest },
  );
}
