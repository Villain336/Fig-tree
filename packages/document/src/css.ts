import type { FigDocument } from "./document";
import {
  ROOT_ID,
  hasProp,
  type Constraints,
  type CornerRadius,
  type GridLine,
  type SizingMode,
  type StrokeWeight,
  type TrackListEntry,
  type TrackSize,
} from "./schema";

/**
 * The CSS a node's layout and box properties stand for: the declarations
 * the layout engine implements and code export will emit. Paints, effects
 * and typography are mapped by later modules.
 *
 * Sizing modes depend on the parent:
 *
 * | mode  | flex main axis              | flex cross axis       | grid                       | otherwise    |
 * |-------|-----------------------------|-----------------------|----------------------------|--------------|
 * | fixed | `width: Npx; flex-shrink: 0`| `width: Npx`          | `width: Npx`               | `width: Npx` |
 * | hug   | `width: fit-content`        | `width: fit-content`  | `width: fit-content`       | `width: fit-content` |
 * | fill  | `flex: 1 1 0px`             | `align-self: stretch` | `justify/align-self: stretch` | `width: 100%` |
 *
 * Absolutely positioned nodes are placed with insets chosen by their
 * constraints, measured against the parent's padding box.
 */
export function cssDeclarations(doc: FigDocument, id: string): Record<string, string> {
  const type = doc.typeOf(id);
  if (!type || type === "page") return {};
  const css: Record<string, string> = {};
  const has = (k: string): boolean => hasProp(type, k);
  const get = <T>(k: string): T => doc.get<T>(id, k);
  const stored = (k: string): boolean => doc.stored(id, k) !== undefined;

  const parent = doc.tree.parentOf(id)!;
  const parentType = parent === ROOT_ID ? null : doc.typeOf(parent)!;
  const parentDisplay = parentType && hasProp(parentType, "display") ? doc.get<string>(parent, "display") : "block";
  const parentDirection = parentDisplay === "flex" ? doc.get<string>(parent, "flexDirection") : "row";
  const mainIsWidth = parentDirection === "row" || parentDirection === "row-reverse";

  if (get<boolean>("visible") === false) css.display = "none";

  // Position.
  const position = has("position") ? get<string>("position") : "absolute";
  const inFlow = position === "relative" && (parentDisplay === "flex" || parentDisplay === "grid");
  if (has("x")) {
    if (inFlow) {
      css.position = "relative";
    } else {
      css.position = position === "relative" ? "absolute" : position;
      Object.assign(css, insets(doc, id, parent, parentType, position));
    }
  } else if (has("position")) {
    css.position = position === "relative" && !inFlow ? "absolute" : position;
  }

  // Size.
  if (has("width")) {
    for (const axis of ["width", "height"] as const) {
      const mode = get<SizingMode>(axis === "width" ? "widthMode" : "heightMode");
      const isMain = parentDisplay === "flex" && inFlow && (axis === "width") === mainIsWidth;
      const isCross = parentDisplay === "flex" && inFlow && !isMain;
      const constraint = get<Constraints>("constraints")[axis === "width" ? "horizontal" : "vertical"];
      const constrainedBoth = !inFlow && constraint === "start-end";
      // Scaled boxes get a percentage size from their insets.
      if (!inFlow && constraint === "scale" && css[axis] !== undefined) continue;
      if (mode === "fixed") {
        if (constrainedBoth) css[axis] = "auto";
        else css[axis] = px(get<number>(axis));
        if (isMain && !stored("flexShrink")) css["flex-shrink"] = "0";
      } else if (mode === "hug") {
        css[axis] = "fit-content";
      } else if (isMain) {
        css.flex = "1 1 0px";
      } else if (isCross) {
        css["align-self"] = "stretch";
      } else if (inFlow && parentDisplay === "grid") {
        css[axis === "width" ? "justify-self" : "align-self"] = "stretch";
      } else if (constrainedBoth) {
        css[axis] = "auto";
      } else {
        css[axis] = "100%";
      }
    }
    for (const [prop, name] of [["minWidth", "min-width"], ["maxWidth", "max-width"], ["minHeight", "min-height"], ["maxHeight", "max-height"]] as const) {
      if (stored(prop)) css[name] = px(get<number>(prop));
    }
    if (stored("aspectRatio")) css["aspect-ratio"] = num(get<number>("aspectRatio"));
    const rotation = get<number>("rotation");
    const transforms: string[] = [];
    if (rotation) transforms.push(`rotate(${num(rotation)}deg)`);
    if (get<boolean>("flipX") || get<boolean>("flipY")) transforms.push(`scale(${get<boolean>("flipX") ? -1 : 1}, ${get<boolean>("flipY") ? -1 : 1})`);
    if (transforms.length) css.transform = transforms.join(" ");
  }

  // Item properties (meaningful inside flex and grid containers).
  if (has("flexGrow")) {
    if (stored("flexGrow")) css["flex-grow"] = num(get<number>("flexGrow"));
    if (stored("flexShrink")) css["flex-shrink"] = num(get<number>("flexShrink"));
    if (stored("flexBasis")) {
      const b = get<number | string>("flexBasis");
      css["flex-basis"] = typeof b === "number" ? px(b) : b;
    }
    if (stored("alignSelf")) css["align-self"] = get<string>("alignSelf");
    if (stored("justifySelf")) css["justify-self"] = get<string>("justifySelf");
    if (stored("order")) css.order = String(get<number>("order"));
    for (const [prop, name] of [["gridColumn", "grid-column"], ["gridRow", "grid-row"]] as const) {
      if (stored(prop)) {
        const p = get<{ start: GridLine; end: GridLine }>(prop);
        css[name] = `${gridLine(p.start)} / ${gridLine(p.end)}`;
      }
    }
    if (stored("margin")) css.margin = sides(get<Record<string, number | "auto">>("margin"), (v) => (v === "auto" ? "auto" : px(v)));
  }

  // Box model.
  if (has("boxSizing")) {
    css["box-sizing"] = get<string>("boxSizing");
    if (stored("padding")) css.padding = sides(get<Record<string, number>>("padding"), px);
    if (get<boolean>("strokesInLayout")) {
      const w = get<StrokeWeight>("strokeWeight");
      css["border-style"] = "solid";
      css["border-width"] = typeof w === "number" ? px(w) : sides(w as Record<string, number>, px);
    }
  }
  if (has("overflowX")) {
    const ox = get<string>("overflowX");
    const oy = get<string>("overflowY");
    if (ox !== "visible" || oy !== "visible") css.overflow = ox === oy ? ox : `${ox} ${oy}`;
  }
  if (has("cornerRadius") && has("cornerSmoothing")) {
    const r = get<CornerRadius>("cornerRadius");
    const value = typeof r === "number" ? px(r) : `${px(r.topLeft)} ${px(r.topRight)} ${px(r.bottomRight)} ${px(r.bottomLeft)}`;
    if (value !== "0px") css["border-radius"] = value;
  }

  // Container.
  if (has("display")) {
    const display = get<string>("display");
    if (display === "flex") {
      css.display = css.display ?? "flex";
      css["flex-direction"] = get<string>("flexDirection");
      css["flex-wrap"] = get<string>("flexWrap");
    } else if (display === "grid") {
      css.display = css.display ?? "grid";
      const cols = get<TrackListEntry[]>("gridTemplateColumns");
      const rows = get<TrackListEntry[]>("gridTemplateRows");
      if (cols.length) css["grid-template-columns"] = cols.map(track).join(" ");
      if (rows.length) css["grid-template-rows"] = rows.map(track).join(" ");
      const autoCols = get<TrackSize[]>("gridAutoColumns");
      const autoRows = get<TrackSize[]>("gridAutoRows");
      if (autoCols.length) css["grid-auto-columns"] = autoCols.map(track).join(" ");
      if (autoRows.length) css["grid-auto-rows"] = autoRows.map(track).join(" ");
      if (stored("gridAutoFlow")) css["grid-auto-flow"] = get<string>("gridAutoFlow");
      const areas = get<string[]>("gridTemplateAreas");
      if (areas.length) css["grid-template-areas"] = areas.map((a) => JSON.stringify(a.trim().replace(/\s+/g, " "))).join(" ");
      if (stored("justifyItems")) css["justify-items"] = get<string>("justifyItems");
    }
    if (display !== "block") {
      for (const [prop, name] of [["justifyContent", "justify-content"], ["alignItems", "align-items"], ["alignContent", "align-content"]] as const) {
        if (stored(prop)) css[name] = get<string>(prop);
      }
      const rg = get<number>("rowGap");
      const cg = get<number>("columnGap");
      if (rg || cg) css.gap = rg === cg ? px(rg) : `${px(rg)} ${px(cg)}`;
    }
  }

  // Compositing.
  if (has("opacity") && get<number>("opacity") !== 1) css.opacity = num(get<number>("opacity"));
  if (has("blendMode") && get<string>("blendMode") !== "normal") css["mix-blend-mode"] = get<string>("blendMode");
  if (has("isolation") && get<string>("isolation") === "isolate") css.isolation = "isolate";
  return css;
}

/** Insets for an absolutely positioned node, from its constraints and its parent's box. */
function insets(doc: FigDocument, id: string, parent: string, parentType: string | null, position: string): Record<string, string> {
  const x = doc.get<number>(id, "x");
  const y = doc.get<number>(id, "y");
  const w = doc.get<number>(id, "width");
  const h = doc.get<number>(id, "height");
  const c = doc.get<Constraints>(id, "constraints");
  const sized = parentType !== null && parentType !== "page" && parentType !== "group" && position !== "fixed";
  if (!sized) return { left: px(x), top: px(y) };
  // Insets are measured from the parent's padding box: inside its borders when strokes take layout space.
  const b = parentBorders(doc, parent, parentType);
  const pw = doc.get<number>(parent, "width") - b.left - b.right;
  const ph = doc.get<number>(parent, "height") - b.top - b.bottom;
  const out: Record<string, string> = {};
  const axis = (kind: Constraints["horizontal"], start: number, size: number, parentSize: number, startName: string, endName: string): void => {
    switch (kind) {
      case "start":
        out[startName] = px(start);
        return;
      case "end":
        out[endName] = px(parentSize - start - size);
        return;
      case "start-end":
        out[startName] = px(start);
        out[endName] = px(parentSize - start - size);
        return;
      case "center": {
        // Keeps the box's offset from the parent's center: start = 50% + (start - parentSize / 2).
        const d = start - parentSize / 2;
        out[startName] = d === 0 ? "50%" : `calc(50% ${d < 0 ? "-" : "+"} ${px(Math.abs(d))})`;
        return;
      }
      case "scale":
        out[startName] = parentSize > 0 ? `${num((start / parentSize) * 100)}%` : px(start);
        return;
    }
  };
  axis(c.horizontal, x - b.left, w, pw, "left", "right");
  axis(c.vertical, y - b.top, h, ph, "top", "bottom");
  if (c.horizontal === "scale" && pw > 0) out.width = `${num((w / pw) * 100)}%`;
  if (c.vertical === "scale" && ph > 0) out.height = `${num((h / ph) * 100)}%`;
  return out;
}

function parentBorders(doc: FigDocument, parent: string, parentType: string): { top: number; right: number; bottom: number; left: number } {
  if (!hasProp(parentType as Parameters<typeof hasProp>[0], "strokesInLayout") || !doc.get<boolean>(parent, "strokesInLayout")) return { top: 0, right: 0, bottom: 0, left: 0 };
  const w = doc.get<StrokeWeight>(parent, "strokeWeight");
  return typeof w === "number" ? { top: w, right: w, bottom: w, left: w } : (w as { top: number; right: number; bottom: number; left: number });
}

function num(v: number): string {
  const r = Math.round(v * 1e4) / 1e4;
  return String(Object.is(r, -0) ? 0 : r);
}

function px(v: number): string {
  return `${num(v)}px`;
}

function sides<T>(s: Record<string, T>, f: (v: T) => string): string {
  const [t, r, b, l] = [s.top!, s.right!, s.bottom!, s.left!].map(f);
  if (t === r && r === b && b === l) return t!;
  if (t === b && r === l) return `${t} ${r}`;
  return `${t} ${r} ${b} ${l}`;
}

function gridLine(g: GridLine): string {
  if (typeof g === "number") return String(g);
  if (g === "auto") return "auto";
  if ("span" in g) return `span ${g.span}`;
  return g.name;
}

function track(t: TrackListEntry): string {
  switch (t.type) {
    case "px":
      return px(t.value);
    case "percent":
      return `${num(t.value)}%`;
    case "fr":
      return `${num(t.value)}fr`;
    case "auto":
    case "min-content":
    case "max-content":
      return t.type;
    case "minmax":
      return `minmax(${track(t.min)}, ${track(t.max)})`;
    case "fit-content":
      return `fit-content(${px(t.value)})`;
    case "repeat":
      return `repeat(${t.count}, ${t.tracks.map(track).join(" ")})`;
  }
}
