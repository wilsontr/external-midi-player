/**
 * Web MIDI device access: permission request, output listing, hot-plug
 * (statechange) handling, and remembering the selected output by name.
 * See the design doc, "MIDI output > Device access", and ticket T1.
 *
 * This module is DOM-independent; the UI layer renders what it reports.
 */

export interface MidiOutputInfo {
  id: string;
  name: string;
  manufacturer: string;
}

export interface MidiDevicesOptions {
  /** Every user-visible status message funnels through here (single aria-live region). */
  onStatus: (message: string) => void;
  /** Fired whenever the selection changes (id), or is cleared (null). */
  onSelectionChange: (outputId: string | null) => void;
  /** Fired whenever the output list changes (connect or statechange). */
  onOutputsChanged: () => void;
  /** Fired when the previously selected output disconnected. */
  onSelectedOutputLost: () => void;
  /** Storage used to remember the selected output name. Defaults to localStorage. */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

export const SELECTED_OUTPUT_STORAGE_KEY = 'external-midi-player.selected-output';

interface RequestMidiAccess {
  (options?: { sysex: boolean }): Promise<MIDIAccess>;
}

function requestMidiAccessFromNavigator(): RequestMidiAccess | undefined {
  const candidate = (navigator as { requestMIDIAccess?: RequestMidiAccess }).requestMIDIAccess;
  return typeof candidate === 'function' ? candidate : undefined;
}

export class MidiDevices {
  private access: MIDIAccess | null = null;
  private outputs: MidiOutputInfo[] = [];
  private currentSelection: string | null = null;

  constructor(private readonly options: MidiDevicesOptions) {}

  /** True once access has been granted (even with zero outputs). */
  get connected(): boolean {
    return this.access !== null;
  }

  /**
   * Request MIDI access. Must be called from a user gesture — Firefox only
   * grants the site permission in response to one. Resolves to false when
   * the browser is unsupported or the user denies/cancels the prompt.
   * Always requests `{ sysex: false }` (see ticket T1 open question).
   */
  async connect(): Promise<boolean> {
    const request = requestMidiAccessFromNavigator();
    if (!request) {
      this.options.onStatus('This browser does not support Web MIDI.');
      return false;
    }
    try {
      const access = await request.call(navigator, { sysex: false });
      this.access = access;
      access.onstatechange = () => this.handleStateChange();
      this.refreshOutputs();
      const count = this.outputs.length;
      this.options.onStatus(
        count > 0
          ? `MIDI access granted. ${count} output${count === 1 ? '' : 's'} available.`
          : 'MIDI access granted. No outputs available yet.',
      );
      return true;
    } catch {
      this.options.onStatus('MIDI access denied or cancelled — click "Connect devices" to retry.');
      return false;
    }
  }

  /** The outputs currently offered by the browser, for the picker. */
  listOutputs(): MidiOutputInfo[] {
    return this.outputs.slice();
  }

  /** The id of the selected output, if any. */
  selectedId(): string | null {
    return this.currentSelection;
  }

  /**
   * Select an output by id. The selection is remembered by *name* so a
   * device that reconnects under the same name can be reselected after a
   * reload.
   */
  select(id: string): void {
    const output = this.outputs.find((o) => o.id === id);
    if (!output) return;
    this.currentSelection = id;
    this.saveSelectedName(output.name);
    this.options.onSelectionChange(id);
  }

  /** The live MIDIOutput for the selection, once access is granted. */
  selectedOutput(): MIDIOutput | null {
    if (!this.access || !this.currentSelection) return null;
    return this.access.outputs.get(this.currentSelection) ?? null;
  }

  private saveSelectedName(name: string): void {
    const storage = this.options.storage ?? safeLocalStorage();
    try {
      storage.setItem(SELECTED_OUTPUT_STORAGE_KEY, name);
    } catch {
      // Storage unavailable (e.g. private mode) — selection is not remembered.
    }
  }

  private savedSelectedName(): string | null {
    const storage = this.options.storage ?? safeLocalStorage();
    try {
      return storage.getItem(SELECTED_OUTPUT_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private refreshOutputs(): void {
    if (!this.access) return;
    this.outputs = Array.from(this.access.outputs.values(), (o) => ({
      id: o.id,
      name: o.name ?? 'Unknown device',
      manufacturer: o.manufacturer ?? 'Unknown',
    }));
    this.reselectKnownOutput();
    this.options.onOutputsChanged();
  }

  /**
   * Reselect the remembered output (by name) when nothing is selected.
   * Runs on connect and after every statechange, so a reconnected device
   * with the same name is picked up again.
   */
  private reselectKnownOutput(): void {
    if (this.currentSelection !== null) return;
    const savedName = this.savedSelectedName();
    if (!savedName) return;
    const match = this.outputs.find((o) => o.name === savedName);
    if (!match) return;
    this.currentSelection = match.id;
    this.options.onSelectionChange(match.id);
  }

  private handleStateChange(): void {
    const previousSelection = this.currentSelection;
    const stillPresent =
      previousSelection !== null &&
      Array.from(this.access?.outputs.values() ?? []).some((o) => o.id === previousSelection);
    this.refreshOutputs();
    if (previousSelection !== null && !stillPresent) {
      this.currentSelection = null;
      this.options.onSelectionChange(null);
      this.options.onSelectedOutputLost();
    }
  }
}

function safeLocalStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  try {
    return localStorage;
  } catch {
    const empty = new Map<string, string>();
    return {
      getItem: (key: string) => empty.get(key) ?? null,
      setItem: (key: string, value: string) => {
        empty.set(key, value);
      },
    };
  }
}
