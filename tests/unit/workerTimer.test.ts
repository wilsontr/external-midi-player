import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IntervalTimer,
  WorkerTimer,
  createSchedulerTimer,
} from '../../src/workerTimer';

/** Minimal stand-in for the browser Worker used by WorkerTimer. */
class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: unknown[] = [];
  terminated = false;
  readonly url: string;

  constructor(url: URL | string) {
    this.url = String(url);
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('WorkerTimer', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('posts start/stop to the worker and forwards its ticks', () => {
    const timer = new WorkerTimer();
    const onTick = vi.fn();

    timer.start(25, onTick);
    const worker = FakeWorker.instances[0];
    expect(worker.messages).toEqual([{ type: 'start', intervalMs: 25 }]);

    worker.onmessage?.({ data: 'tick' } as MessageEvent);
    expect(onTick).toHaveBeenCalledTimes(1);

    timer.stop();
    expect(worker.messages[1]).toEqual({ type: 'stop' });
    worker.onmessage?.({ data: 'tick' } as MessageEvent);
    expect(onTick).toHaveBeenCalledTimes(1); // no ticks while stopped

    timer.start(25, onTick);
    expect(worker.messages[2]).toEqual({ type: 'start', intervalMs: 25 });
    worker.onmessage?.({ data: 'tick' } as MessageEvent);
    expect(onTick).toHaveBeenCalledTimes(2);

    timer.dispose();
    expect(worker.terminated).toBe(true);
  });

  it('falls back to setInterval if the worker fails to load', () => {
    vi.useFakeTimers();
    const timer = new WorkerTimer();
    const onTick = vi.fn();
    timer.start(25, onTick);

    const worker = FakeWorker.instances[0];
    worker.onerror?.({} as ErrorEvent);

    expect(worker.terminated).toBe(true);
    vi.advanceTimersByTime(25);
    expect(onTick).toHaveBeenCalledTimes(1);

    timer.dispose();
    vi.advanceTimersByTime(100);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('uses the plain interval timer without a page or Worker', () => {
    vi.unstubAllGlobals(); // Node's Vitest environment has no document
    expect(createSchedulerTimer()).toBeInstanceOf(IntervalTimer);
  });

  it('uses the Worker timer in a browser-like environment', () => {
    vi.stubGlobal('document', {});
    expect(createSchedulerTimer()).toBeInstanceOf(WorkerTimer);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('stops the fallback interval on dispose', () => {
    vi.useFakeTimers();
    const timer = new WorkerTimer();
    const onTick = vi.fn();
    timer.start(25, onTick);
    FakeWorker.instances[0].onerror?.({} as ErrorEvent);

    timer.stop();
    vi.advanceTimersByTime(100);
    expect(onTick).not.toHaveBeenCalled();
  });
});
