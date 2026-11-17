import { afterEach, describe, expect, it, vi } from 'vitest';
import { MidiDevices, SELECTED_OUTPUT_STORAGE_KEY } from '../../src/midiDevices';

interface FakeOutput {
  id: string;
  name: string;
  manufacturer: string;
}

function makeAccess(outputs: FakeOutput[]) {
  const map = new Map<string, object>(
    outputs.map((o) => [
      o.id,
      { id: o.id, name: o.name, manufacturer: o.manufacturer, state: 'connected', send: () => {} },
    ]),
  );
  const access = {
    outputs: map,
    inputs: new Map<string, object>(),
    onstatechange: null as null | (() => void),
  } as unknown as MIDIAccess;
  return {
    access,
    setOutput(id: string, output: FakeOutput) {
      map.set(id, { ...output, state: 'connected', send: () => {} });
    },
    removeOutput(id: string) {
      map.delete(id);
    },
    fireStateChange() {
      access.onstatechange?.(new Event('statechange') as unknown as MIDIConnectionEvent);
    },
  };
}

function mockNavigator(
  access: MIDIAccess,
  { reject = false } = {},
): { requestMIDIAccess: ReturnType<typeof vi.fn> } {
  const requestMIDIAccess = vi
    .fn()
    .mockImplementation(() =>
      reject
        ? Promise.reject(new Error('NotAllowedError'))
        : Promise.resolve(access),
    );
  return { requestMIDIAccess };
}

function makeStorage() {
  const backing = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
    },
    backing,
  };
}

function makeOptions(overrides: Record<string, unknown> = {}) {
  const { storage, backing } = makeStorage();
  return {
    options: {
      onStatus: vi.fn(),
      onSelectionChange: vi.fn(),
      onOutputsChanged: vi.fn(),
      onSelectedOutputLost: vi.fn(),
      storage,
      ...overrides,
    },
    storage: backing,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MidiDevices', () => {
  it('requests access without sysex when connect() is called', async () => {
    const fake = makeAccess([
      { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' },
    ]);
    const nav = mockNavigator(fake.access);
    vi.stubGlobal('navigator', nav);
    const { options } = makeOptions();
    const devices = new MidiDevices(options);

    const granted = await devices.connect();

    expect(granted).toBe(true);
    expect(nav.requestMIDIAccess).toHaveBeenCalledWith({ sysex: false });
  });

  it('lists outputs with name and manufacturer', async () => {
    const fake = makeAccess([
      { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' },
      { id: 'o2', name: 'Monopod', manufacturer: 'Korg' },
    ]);
    vi.stubGlobal('navigator', mockNavigator(fake.access));
    const { options } = makeOptions();
    const devices = new MidiDevices(options);

    await devices.connect();

    expect(devices.listOutputs()).toEqual([
      { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' },
      { id: 'o2', name: 'Monopod', manufacturer: 'Korg' },
    ]);
  });

  it('reports denial when the permission prompt is cancelled', async () => {
    const fake = makeAccess([]);
    vi.stubGlobal('navigator', mockNavigator(fake.access, { reject: true }));
    const { options } = makeOptions();
    const devices = new MidiDevices(options);

    const granted = await devices.connect();

    expect(granted).toBe(false);
    expect(options.onStatus).toHaveBeenCalledWith(
      'MIDI access denied or cancelled — click "Connect devices" to retry.',
    );
  });

  it('reports unsupported browsers without throwing', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Test' });
    const { options } = makeOptions();
    const devices = new MidiDevices(options);

    const granted = await devices.connect();

    expect(granted).toBe(false);
    expect(options.onStatus).toHaveBeenCalledWith('This browser does not support Web MIDI.');
  });

  it('select() persists the output name and reports the selection', async () => {
    const fake = makeAccess([
      { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' },
    ]);
    vi.stubGlobal('navigator', mockNavigator(fake.access));
    const { options, storage } = makeOptions();
    const devices = new MidiDevices(options);
    await devices.connect();

    devices.select('o1');

    expect(options.onSelectionChange).toHaveBeenLastCalledWith('o1');
    expect(storage.get(SELECTED_OUTPUT_STORAGE_KEY)).toBe('Juno-106');
    expect(devices.selectedId()).toBe('o1');
  });

  it('exposes the selected MIDIOutput', async () => {
    const fake = makeAccess([
      { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' },
    ]);
    vi.stubGlobal('navigator', mockNavigator(fake.access));
    const { options } = makeOptions();
    const devices = new MidiDevices(options);
    await devices.connect();

    devices.select('o1');

    expect(devices.selectedOutput()).toBe(fake.access.outputs.get('o1'));
  });

  it('reselects the remembered output by name after a reconnect', async () => {
    const fake = makeAccess([
      { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' },
    ]);
    vi.stubGlobal('navigator', mockNavigator(fake.access));
    const { options, storage } = makeOptions();
    storage.set(SELECTED_OUTPUT_STORAGE_KEY, 'Juno-106');
    const devices = new MidiDevices(options);

    await devices.connect();

    expect(devices.selectedId()).toBe('o1');
    expect(options.onSelectionChange).toHaveBeenCalledWith('o1');
  });

  it('does not reselect a remembered output that is absent', async () => {
    const fake = makeAccess([
      { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' },
    ]);
    vi.stubGlobal('navigator', mockNavigator(fake.access));
    const { options, storage } = makeOptions();
    storage.set(SELECTED_OUTPUT_STORAGE_KEY, 'Missing Device');
    const devices = new MidiDevices(options);

    await devices.connect();

    expect(devices.selectedId()).toBeNull();
    expect(options.onSelectionChange).not.toHaveBeenCalled();
  });

  it('a hot-plugged output appears in the list after statechange', async () => {
    const fake = makeAccess([
      { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' },
    ]);
    vi.stubGlobal('navigator', mockNavigator(fake.access));
    const { options } = makeOptions();
    const devices = new MidiDevices(options);
    await devices.connect();
    options.onOutputsChanged.mockClear();

    fake.setOutput('o2', { id: 'o2', name: 'Monopod', manufacturer: 'Korg' });
    fake.fireStateChange();

    expect(devices.listOutputs()).toEqual([
      { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' },
      { id: 'o2', name: 'Monopod', manufacturer: 'Korg' },
    ]);
    expect(options.onOutputsChanged).toHaveBeenCalled();
  });

  it('unplugging the selected output clears the selection and reports the loss', async () => {
    const fake = makeAccess([
      { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' },
    ]);
    vi.stubGlobal('navigator', mockNavigator(fake.access));
    const { options, storage } = makeOptions();
    storage.delete(SELECTED_OUTPUT_STORAGE_KEY);
    const devices = new MidiDevices(options);
    await devices.connect();
    devices.select('o1');
    options.onSelectionChange.mockClear();

    fake.removeOutput('o1');
    fake.fireStateChange();

    expect(devices.selectedId()).toBeNull();
    expect(options.onSelectionChange).toHaveBeenCalledWith(null);
    expect(options.onSelectedOutputLost).toHaveBeenCalledTimes(1);
  });

  it('unplugging a non-selected output keeps the selection', async () => {
    const fake = makeAccess([
      { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' },
      { id: 'o2', name: 'Monopod', manufacturer: 'Korg' },
    ]);
    vi.stubGlobal('navigator', mockNavigator(fake.access));
    const { options } = makeOptions();
    const devices = new MidiDevices(options);
    await devices.connect();
    devices.select('o1');
    options.onSelectedOutputLost.mockClear();

    fake.removeOutput('o2');
    fake.fireStateChange();

    expect(devices.selectedId()).toBe('o1');
    expect(options.onSelectedOutputLost).not.toHaveBeenCalled();
  });

  it('a reconnected device with the saved name is reselected after its loss', async () => {
    const fake = makeAccess([
      { id: 'o1', name: 'Juno-106', manufacturer: 'Roland' },
    ]);
    vi.stubGlobal('navigator', mockNavigator(fake.access));
    const { options, storage } = makeOptions();
    storage.set(SELECTED_OUTPUT_STORAGE_KEY, 'Juno-106');
    const devices = new MidiDevices(options);
    await devices.connect();
    expect(devices.selectedId()).toBe('o1');

    fake.removeOutput('o1');
    fake.fireStateChange();
    expect(devices.selectedId()).toBeNull();

    fake.setOutput('o2', { id: 'o2', name: 'Juno-106', manufacturer: 'Roland' });
    fake.fireStateChange();

    expect(devices.selectedId()).toBe('o2');
    expect(options.onSelectedOutputLost).toHaveBeenCalledTimes(1);
  });
});
