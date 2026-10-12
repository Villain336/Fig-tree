import { IDENTITY, flattenPath, type Mat2D, type Path, type Point, type Polylines } from "@fig-tree/geometry";
import type { FigDocument, NodeType, SceneBridge } from "@fig-tree/document";
import type { SceneNode } from "@fig-tree/renderer";
import { multiply, quad, transformedBox, unionBoxes, type Box } from "./math";

/**
 * Where nodes are on the canvas, read from the renderer bridge: every box is
 * the layout engine's computed box (so flex and grid children are where
 * they are drawn), and world matrices compose the scene transforms
 * (rotation and flips about the box center). World space is page space.
 *
 * Groups have no box: their bounds are the union of their children, and
 * their children's coordinates are in the group's parent space.
 */
export class CanvasGeometry {
  private readonly flattened = new WeakMap<Path, Polylines>();

  constructor(
    readonly doc: FigDocument,
    readonly bridge: SceneBridge,
  ) {}

  get page(): string {
    return this.bridge.page;
  }

  type(id: string): NodeType | undefined {
    return this.doc.typeOf(id);
  }

  /** Whether a node has a box of its own (everything but pages and groups). */
  hasBox(id: string): boolean {
    const t = this.doc.typeOf(id);
    return t !== undefined && t !== "page" && t !== "group";
  }

  /** The laid-out size of a node's box (0 × 0 for pages and groups). */
  size(id: string): { width: number; height: number } {
    if (!this.hasBox(id)) return { width: 0, height: 0 };
    const b = this.bridge.box(id);
    return b ? { width: b.width, height: b.height } : { width: this.doc.get<number>(id, "width"), height: this.doc.get<number>(id, "height") };
  }

  /** Local-to-parent matrix of a node's box (identity for pages and groups). */
  localMatrix(id: string): Mat2D {
    return this.bridge.sceneNodeFor(id)?.transform ?? IDENTITY;
  }

  /** Local-to-world matrix: maps the node's box coordinates (0,0 at its top-left) to page coordinates. */
  worldMatrix(id: string): Mat2D {
    let n: SceneNode | null | undefined = this.bridge.sceneNodeFor(id);
    let m: Mat2D = IDENTITY;
    while (n) {
      m = multiply(n.transform, m);
      n = n.parent;
    }
    return m;
  }

  /**
   * The world matrix of the space a node's `x`/`y`/`rotation` are stored in:
   * its parent's box, or for children of groups, the group's parent space.
   */
  parentSpace(id: string): Mat2D {
    const parent = this.doc.tree.parentOf(id);
    if (parent === undefined || parent === "root") return IDENTITY;
    return this.worldMatrix(parent);
  }

  /** The node's box corners in world space (for groups, the corners of their bounds). */
  quad(id: string): [Point, Point, Point, Point] {
    if (this.doc.typeOf(id) === "group") {
      const b = this.bounds(id);
      return [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }];
    }
    const s = this.size(id);
    return quad(this.worldMatrix(id), s.width, s.height);
  }

  /** Axis-aligned world bounds of a node's box; groups take the union of their visible children. */
  bounds(id: string): Box {
    const type = this.doc.typeOf(id);
    if (type === "group" || type === "page") {
      const kids = this.doc.tree.childrenOf(id).filter((c) => type === "page" || this.doc.get<boolean>(c, "visible"));
      return unionBoxes(kids.map((c) => this.bounds(c))) ?? { x: 0, y: 0, width: 0, height: 0 };
    }
    const s = this.size(id);
    return transformedBox(this.worldMatrix(id), s.width, s.height);
  }

  /** Union of the bounds of several nodes. */
  boundsOf(ids: readonly string[]): Box | null {
    return unionBoxes(ids.filter((id) => this.doc.has(id)).map((id) => this.bounds(id)));
  }

  /** The node's own scene nodes (main, fills, strokes, glyph runs), not those of its children. */
  ownSceneNodes(id: string): SceneNode[] {
    const main = this.bridge.sceneNodeFor(id);
    if (!main) return [];
    const out: SceneNode[] = [main];
    const visit = (n: SceneNode): void => {
      for (const c of n.children) {
        // A container's host holds its children's scene nodes, which belong to other ids.
        if (this.bridge.nodeIdFor(c) !== id) continue;
        out.push(c);
        visit(c);
      }
    };
    visit(main);
    return out;
  }

  /** Flattened polylines of a path (cached by path identity; paths are immutable once assigned). */
  polylines(path: Path): Polylines {
    let p = this.flattened.get(path);
    if (!p) {
      p = flattenPath(path, IDENTITY, 0.05);
      this.flattened.set(path, p);
    }
    return p;
  }
}
