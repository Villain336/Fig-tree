import { Path, ellipsePath, multiply, rotation, roundedRectPath, translation } from "@fig-tree/geometry";
import { Scene, rgba, type Color, type Paint } from "@fig-tree/renderer";

export const WORLD_WIDTH = 6000;
export const WORLD_HEIGHT = 4000;

/** Deterministic PRNG (mulberry32) so every run benchmarks the same scene. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds the benchmark scene: `count` shapes scattered over the world.
 * Mix: 35% rounded rects (per-corner radii, some smoothed), 30% ellipses,
 * 35% cubic blobs; 30% of all fills are gradients and 10% carry strokes.
 */
export function buildBenchScene(count: number, seed = 7): Scene {
  const rnd = random(seed);
  const scene = new Scene();
  const color = (alpha = 1): Color => rgba(rnd(), rnd(), rnd(), alpha);
  for (let i = 0; i < count; i++) {
    const size = 12 + rnd() * rnd() * 110;
    const x = rnd() * (WORLD_WIDTH - size);
    const y = rnd() * (WORLD_HEIGHT - size);
    const kind = rnd();
    let path: Path;
    if (kind < 0.35) {
      const r = (): number => rnd() * size * 0.4;
      path = roundedRectPath(-size / 2, -size * 0.35, size, size * 0.7, [r(), r(), r(), r()], rnd() < 0.3 ? 0.6 : 0);
    } else if (kind < 0.65) {
      path = ellipsePath(0, 0, size / 2, size * (0.25 + rnd() * 0.25));
    } else {
      path = blob(rnd, size / 2);
    }
    const g = rnd();
    let fill: Paint;
    if (g < 0.15) {
      fill = {
        type: "linear-gradient",
        start: { x: -size / 2, y: 0 },
        end: { x: size / 2, y: 0 },
        stops: [{ offset: 0, color: color() }, { offset: 1, color: color(0.6) }],
      };
    } else if (g < 0.3) {
      fill = {
        type: "radial-gradient",
        center: { x: 0, y: 0 },
        radius: size / 2,
        stops: [{ offset: 0, color: color() }, { offset: 0.6, color: color() }, { offset: 1, color: color(0.2) }],
      };
    } else {
      fill = { type: "solid", color: color(0.55 + rnd() * 0.45) };
    }
    scene.root.appendChild(scene.createNode({
      path,
      fill,
      transform: multiply(translation(x + size / 2, y + size / 2), rotation(rnd() * Math.PI)),
      stroke: rnd() < 0.1 ? { paint: { type: "solid", color: color() }, width: 1 + rnd() * 3, join: "round" } : null,
    }));
  }
  return scene;
}

/** A closed blob of cubic segments around the origin. */
function blob(rnd: () => number, radius: number): Path {
  const n = 4 + Math.floor(rnd() * 3);
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const r = radius * (0.6 + rnd() * 0.4);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, a };
  });
  const k = (radius * 4) / (3 * n);
  const path = new Path().moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % n]!;
    path.cubicTo(
      p.x - Math.sin(p.a) * k, p.y + Math.cos(p.a) * k,
      q.x + Math.sin(q.a) * k, q.y - Math.cos(q.a) * k,
      q.x, q.y,
    );
  }
  return path.close();
}
