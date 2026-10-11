import { Path, inflateRect, type Mat2D } from "@fig-tree/geometry";
import type { Color, Paint as RenderPaint, Scene, SceneNode, Stroke } from "@fig-tree/renderer";
import type { DocumentChange, FigDocument } from "../document";
import type { Effect, NodeType, Paint, StrokeWeight, VectorNetwork } from "../schema";
import { boxMatrix } from "../transform";
import { geometryKey, outlinePath, regionPaths, strokeOutline } from "./geometry";
import { toRenderPaint } from "./paints";

/**
 * Projects one page of a document into a renderer {@link Scene} and keeps
 * it in sync: each transaction's {@link DocumentChange} recompiles only the
 * nodes it touched, and structural edits relink only the containers whose
 * child lists changed. Layout is not computed yet (module 3): nodes use their
 * stored x/y/width/height.
 *
 * A document node becomes a small group of scene nodes:
 *
 *     main         transform, opacity, visibility, outline, bottom fill, top center stroke
 *     ├ fills      further fills, bottom to top (same outline)
 *     ├ host       containers' children; clips them when overflow is not visible
 *     └ strokes    further strokes; inside/outside alignment as clipped double-width strokes
 *
 * Features the renderer cannot draw yet are listed in {@link unsupported}
 * per node and are not drawn (or, for modifiers like blend modes and
 * effects, ignored); nothing is approximated silently.
 */
export class SceneBridge {
  private readonly entries = new Map<string, Entry>();
  private readonly owners = new Map<SceneNode, string>();
  private readonly unsubscribe: () => void;
  private _page: string;
  private _unsupported = new Map<string, ReadonlySet<string>>();
  /** Nodes compiled by the last sync (initial build or one change). */
  lastCompiled = 0;
  /** Node compilations since the bridge was created. */
  totalCompiled = 0;
  /** Called after each change was applied to the scene. */
  onSync: ((compiled: number) => void) | null = null;

  constructor(
    readonly doc: FigDocument,
    readonly scene: Scene,
    options: { page?: string } = {},
  ) {
    this._page = options.page ?? doc.pages[0] ?? "";
    this.unsubscribe = doc.onChange(this.onChange);
    this.build();
  }

  get page(): string {
    return this._page;
  }

  /** Shows another page. */
  setPage(page: string): void {
    if (page === this._page) return;
    this._page = page;
    this.build();
  }

  /** Canvas color of the current page. */
  get background(): Color {
    return this.doc.get<Color>(this._page, "backgroundColor");
  }

  /** Features each node uses that the renderer cannot draw yet. */
  get unsupported(): ReadonlyMap<string, ReadonlySet<string>> {
    return this._unsupported;
  }

  /** The document node a scene node belongs to (for hit-testing). */
  nodeIdFor(sceneNode: SceneNode | null): string | undefined {
    for (let n = sceneNode; n; n = n.parent) {
      const id = this.owners.get(n);
      if (id !== undefined) return id;
    }
    return undefined;
  }

  /** The main scene node of a document node. */
  sceneNodeFor(id: string): SceneNode | undefined {
    return this.entries.get(id)?.main;
  }

  dispose(): void {
    this.unsubscribe();
    this.clear();
  }

  // ── Building ─────────────────────────────────────────────────────────

  private clear(): void {
    for (const e of this.entries.values()) e.main.removeFromParent();
    this.entries.clear();
    this.owners.clear();
    this._unsupported = new Map();
  }

  private build(): void {
    this.clear();
    if (!this.doc.has(this._page)) this._page = this.doc.pages[0] ?? "";
    if (!this._page) return;
    const before = this.totalCompiled;
    const ids = this.doc.tree.subtree(this._page);
    for (const id of ids) this.compile(id);
    for (const id of ids) this.relink(id);
    this.scene.root.replaceChildren([this.entries.get(this._page)!.main]);
    this.lastCompiled = this.totalCompiled - before;
  }

  private readonly onChange = (change: DocumentChange): void => {
    const before = this.totalCompiled;
    const tree = this.doc.tree;
    const s = change.structure;
    if (s) {
      if (!tree.has(this._page)) {
        this.build();
        this.onSync?.(this.lastCompiled);
        return;
      }
      const onPage = (id: string): boolean => tree.pageOf(id) === this._page;
      for (const id of s.removed) this.drop(id);
      for (const id of s.reparented) {
        const has = this.entries.has(id);
        if (has && !onPage(id)) for (const d of this.collectEntries(id)) this.drop(d);
        else if (!has && onPage(id)) {
          for (const d of tree.subtree(id)) this.compile(d);
          for (const d of tree.subtree(id)) this.relink(d);
        }
      }
      const added = [...s.added].filter(onPage);
      for (const id of added) this.compile(id);
      for (const id of added) this.relink(id);
      for (const p of s.parents) if (this.entries.has(p)) this.relink(p);
    }
    for (const id of change.props.keys()) {
      if (!this.entries.has(id) || s?.added.has(id)) continue;
      this.compile(id);
    }
    for (const id of change.text) {
      if (!this.entries.has(id) || s?.added.has(id) || change.props.has(id)) continue;
      this.compile(id);
    }
    this.lastCompiled = this.totalCompiled - before;
    this.onSync?.(this.lastCompiled);
  };

  /** Ids of entries in the scene subtree of `id` (which may already be gone from the document tree). */
  private collectEntries(id: string): string[] {
    const e = this.entries.get(id);
    if (!e) return [];
    const out: string[] = [];
    const visit = (n: SceneNode): void => {
      const owner = this.owners.get(n);
      if (owner !== undefined && this.entries.get(owner)?.main === n) out.push(owner);
      for (const c of n.children) visit(c);
    };
    visit(e.main);
    return out;
  }

  private drop(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.main.removeFromParent();
    for (const n of e.all()) this.owners.delete(n);
    this.entries.delete(id);
    this._unsupported.delete(id);
  }

  /** Puts the scene nodes of a container's document children in order under its host. */
  private relink(id: string): void {
    const e = this.entries.get(id);
    if (!e?.host) return;
    const kids: SceneNode[] = [];
    for (const c of this.doc.tree.childrenOf(id)) {
      const ce = this.entries.get(c);
      if (ce) kids.push(ce.main);
    }
    if (e.host === e.main) {
      if (!sameNodes(e.main.children, kids)) e.main.replaceChildren(kids);
    } else if (!sameNodes(e.host.children, kids)) {
      e.host.replaceChildren(kids);
    }
  }

  // ── Compiling one node ───────────────────────────────────────────────

  private compile(id: string): void {
    this.totalCompiled++;
    const doc = this.doc;
    const type = doc.typeOf(id);
    if (!type) return;
    let e = this.entries.get(id);
    if (!e) {
      e = new Entry(this.scene.createNode({ name: id }), type);
      this.entries.set(id, e);
      this.own(e.main, id);
      if (type === "page" || type === "group") e.host = e.main;
      else if (type === "frame" || type === "component" || type === "instance") {
        e.host = this.scene.createNode({ name: `${id}:children` });
        e.main.appendChild(e.host);
        this.own(e.host, id);
      }
    }
    const notes = new Set<string>();
    const get = <T>(k: string): T => doc.get<T>(id, k);

    // Transform, visibility, opacity.
    const transform: Mat2D =
      type === "page" || type === "group"
        ? [1, 0, 0, 1, 0, 0]
        : boxMatrix({ x: get("x"), y: get("y"), width: get("width"), height: get("height"), rotation: get("rotation"), flipX: get("flipX"), flipY: get("flipY") });
    if (!sameMatrix(e.main.transform, transform)) e.main.transform = transform;
    const visible = type === "page" ? true : get<boolean>("visible");
    if (e.main.visible !== visible) e.main.visible = visible;
    const opacity = type === "page" ? 1 : get<number>("opacity");
    if (e.main.opacity !== opacity) e.main.opacity = opacity;
    if (type !== "page") {
      const blend = get<string>("blendMode");
      if (blend !== "normal") notes.add(`blend-mode:${blend}`);
      for (const fx of get<Effect[]>("effects")) if (fx.visible !== false) notes.add(`effect:${fx.type}`);
    }
    if (type === "text") notes.add("text");
    if (type === "image") notes.add("image");

    // Geometry.
    const gk = geometryKey(doc, id, type);
    if (gk !== e.geometryKey) {
      e.geometryKey = gk;
      e.outline = outlinePath(doc, id, type);
      if (type === "vector") {
        const net = get<VectorNetwork>("vectorNetwork");
        e.regions = regionPaths(net);
        e.strokePath = strokeOutline(net);
      } else {
        e.regions = null;
        e.strokePath = e.outline;
      }
      e.paintKey = ""; // paint nodes carry the outline: rebuild them
    }
    if (type === "vector") {
      const net = get<VectorNetwork>("vectorNetwork");
      if (get<number>("cornerRadius") > 0 || net.vertices.some((v) => (v.cornerRadius ?? 0) > 0)) notes.add("vector-corner-radius");
      if (net.vertices.some((v) => v.strokeCap !== undefined)) notes.add("vector-vertex-cap");
    }

    // Paints.
    const width = type === "page" || type === "group" ? 0 : get<number>("width");
    const height = type === "page" || type === "group" ? 0 : get<number>("height");
    const fillsDoc = hasFills(type) ? get<Paint[]>("fills") : [];
    const strokesDoc = hasStrokes(type) ? get<Paint[]>("strokes") : [];
    const strokeStyle = hasStrokes(type)
      ? [get("strokeWeight"), get("strokeAlign"), get("strokeCap"), get("strokeJoin"), get("strokeMiterLimit"), get("strokeDashes"), get("strokeDashOffset")]
      : [];
    const overflow = hasHostClip(type) ? [get<string>("overflowX"), get<string>("overflowY")] : ["visible", "visible"];
    const pk = JSON.stringify([fillsDoc, strokesDoc, strokeStyle, overflow, width, height, type === "vector" ? get("vectorNetwork") : null]);
    if (pk !== e.paintKey) {
      e.paintKey = pk;
      this.rebuildPaint(id, e, type, fillsDoc, strokesDoc, overflow, width, height, e.paintNotes);
    }
    for (const n of e.paintNotes) notes.add(n);
    if (notes.size) this._unsupported.set(id, notes);
    else this._unsupported.delete(id);
  }

  /**
   * Reconciles the node's paint nodes with its fills, strokes and clip.
   * Setters run only for values that changed, so a paint edit never touches
   * geometry, and existing paint nodes are reused when their shape matches.
   */
  private rebuildPaint(
    id: string,
    e: Entry,
    type: NodeType,
    fillsDoc: readonly Paint[],
    strokesDoc: readonly Paint[],
    overflow: readonly string[],
    width: number,
    height: number,
    notes: Set<string>,
  ): void {
    notes.clear();
    const get = <T>(k: string): T => this.doc.get<T>(id, k);
    const convert = (paints: readonly Paint[]): RenderPaint[] => {
      const out: RenderPaint[] = [];
      for (const p of paints) {
        if (p.visible === false) continue;
        if (p.blendMode && p.blendMode !== "normal") notes.add(`paint-blend-mode:${p.blendMode}`);
        const r = toRenderPaint(p, width, height);
        if ("paint" in r) out.push(r.paint);
        else notes.add(r.unsupported);
      }
      return out;
    };

    // Fills: the bottom one on main, the rest as nodes with the same outline above it.
    const outline = e.outline;
    let mainFill: RenderPaint | null = null;
    const fillSpecs: { name: string; path: Path; fill: RenderPaint; rule: "nonzero" | "evenodd" }[] = [];
    if (type === "vector") {
      get<VectorNetwork>("vectorNetwork").regions.forEach((region, i) => {
        for (const paint of convert(region.fills ?? fillsDoc)) fillSpecs.push({ name: `${id}:region${i}`, path: e.regions![i]!, fill: paint, rule: region.fillRule });
      });
    } else if (outline) {
      const paints = convert(fillsDoc);
      mainFill = paints[0] ?? null;
      for (const paint of paints.slice(1)) fillSpecs.push({ name: `${id}:fill`, path: outline, fill: paint, rule: "nonzero" });
    }
    // Vectors fill their regions in child nodes; main carries the stroke outline for its stroke.
    setPath(e.main, type === "vector" ? e.strokePath : outline);
    setFill(e.main, mainFill);

    // Host clip.
    if (e.host && e.host !== e.main) {
      const clips = overflow[0] !== "visible" || overflow[1] !== "visible";
      if (clips && overflow[0] !== overflow[1] && (overflow[0] === "visible" || overflow[1] === "visible")) notes.add("overflow-single-axis");
      setPath(e.host, clips ? outline : null);
      if (e.host.clipsContent !== clips) e.host.clipsContent = clips;
    }

    // Strokes.
    let mainStroke: Stroke | null = null;
    const strokeSpecs: { path: Path; stroke: Stroke; clip: { path: Path; rule: "nonzero" | "evenodd"; align: string } | null }[] = [];
    const strokePaints = convert(strokesDoc);
    const geometry = e.strokePath;
    if (strokePaints.length > 0 && geometry) {
      const weight = get<StrokeWeight>("strokeWeight");
      let w: number | null = typeof weight === "number" ? weight : null;
      if (typeof weight !== "number") {
        const { top, right, bottom, left } = weight;
        if (top === right && right === bottom && bottom === left) w = top;
        else notes.add("stroke-weight-per-side");
      }
      let align = get<string>("strokeAlign");
      if (align !== "center" && (type === "line" || type === "vector")) {
        notes.add(`stroke-align-${align}-open-path`);
        align = "center";
      }
      if (w !== null && w > 0) {
        const style = {
          join: get<"miter" | "round" | "bevel">("strokeJoin"),
          cap: get<"butt" | "round" | "square">("strokeCap"),
          miterLimit: get<number>("strokeMiterLimit"),
          dash: get<number[]>("strokeDashes"),
          dashOffset: get<number>("strokeDashOffset"),
        };
        const strokeOf = (paint: RenderPaint, sw: number): Stroke => ({ paint, width: sw, ...style });
        if (align === "center") {
          // The topmost stroke rides on main; lower ones are nodes painted before it.
          mainStroke = strokeOf(strokePaints[strokePaints.length - 1]!, w);
          for (const paint of strokePaints.slice(0, -1)) strokeSpecs.push({ path: geometry, stroke: strokeOf(paint, w), clip: null });
        } else {
          // Inside: a double-width stroke clipped by the outline. Outside: clipped by its complement.
          let clipPath = geometry;
          if (align === "outside") {
            const key = `${e.geometryKey}|${w}`;
            if (e.complementKey !== key) {
              e.complementKey = key;
              e.complement = complement(geometry, w * 2 + 2);
            }
            clipPath = e.complement!;
          }
          const rule = align === "inside" ? "nonzero" : "evenodd";
          for (const paint of strokePaints) strokeSpecs.push({ path: geometry, stroke: strokeOf(paint, w * 2), clip: { path: clipPath, rule, align } });
        }
      }
    }
    setStroke(e.main, mainStroke);

    // Reuse paint nodes when the shape of the stack is unchanged.
    let restructured = false;
    if (e.fills.length === fillSpecs.length) {
      fillSpecs.forEach((f, i) => {
        const n = e.fills[i]!;
        setPath(n, f.path);
        setFill(n, f.fill);
        if (n.fillRule !== f.rule) n.fillRule = f.rule;
      });
    } else {
      for (const n of e.fills) this.disown(n);
      e.fills = fillSpecs.map((f) => this.scene.createNode({ name: f.name, path: f.path, fill: f.fill, fillRule: f.rule }));
      restructured = true;
    }
    const strokeShape = (specs: typeof strokeSpecs): string => specs.map((sp) => sp.clip?.align ?? "center").join(",");
    if (e.strokeShape === strokeShape(strokeSpecs) && e.strokes.length === strokeSpecs.length) {
      strokeSpecs.forEach((sp, i) => {
        const n = e.strokes[i]!;
        const target = sp.clip ? n.children[0]! : n;
        if (sp.clip) {
          setPath(n, sp.clip.path);
          if (n.fillRule !== sp.clip.rule) n.fillRule = sp.clip.rule;
        }
        setPath(target, sp.path);
        setStroke(target, sp.stroke);
      });
    } else {
      for (const n of e.strokes) this.disown(n);
      e.strokes = strokeSpecs.map((sp) => {
        const stroke = this.scene.createNode({ name: `${id}:stroke`, path: sp.path, stroke: sp.stroke });
        if (!sp.clip) return stroke;
        const clip = this.scene.createNode({ name: `${id}:stroke-${sp.clip.align}`, path: sp.clip.path, fillRule: sp.clip.rule, clipsContent: true });
        return clip.appendChild(stroke);
      });
      e.strokeShape = strokeShape(strokeSpecs);
      restructured = true;
    }
    if (restructured) {
      for (const n of [...e.fills, ...e.strokes]) this.own(n, id);
      const kids = [...e.fills, ...(e.host && e.host !== e.main ? [e.host] : []), ...e.strokes];
      if (e.host !== e.main && !sameNodes(e.main.children, kids)) e.main.replaceChildren(kids);
    }
  }

  private own(n: SceneNode, id: string): void {
    this.owners.set(n, id);
    for (const c of n.children) this.own(c, id);
  }

  private disown(n: SceneNode): void {
    this.owners.delete(n);
    for (const c of n.children) this.disown(c);
  }
}

class Entry {
  host: SceneNode | null = null;
  fills: SceneNode[] = [];
  strokes: SceneNode[] = [];
  outline: Path | null = null;
  regions: Path[] | null = null;
  strokePath: Path | null = null;
  geometryKey = "";
  paintKey = "";
  strokeShape = "";
  complement: Path | null = null;
  complementKey = "";
  readonly paintNotes = new Set<string>();

  constructor(
    readonly main: SceneNode,
    readonly type: NodeType,
  ) {}

  /** Scene nodes owned by this entry (not the scene nodes of document children). */
  all(): SceneNode[] {
    const out = [this.main, ...this.fills];
    if (this.host && this.host !== this.main) out.push(this.host);
    for (const s of this.strokes) out.push(s, ...s.children);
    return out;
  }
}

function hasFills(type: NodeType): boolean {
  return type !== "page" && type !== "group" && type !== "line";
}

function hasStrokes(type: NodeType): boolean {
  return type !== "page" && type !== "group";
}

function hasHostClip(type: NodeType): boolean {
  return type === "frame" || type === "component" || type === "instance";
}

/** A path covering everything around `path` (even-odd with a surrounding rectangle). */
function complement(path: Path, margin: number): Path {
  const b = inflateRect(path.bounds(), margin);
  return new Path().moveTo(b.minX, b.minY).lineTo(b.maxX, b.minY).lineTo(b.maxX, b.maxY).lineTo(b.minX, b.maxY).close().append(path);
}

function setPath(n: SceneNode, path: Path | null): void {
  if (n.path !== path) n.path = path;
}

function setFill(n: SceneNode, fill: RenderPaint | null): void {
  if (fill === n.fill) return;
  if (fill && n.fill && JSON.stringify(fill) === JSON.stringify(n.fill)) return;
  n.fill = fill;
}

function setStroke(n: SceneNode, stroke: Stroke | null): void {
  if (stroke === n.stroke) return;
  if (stroke && n.stroke && JSON.stringify(stroke) === JSON.stringify(n.stroke)) return;
  n.stroke = stroke;
}

function sameMatrix(a: Mat2D, b: Mat2D): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5];
}

function sameNodes(a: readonly SceneNode[], b: readonly SceneNode[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

