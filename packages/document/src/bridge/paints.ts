import type { Paint as RenderPaint, GradientStop as RenderStop } from "@fig-tree/renderer";
import type { GradientStop, Paint } from "../schema";

/**
 * Maps a document paint to a renderer paint in the node's local space
 * (gradient handles are normalized to the node's box), or explains why it
 * cannot be drawn yet.
 */
export function toRenderPaint(paint: Paint, width: number, height: number): { paint: RenderPaint } | { unsupported: string } {
  const opacity = paint.opacity ?? 1;
  const stops = (list: readonly GradientStop[]): RenderStop[] =>
    list.map((s) => ({ offset: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a * opacity } }));
  switch (paint.type) {
    case "solid":
      return { paint: { type: "solid", color: { ...paint.color, a: paint.color.a * opacity } } };
    case "linear-gradient":
      return {
        paint: {
          type: "linear-gradient",
          start: { x: paint.start.x * width, y: paint.start.y * height },
          end: { x: paint.end.x * width, y: paint.end.y * height },
          stops: stops(paint.stops),
        },
      };
    case "radial-gradient": {
      // Unit circle in gradient space → the ellipse spanned by the handles.
      const cx = paint.center.x * width, cy = paint.center.y * height;
      return {
        paint: {
          type: "radial-gradient",
          center: { x: 0, y: 0 },
          radius: 1,
          stops: stops(paint.stops),
          transform: [paint.radiusX.x * width - cx, paint.radiusX.y * height - cy, paint.radiusY.x * width - cx, paint.radiusY.y * height - cy, cx, cy],
        },
      };
    }
    default:
      return { unsupported: `fill:${paint.type}` };
  }
}
