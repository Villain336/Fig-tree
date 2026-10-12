import { IDENTITY, Path, type FillRule, type Mat2D } from "@fig-tree/geometry";
import { runBounds, runOutlinePath, type GlyphRun } from "./glyphs/atlas";
import { shaderAnimated, shaderUsesBackdrop } from "./shaders/library";
import type { BlendMode, Effect, MaskType, Paint, Stroke } from "./types";

export interface NodeProps {
  readonly name?: string;
  /** Local-to-parent transform. */
  readonly transform?: Mat2D;
  /** Geometry used for the fill, the stroke and (with `clipsContent`) clipping. */
  readonly path?: Path | null;
  readonly fill?: Paint | null;
  readonly fillRule?: FillRule;
  readonly stroke?: Stroke | null;
  /** Group opacity in [0, 1]; applied to the node and its subtree as one layer. */
  readonly opacity?: number;
  /** Clip children to this node's path (its fill area). */
  readonly clipsContent?: boolean;
  readonly visible?: boolean;
  /** Text: a glyph run, filled with `fill` (its outlines are also the node's path). */
  readonly glyphs?: GlyphRun | null;
  /** How the node (as one layer) blends with what is below it. Default "normal". */
  readonly blendMode?: BlendMode;
  /**
   * CSS `isolation: isolate`: children blend only with each other. Nodes with
   * opacity below 1, a blend mode, a mask or effects are isolated anyway.
   */
  readonly isolate?: boolean;
  /** Shadows and blurs, drawn in their stacking order (see `Effect`). */
  readonly effects?: readonly Effect[];
  /** Makes this node a mask for its following siblings (it is not drawn itself). */
  readonly mask?: MaskType | null;
}

/**
 * A node in the retained scene graph. Mutations bump per-aspect versions so
 * the renderer re-derives only what changed: transforms never trigger
 * re-flattening, and paint edits never touch geometry buffers.
 */
export class SceneNode {
  readonly id: number;
  name: string;
  private _parent: SceneNode | null = null;
  private readonly _children: SceneNode[] = [];
  private _transform: Mat2D;
  private _path: Path | null;
  private _fill: Paint | null;
  private _fillRule: FillRule;
  private _stroke: Stroke | null;
  private _opacity: number;
  private _clipsContent: boolean;
  private _visible: boolean;
  private _glyphs: GlyphRun | null = null;
  private _blendMode: BlendMode;
  private _isolate: boolean;
  private _effects: readonly Effect[];
  private _mask: MaskType | null;
  /** @internal Bumped when the path or stroke style changes. */
  geometryVersion = 0;
  /** @internal Bumped when fill or stroke paint changes. */
  paintVersion = 0;

  /** @internal Nodes are created through {@link Scene.createNode}. */
  constructor(private readonly scene: Scene, id: number, props: NodeProps) {
    this.id = id;
    this.name = props.name ?? "";
    this._transform = props.transform ?? IDENTITY;
    this._path = props.path ?? null;
    this._fill = props.fill ?? null;
    this._fillRule = props.fillRule ?? "nonzero";
    this._stroke = props.stroke ?? null;
    this._opacity = clamp01(props.opacity ?? 1);
    this._clipsContent = props.clipsContent ?? false;
    this._visible = props.visible ?? true;
    this._blendMode = props.blendMode ?? "normal";
    this._isolate = props.isolate ?? false;
    this._effects = props.effects ?? [];
    this._mask = props.mask ?? null;
    if (props.glyphs) {
      this._glyphs = props.glyphs;
      this._path = glyphPath(props.glyphs);
    }
  }

  /**
   * A glyph run drawn with this node's fill. Small axis-aligned text draws
   * from the glyph atlas; rotated or large text draws the run's outlines,
   * which also back hit-testing. Setting it replaces the node's path.
   */
  get glyphs(): GlyphRun | null {
    return this._glyphs;
  }

  set glyphs(run: GlyphRun | null) {
    this._glyphs = run;
    this.path = run ? glyphPath(run) : null;
  }

  get parent(): SceneNode | null {
    return this._parent;
  }

  get children(): readonly SceneNode[] {
    return this._children;
  }

  get transform(): Mat2D {
    return this._transform;
  }

  set transform(m: Mat2D) {
    this._transform = m;
    this.scene.markTransform(this);
  }

  get path(): Path | null {
    return this._path;
  }

  /** Paths are treated as immutable once assigned; assign a new path to change geometry. */
  set path(p: Path | null) {
    const structural = (p === null) !== (this._path === null);
    this._path = p;
    this.geometryVersion++;
    // Gaining or losing a path changes which draws exist.
    if (structural) this.scene.markStructure();
    this.scene.markGeometry(this);
  }

  get fill(): Paint | null {
    return this._fill;
  }

  set fill(p: Paint | null) {
    const structural = (p === null) !== (this._fill === null) || paintTraits(p) !== paintTraits(this._fill);
    this._fill = p;
    this.paintVersion++;
    if (structural) this.scene.markStructure();
    else this.scene.markPaint();
  }

  get fillRule(): FillRule {
    return this._fillRule;
  }

  set fillRule(r: FillRule) {
    this._fillRule = r;
    this.scene.markStructure();
  }

  get stroke(): Stroke | null {
    return this._stroke;
  }

  set stroke(s: Stroke | null) {
    const prev = this._stroke;
    this._stroke = s;
    this.paintVersion++;
    if ((s === null) !== (prev === null) || paintTraits(s?.paint ?? null) !== paintTraits(prev?.paint ?? null)) {
      this.geometryVersion++;
      this.scene.markStructure();
      return;
    }
    if (s && prev && !sameStrokeStyle(s, prev)) {
      this.geometryVersion++;
      this.scene.markGeometry(this);
    } else {
      this.scene.markPaint();
    }
  }

  get opacity(): number {
    return this._opacity;
  }

  set opacity(v: number) {
    this._opacity = clamp01(v);
    this.scene.markStructure();
  }

  get clipsContent(): boolean {
    return this._clipsContent;
  }

  set clipsContent(v: boolean) {
    this._clipsContent = v;
    this.scene.markStructure();
  }

  get visible(): boolean {
    return this._visible;
  }

  get blendMode(): BlendMode {
    return this._blendMode;
  }

  set blendMode(m: BlendMode) {
    if (m === this._blendMode) return;
    this._blendMode = m;
    this.scene.markStructure();
  }

  get isolate(): boolean {
    return this._isolate;
  }

  set isolate(v: boolean) {
    if (v === this._isolate) return;
    this._isolate = v;
    this.scene.markStructure();
  }

  get effects(): readonly Effect[] {
    return this._effects;
  }

  /** Effects change which items a node draws, so setting them recompiles the draw list. */
  set effects(list: readonly Effect[]) {
    this._effects = list;
    this.scene.markStructure();
  }

  get mask(): MaskType | null {
    return this._mask;
  }

  set mask(m: MaskType | null) {
    if (m === this._mask) return;
    this._mask = m;
    this.scene.markStructure();
  }

  set visible(v: boolean) {
    this._visible = v;
    this.scene.markStructure();
  }

  appendChild(child: SceneNode): this {
    return this.insertChild(this._children.length, child);
  }

  /** Inserts `child` at `index` in paint order (later children paint on top). */
  insertChild(index: number, child: SceneNode): this {
    if (child.scene !== this.scene) throw new Error("cannot move nodes between scenes");
    for (let n: SceneNode | null = this; n; n = n._parent) {
      if (n === child) throw new Error("cannot insert a node into its own subtree");
    }
    child.removeFromParent();
    this._children.splice(Math.max(0, Math.min(index, this._children.length)), 0, child);
    child._parent = this;
    this.scene.markStructure();
    return this;
  }

  /**
   * Replaces the whole child list in one step (O(children)), moving nodes
   * from other parents as needed. Former children not in `children` are
   * detached.
   */
  replaceChildren(children: readonly SceneNode[]): this {
    const next = new Set(children);
    if (next.size !== children.length) throw new Error("duplicate child");
    for (const child of children) {
      if (child.scene !== this.scene) throw new Error("cannot move nodes between scenes");
      for (let n: SceneNode | null = this; n; n = n._parent) {
        if (n === child) throw new Error("cannot insert a node into its own subtree");
      }
    }
    for (const old of this._children) if (!next.has(old)) old._parent = null;
    for (const child of children) {
      if (child._parent && child._parent !== this) child._parent.removeChild(child);
      child._parent = this;
    }
    this._children.length = 0;
    this._children.push(...children);
    this.scene.markStructure();
    return this;
  }

  removeChild(child: SceneNode): this {
    const i = this._children.indexOf(child);
    if (i < 0) return this;
    this._children.splice(i, 1);
    child._parent = null;
    this.scene.markStructure();
    return this;
  }

  removeFromParent(): void {
    this._parent?.removeChild(this);
  }
}

/** A run's outline path, built only when something needs the outlines (bounds are known up front). */
function glyphPath(run: GlyphRun): Path {
  return Path.deferred(runBounds(run), () => runOutlinePath(run));
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/** Paint properties that change the draw list's structure (backdrops, animation): 0 for plain paints. */
export function paintTraits(p: Paint | null): number {
  if (!p || p.type !== "shader") return 0;
  return (shaderUsesBackdrop(p) ? 1 : 0) | (shaderAnimated(p) ? 2 : 0);
}

function sameStrokeStyle(a: Stroke, b: Stroke): boolean {
  const da = a.dash ?? [];
  const db = b.dash ?? [];
  return (
    a.width === b.width &&
    a.join === b.join &&
    a.cap === b.cap &&
    a.miterLimit === b.miterLimit &&
    a.dashOffset === b.dashOffset &&
    da.length === db.length &&
    da.every((v, i) => v === db[i])
  );
}

/**
 * A retained scene: a tree of {@link SceneNode}s under `root`. The scene keeps
 * coarse change counters that renderers poll once per frame.
 */
let nextSceneId = 1;

export class Scene {
  readonly root: SceneNode;
  /** Unique per scene in this process. */
  readonly id = nextSceneId++;
  private nextId = 1;
  /** @internal Tree shape, visibility, opacity, clipping or fill presence changed. */
  structureVersion = 0;
  /** @internal Any transform changed. */
  transformVersion = 0;
  /** Bumped by every change to the scene, including paint-only edits. */
  version = 0;
  /** @internal Nodes whose geometry changed since the last {@link takeDirty}. Paint edits are picked up lazily via `paintVersion`. */
  private dirty = new Set<SceneNode>();
  /** @internal Nodes whose transform changed since the last {@link takeDirtyTransforms}. */
  private dirtyTransforms = new Set<SceneNode>();

  constructor() {
    this.root = new SceneNode(this, 0, { name: "root" });
  }

  createNode(props: NodeProps = {}): SceneNode {
    return new SceneNode(this, this.nextId++, props);
  }

  /** @internal */
  markStructure(): void {
    this.structureVersion++;
    this.version++;
  }

  /** @internal */
  markTransform(node: SceneNode): void {
    this.dirtyTransforms.add(node);
    this.transformVersion++;
    this.version++;
  }

  /** @internal */
  markGeometry(node: SceneNode): void {
    this.dirty.add(node);
    this.version++;
  }

  /** @internal */
  markPaint(): void {
    this.version++;
  }

  /**
   * @internal Returns and clears the set of nodes with geometry edits. A scene
   * is therefore consumed by one renderer at a time.
   */
  takeDirty(): Set<SceneNode> {
    const d = this.dirty;
    this.dirty = new Set();
    return d;
  }

  /** @internal Returns and clears the set of nodes whose transform changed. */
  takeDirtyTransforms(): Set<SceneNode> {
    const d = this.dirtyTransforms;
    this.dirtyTransforms = new Set();
    return d;
  }
}
