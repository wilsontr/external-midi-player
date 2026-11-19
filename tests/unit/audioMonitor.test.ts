import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AUDIO_SETTINGS_STORAGE_KEY,
  AudioMonitor,
  DB_FLOOR,
  type OutputRouting,
} from '../../src/audioMonitor';

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

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function setup(routing: OutputRouting = 'context', storage = memoryStorage()) {
  let devices: MediaDeviceInfo[] = [
    device('audioinput', 'in1', 'Interface', 'g1'),
    device('audioinput', 'in2', 'Built-in Mic', 'g2'),
    device('audiooutput', 'default', 'Default', 'g2'),
    device('audiooutput', 'out1', 'Interface', 'g1'),
  ];
  const streams: Array<ReturnType<typeof makeStream>> = [];
  const splitters: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  let nextChannels = 2;
  const mediaDevices = {
    getUserMedia: vi.fn(async () => {
      const made = makeStream(nextChannels);
      streams.push(made);
      return made.stream;
    }),
    enumerateDevices: vi.fn(async () => devices),
    ondevicechange: null as null | (() => void),
    selectAudioOutput: undefined as undefined | (() => Promise<{ deviceId: string; label: string; groupId?: string }>),
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
  const sources: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const context = {
    baseLatency: 0.01,
    outputLatency: 0.02,
    destination: {},
    setSinkId: vi.fn(async (_id: string) => {}),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createGain: () => gain,
    createAnalyser: () => analysers[analyserIndex++],
    createChannelSplitter: () => {
      const splitter = { connect: vi.fn(), disconnect: vi.fn() };
      splitters.push(splitter);
      return splitter;
    },
    createMediaStreamSource: vi.fn(() => {
      const source = { connect: vi.fn(), disconnect: vi.fn() };
      sources.push(source);
      return source;
    }),
    createMediaStreamDestination: () => ({ stream: {}, connect: vi.fn() }),
  };
  const createContext = vi.fn(() => context as unknown as AudioContext);
  const audio = { srcObject: null, play: vi.fn(async () => {}), pause: vi.fn(), setSinkId: vi.fn(async (_id: string) => {}) };

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
    storage,
  });
  return {
    monitor, mediaDevices, context, gain, samples, streams, splitters, sources, statuses, audio, createContext, storage,
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

  it('falls back to the system default output when the chosen one is rejected', async () => {
    await t.monitor.unlock();
    await t.monitor.selectInput('in1');
    t.context.setSinkId.mockClear();
    t.context.setSinkId.mockRejectedValueOnce(new Error('NotAllowedError'));

    await t.monitor.selectOutput('out1');

    expect(t.monitor.selectedOutput).toBe('');
    expect(t.context.setSinkId.mock.calls.map((call) => call[0])).toEqual(['out1', '']);
    expect(t.statuses[t.statuses.length - 1]).toContain('system default');
  });

  it('releases a newly opened capture when the audio graph cannot be built', async () => {
    await t.monitor.unlock();
    t.createContext.mockImplementationOnce(() => {
      throw new Error('no audio device');
    });

    expect(await t.monitor.selectInput('in1')).toBe(false);

    expect(t.streams[t.streams.length - 1]!.track.stop).toHaveBeenCalled();
    expect(t.monitor.selectedInput).toBeNull();
    expect(t.statuses[t.statuses.length - 1]).toContain('Could not start audio monitoring');
  });

  it('keeps one meter tap across input changes', async () => {
    await t.monitor.unlock();
    await t.monitor.selectInput('in1');
    await t.monitor.selectInput('in2');

    // The splitter belongs to the bus (the synth shares it), not the capture.
    expect(t.splitters).toHaveLength(1);
    expect(t.sources[0].disconnect).toHaveBeenCalled();
    expect(t.sources[1].connect).toHaveBeenCalledWith(t.splitters[0]);
  });

  it('puts a generated source on the monitor bus (gain and meter) with no capture', () => {
    const source = { connect: vi.fn() };

    t.monitor.attachSource(source);

    expect(t.createContext).toHaveBeenCalledTimes(1);
    expect(source.connect).toHaveBeenCalledWith(t.gain);
    expect(source.connect).toHaveBeenCalledWith(t.splitters[0]);
    // The same mute and volume state governs the synth from the start.
    expect(t.gain.gain.value).toBe(0);
    t.monitor.setMuted(false);
    t.monitor.setVolume(0.5);
    expect(t.gain.gain.value).toBe(0.5);
  });

  it('reads the attached synth level even with no captured input', () => {
    t.samples[0] = [0.5];
    t.samples[1] = [0.25];
    // Nothing on the bus: silent, even though the fake analysers hold samples.
    expect(t.monitor.peaks()).toEqual({ left: DB_FLOOR, right: DB_FLOOR });

    t.monitor.attachSource({ connect: vi.fn() });

    const { left, right } = t.monitor.peaks();
    expect(left).toBeCloseTo(-6.02, 1);
    expect(right).toBeCloseTo(-12.04, 1);
  });

  it('does not mirror a mono input when the synth shares the bus', async () => {
    t.setChannels(1);
    await t.monitor.unlock();
    t.monitor.attachSource({ connect: vi.fn() });
    await t.monitor.selectInput('in1');
    t.samples[0] = [0.5];
    t.samples[1] = [0.25];

    const { left, right } = t.monitor.peaks();
    expect(left).toBeCloseTo(-6.02, 1);
    expect(right).toBeCloseTo(-12.04, 1);
  });

  it('offers only granted outputs and keeps their group on the <audio> path', async () => {
    const e = setup('element');
    await e.monitor.unlock();
    expect(e.monitor.canSelectAudioOutput).toBe(false);
    e.mediaDevices.selectAudioOutput = vi.fn(async () => ({
      deviceId: 'out1',
      label: 'Interface',
      groupId: 'g1',
    }));
    expect(e.monitor.canSelectAudioOutput).toBe(true);
    // Enumerated-but-ungranted devices cannot be used with setSinkId.
    expect(e.monitor.outputs()).toEqual([]);

    await e.monitor.selectInput('in1');
    const granted = await e.monitor.grantOutput();

    expect(granted?.id).toBe('out1');
    expect(e.monitor.outputs().map((d) => d.id)).toEqual(['out1']);
    expect(e.monitor.selectedOutput).toBe('out1');
    expect(e.audio.setSinkId).toHaveBeenLastCalledWith('out1');
    expect(e.monitor.sharesDevice()).toBe(true);
  });

  it('says so when the output picker is dismissed without a device', async () => {
    const e = setup('element');
    await e.monitor.unlock();
    e.mediaDevices.selectAudioOutput = vi.fn(async () => {
      throw new DOMException('cancelled', 'AbortError');
    });

    expect(await e.monitor.grantOutput()).toBeNull();
    expect(e.statuses[e.statuses.length - 1]).toContain('No output device selected');
  });

  it('restores the saved input, output, mute and volume after unlock', async () => {
    const store = memoryStorage({
      [AUDIO_SETTINGS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        inputId: 'in1',
        inputLabel: 'Interface',
        outputId: 'out1',
        outputLabel: 'Interface',
        muted: false,
        volume: 0.4,
      }),
    });
    const r = setup('context', store);
    expect(r.monitor.muted).toBe(false);
    expect(r.monitor.volume).toBe(0.4);

    await r.monitor.unlock();

    expect(r.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(r.monitor.selectedInput).toBe('in1');
    expect(r.monitor.selectedOutput).toBe('out1');
    expect(r.gain.gain.value).toBe(0.4);
    expect(r.context.setSinkId).toHaveBeenLastCalledWith('out1');
  });

  it('matches a saved input by label when its device id has rotated', async () => {
    const store = memoryStorage({
      [AUDIO_SETTINGS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        inputId: 'stale-id',
        inputLabel: 'Interface',
        outputId: '',
        outputLabel: '',
        muted: true,
        volume: 1,
      }),
    });
    const r = setup('context', store);

    await r.monitor.unlock();

    expect(r.monitor.selectedInput).toBe('in1');
  });

  it('saves device, mute and volume changes', async () => {
    await t.monitor.unlock();
    await t.monitor.selectInput('in1');
    await t.monitor.selectOutput('out1');
    t.monitor.setMuted(false);
    t.monitor.setVolume(0.6);

    const saved = JSON.parse(t.storage.getItem(AUDIO_SETTINGS_STORAGE_KEY)!);
    expect(saved).toMatchObject({ inputId: 'in1', outputId: 'out1', muted: false, volume: 0.6 });
  });

  it('keeps the remembered input when a new selection fails', async () => {
    await t.monitor.unlock();
    await t.monitor.selectInput('in1');
    t.mediaDevices.getUserMedia.mockRejectedValueOnce(new Error('gone'));

    expect(await t.monitor.selectInput('in2')).toBe(false);

    const saved = JSON.parse(t.storage.getItem(AUDIO_SETTINGS_STORAGE_KEY)!);
    expect(saved.inputId).toBe('in1');
  });

  it('keeps the stored input when it cannot be reopened on restore', async () => {
    const store = memoryStorage({
      [AUDIO_SETTINGS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        inputId: 'in1',
        inputLabel: 'Interface',
        outputId: '',
        outputLabel: '',
        muted: true,
        volume: 1,
      }),
    });
    const r = setup('context', store);

    const unlocking = r.monitor.unlock();
    // The unlock stream opens; the capture attempt in restoreSelection fails.
    r.mediaDevices.getUserMedia.mockRejectedValueOnce(new Error('device busy'));

    expect(await unlocking).toBe(true);
    expect(r.monitor.selectedInput).toBeNull();
    expect(JSON.parse(store.getItem(AUDIO_SETTINGS_STORAGE_KEY)!).inputId).toBe('in1');
  });

  it('keeps monitoring when settings storage rejects writes', async () => {
    const r = setup('context', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    });
    await r.monitor.unlock();

    expect(await r.monitor.selectInput('in1')).toBe(true);
    expect(r.monitor.selectedInput).toBe('in1');
  });

  it('keeps the remembered input after the device is unplugged', async () => {
    await t.monitor.unlock();
    await t.monitor.selectInput('in1');

    t.setDevices([
      device('audioinput', 'in2', 'Built-in Mic', 'g2'),
      device('audiooutput', 'default', 'Default', 'g2'),
    ]);
    await t.monitor.refreshDevices();
    expect(t.monitor.selectedInput).toBeNull();

    t.monitor.setVolume(0.5);

    const saved = JSON.parse(t.storage.getItem(AUDIO_SETTINGS_STORAGE_KEY)!);
    expect(saved.inputId).toBe('in1');
    expect(saved.volume).toBe(0.5);
  });
});
