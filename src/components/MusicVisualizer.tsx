import { useEffect, useRef, useState } from 'react';

/**
 * Canvas-based "cosmic pulse" visualiser.
 *
 * A glowing nebula core surrounded by ~90 particles that stream in toward
 * the centre with a slight tangential swirl. Pure canvas + requestAnimation
 * Frame, no libraries. Pauses gently when the music stops.
 *
 * Props:
 *   - playing:     true while Last.fm reports a live track. Controls spawn
 *                  rate, pull strength, and core brightness.
 *   - tapPulse:    monotonically-increasing counter. Each bump emits a
 *                  short flash + 3 bright spark particles.
 *   - trackChange: monotonically-increasing counter. Each bump emits a
 *                  centred burst of ~25 particles in all directions.
 */
const MASCOT_COUNT = 9;
const MASCOT_SRCS = Array.from({ length: MASCOT_COUNT }, (_, i) => `/mascot/sprite${i + 1}.png`);

export function MusicVisualizer({
  playing,
  tapPulse,
  trackChange,
}: {
  playing: boolean;
  tapPulse: number;
  trackChange: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Mascot state
  const [mascotReady, setMascotReady] = useState(false);
  const [spriteIndex, setspriteIndex] = useState(0);
  const [bounce, setBounce] = useState(false);
  const burstUntilRef = useRef(0);
  const lastTapForMascot = useRef(tapPulse);
  const lastTrackForMascot = useRef(trackChange);
  const bounceTimerRef = useRef<number | null>(null);

  // Preload all 9 mascot images at startup. If any fails, hide mascot entirely.
  useEffect(() => {
    let cancelled = false;
    let loaded = 0;
    let failed = false;
    for (const src of MASCOT_SRCS) {
      const img = new Image();
      img.onload = () => {
        if (cancelled || failed) return;
        loaded += 1;
        if (loaded === MASCOT_COUNT) setMascotReady(true);
      };
      img.onerror = () => {
        failed = true;
        if (!cancelled) setMascotReady(false);
      };
      img.src = src;
    }
    return () => { cancelled = true; };
  }, []);

  // sprite cycling: normal 450ms, burst 200ms for 2s after a track change.
  // Paused → stay on sprite 0.
  useEffect(() => {
    if (!mascotReady) return;
    if (!playing) {
      setspriteIndex(0);
      return;
    }
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      setspriteIndex((p) => (p + 1) % MASCOT_COUNT);
      const bursting = Date.now() < burstUntilRef.current;
      const delay = bursting ? 200 : 450;
      timer = window.setTimeout(tick, delay);
    };
    let timer = window.setTimeout(tick, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [playing, mascotReady]);

  // Mutable state that outlives re-renders. Kept out of React state to avoid
  // re-rendering 60 times per second.
  const stateRef = useRef({
    particles: [] as Particle[],
    playing: false,
    tapFlash: 0,
    trackBurst: 0,
    t: 0,
    lastTap: tapPulse,
    lastTrack: trackChange,
  });

  // Sync playing flag
  useEffect(() => {
    stateRef.current.playing = playing;
  }, [playing]);

  // Tap pulse → flash + 3 bright sparks + instant sprite swap + bounce
  useEffect(() => {
    const s = stateRef.current;
    if (tapPulse === s.lastTap) return;
    s.lastTap = tapPulse;
    s.tapFlash = 1;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const cx = W / 2;
    const cy = H / 2;
    for (let i = 0; i < 3; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2.2 + Math.random() * 1.4;
      s.particles.push({
        x: cx + Math.cos(angle) * 18,
        y: cy + Math.sin(angle) * 18,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 70 + Math.random() * 30,
        hue: 180 + Math.random() * 20, // cyan-ish
        size: 2.4 + Math.random() * 1.6,
        bright: 1,
        glow: 5,
      });
    }

    // Mascot reaction: instant sprite swap + 200ms bounce
    if (tapPulse !== lastTapForMascot.current) {
      lastTapForMascot.current = tapPulse;
      setspriteIndex((p) => (p + 1) % MASCOT_COUNT);
      setBounce(true);
      if (bounceTimerRef.current) window.clearTimeout(bounceTimerRef.current);
      bounceTimerRef.current = window.setTimeout(() => setBounce(false), 200);
    }
  }, [tapPulse]);

  // Track change → full-circle burst + mascot burst-mode for 2s
  useEffect(() => {
    const s = stateRef.current;
    if (trackChange === s.lastTrack) return;
    s.lastTrack = trackChange;
    s.trackBurst = 1;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const cx = W / 2;
    const cy = H / 2;
    const hues = [195, 215, 270, 330, 200];
    for (let i = 0; i < 26; i++) {
      const angle = (i / 26) * Math.PI * 2 + Math.random() * 0.2;
      const speed = 2.2 + Math.random() * 1.8;
      s.particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 130 + Math.random() * 50,
        hue: hues[i % hues.length],
        size: 2 + Math.random() * 2,
        bright: 1,
        glow: 4.5,
      });
    }

    if (trackChange !== lastTrackForMascot.current) {
      lastTrackForMascot.current = trackChange;
      burstUntilRef.current = Date.now() + 2000;
    }
  }, [trackChange]);

  // Cleanup bounce timer on unmount
  useEffect(() => {
    return () => {
      if (bounceTimerRef.current) window.clearTimeout(bounceTimerRef.current);
    };
  }, []);

  // Main render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = 560;
    const cssH = 260;
    canvas.width = cssW * DPR;
    canvas.height = cssH * DPR;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx.scale(DPR, DPR);

    const state = stateRef.current;
    let raf = 0;

    const spawnStream = () => {
      const hues = [195, 215, 270, 330, 180];
      const edge = Math.floor(Math.random() * 4);
      let x = 0, y = 0, vx = 0, vy = 0;
      const speed = 0.35 + Math.random() * 0.65;
      if (edge === 0)      { x = Math.random() * cssW; y = -8; vx = (Math.random() - 0.5) * 0.5; vy = speed; }
      else if (edge === 1) { x = cssW + 8;             y = Math.random() * cssH; vx = -speed; vy = (Math.random() - 0.5) * 0.5; }
      else if (edge === 2) { x = Math.random() * cssW; y = cssH + 8; vx = (Math.random() - 0.5) * 0.5; vy = -speed; }
      else                 { x = -8;                   y = Math.random() * cssH; vx = speed; vy = (Math.random() - 0.5) * 0.5; }
      state.particles.push({
        x, y, vx, vy,
        life: 0,
        maxLife: 220 + Math.random() * 140,
        hue: hues[Math.floor(Math.random() * hues.length)],
        size: 1.1 + Math.random() * 1.8,
        bright: 0.55 + Math.random() * 0.35,
        glow: 3.5,
      });
    };

    const render = () => {
      state.t += 1;

      // Fade trail (shorter when paused so the scene dims)
      ctx.fillStyle = state.playing ? 'rgba(7, 11, 24, 0.13)' : 'rgba(7, 11, 24, 0.07)';
      ctx.fillRect(0, 0, cssW, cssH);

      // Particle spawns
      const maxParticles = state.playing ? 110 : 30;
      if (state.particles.length < maxParticles) {
        const every = state.playing ? 2 : 8;
        if (state.t % every === 0) spawnStream();
      }

      const cx = cssW / 2;
      const cy = cssH / 2;

      // Central aurora glow
      const pulse = 0.5 + 0.5 * Math.sin(state.t * 0.03);
      const basePulse = state.playing ? 0.45 + pulse * 0.3 : 0.08;
      const flashBoost = state.tapFlash * 0.4;
      const burstBoost = state.trackBurst * 0.55;
      const coreAlpha = Math.min(1, basePulse + flashBoost + burstBoost);

      const glowR = 150 + pulse * 25 + state.trackBurst * 40;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
      grad.addColorStop(0, `rgba(255, 255, 255, ${coreAlpha})`);
      grad.addColorStop(0.14, `rgba(189, 242, 255, ${coreAlpha * 0.75})`);
      grad.addColorStop(0.34, `rgba(56, 225, 255, ${coreAlpha * 0.55})`);
      grad.addColorStop(0.58, `rgba(139, 92, 246, ${coreAlpha * 0.35})`);
      grad.addColorStop(0.82, `rgba(255, 42, 138, ${coreAlpha * 0.22})`);
      grad.addColorStop(1, 'rgba(7, 11, 24, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cssW, cssH);

      // Decay flashes
      state.tapFlash = Math.max(0, state.tapFlash - 0.08);
      state.trackBurst = Math.max(0, state.trackBurst - 0.015);

      // Update + draw particles (additive glow via source-over with alpha)
      ctx.globalCompositeOperation = 'lighter';
      const pull = state.playing ? 0.020 : 0.006;
      const swirl = state.playing ? 0.022 : 0.008;
      const damp = 0.985;

      const kept: Particle[] = [];
      for (const p of state.particles) {
        p.life += 1;
        if (p.life >= p.maxLife) continue;

        const dx = cx - p.x;
        const dy = cy - p.y;
        const dist = Math.max(12, Math.hypot(dx, dy));
        // Gentle gravitational pull + tangential swirl
        p.vx += (dx / dist) * pull;
        p.vy += (dy / dist) * pull;
        p.vx += (-dy / dist) * swirl;
        p.vy += ( dx / dist) * swirl;
        p.vx *= damp;
        p.vy *= damp;
        p.x += p.vx;
        p.y += p.vy;

        // Kill if it drifts out of view or converges
        if (p.x < -40 || p.x > cssW + 40 || p.y < -40 || p.y > cssH + 40) continue;

        const t = p.life / p.maxLife;
        const fade = 1 - t * t;
        const alpha = fade * p.bright * (state.playing ? 1 : 0.38);
        const r = p.size * p.glow;

        const pg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        pg.addColorStop(0, `hsla(${p.hue}, 100%, 88%, ${Math.min(1, alpha)})`);
        pg.addColorStop(0.45, `hsla(${p.hue}, 100%, 66%, ${alpha * 0.55})`);
        pg.addColorStop(1, `hsla(${p.hue}, 100%, 50%, 0)`);
        ctx.fillStyle = pg;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();

        kept.push(p);
      }
      state.particles = kept;
      ctx.globalCompositeOperation = 'source-over';

      // Bright core bead on top
      if (state.playing || state.tapFlash > 0 || state.trackBurst > 0) {
        const coreR = 9 + pulse * 3 + state.tapFlash * 8 + state.trackBurst * 14;
        const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3);
        const bright = 0.9 + state.tapFlash * 0.1 + state.trackBurst * 0.1;
        cg.addColorStop(0,   `rgba(255, 255, 255, ${Math.min(1, bright)})`);
        cg.addColorStop(0.35,`rgba(189, 242, 255, ${bright * 0.6})`);
        cg.addColorStop(1,   'rgba(56, 225, 255, 0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(cx, cy, coreR * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }

      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className={`viz-wrap ${playing ? 'viz-wrap--on' : 'viz-wrap--off'}`}>
      <canvas ref={canvasRef} className="viz-canvas" />
      {mascotReady && (
        <div
          className={`viz-mascot ${playing ? 'viz-mascot--on' : 'viz-mascot--off'} ${bounce ? 'viz-mascot--bounce' : ''}`}
          aria-hidden="true"
        >
          <img src={MASCOT_SRCS[spriteIndex]} alt="" draggable={false} />
        </div>
      )}
    </div>
  );
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  hue: number;
  size: number;
  bright: number;
  glow: number;
}
