/**
 * Tick timer for the scheduler (ticket T5).
 *
 * A dedicated Worker's interval is not throttled like a background tab's
 * timers, so the 25 ms tick keeps running while the page is hidden. Where a
 * Worker is unavailable — or the worker script fails to start — this falls
 * back to a plain `setInterval`; the scheduler's 200 ms look-ahead absorbs
 * short stalls either way.
 *
 * The timer only schedules *ticks*. Note timing still comes from the future
 * timestamps handed to `MIDIOutput.send`, never from this timer.
 */

/** Drives `Scheduler.tick()`; injectable so tests can control it. */
export interface SchedulerTimer {
  /** Starts (or restarts) `onTick` every `intervalMs`. */
  start(intervalMs: number, onTick: () => void): void;
  /** Stops ticking but keeps the timer reusable (pause/resume). */
  stop(): void;
  /** Stops and releases the worker/interval. */
  dispose(): void;
}

/** Plain interval timer, also the fallback when a Worker cannot run. */
export class IntervalTimer implements SchedulerTimer {
  private handle: ReturnType<typeof setInterval> | null = null;

  start(intervalMs: number, onTick: () => void): void {
    this.stop();
    this.handle = setInterval(onTick, intervalMs);
  }

  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  dispose(): void {
    this.stop();
  }
}

interface StartMessage {
  type: 'start';
  intervalMs: number;
}

interface StopMessage {
  type: 'stop';
}

export type TickMessage = StartMessage | StopMessage;

/** Runs the interval inside a dedicated Worker. */
export class WorkerTimer implements SchedulerTimer {
  private worker: Worker | null;
  private fallback: IntervalTimer | null = null;
  private intervalMs = 25;
  private onTick: (() => void) | null = null;
  private running = false;

  constructor() {
    this.worker = new Worker(new URL('./tickWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = () => {
      if (this.running) this.onTick?.();
    };
    // A worker that fails to load falls back to a page timer rather than
    // silently leaving playback without ticks.
    this.worker.onerror = () => this.useFallback();
  }

  start(intervalMs: number, onTick: () => void): void {
    this.intervalMs = intervalMs;
    this.onTick = onTick;
    this.running = true;
    if (this.fallback !== null) {
      this.fallback.start(intervalMs, onTick);
      return;
    }
    const message: StartMessage = { type: 'start', intervalMs };
    this.worker?.postMessage(message);
  }

  stop(): void {
    this.running = false;
    this.fallback?.stop();
    if (this.worker !== null) {
      const message: StopMessage = { type: 'stop' };
      this.worker.postMessage(message);
    }
  }

  dispose(): void {
    this.running = false;
    this.fallback?.dispose();
    this.fallback = null;
    this.worker?.terminate();
    this.worker = null;
    this.onTick = null;
  }

  /** Switch to a page interval after a worker load/runtime error. */
  private useFallback(): void {
    if (this.fallback !== null || this.worker === null) return;
    this.worker.terminate();
    this.worker = null;
    this.fallback = new IntervalTimer();
    if (this.running && this.onTick !== null) {
      this.fallback.start(this.intervalMs, this.onTick);
    }
  }
}

/**
 * Picks the Worker timer in a browser, with `setInterval` as the fallback
 * (also used in the Node-driven unit tests, where there is no page).
 */
export function createSchedulerTimer(): SchedulerTimer {
  if (typeof document === 'undefined' || typeof Worker === 'undefined') {
    return new IntervalTimer();
  }
  try {
    return new WorkerTimer();
  } catch {
    return new IntervalTimer();
  }
}
