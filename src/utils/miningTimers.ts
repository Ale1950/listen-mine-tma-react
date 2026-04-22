/**
 * ═══ Mining Timers (main-thread wrapper around miningWorker) ═══
 *
 * Singleton facade that forwards setInterval/setTimeout requests to the
 * Web Worker, then dispatches the worker's tick messages back to main-
 * thread callbacks. Keeps the mining loop running at the intended cadence
 * even when the browser tab is hidden.
 *
 * Usage:
 *   miningTimers.setInterval('tap', 1875, () => { addTap(x, y); ... });
 *   miningTimers.setTimeout('watchdog', 33000, () => { ... });
 *   miningTimers.clear('tap');
 *   miningTimers.clearAll();
 *
 * IDs are strings — the worker tracks one timer per ID, so re-registering
 * the same ID replaces the previous timer. This matches the semantics we
 * already used with *Ref variables in App.tsx.
 */

type OutMsg = { kind: 'tick'; id: string };

class MiningTimers {
  private worker: Worker | null = null;
  private handlers = new Map<string, () => void>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('../workers/miningWorker.ts', import.meta.url), {
      type: 'module',
    });
    w.addEventListener('message', (ev: MessageEvent<OutMsg>) => {
      const msg = ev.data;
      if (msg?.kind !== 'tick') return;
      const fn = this.handlers.get(msg.id);
      if (fn) fn();
    });
    this.worker = w;
    return w;
  }

  setInterval(id: string, ms: number, cb: () => void) {
    this.handlers.set(id, cb);
    this.ensureWorker().postMessage({ kind: 'setInterval', id, ms });
  }

  /** Callback fires exactly once; the ID is auto-cleared after. */
  setTimeout(id: string, ms: number, cb: () => void) {
    this.handlers.set(id, () => {
      this.handlers.delete(id);
      cb();
    });
    this.ensureWorker().postMessage({ kind: 'setTimeout', id, ms });
  }

  clear(id: string) {
    this.handlers.delete(id);
    this.worker?.postMessage({ kind: 'clear', id });
  }

  clearAll() {
    this.handlers.clear();
    this.worker?.postMessage({ kind: 'clearAll' });
  }
}

export const miningTimers = new MiningTimers();
