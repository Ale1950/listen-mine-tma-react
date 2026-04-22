/**
 * ═══ Background Keep-Alive ═══
 *
 * Two tricks to reduce how aggressively browsers throttle a hidden tab:
 *
 *   1. Play a silent audio track via Web Audio API. Most desktop browsers
 *      skip background-tab throttling while audio is actively playing.
 *
 *   2. Register a minimal Service Worker so the app is "installed" and the
 *      browser keeps its JS context warm.
 *
 * iOS Safari / Telegram in-app browser don't honour either (iOS suspends
 * background tabs hard); this is mainly for desktop browsers.
 */

let audioCtx: AudioContext | null = null;
let osc: OscillatorNode | null = null;
let gain: GainNode | null = null;

/** Start a silent oscillator so the browser treats the tab as "playing audio". */
export function startSilentKeepAlive() {
  if (typeof window === 'undefined') return;
  if (audioCtx) return;
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  try {
    audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume().catch(() => {});
    }
    osc = audioCtx.createOscillator();
    gain = audioCtx.createGain();
    gain.gain.value = 0; // fully silent
    osc.frequency.value = 440; // inaudible anyway at 0 gain
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
  } catch (e) {
    console.warn('[keep-alive] audio context failed:', e);
    audioCtx = null;
    osc = null;
    gain = null;
  }
}

export function stopSilentKeepAlive() {
  try { osc?.stop(); } catch {}
  try { osc?.disconnect(); } catch {}
  try { gain?.disconnect(); } catch {}
  try { void audioCtx?.close(); } catch {}
  audioCtx = null;
  osc = null;
  gain = null;
}

/** Register the minimal service worker shipped in public/sw.js. */
export async function registerKeepAliveSw(): Promise<void> {
  if (typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  const base = import.meta.env.BASE_URL || '/';
  const url = `${base}sw.js`;
  try {
    await navigator.serviceWorker.register(url, { scope: base });
  } catch (e) {
    console.warn('[keep-alive] SW register failed:', e);
  }
}
