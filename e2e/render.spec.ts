import { expect, test } from "@playwright/test";
import { encodePaint, sampleStops } from "../packages/renderer/src/paint";
import { hexColor, rgba, type GradientStop } from "../packages/renderer/src/types";
import { backends, coverageAt, diff, expectGolden, pixel, renderScene, type Image } from "./pixels";

/**
 * Pixel-quality suite. Scenes live in apps/editor/app/render-test/scenes.ts.
 * Black-on-white scenes are checked against exact analytic coverage; the
 * WebGPU path computes exact area so it must match within 8-bit rounding,
 * while WebGL2 uses 4x MSAA and gets proportionally looser bounds.
 */

/** Exact area of the axis-aligned rect intersected with pixel (px, py). */
function rectCoverage(x0: number, y0: number, x1: number, y1: number, px: number, py: number): number {
  const w = Math.max(0, Math.min(x1, px + 1) - Math.max(x0, px));
  const h = Math.max(0, Math.min(y1, py + 1) - Math.max(y0, py));
  return w * h;
}

/** Disk coverage by 32x32 supersampling (error < 0.002). */
function diskCoverage(cx: number, cy: number, r: number, px: number, py: number): number {
  let n = 0;
  for (let j = 0; j < 32; j++) {
    for (let i = 0; i < 32; i++) {
      const x = px + (i + 0.5) / 32, y = py + (j + 0.5) / 32;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) n++;
    }
  }
  return n / 1024;
}

interface CoverageStats {
  max: number;
  meanEdge: number;
}

function compareCoverage(img: Image, expected: (x: number, y: number) => number): CoverageStats {
  let max = 0;
  let edgeSum = 0;
  let edges = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const want = expected(x, y);
      const err = Math.abs(coverageAt(img, x, y) - want);
      max = Math.max(max, err);
      if (want > 0 && want < 1) {
        edgeSum += err;
        edges++;
      }
    }
  }
  return { max, meanEdge: edges ? edgeSum / edges : 0 };
}

const bounds = {
  webgpu: { rectMax: 0.006, diskMax: 0.12, diskMean: 0.05 },
  webgl2: { rectMax: 0.38, diskMax: 0.45, diskMean: 0.12 },
};

for (const backend of backends) {
  test.describe(`${backend} backend`, () => {
    test("matches analytic coverage of a fractional rectangle", async ({ page }) => {
      const img = await renderScene(page, "rect-fractional", backend);
      const stats = compareCoverage(img, (x, y) => rectCoverage(10.25, 20.5, 100.75, 60.4, x, y));
      expect(stats.max).toBeLessThan(bounds[backend].rectMax);
      expectGolden(`rect-fractional.${backend}`, img);
    });

    test("anti-aliases a circle smoothly", async ({ page }) => {
      const img = await renderScene(page, "circle", backend);
      const stats = compareCoverage(img, (x, y) => diskCoverage(64.3, 64.7, 50, x, y));
      expect(stats.max).toBeLessThan(bounds[backend].diskMax);
      expect(stats.meanEdge).toBeLessThan(bounds[backend].diskMean);
      expectGolden(`circle.${backend}`, img);
    });

    test("leaves no cracks between abutting shapes", async ({ page }) => {
      const img = await renderScene(page, "abutting", backend);
      // Interior of two triangles sharing a diagonal inside one path.
      for (const [x, y] of [[20, 20], [30, 30], [40, 40], [15, 45], [45, 15], [29, 31], [31, 29]] as const) {
        expect(pixel(img, x, y).slice(0, 3), `triangle seam at ${x},${y}`).toEqual([0, 0, 0]);
      }
      // Separate draws sharing the pixel-aligned edge x = 96.
      for (let y = 9; y < 55; y++) {
        expect(pixel(img, 95, y).slice(0, 3)).toEqual([0, 0, 0]);
        expect(pixel(img, 96, y).slice(0, 3)).toEqual([0, 0, 0]);
      }
      expectGolden(`abutting.${backend}`, img);
    });

    test("separate draws abutting at a fractional edge", async ({ page }) => {
      const img = await renderScene(page, "abutting-fractional", backend);
      const seam = pixel(img, 32, 16)[0];
      if (backend === "webgl2") {
        // MSAA assigns each sample to exactly one shape: no seam.
        expect(seam).toBe(0);
      } else {
        // Analytic AA composites two 50% coverages: 1 - 0.5 * 0.5 = 75% ink.
        // Known conflation artifact, tracked in docs/parity.md.
        expect(Math.abs(seam - 64)).toBeLessThanOrEqual(2);
      }
    });

    test("evaluates linear and radial gradients", async ({ page }) => {
      const img = await renderScene(page, "gradients", backend);
      const stops: GradientStop[] = [
        { offset: 0, color: hexColor("#ff0000") },
        { offset: 0.5, color: rgba(0, 0, 1, 0.5) },
        { offset: 1, color: hexColor("#00ff00") },
      ];
      const encoded = encodePaint({ type: "linear-gradient", start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, stops }).stops;
      const overWhite = (c: [number, number, number, number]): number[] => c.slice(0, 3).map((v) => (v + (1 - c[3])) * 255);
      let worst = 0;
      for (let y = 2; y < 78; y += 3) {
        for (let x = 2; x < 158; x += 3) {
          if (x >= 78 && x <= 81) continue; // shared edge between the two rects
          const t = x < 80 ? (x + 0.5 - 8) / 64 : Math.hypot(x + 0.5 - 120, y + 0.5 - 40) / 36;
          const want = overWhite(sampleStops(encoded, t));
          const got = pixel(img, x, y);
          for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(got[c]! - want[c]!));
        }
      }
      expect(worst).toBeLessThanOrEqual(3);
      expectGolden(`gradients.${backend}`, img);
    });

    test("applies the even-odd fill rule", async ({ page }) => {
      const img = await renderScene(page, "evenodd", backend);
      expect(pixel(img, 48, 48).slice(0, 3)).toEqual([255, 255, 255]);
      expect(pixel(img, 16, 16).slice(0, 3)).toEqual([0, 0, 0]);
      expect(pixel(img, 80, 48).slice(0, 3)).toEqual([0, 0, 0]);
    });

    test("isolates group opacity and clips to a rounded frame", async ({ page }) => {
      const img = await renderScene(page, "layers", backend);
      const near = (got: number[], want: number[]): void => {
        for (let c = 0; c < 3; c++) expect(Math.abs(got[c]! - want[c]!)).toBeLessThanOrEqual(2);
      };
      near(pixel(img, 44, 44), [127.5, 127.5, 255]); // overlap: only the top rect, at 50%
      near(pixel(img, 16, 16), [255, 127.5, 127.5]);
      near(pixel(img, 124, 48), [0, 170, 0]); // inside the clip
      near(pixel(img, 97, 17), [255, 255, 255]); // cut by the rounded corner
      near(pixel(img, 90, 48), [255, 255, 255]); // outside the frame
      expectGolden(`layers.${backend}`, img);
    });

    test("skips draws hidden by opaque fills without losing what is visible", async ({ page }) => {
      const img = await renderScene(page, "occlusion", backend);
      const near = (got: number[], want: number[]): void => {
        for (let c = 0; c < 3; c++) expect(Math.abs(got[c]! - want[c]!)).toBeLessThanOrEqual(2);
      };
      near(pixel(img, 40, 40), [0, 0, 255]); // red circle fully hidden
      near(pixel(img, 40, 16), [0, 127.5, 127.5]); // translucent green over blue
      near(pixel(img, 70, 16), [127.5, 127.5, 0]); // green over the part of the circle outside the blue rect
      near(pixel(img, 70, 40), [127.5, 0, 0]); // the group's opaque black is 50%: the circle still shows
      near(pixel(img, 88, 56), [255, 255, 255]); // white at 50% over white
      near(pixel(img, 76, 30), [255, 0, 0]); // circle outside every occluder
    });

    test("keeps gradient data bound when a layer target is created mid-frame", async ({ page }) => {
      const img = await renderScene(page, "layer-then-gradient", backend);
      const encoded = encodePaint({ type: "linear-gradient", start: { x: 80, y: 0 }, end: { x: 152, y: 0 }, stops: [
        { offset: 0, color: hexColor("#ff0000") },
        { offset: 0.5, color: rgba(0, 0, 1, 0.5) },
        { offset: 1, color: hexColor("#00ff00") },
      ] }).stops;
      for (const x of [84, 100, 116, 132, 148]) {
        const c = sampleStops(encoded, (x + 0.5 - 80) / 72);
        const want = c.slice(0, 3).map((v) => (v + (1 - c[3])) * 255);
        const got = pixel(img, x, 40);
        for (let k = 0; k < 3; k++) expect(Math.abs(got[k]! - want[k]!), `gradient at x=${x}`).toBeLessThanOrEqual(3);
      }
      // The group itself: isolated 50% opacity.
      const near = (got: number[], want: number[]): void => {
        for (let k = 0; k < 3; k++) expect(Math.abs(got[k]! - want[k]!)).toBeLessThanOrEqual(2);
      };
      near(pixel(img, 30, 30), [127.5, 127.5, 255]);
    });

    test("renders the mixed reference scene", async ({ page }) => {
      const img = await renderScene(page, "mixed", backend);
      expect(img.mode).toBe("direct");
      expectGolden(`mixed.${backend}`, img);
    });

    test("tile-cached frames match direct rendering after a pan", async ({ page }) => {
      const direct = await renderScene(page, "mixed", backend);
      const tiled = await renderScene(page, "mixed", backend, "tiled");
      expect(tiled.mode).toBe("tiles");
      // Same math at integer offsets; only float rounding of shifted coordinates differs.
      const d = diff(direct, tiled, 2);
      expect(d.fractionOver).toBeLessThan(0.001);
      expect(d.maxDelta).toBeLessThanOrEqual(8);
    });
  });
}

test("backends agree on the mixed scene", async ({ page }) => {
  const gpu = await renderScene(page, "mixed", "webgpu");
  const gl = await renderScene(page, "mixed", "webgl2");
  const d = diff(gpu, gl, 24);
  // Differences are confined to anti-aliased edges (analytic vs 4x MSAA).
  expect(d.meanDelta).toBeLessThan(1.5);
  expect(d.fractionOver).toBeLessThan(0.02);
});
