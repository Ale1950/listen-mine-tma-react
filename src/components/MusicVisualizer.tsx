import { useEffect, useRef, useState } from 'react';

/**
 * Concentric circles visualiser. Pure CSS animations driven by two React
 * triggers: `tapPulse` (increments on every computed tap) and `trackChange`
 * (increments on every new track). The component has no dependency on the
 * mining service — parents push counters and it reacts.
 *
 * States:
 *  - playing=true  → rings pulse, outward white beams + inward coloured beams
 *  - playing=false → everything dims to ~15 %
 *  - trackChange bumped → single burst of brightness for 900 ms
 *  - tapPulse bumped   → single core flash for 380 ms
 */
export function MusicVisualizer({
  playing,
  tapPulse,
  trackChange,
}: {
  playing: boolean;
  tapPulse: number;
  trackChange: number;
}) {
  const [flash, setFlash] = useState(false);
  const [burst, setBurst] = useState(false);

  // Tap flash (short)
  const firstTap = useRef(true);
  useEffect(() => {
    if (firstTap.current) { firstTap.current = false; return; }
    setFlash(true);
    const id = window.setTimeout(() => setFlash(false), 380);
    return () => window.clearTimeout(id);
  }, [tapPulse]);

  // Track burst (longer)
  const firstTrack = useRef(true);
  useEffect(() => {
    if (firstTrack.current) { firstTrack.current = false; return; }
    setBurst(true);
    const id = window.setTimeout(() => setBurst(false), 900);
    return () => window.clearTimeout(id);
  }, [trackChange]);

  // Slight speed variation per track (so every song "feels" different)
  const periodSec = 1.8 + ((trackChange * 0.17) % 0.9);

  const cls = [
    'viz',
    playing ? 'viz--on' : 'viz--off',
    flash ? 'viz--flash' : '',
    burst ? 'viz--burst' : '',
  ].filter(Boolean).join(' ');

  // 12 outgoing white beams + 12 incoming coloured beams, rotated around the centre.
  const outgoingBeams = Array.from({ length: 12 }, (_, i) => i);
  const incomingBeams = Array.from({ length: 12 }, (_, i) => i);

  return (
    <div
      className={cls}
      style={{ ['--viz-period' as any]: `${periodSec}s` }}
    >
      {/* Glow halo */}
      <div className="viz__halo" />

      {/* Concentric rings */}
      <div className="viz__ring viz__ring--1" />
      <div className="viz__ring viz__ring--2" />
      <div className="viz__ring viz__ring--3" />
      <div className="viz__ring viz__ring--4" />

      {/* Outgoing beams (white, from centre outward) */}
      <div className="viz__beams viz__beams--out">
        {outgoingBeams.map((i) => (
          <div
            key={`out-${i}`}
            className="viz__beam viz__beam--out"
            style={{ transform: `translate(-50%, -100%) rotate(${i * 30}deg)` }}
          />
        ))}
      </div>

      {/* Incoming beams (coloured, from outside inward) */}
      <div className="viz__beams viz__beams--in">
        {incomingBeams.map((i) => (
          <div
            key={`in-${i}`}
            className="viz__beam viz__beam--in"
            style={{ transform: `translate(-50%, -100%) rotate(${i * 30 + 15}deg)` }}
          />
        ))}
      </div>

      {/* Central core */}
      <div className="viz__core">
        <div className="viz__core-inner" />
      </div>
    </div>
  );
}
