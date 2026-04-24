import { useEffect, useRef, useState } from 'react';

/**
 * Canvas-based "cosmic pulse" visualiser + dancing mascot + 80s disco spotlights.
 *
 * Props:
 *   - playing:     true while Last.fm reports a live track.
 *   - tapPulse:    monotonically-increasing counter. Each bump emits a
 *                  short flash + 3 bright spark particles, swaps mascot pose,
 *                  and intensifies the spotlights for 200 ms.
 *   - trackChange: monotonically-increasing counter. Each bump emits a
 *                  centred burst of particles AND rotates the mascot to the
 *                  next valid group (1 → 2 → 3 → 1).
 */

const GROUP_COUNT = 3;
const POSES_PER_GROUP = 9;
const POSE_INTERVAL_MS = 150;

// Honour Vite's BASE_URL so paths resolve correctly when the app is mounted
// under a non-root prefix (e.g. Vercel preview subpaths).
const MASCOT_SRCS: string[][] = Array.from({ length: GROUP_COUNT }, (_, g) =>
  Array.from(
    { length: POSES_PER_GROUP },
    (_, p) => `${import.meta.env.BASE_URL}mascot/group${g + 1}_${p + 1}.png`,
  ),
);

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
  const [validGroups, setValidGroups] = useState<number[]>([]);
  const [poseIndex, setPoseIndex] = useState(0);
  const [groupSlot, setGroupSlot] = useState(0);
  const [bounce, setBounce] = useState(false);
  const [spotFlash, setSpotFlash] = useState(false);
  const lastTapForMascot = useRef(tapPulse);
  const lastTrackForMascot = useRef(trackChange);
  const bounceTimerRef = useRef<number | null>(null);
  const spotFlashTimerRef = useRef<number | null>(null);

  // Preload all 27 mascot images at startup. Group is considered "valid" only
  // when all 9 poses in it load successfully. If no group is fully valid, the
  // mascot stays hidden (fallback).
  useEffect(() => {
    let cancelled = false;
    const loaded = Array.from({ length: GROUP_COUNT }, () => 0);
    const failed = Array.from({ length: GROUP_COUNT }, () => false);
    MASCOT_SRCS.forEach((srcs, gi) => {
      srcs.forEach((src) => {
        const img = new Image();
        img.onload = () => {
          if (cancelled || failed[gi]) return;
          loaded[gi] += 1;
          if (loaded[gi] === POSES_PER_GROUP) {
            setValidGroups((prev) => (prev.includes(gi) ? prev : [...prev, gi].sort()));
          }
        };
        img.onerror = () => {
          failed[gi] = true;
        };
        img.src = src;
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Pose cycling: 150 ms always. Paused → freeze on pose 1 of current group.
  useEffect(() => {
    if (validGroups.length === 0) return;
    if (!playing) {
      setPoseIndex(0);
      return;
    }
    let cancelled = false;
    let timer: number;
    const tick = () => {
      if (cancelled) return;
      setPoseIndex((p) => (p + 1) % POSES_PER_GROUP);
      timer = window.setTimeout(tick, POSE_INTERVAL_MS);
    };
    timer = window.setTimeout(tick, POSE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [playing, validGroups.length]);

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

  // Tap pulse → flash + 3 bright sparks + instant pose swap + bounce + spotlight flash
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
        hue: 180 + Math.random() * 20,
        size: 2.4 + Math.random() * 1.6,
        bright: 1,
        glow: 5,
      });
    }

    // Mascot reaction: instant pose swap + 200ms bounce
    if (tapPulse !== lastTapForMascot.current) {
      lastTapForMascot.current = tapPulse;
      setPoseIndex((p) => (p + 1) % POSES_PER_GROUP);
      setBounce(true);
      if (bounceTimerRef.current) window.clearTimeout(bounceTimerRef.current);
      bounceTimerRef.current = window.setTimeout(() => setBounce(false), 200);
    }

    // Spotlight intensity flash 200ms
    setSpotFlash(true);
    if (spotFlashTimerRef.current) window.clearTimeout(spotFlashTimerRef.current);
    spotFlashTimerRef.current = window.setTimeout(() => setSpotFlash(false), 200);
  }, [tapPulse]);

  // Track change → full-circle particle burst + rotate to next valid group
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
        x: cx,
        y: cy,
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
      setGroupSlot((slot) => slot + 1);
      setPoseIndex(0);
    }
  }, [trackChange]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (bounceTimerRef.current) window.clearTimeout(bounceTimerRef.current);
      if (spotFlashTimerRef.current) window.clearTimeout(spotFlashTimerRef.current);
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

      ctx.fillStyle = state.playing ? 'rgba(7, 11, 24, 0.13)' : 'rgba(7, 11, 24, 0.07)';
      ctx.fillRect(0, 0, cssW, cssH);

      const maxParticles = state.playing ? 110 : 30;
      if (state.particles.length < maxParticles) {
        const every = state.playing ? 2 : 8;
        if (state.t % every === 0) spawnStream();
      }

      const cx = cssW / 2;
      const cy = cssH / 2;

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

      state.tapFlash = Math.max(0, state.tapFlash - 0.08);
      state.trackBurst = Math.max(0, state.trackBurst - 0.015);

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
        p.vx += (dx / dist) * pull;
        p.vy += (dy / dist) * pull;
        p.vx += (-dy / dist) * swirl;
        p.vy += ( dx / dist) * swirl;
        p.vx *= damp;
        p.vy *= damp;
        p.x += p.vx;
        p.y += p.vy;

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

      if (state.playing || state.tapFlash > 0 || state.trackBurst > 0) {
        const coreR = 9 + pulse * 3 + state.tapFlash * 8 + state.trackBurst * 14;
        const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3);
        const bright = 0.9 + state.tapFlash * 0.1 + state.trackBurst * 0.1;
        cg.addColorStop(0,    `rgba(255, 255, 255, ${Math.min(1, bright)})`);
        cg.addColorStop(0.35, `rgba(189, 242, 255, ${bright * 0.6})`);
        cg.addColorStop(1,    'rgba(56, 225, 255, 0)');
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

  const currentGroup =
    validGroups.length > 0 ? validGroups[groupSlot % validGroups.length] : -1;
  const mascotSrc = currentGroup >= 0 ? MASCOT_SRCS[currentGroup][poseIndex] : null;

  return (
    <div className={`viz-wrap ${playing ? 'viz-wrap--on' : 'viz-wrap--off'}`}>
      <canvas ref={canvasRef} className="viz-canvas" />

      {/* 80s disco spotlights — two beams, phase-shifted colours, swinging */}
      <div
        className={`viz-spotlight viz-spotlight--1 ${playing ? 'on' : 'off'} ${spotFlash ? 'flash' : ''}`}
        aria-hidden="true"
      />
      <div
        className={`viz-spotlight viz-spotlight--2 ${playing ? 'on' : 'off'} ${spotFlash ? 'flash' : ''}`}
        aria-hidden="true"
      />

      {mascotSrc && (
        <div
          className={`viz-mascot ${playing ? 'viz-mascot--on' : 'viz-mascot--off'} ${bounce ? 'viz-mascot--bounce' : ''}`}
          aria-hidden="true"
        >
          <img src={mascotSrc} alt="" draggable={false} />
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
