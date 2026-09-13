import { useMemo } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Ambient drifting leaves — the Zogal landing-page motif, carried into the
 * ERP's signed-out screens only.
 *
 * Deliberately NOT on working screens: a till operator counting money does
 * not need motion in their peripheral vision. This is atmosphere for the
 * moments when nothing is happening (login, terminal setup).
 *
 * The artwork is the same leaves as zogal.app, extracted from those 1–1.8 MB
 * SVGs (they were raster images in an SVG wrapper) and downscaled to ~13–20 KB
 * PNGs — 93 KB for the set instead of 9 MB. CSS keyframes, no JS loop, no
 * animation library; transform + opacity only so it never leaves the
 * compositor. Honours prefers-reduced-motion (see styles.css).
 */
const LEAVES = [1, 2, 3, 4, 5, 6];

interface Drift {
  src: string;
  left: number;
  size: number;
  delay: number;
  duration: number;
  drift: number;
  spin: number;
  opacity: number;
}

export function LeafField({ count = 9, className }: { count?: number; className?: string }) {
  // Fixed per mount: a deterministic-looking scatter that doesn't re-randomise on render.
  const drifts = useMemo<Drift[]>(
    () =>
      Array.from({ length: count }, (_, i) => {
        const r = (n: number) => ((Math.sin((i + 1) * n) + 1) / 2); // stable pseudo-random
        return {
          src: `/brand/leaf-${LEAVES[i % LEAVES.length]}.png`,
          left: r(12.9898) * 100,
          size: 26 + r(78.233) * 34,
          delay: r(45.164) * 18,
          duration: 16 + r(94.673) * 14,
          drift: (r(31.7) - 0.5) * 120,
          spin: (r(57.3) - 0.5) * 520,
          opacity: 0.18 + r(23.1) * 0.22,
        };
      }),
    [count],
  );

  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      {drifts.map((d, i) => (
        <img
          key={i}
          src={d.src}
          alt=""
          draggable={false}
          className="absolute top-0 will-change-transform animate-[zogal-leaf-fall_linear_infinite]"
          style={{
            left: `${d.left}%`,
            width: d.size,
            height: d.size,
            opacity: d.opacity,
            animationDelay: `-${d.delay}s`,
            animationDuration: `${d.duration}s`,
            ["--leaf-drift" as string]: `${d.drift}px`,
            ["--leaf-spin" as string]: `${d.spin}deg`,
          }}
        />
      ))}
    </div>
  );
}
