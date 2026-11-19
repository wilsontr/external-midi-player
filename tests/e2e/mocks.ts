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
export interface AudioDeviceMock {
  id: string;
  label: string;
  groupId: string;
}

/** Web Audio / getUserMedia mock; see `window.__mockAudio`. */
export interface AudioMockOptions {
  inputs?: AudioDeviceMock[];
  outputs?: AudioDeviceMock[];
  /** `AudioContext.prototype.setSinkId` exists (Chrome). Default true. */
  contextSinkId?: boolean;
  /** `HTMLMediaElement.prototype.setSinkId` exists. Default true. */
  elementSinkId?: boolean;
  /** `mediaDevices.selectAudioOutput` resolves to this device (Firefox). */
  selectAudioOutput?: { id: string; label: string };
  /** Capture rejects for these input ids (a device that vanished). */
  failInputs?: string[];
  /** `setSinkId` rejects for these output ids (an output that is not granted). */
  failSinkIds?: string[];
}

export const DEFAULT_AUDIO_INPUTS: AudioDeviceMock[] = [
  { id: 'in1', label: 'Studio Interface', groupId: 'g1' },
  { id: 'in2', label: 'Built-in Microphone', groupId: 'g2' },
];
export const DEFAULT_AUDIO_OUTPUTS: AudioDeviceMock[] = [
  { id: 'out1', label: 'Studio Interface', groupId: 'g1' },
  { id: 'out2', label: 'Laptop Speakers', groupId: 'g2' },
];

export interface MidiMockOptions {
  audio?: AudioMockOptions;
  /**
   * Set false to leave the real `AudioContext` in place (default true). The
   * built-in synth spec needs a real worklet, so it mocks Web MIDI only.
   */
  mockAudio?: boolean;
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
  const mockAudio = options.mockAudio !== false;
  const audio = {
    inputs: DEFAULT_AUDIO_INPUTS,
    outputs: DEFAULT_AUDIO_OUTPUTS,
    contextSinkId: true,
    elementSinkId: true,
    selectAudioOutput: undefined,
    failInputs: [],
    failSinkIds: [],
    ...options.audio,
  } as Required<Omit<AudioMockOptions, 'selectAudioOutput'>> &
    Pick<AudioMockOptions, 'selectAudioOutput'>;
  await page.addInitScript(
    ({ outputs, failRequest, noRequest, mockAudio, audio }) => {
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
      if (mockAudio) {
        /**
         * Exposes `window.__mockAudio`: `level` (peak per channel the analysers
         * report), `constraints` (every non-trivial getUserMedia request),
         * `stopped` (tracks stopped), `gain` (the live gain value), `contextSinks` /
         * `elementSinks` (every setSinkId call), `ctxOptions`, and
         * `setDevices(inputs, outputs)` to hot-plug devices.
         */
        let inputs = audio.inputs;
        let outputsAudio = audio.outputs;
        const mock = {
          level: [0, 0],
          constraints: [] as unknown[],
          stopped: 0,
          gain: null as null | { gain: { value: number } },
          contextSinks: [] as string[],
          elementSinks: [] as string[],
          ctxOptions: null as unknown,
          setDevices(newInputs: typeof inputs, newOutputs: typeof outputsAudio) {
            inputs = newInputs;
            outputsAudio = newOutputs;
            mediaDevices.ondevicechange?.();
          },
        };
        (window as any).__mockAudio = mock;

        const mediaDevices: any = {
          ondevicechange: null,
          getUserMedia: (constraints: any) => {
            if (constraints?.audio === true) {
              (window as any).__mockMidi.calls.mic += 1;
            } else {
              mock.constraints.push(constraints);
              const wanted = constraints?.audio?.deviceId?.exact;
              if (audio.failInputs.includes(wanted)) {
                return Promise.reject(new DOMException('device vanished', 'NotAllowedError'));
              }
            }
            const track = {
              stop: () => {
                mock.stopped += 1;
              },
              getSettings: () => ({ channelCount: 2 }),
              addEventListener: () => {},
            };
            return Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track] });
          },
          enumerateDevices: () =>
            Promise.resolve([
              ...inputs.map((d) => ({ kind: 'audioinput', deviceId: d.id, label: d.label, groupId: d.groupId })),
              ...outputsAudio.map((d) => ({ kind: 'audiooutput', deviceId: d.id, label: d.label, groupId: d.groupId })),
            ]),
        };
        if (audio.selectAudioOutput) {
          const granted = audio.selectAudioOutput;
          mediaDevices.selectAudioOutput = () =>
            Promise.resolve({ deviceId: granted.id, label: granted.label });
        }
        Object.defineProperty(nav, 'mediaDevices', { configurable: true, value: mediaDevices });

        class FakeAudioContext {
          baseLatency = 0.01;
          outputLatency = 0.02;
          destination = {};
          private analysers = 0;
          constructor(opts: unknown) {
            mock.ctxOptions = opts;
          }
          resume() {
            return Promise.resolve();
          }
          close() {
            return Promise.resolve();
          }
          createGain() {
            const node = { gain: { value: 1 }, connect() {} };
            mock.gain = node;
            return node;
          }
          createAnalyser() {
            const channel = this.analysers++ % 2;
            return {
              fftSize: 2048,
              getFloatTimeDomainData(buf: Float32Array) {
                buf.fill(0);
                buf[0] = mock.level[channel];
              },
            };
          }
          createChannelSplitter() {
            return { connect() {}, disconnect() {} };
          }
          createMediaStreamSource() {
            return { connect() {}, disconnect() {} };
          }
          createMediaStreamDestination() {
            return { stream: new MediaStream(), connect() {} };
          }
        }
        if (audio.contextSinkId) {
          (FakeAudioContext.prototype as any).setSinkId = (id: string) => {
            mock.contextSinks.push(id);
            if (audio.failSinkIds.includes(id)) {
              return Promise.reject(new DOMException('sink not granted', 'NotAllowedError'));
            }
            return Promise.resolve();
          };
        }
        (window as any).AudioContext = FakeAudioContext;
        Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
          configurable: true,
          writable: true,
          value: audio.elementSinkId
            ? (id: string) => {
                mock.elementSinks.push(id);
                if (audio.failSinkIds.includes(id)) {
                  return Promise.reject(new DOMException('sink not granted', 'NotAllowedError'));
                }
                return Promise.resolve();
              }
            : undefined,
        });
      }
    },
    { outputs, failRequest, noRequest, mockAudio, audio },
  );
}
