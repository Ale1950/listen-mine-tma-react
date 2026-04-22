/**
 * ═══ Mining Timer Worker ═══
 *
 * Pure-timer broker that runs in a Web Worker thread. Main thread requests
 * named intervals / timeouts; worker fires `tick` messages back when they
 * expire. Because Web Workers are NOT subject to the 1000ms throttling that
 * browsers apply to setInterval/setTimeout in hidden tabs, moving our
 * mining timers here keeps the tap loop + reward poll + canStart poll
 * running at the right cadence when the app is in the background.
 *
 * The worker only schedules timers. All WASM/SDK calls still happen in the
 * main thread (inside the onmessage handler in utils/miningTimers.ts).
 */

type InMsg =
  | { kind: 'setInterval'; id: string; ms: number }
  | { kind: 'setTimeout'; id: string; ms: number }
  | { kind: 'clear'; id: string }
  | { kind: 'clearAll' };

type OutMsg = { kind: 'tick'; id: string };

interface TimerRecord {
  handle: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
  isInterval: boolean;
}

const timers = new Map<string, TimerRecord>();

function clearTimer(id: string) {
  const rec = timers.get(id);
  if (!rec) return;
  if (rec.isInterval) clearInterval(rec.handle as ReturnType<typeof setInterval>);
  else clearTimeout(rec.handle as ReturnType<typeof setTimeout>);
  timers.delete(id);
}

function emit(id: string) {
  const msg: OutMsg = { kind: 'tick', id };
  (self as unknown as Worker).postMessage(msg);
}

self.addEventListener('message', (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (msg.kind === 'setInterval') {
    clearTimer(msg.id);
    const handle = setInterval(() => emit(msg.id), msg.ms);
    timers.set(msg.id, { handle, isInterval: true });
  } else if (msg.kind === 'setTimeout') {
    clearTimer(msg.id);
    const handle = setTimeout(() => {
      timers.delete(msg.id);
      emit(msg.id);
    }, msg.ms);
    timers.set(msg.id, { handle, isInterval: false });
  } else if (msg.kind === 'clear') {
    clearTimer(msg.id);
  } else if (msg.kind === 'clearAll') {
    for (const id of Array.from(timers.keys())) clearTimer(id);
  }
});
