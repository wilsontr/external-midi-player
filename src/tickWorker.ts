/**
 * Dedicated worker that posts a `tick` message on a fixed interval (T5).
 *
 * Running the interval here keeps the scheduler ticking when the page is in
 * a background tab, where window timers are throttled to about one second.
 * The main thread still decides what to send, using future MIDI timestamps.
 */

interface StartMessage {
  type: 'start';
  intervalMs: number;
}

interface StopMessage {
  type: 'stop';
}

type TimerMessage = StartMessage | StopMessage;

/**
 * `self` in this module is the dedicated-worker scope. The project compiles
 * against the DOM lib (the app is a page), so narrow it rather than pulling in
 * the full WebWorker lib and risking duplicate declarations.
 */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<TimerMessage>) => void) | null;
  postMessage: (message: 'tick') => void;
};

let handle: ReturnType<typeof setInterval> | null = null;

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'start') {
    if (handle !== null) clearInterval(handle);
    handle = setInterval(() => scope.postMessage('tick'), message.intervalMs);
  } else if (message.type === 'stop' && handle !== null) {
    clearInterval(handle);
    handle = null;
  }
};
