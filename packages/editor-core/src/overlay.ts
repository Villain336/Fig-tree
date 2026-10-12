import type { Point } from "@fig-tree/geometry";

/**
 * What the editor draws over the canvas (selection, hover, handles, guides,
 * measurements, carets), in canvas CSS pixels. Tools and edit modes
 * produce these items; {@link drawOverlay} paints them on a 2D canvas that
 * sits above the GPU canvas, so overlay changes never touch the document's
 * scene or its tile cache.
 */
export type OverlayItem =
  | { readonly kind: "outline"; readonly points: readonly Point[]; readonly closed: boolean; readonly role: OutlineRole }
  | { readonly kind: "rect"; readonly points: readonly Point[]; readonly role: RectRole }
  | { readonly kind: "handle"; readonly id: string; readonly center: Point; readonly shape: "square" | "circle" | "diamond"; readonly size: number; readonly color?: string }
  | { readonly kind: "line"; readonly from: Point; readonly to: Point; readonly role: LineRole }
  | { readonly kind: "label"; readonly at: Point; readonly text: string; readonly role: LabelRole; readonly align?: "left" | "center"; readonly selected?: boolean }
  | { readonly kind: "caret"; readonly from: Point; readonly to: Point }
  | { readonly kind: "pixel-grid"; readonly scale: number; readonly offsetX: number; readonly offsetY: number }
  | { readonly kind: "image-placeholder"; readonly points: readonly Point[] };

export type OutlineRole = "selection" | "hover" | "editing" | "parent" | "drop-target" | "remote";
export type RectRole = "selection-bounds" | "marquee" | "text-selection" | "gradient-line";
export type LineRole = "snap" | "spacing" | "measure" | "drop" | "gradient";
export type LabelRole = "size" | "measure" | "frame-name" | "spacing";

/** Colors of the overlay (our own palette). */
export const OVERLAY_THEME = {
  selection: "#2563eb",
  hover: "#2563eb",
  editing: "#2563eb",
  parent: "rgba(37, 99, 235, 0.35)",
  dropTarget: "#2563eb",
  snap: "#e11d48",
  spacing: "#e11d48",
  measure: "#e11d48",
  marqueeFill: "rgba(37, 99, 235, 0.08)",
  textSelection: "rgba(37, 99, 235, 0.25)",
  handleFill: "#ffffff",
  labelText: "#ffffff",
  frameName: "#57534e",
  frameNameSelected: "#2563eb",
  pixelGrid: "rgba(120, 120, 120, 0.18)",
} as const;

/** The subset of the Canvas 2D API the overlay uses (so it can be drawn in tests or workers). */
export interface OverlayContext {
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  setLineDash(segments: number[]): void;
  lineWidth: number;
  strokeStyle: unknown;
  fillStyle: unknown;
  font: string;
  textBaseline: unknown;
  textAlign: unknown;
}

export const LABEL_FONT = "500 11px system-ui, sans-serif";

/** Paints overlay items onto a 2D context already scaled to CSS pixels. */
export function drawOverlay(ctx: OverlayContext, items: readonly OverlayItem[], width: number, height: number): void {
  const t = OVERLAY_THEME;
  for (const item of items) {
    ctx.save();
    switch (item.kind) {
      case "pixel-grid": {
        ctx.strokeStyle = t.pixelGrid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const s = item.scale;
        const startX = item.offsetX - Math.floor(item.offsetX / s) * s;
        for (let x = startX; x <= width; x += s) {
          const px = Math.round(x) + 0.5;
          ctx.moveTo(px, 0);
          ctx.lineTo(px, height);
        }
        const startY = item.offsetY - Math.floor(item.offsetY / s) * s;
        for (let y = startY; y <= height; y += s) {
          const py = Math.round(y) + 0.5;
          ctx.moveTo(0, py);
          ctx.lineTo(width, py);
        }
        ctx.stroke();
        break;
      }
      case "outline": {
        ctx.strokeStyle = item.role === "parent" ? t.parent : item.role === "hover" ? t.hover : t.selection;
        ctx.lineWidth = item.role === "hover" || item.role === "drop-target" ? 2 : 1;
        if (item.role === "parent") ctx.setLineDash([4, 3]);
        polyline(ctx, item.points, item.closed);
        ctx.stroke();
        break;
      }
      case "rect": {
        if (item.role === "marquee") {
          ctx.fillStyle = t.marqueeFill;
          polyline(ctx, item.points, true);
          ctx.fill();
          ctx.strokeStyle = t.selection;
          ctx.lineWidth = 1;
          ctx.stroke();
        } else if (item.role === "text-selection") {
          ctx.fillStyle = t.textSelection;
          polyline(ctx, item.points, true);
          ctx.fill();
        } else if (item.role === "gradient-line") {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 3;
          polyline(ctx, item.points, false);
          ctx.stroke();
          ctx.strokeStyle = t.selection;
          ctx.lineWidth = 1;
          ctx.stroke();
        } else {
          ctx.strokeStyle = t.selection;
          ctx.lineWidth = 1;
          polyline(ctx, item.points, true);
          ctx.stroke();
        }
        break;
      }
      case "handle": {
        const r = item.size / 2;
        ctx.fillStyle = item.color ?? t.handleFill;
        ctx.strokeStyle = t.selection;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (item.shape === "circle") ctx.arc(item.center.x, item.center.y, r, 0, Math.PI * 2);
        else if (item.shape === "diamond") {
          ctx.moveTo(item.center.x, item.center.y - r);
          ctx.lineTo(item.center.x + r, item.center.y);
          ctx.lineTo(item.center.x, item.center.y + r);
          ctx.lineTo(item.center.x - r, item.center.y);
          ctx.closePath();
        } else ctx.rect(Math.round(item.center.x - r) + 0.5, Math.round(item.center.y - r) + 0.5, item.size - 1, item.size - 1);
        ctx.fill();
        ctx.stroke();
        break;
      }
      case "line": {
        ctx.strokeStyle = item.role === "drop" ? t.selection : item.role === "gradient" ? t.selection : t.snap;
        ctx.lineWidth = item.role === "drop" ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(item.from.x, item.from.y);
        ctx.lineTo(item.to.x, item.to.y);
        ctx.stroke();
        if (item.role === "spacing" || item.role === "measure") {
          // End ticks.
          const dx = item.to.x - item.from.x;
          const dy = item.to.y - item.from.y;
          const len = Math.hypot(dx, dy) || 1;
          const nx = (-dy / len) * 3;
          const ny = (dx / len) * 3;
          ctx.beginPath();
          for (const p of [item.from, item.to]) {
            ctx.moveTo(p.x - nx, p.y - ny);
            ctx.lineTo(p.x + nx, p.y + ny);
          }
          ctx.stroke();
        }
        break;
      }
      case "label": {
        ctx.font = LABEL_FONT;
        ctx.textBaseline = "middle";
        const w = ctx.measureText(item.text).width;
        if (item.role === "frame-name") {
          ctx.fillStyle = item.selected ? t.frameNameSelected : t.frameName;
          ctx.textAlign = "left";
          ctx.fillText(item.text, item.at.x, item.at.y);
        } else {
          const padX = 4;
          const h = 16;
          const x = item.align === "left" ? item.at.x : item.at.x - w / 2 - padX;
          ctx.fillStyle = item.role === "size" ? t.selection : t.measure;
          roundRect(ctx, x, item.at.y - h / 2, w + padX * 2, h, 3);
          ctx.fill();
          ctx.fillStyle = t.labelText;
          ctx.textAlign = "left";
          ctx.fillText(item.text, x + padX, item.at.y + 0.5);
        }
        break;
      }
      case "caret": {
        ctx.strokeStyle = "#111111";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(item.from.x, item.from.y);
        ctx.lineTo(item.to.x, item.to.y);
        ctx.stroke();
        break;
      }
      case "image-placeholder": {
        ctx.strokeStyle = "rgba(120, 113, 108, 0.6)";
        ctx.lineWidth = 1;
        polyline(ctx, item.points, true);
        ctx.stroke();
        const [a, b, c, d] = item.points;
        if (a && b && c && d) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(c.x, c.y);
          ctx.moveTo(b.x, b.y);
          ctx.lineTo(d.x, d.y);
          ctx.stroke();
        }
        break;
      }
    }
    ctx.restore();
  }
}

function polyline(ctx: OverlayContext, points: readonly Point[], closed: boolean): void {
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  if (closed) ctx.closePath();
}

function roundRect(ctx: OverlayContext, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

/** Screen rectangle of a handle (for hit-testing and anchors). */
export function handleRect(item: Extract<OverlayItem, { kind: "handle" }>, pad = 0): { x: number; y: number; width: number; height: number } {
  const r = item.size / 2 + pad;
  return { x: item.center.x - r, y: item.center.y - r, width: r * 2, height: r * 2 };
}
