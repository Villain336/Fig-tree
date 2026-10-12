import type { Paint } from "@fig-tree/document";
import { describe, expect, it } from "vitest";
import { gradientHandles } from "../src";
import { drag, rect, setup } from "./helpers";

const stops = [
  { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
  { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
];

describe("gradient handles on the canvas", () => {
  it("drags linear gradient ends and stops, as one undo step each", () => {
    const s = setup((page) => [rect("a", page, 100, 100, 200, 100, { fills: [{ type: "linear-gradient", start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 }, stops }] })]);
    s.editor.select(["a"]);
    s.editor.setPaintEdit({ id: "a", key: "fills", index: 0 });
    const hs = gradientHandles(s.editor);
    expect(hs.map((h) => [h.id, h.center])).toEqual([
      ["canvas.handle.gradient.stop.0", { x: 100, y: 150 }],
      ["canvas.handle.gradient.stop.1", { x: 300, y: 150 }],
      ["canvas.handle.gradient.start", { x: 100, y: 150 }],
      ["canvas.handle.gradient.end", { x: 300, y: 150 }],
    ]);
    // The end handle sits under the last stop: stops win, so drag the end from a point on it.
    expect(s.editor.overlay().some((i) => i.kind === "handle" && i.id === "canvas.handle.gradient.end")).toBe(true);
    drag(s.editor, [300, 150], [250, 150]);
    let p = s.doc.get<Paint[]>("a", "fills")[0]! as Extract<Paint, { type: "linear-gradient" }>;
    expect(p.stops[1]!.position).toBe(0.75);
    s.editor.run("edit.undo");
    // Move the stop out of the way, then drag the end handle down.
    s.doc.apply([{ type: "updateProps", id: "a", props: { fills: [{ ...p, stops: [stops[0]!, { ...stops[1]!, position: 0.5 }] }] } }], s.doc.actor("x"));
    drag(s.editor, [300, 150], [300, 200]);
    p = s.doc.get<Paint[]>("a", "fills")[0]! as Extract<Paint, { type: "linear-gradient" }>;
    expect(p.end).toEqual({ x: 1, y: 1 });
    expect(s.editor.selection).toEqual(["a"]);
  });

  it("moves a radial gradient's radius handles with its center", () => {
    const s = setup((page) => [rect("a", page, 0, 0, 100, 100, { fills: [{ type: "radial-gradient", center: { x: 0.5, y: 0.5 }, radiusX: { x: 1, y: 0.5 }, radiusY: { x: 0.5, y: 1 }, stops }] })]);
    s.editor.setPaintEdit({ id: "a", key: "fills", index: 0 });
    // The center sits under the first stop; nudge the stop away first.
    const fills = s.doc.get<Paint[]>("a", "fills");
    s.doc.apply([{ type: "updateProps", id: "a", props: { fills: [{ ...fills[0]!, stops: [{ ...stops[0]!, position: 0.3 }, stops[1]!] }] } }], s.doc.actor("x"));
    drag(s.editor, [50, 50], [60, 40]);
    const p = s.doc.get<Paint[]>("a", "fills")[0]! as Extract<Paint, { type: "radial-gradient" }>;
    expect(p.center).toEqual({ x: 0.6, y: 0.4 });
    expect(p.radiusX).toEqual({ x: 1.1, y: 0.4 });
    expect(p.radiusY).toEqual({ x: 0.6, y: 0.9 });
    s.editor.setPaintEdit(null);
    expect(gradientHandles(s.editor)).toEqual([]);
  });
});
