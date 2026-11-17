import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AudioMonitor, DB_FLOOR, type OutputRouting } from '../../src/audioMonitor';

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>;
  getSettings: () => { channelCount: number };
  addEventListener: ReturnType<typeof vi.fn>;
}

function makeStream(channelCount = 2) {
  const track: FakeTrack = {
    stop: vi.fn(),
    getSettings: () => ({ channelCount }),
    addEventListener: vi.fn(),
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  return { stream: stream as unknown as MediaStream, track };
}

const device = (kind: string, id: string, label: string, groupId: string) =>
  ({ kind, deviceId: id, label, groupId }) as MediaDeviceInfo;

function setup(routing: OutputRouting = 'context') {
  let devices: MediaDeviceInfo[] = [
    device('audioinput', 'in1', 'Interface', 'g1'),
    device('audioinput', 'in2', 'Built-in Mic', 'g2'),
    device('audiooutput', 'default', 'Default', 'g2'),
    device('audiooutput', 'out1', 'Interface', 'g1'),
  ];
  const streams: Array<ReturnType<typeof makeStream>> = [];
  let nextChannels = 2;
  const mediaDevices = {
    getUserMedia: vi.fn(async () => {
      const made = makeStream(nextChannels);
      streams.push(made);
      return made.stream;
    }),
    enumerateDevices: vi.fn(async () => devices),
    ondevicechange: null as null | (() => void),
  };

  const gain = { gain: { value: -1 }, connect: vi.fn() };
  const samples: [number[], number[]] = [[0], [0]];
  const analysers = [0, 1].map((i) => ({
    fftSize: 2048,
    getFloatTimeDomainData: (buf: Float32Array) => {
      buf.fill(0);
      samples[i].forEach((v, k) => (buf[k] = v));
    },
  }));
  let analyserIndex = 0;
  const context = {
    baseLatency: 0.01,
    outputLatency: 0.02,
    destination: {},
    setSinkId: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createGain: () => gain,
    createAnalyser: () => analysers[analyserIndex++],
    createChannelSplitter: () => ({ connect: vi.fn() }),
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    createMediaStreamDestination: () => ({ stream: {}, connect: vi.fn() }),
  };
  const createContext = vi.fn(() => context as unknown as AudioContext);
  const audio = { srcObject: null, play: vi.fn(async () => {}), pause: vi.fn(), setSinkId: vi.fn(async () => {}) };

  const statuses: string[] = [];
  const onDevicesChanged = vi.fn();
  const onInputLost = vi.fn();
  const monitor = new AudioMonitor({
    onStatus: (m) => statuses.push(m),
    onDevicesChanged,
    onInputLost,
    mediaDevices: mediaDevices as unknown as MediaDevices,
    createContext,
    createAudioElement: () => audio as unknown as HTMLAudioElement,
    routing,
  });
  return {
    monitor, mediaDevices, context, gain, samples, streams, statuses, audio, createContext,
    onDevicesChanged, onInputLost,
    setDevices: (d: MediaDeviceInfo[]) => (devices = d),
    setChannels: (n: number) => (nextChannels = n),
  };
}

describe('AudioMonitor', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('unlocks once with plain audio:true, then lists input and output devices', async () => {
    expect(await t.monitor.unlock()).toBe(true);
    expect(t.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(t.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(t.streams[0].track.stop).toHaveBeenCalled();
    expect(t.monitor.inputs().map((d) => d.label)).toEqual(['Interface', 'Built-in Mic']);
    expect(t.monitor.outputs().map((d) => d.id)).toEqual(['default', 'out1']);
  });

  it('captures with processing off, builds the graph and starts muted', async () => {
    await t.monitor.unlock();
    await t.monitor.selectInput('in1');
    expect(t.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({
      audio: {
        deviceId: { exact: 'in1' },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
        sampleRate: { ideal: 48000 },
      },
    });
    expect(t.createContext).toHaveBeenCalledWith({ latencyHint: 'interactive' });
    expect(t.monitor.muted).toBe(true);
    expect(t.gain.gain.value).toBe(0);
    expect(t.context.resume).toHaveBeenCalled();
    expect(t.context.createMediaStreamSource).toHaveBeenCalledTimes(1);
  });

  it('mute and volume drive the gain node', async () => {
    await t.monitor.unlock();
    await t.monitor.selectInput('in1');
    t.monitor.setVolume(0.5);
    expect(t.gain.gain.value).toBe(0);
    t.monitor.setMuted(false);
    expect(t.gain.gain.value).toBe(0.5);
    t.monitor.setVolume(2);
    expect(t.gain.gain.value).toBe(1);
    t.monitor.setMuted(true);
    expect(t.gain.gain.value).toBe(0);
  });

  it('stops the old tracks when the input changes', async () => {
    await t.monitor.unlock();
    await t.monitor.selectInput('in1');
    const first = t.streams[1];
    await t.monitor.selectInput('in2');
    expect(first.track.stop).toHaveBeenCalled();
    expect(t.monitor.selectedInput).toBe('in2');
    await t.monitor.selectInput(null);
    expect(t.streams[2].track.stop).toHaveBeenCalled();
    expect(t.monitor.selectedInput).toBeNull();
  });

  it('reports peak dBFS per channel and mirrors a mono input', async () => {
    await t.monitor.unlock();
    await t.monitor.selectInput('in1');
    expect(t.monitor.peaks()).toEqual({ left: DB_FLOOR, right: DB_FLOOR });
    t.samples[0] = [0.1, -0.5, 0.2];
    t.samples[1] = [1];
    const { left, right } = t.monitor.peaks();
    expect(left).toBeCloseTo(-6.02, 1);
    expect(right).toBeCloseTo(0, 5);

    t.setChannels(1);
    await t.monitor.selectInput('in2');
    t.samples[0] = [0.5];
    t.samples[1] = [0];
    expect(t.monitor.peaks().right).toBeCloseTo(-6.02, 1);
  });

  it('shows the browser latency as baseLatency + outputLatency', async () => {
    expect(t.monitor.latencyMs()).toBeNull();
    await t.monitor.unlock();
    await t.monitor.selectInput('in1');
    expect(t.monitor.latencyMs()).toBeCloseTo(30, 5);
  });

  it('routes the output with AudioContext.setSinkId on the context path', async () => {
    await t.monitor.unlock();
    await t.monitor.selectInput('in1');
    await t.monitor.selectOutput('out1');
    expect(t.context.setSinkId).toHaveBeenLastCalledWith('out1');
  });

  it('routes the output through an <audio> element on the element path', async () => {
    const e = setup('element');
    await e.monitor.unlock();
    await e.monitor.selectInput('in1');
    await e.monitor.selectOutput('out1');
    expect(e.audio.setSinkId).toHaveBeenLastCalledWith('out1');
    expect(e.audio.play).toHaveBeenCalled();
    expect(e.context.setSinkId).not.toHaveBeenCalled();
  });

  it('offers no output list when routing falls back to the system default', async () => {
    const d = setup('default');
    await d.monitor.unlock();
    expect(d.monitor.outputs()).toEqual([]);
  });

  it('warns when the input and output share a device', async () => {
    await t.monitor.unlock();
    await t.monitor.selectInput('in1');
    expect(t.monitor.sharesDevice()).toBe(false);
    await t.monitor.selectOutput('out1');
    expect(t.monitor.sharesDevice()).toBe(true);
    await t.monitor.selectInput('in2');
    expect(t.monitor.sharesDevice()).toBe(false);
    await t.monitor.selectOutput('');
    expect(t.monitor.sharesDevice()).toBe(true);
  });

  it('refreshes the lists on devicechange and stops when the input is unplugged', async () => {
    await t.monitor.unlock();
    await t.monitor.selectInput('in1');
    t.onDevicesChanged.mockClear();

    t.setDevices([
      device('audioinput', 'in2', 'Built-in Mic', 'g2'),
      device('audioinput', 'in3', 'New USB', 'g3'),
      device('audiooutput', 'default', 'Default', 'g2'),
    ]);
    t.mediaDevices.ondevicechange!();
    await vi.waitFor(() => expect(t.onInputLost).toHaveBeenCalled());

    expect(t.monitor.inputs().map((d) => d.id)).toEqual(['in2', 'in3']);
    expect(t.monitor.selectedInput).toBeNull();
    expect(t.streams[1].track.stop).toHaveBeenCalled();
    expect(t.onDevicesChanged).toHaveBeenCalled();
    expect(t.statuses.some((m) => m.includes('disconnected'))).toBe(true);
  });

  it('falls back to the default output when the selected output disappears', async () => {
    await t.monitor.unlock();
    await t.monitor.selectOutput('out1');
    t.setDevices([
      device('audioinput', 'in1', 'Interface', 'g1'),
      device('audiooutput', 'default', 'Default', 'g2'),
    ]);
    await t.monitor.refreshDevices();
    expect(t.monitor.selectedOutput).toBe('');
    expect(t.statuses.some((m) => m.includes('default output'))).toBe(true);
  });

  it('returns false from unlock when microphone permission is denied', async () => {
    t.mediaDevices.getUserMedia.mockRejectedValueOnce(new Error('NotAllowedError'));
    expect(await t.monitor.unlock()).toBe(false);
    expect(t.monitor.inputs()).toEqual([]);
  });
});
