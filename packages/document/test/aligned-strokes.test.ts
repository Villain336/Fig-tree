import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Scene, type SceneNode } from "@fig-tree/renderer";
import { containsPoint, flattenPath, strokePath, type Polylines } from "@fig-tree/geometry";
import { SceneBridge } from "../src";
import { makeDoc } from "./helpers";

const RED = { type: "solid" as const, color: { r: 1, g: 0, b: 0, a: 1 } };

/** The set of points a scene node's stroke paints, honouring a clip wrapper. */
function strokeCover(n: SceneNode): (x: number, y: number) => boolean {
  const target = n.clipsContent ? n.children[0]! : n;
  const stroke: Polylines = strokePath(target.path!, target.stroke!, undefined, 0.01);
  const clip: Polylines | null = n.clipsContent ? flattenPath(n.path!, undefined, 0.01) : null;
  return (x, y) => containsPoint(stroke, x, y, "nonzero") && (!clip || containsPoint(clip, x, y, n.fillRule));
}

describe("aligned rectangle strokes", () => {
  it("cover the same band whether drawn as offset rectangles or clipped double-width strokes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 160 }),
        fc.integer({ min: 20, max: 160 }),
        fc.array(fc.constantFrom(0, 0, 3, 8, 20, 60), { minLength: 4, maxLength: 4 }),
        fc.constantFrom(1, 2, 5, 9),
        fc.constantFrom("inside", "outside"),
        fc.constantFrom("miter", "round", "bevel"),
        (width, height, [tl, tr, br, bl], weight, align, join) => {
          const { doc, page, user } = makeDoc(1);
          const props = { width, height, cornerRadius: { topLeft: tl!, topRight: tr!, bottomRight: br!, bottomLeft: bl! }, strokes: [RED], strokeWeight: weight, strokeAlign: align, strokeJoin: join };
          doc.apply(
            [
              { type: "createNode", node: { id: "fast", type: "rectangle", props }, parent: page },
              // Corner smoothing 1e-9 is visually nothing but forces the clipped construction.
              { type: "createNode", node: { id: "ref", type: "rectangle", props: { ...props, cornerSmoothing: 1e-9 } }, parent: page },
            ],
            user,
          );
          const scene = new Scene();
          const bridge = new SceneBridge(doc, scene);
          const fast = bridge.sceneNodeFor("fast")!.children.at(-1)!;
          const ref = bridge.sceneNodeFor("ref")!.children.at(-1)!;
          expect(ref.clipsContent).toBe(true);
          const a = strokeCover(fast);
          const b = strokeCover(ref);
          let mismatches = 0;
          let samples = 0;
          for (let y = -12; y <= height + 12; y += 0.73) {
            for (let x = -12; x <= width + 12; x += 0.81) {
              samples++;
              if (a(x, y) !== b(x, y)) mismatches++;
            }
          }
          // Only points within the flattening tolerance of an edge may disagree.
          expect(mismatches / samples).toBeLessThan(0.003);
        },
      ),
      { numRuns: Number(process.env.STROKE_RUNS ?? 60) },
    );
  }, 60_000);
});
