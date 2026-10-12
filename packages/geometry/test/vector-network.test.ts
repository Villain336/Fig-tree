import { describe, expect, it } from "vitest";
import {
  addSegment,
  addVertex,
  bendSegment,
  closePath,
  contoursArea,
  curveSegment,
  deleteVertexPreservingShape,
  disconnectVertex,
  ellipseNetwork,
  flattenPath,
  handleOf,
  makeCorner,
  mergeVertices,
  moveHandle,
  moveVertices,
  networkFaces,
  networkStrokePath,
  pathContours,
  pathToNetwork,
  pointAt,
  polygonNetwork,
  rectangleNetwork,
  regionPath,
  removeSegments,
  removeVertices,
  reverseSegment,
  roundNetworkCorners,
  roundedPolygonPath,
  segmentCubic,
  setVertexMirroring,
  splitSegment,
  starNetwork,
  straightenSegment,
  toggleFaceFill,
  transformNetwork,
  validateNetwork,
  type VectorNetwork,
} from "../src";
import { rng, signedArea } from "./helpers";


const square: VectorNetwork = {
  vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
  segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }],
  regions: [{ loops: [[0, 1, 2, 3]], fillRule: "nonzero" }],
};

function areaOf(net: VectorNetwork, region = 0): number {
  return Math.abs(contoursArea(pathContours(regionPath(net, region))));
}

describe("vector network edits", () => {
  it("adds vertices and segments, and closes a path with a filled region", () => {
    let net: VectorNetwork = { vertices: [], segments: [], regions: [] };
    const pts = [[0, 0], [10, 0], [10, 10], [0, 10]] as const;
    for (const [x, y] of pts) net = addVertex(net, x, y).network;
    for (let i = 0; i < 3; i++) net = addSegment(net, i, i + 1).network;
    expect(net.regions).toHaveLength(0);
    const r = closePath(net, 3, 0);
    expect(r.region).toBe(0);
    expect(validateNetwork(r.network)).toEqual([]);
    expect(areaOf(r.network)).toBeCloseTo(100, 9);
  });

  it("splits a segment without changing its shape, keeping regions", () => {
    const curved = curveSegment(square, 0);
    const bent = bendSegment(curved, 0, 0.5, { x: 50, y: -30 });
    const before = segmentCubic(bent, 0);
    const { network, vertex, segment } = splitSegment(bent, 0, 0.3);
    expect(validateNetwork(network)).toEqual([]);
    expect(network.regions[0]!.loops[0]).toEqual([0, segment, 1, 2, 3]);
    const p = pointAt(before, 0.3);
    expect(network.vertices[vertex]!.x).toBeCloseTo(p.x, 9);
    // Both halves trace the original.
    for (const s of [0.1, 0.5, 0.9]) {
      const q = pointAt(segmentCubic(network, 0), s);
      const want = pointAt(before, 0.3 * s);
      expect(Math.hypot(q.x - want.x, q.y - want.y)).toBeLessThan(1e-9);
      const q2 = pointAt(segmentCubic(network, segment), s);
      const want2 = pointAt(before, 0.3 + 0.7 * s);
      expect(Math.hypot(q2.x - want2.x, q2.y - want2.y)).toBeLessThan(1e-9);
    }
    expect(areaOf(network)).toBeCloseTo(areaOf(bent), 6);
  });

  it("splits a segment walked backwards in a loop", () => {
    const rev = reverseSegment(square, 1);
    const { network, segment } = splitSegment(rev, 1, 0.5);
    expect(validateNetwork(network)).toEqual([]);
    // Segment 1 now runs 2 → 1; walking the loop 0 → 1 → 2 visits the second half first.
    expect(network.regions[0]!.loops[0]).toEqual([0, segment, 1, 2, 3]);
  });

  it("bends a segment so the point at t reaches the target", () => {
    for (const t of [0.2, 0.5, 0.8]) {
      const net = bendSegment(square, 0, t, { x: 40, y: -25 });
      const p = pointAt(segmentCubic(net, 0), t);
      expect(p.x).toBeCloseTo(40, 9);
      expect(p.y).toBeCloseTo(-25, 9);
      expect(validateNetwork(net)).toEqual([]);
    }
  });

  it("mirrors handles by angle and by angle and length", () => {
    let net = setVertexMirroring(square, 1, "angle-length");
    // Smooth handles were created, collinear and of equal length.
    const h0 = handleOf(net, 0, "end"), h1 = handleOf(net, 1, "start");
    expect(h0.x * h1.y - h0.y * h1.x).toBeCloseTo(0, 9);
    expect(Math.hypot(h0.x, h0.y)).toBeCloseTo(Math.hypot(h1.x, h1.y), 9);
    net = moveHandle(net, 1, "start", { x: 30, y: 40 });
    expect(handleOf(net, 0, "end")).toEqual({ x: -30, y: -40 });
    net = moveHandle(net, 1, "start", { x: 0, y: 10 }, "angle");
    const opp = handleOf(net, 0, "end");
    expect(opp.x).toBeCloseTo(0, 9);
    expect(opp.y).toBeCloseTo(-50, 9);
    net = moveHandle(net, 1, "start", { x: 5, y: 5 }, "none");
    expect(handleOf(net, 0, "end").y).toBeCloseTo(-50, 9);
    net = makeCorner(net, 1);
    expect(handleOf(net, 0, "end")).toEqual({ x: 0, y: 0 });
    expect(net.vertices[1]!.handleMirroring).toBeUndefined();
  });

  it("removes vertices and segments, dropping broken regions", () => {
    const net = removeVertices(square, [2]);
    expect(validateNetwork(net)).toEqual([]);
    expect(net.vertices).toHaveLength(3);
    expect(net.segments).toHaveLength(2);
    expect(net.regions).toHaveLength(0);
    const net2 = removeSegments(square, [0]);
    expect(net2.segments).toHaveLength(3);
    expect(net2.regions).toHaveLength(0);
  });

  it("merges and disconnects vertices", () => {
    // Open path 0-1-2-3, then merge 3 into 0: closed again.
    const open = removeSegments(square, [3]);
    const moved = moveVertices(open, [3], 0, -100);
    const merged = mergeVertices(moved, 0, 3);
    expect(validateNetwork(merged)).toEqual([]);
    expect(merged.vertices).toHaveLength(3);
    // Disconnect vertex 0 of the square: two vertices at the same place, region gone.
    const d = disconnectVertex(square, 0);
    expect(validateNetwork(d)).toEqual([]);
    expect(d.vertices).toHaveLength(5);
    expect(d.regions).toHaveLength(0);
  });

  it("transforms tangents with vertices", () => {
    const c = bendSegment(square, 0, 0.5, { x: 50, y: 20 });
    const t = transformNetwork(c, [2, 0, 0, 3, 5, 7]);
    const p = pointAt(segmentCubic(t, 0), 0.5);
    expect(p.x).toBeCloseTo(105, 9);
    expect(p.y).toBeCloseTo(67, 9);
  });
});

describe("faces and the fill tool", () => {
  it("finds the faces of a network with a branch (a square split by a diagonal)", () => {
    let net = { ...square, regions: [] } as VectorNetwork;
    net = addSegment(net, 0, 2).network;
    const faces = networkFaces(net);
    expect(faces).toHaveLength(2);
    for (const f of faces) expect(f.area).toBeCloseTo(5000, 6);
    // Fill one triangle, then the other, then unfill the first.
    net = toggleFaceFill(net, 70, 30);
    expect(net.regions).toHaveLength(1);
    expect(areaOf(net, 0)).toBeCloseTo(5000, 6);
    net = toggleFaceFill(net, 30, 70);
    expect(net.regions).toHaveLength(2);
    net = toggleFaceFill(net, 70, 30);
    expect(net.regions).toHaveLength(1);
    expect(validateNetwork(net)).toEqual([]);
  });

  it("detects holes: a separate loop inside a face", () => {
    const outer = pathToNetwork(roundedPolygonPath([[0, 0], [100, 0], [100, 100], [0, 100]]));
    const inner = pathToNetwork(roundedPolygonPath([[30, 30], [70, 30], [70, 70], [30, 70]]));
    const n = outer.vertices.length;
    const net: VectorNetwork = {
      vertices: [...outer.vertices, ...inner.vertices],
      segments: [...outer.segments, ...inner.segments.map((s) => ({ ...s, start: s.start + n, end: s.end + n }))],
      regions: [],
    };
    const faces = networkFaces(net);
    expect(faces).toHaveLength(2);
    const ring = faces.find((f) => f.loops.length === 2)!;
    expect(ring.area).toBeCloseTo(10000 - 1600, 6);
    const filled = toggleFaceFill(net, 10, 10);
    expect(areaOf(filled)).toBeCloseTo(8400, 6);
    // The region fills with nonzero and leaves the hole empty.
    const poly = flattenPath(regionPath(filled, 0));
    expect(Math.abs(signedArea(poly))).toBeLessThan(10000);
  });

  it("orders curves leaving a vertex in the same direction", () => {
    // Two curves from (0,0) to (100,0), both leaving horizontally, one bulging up and one down, plus a chord.
    const net: VectorNetwork = {
      vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      segments: [
        { start: 0, end: 1, tangentStart: { x: 40, y: 0 }, tangentEnd: { x: 0, y: -50 } },
        { start: 0, end: 1, tangentStart: { x: 40, y: 0 }, tangentEnd: { x: 0, y: 50 } },
        { start: 0, end: 1 },
      ],
      regions: [],
    };
    const faces = networkFaces(net);
    expect(faces).toHaveLength(2);
    expect(faces.every((f) => f.loops[0]!.length === 2)).toBe(true);
  });
});

describe("conversions", () => {
  it("flattens shapes to networks with exact geometry", () => {
    const rect = rectangleNetwork(100, 50, [10, 0, 20, 5], 0.5);
    expect(validateNetwork(rect)).toEqual([]);
    expect(rect.regions).toHaveLength(1);
    const ell = ellipseNetwork(100, 60, 0, Math.PI * 2, 0.5);
    expect(validateNetwork(ell)).toEqual([]);
    expect(ell.regions[0]!.loops).toHaveLength(2);
    const area = areaOf(ell);
    expect(area / (Math.PI * 50 * 30 * 0.75)).toBeCloseTo(1, 3);
    for (const net of [polygonNetwork(80, 80, 6, 4), starNetwork(80, 80, 5, 0.4, 2)]) {
      expect(validateNetwork(net)).toEqual([]);
      expect(net.regions).toHaveLength(1);
    }
  });

  it("strokes chains with joins through degree-two vertices only", () => {
    const net = addSegment(square, 0, 2).network; // diagonal: vertices 0 and 2 become junctions
    const path = networkStrokePath(net);
    const contours = flattenPath(path, undefined, 0.1).contourStarts.length - 1;
    // Chains: 0-1-2, 2-3-0, 0-2.
    expect(contours).toBe(3);
  });
});

describe("rounded corners", () => {
  it("matches rounded polygons on straight networks", () => {
    for (const r of [0, 5, 20, 80]) {
      const net = roundNetworkCorners(square, r);
      expect(validateNetwork(net)).toEqual([]);
      const want = Math.abs(contoursArea(pathContours(roundedPolygonPath([[0, 0], [100, 0], [100, 100], [0, 100]], r))));
      expect(areaOf(net)).toBeCloseTo(want, 6);
    }
  });

  it("rounds per vertex, keeps junctions sharp, and inserts arcs into regions", () => {
    const net = { ...square, vertices: square.vertices.map((v, i) => (i === 1 ? { ...v, cornerRadius: 30 } : v)) };
    const out = roundNetworkCorners(net, 0);
    expect(out.vertices).toHaveLength(5);
    expect(out.regions[0]!.loops[0]).toHaveLength(5);
    expect(areaOf(out)).toBeCloseTo(10000 - (900 - (Math.PI * 900) / 4), 0);
    const junction = roundNetworkCorners(addSegment(square, 0, 2).network, 10);
    // Vertices 0 and 2 have three segments: only 1 and 3 are rounded.
    expect(junction.vertices).toHaveLength(6);
  });

  it("rounds corners between curves", () => {
    const curved = bendSegment(square, 0, 0.5, { x: 50, y: -20 });
    const out = roundNetworkCorners(curved, 10);
    expect(validateNetwork(out)).toEqual([]);
    expect(areaOf(out)).toBeLessThan(areaOf(curved));
    expect(areaOf(out)).toBeGreaterThan(areaOf(curved) - 4 * 100);
  });
});

describe("network invariants under random edit sequences", () => {
  it("stays valid over 12,000 random operations (20 seeds)", { timeout: 300_000 }, () => {
    let applied = 0;
    const counts = new Map<string, number>();
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed * 7919);
      let net: VectorNetwork = { vertices: [], segments: [], regions: [] };
      const pick = (n: number): number => Math.floor(r() * n);
      const rp = (): number => Math.round((r() * 200 - 100) * 4) / 4;
      for (let step = 0; step < 600; step++) {
        const nv = net.vertices.length, ns = net.segments.length;
        const ops: [string, number][] = [
          ["addVertex", nv < 30 ? 3 : 0.5],
          ["addSegment", nv >= 2 ? 3 : 0],
          ["closePath", nv >= 3 ? 1 : 0],
          ["removeVertices", nv > 0 ? 0.6 : 0],
          ["removeSegments", ns > 0 ? 0.6 : 0],
          ["splitSegment", ns > 0 ? 1 : 0],
          ["mergeVertices", nv >= 2 ? 0.5 : 0],
          ["disconnect", nv > 0 ? 0.3 : 0],
          ["move", nv > 0 ? 1 : 0],
          ["bend", ns > 0 ? 1 : 0],
          ["moveHandle", ns > 0 ? 1 : 0],
          ["mirror", nv > 0 ? 0.6 : 0],
          ["corner", nv > 0 ? 0.3 : 0],
          ["straighten", ns > 0 ? 0.3 : 0],
          ["reverse", ns > 0 ? 0.3 : 0],
          ["toggleFill", ns > 2 ? 0.7 : 0],
          ["deleteHealing", nv > 0 ? 0.6 : 0],
          ["transform", 0.1],
        ];
        const total = ops.reduce((s, [, w]) => s + w, 0);
        let x = r() * total;
        let op = ops[0]![0];
        for (const [name, w] of ops) {
          if (x < w) {
            op = name;
            break;
          }
          x -= w;
        }
        try {
          switch (op) {
            case "addVertex": net = addVertex(net, rp(), rp()).network; break;
            case "addSegment": {
              const a = pick(nv), b = pick(nv);
              if (a === b) continue;
              const curved = r() < 0.5;
              net = addSegment(net, a, b, curved ? { x: rp() / 4, y: rp() / 4 } : undefined, curved ? { x: rp() / 4, y: rp() / 4 } : undefined).network;
              break;
            }
            case "closePath": {
              const a = pick(nv), b = pick(nv);
              if (a === b) continue;
              net = closePath(net, a, b).network;
              break;
            }
            case "removeVertices": net = removeVertices(net, [pick(nv)]); break;
            case "removeSegments": net = removeSegments(net, [pick(ns)]); break;
            case "splitSegment": net = splitSegment(net, pick(ns), 0.05 + r() * 0.9).network; break;
            case "mergeVertices": {
              const a = pick(nv), b = pick(nv);
              if (a === b) continue;
              net = mergeVertices(net, a, b);
              break;
            }
            case "disconnect": net = disconnectVertex(net, pick(nv)); break;
            case "move": net = moveVertices(net, [pick(nv)], rp() / 10, rp() / 10); break;
            case "bend": net = bendSegment(net, pick(ns), r(), { x: rp(), y: rp() }); break;
            case "moveHandle": net = moveHandle(net, pick(ns), r() < 0.5 ? "start" : "end", { x: rp() / 3, y: rp() / 3 }, (["none", "angle", "angle-length"] as const)[pick(3)]); break;
            case "mirror": net = setVertexMirroring(net, pick(nv), (["none", "angle", "angle-length"] as const)[pick(3)]!); break;
            case "corner": net = makeCorner(net, pick(nv)); break;
            case "straighten": {
              const s = pick(ns);
              const seg = net.segments[s]!;
              if (seg.start === seg.end) continue;
              net = straightenSegment(net, s);
              break;
            }
            case "reverse": net = reverseSegment(net, pick(ns)); break;
            case "toggleFill": net = toggleFaceFill(net, rp(), rp(), r() < 0.5 ? "nonzero" : "evenodd"); break;
            case "deleteHealing": net = deleteVertexPreservingShape(net, pick(nv)); break;
            case "transform": net = transformNetwork(net, [1, 0, 0, 1, rp() / 10, rp() / 10]); break;
          }
        } catch (e) {
          // Operations reject invalid requests with a RangeError and leave the network unchanged.
          if (!(e instanceof RangeError)) throw e;
          continue;
        }
        applied++;
        counts.set(op, (counts.get(op) ?? 0) + 1);
        const issues = validateNetwork(net);
        if (issues.length) throw new Error(`seed ${seed} step ${step} after ${op}: ${issues.join("; ")}`);
      }
    }
    expect(applied).toBeGreaterThanOrEqual(10_000);
    for (const [, c] of counts) expect(c).toBeGreaterThan(50);
  });
});
