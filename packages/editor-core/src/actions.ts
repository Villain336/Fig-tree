import { newId, type Command, type FigDocument } from "@fig-tree/document";
import type { Editor } from "./editor";
import { boxContainsPoint, clean, invert, transformPoint, unionBoxes, type Box } from "./math";
import { boxFromMatrix } from "@fig-tree/document";
import { multiply, type Mat2D } from "@fig-tree/geometry";
import { layoutDisplay, reparentCommands } from "./placement";
import { isBoard, isContainer, normalizeSelection, selectableChildren, selectionScope, sortByPaintOrder } from "./selection";
import { textSession } from "./text/mode";
import { boxedNodes, capture, isInFlow, moveProps, placementProps } from "./transform";

/**
 * Editor actions: what menus, shortcuts and panel buttons do. Each returns
 * false when it does not apply. All edits go through `editor.history`.
 */

type Action = (editor: Editor) => boolean;

const tool = (id: string): Action => (e) => {
  e.setTool(id);
  return true;
};

export const ACTIONS: Record<string, Action> = {
  "tool.select": tool("select"),
  "tool.hand": tool("hand"),
  "tool.frame": tool("frame"),
  "tool.rectangle": tool("rectangle"),
  "tool.ellipse": tool("ellipse"),
  "tool.polygon": tool("polygon"),
  "tool.star": tool("star"),
  "tool.line": tool("line"),
  "tool.text": tool("text"),
  "tool.image": tool("image"),

  "edit.undo": (e) => {
    const ok = e.history.undo();
    textSession(e)?.sync();
    return ok || true;
  },
  "edit.redo": (e) => {
    const ok = e.history.redo();
    textSession(e)?.sync();
    return ok || true;
  },
  // The browser's copy, cut and paste events carry the clipboard; the host handles them.
  "edit.copy": () => false,
  "edit.cut": () => false,
  "edit.paste": () => false,
  "edit.duplicate": (e) => duplicateSelection(e),
  "edit.delete": (e) => deleteSelection(e),
  "edit.rename": (e) => {
    const id = e.selection[0];
    if (!id) return false;
    e.request({ kind: "rename", id });
    return true;
  },

  "select.all": (e) => {
    const scope = selectionScope(e.doc, e.selection, e.page);
    e.select(selectableChildren(e.doc, scope));
    return true;
  },
  "select.none": (e) => {
    if (e.session) {
      const id = e.session.nodeId;
      e.exitEditMode();
      if (e.doc.has(id)) e.select([id]);
      return true;
    }
    if (e.selection.length === 0) return false;
    const parents = [...new Set(e.selection.map((id) => e.doc.tree.parentOf(id)!))];
    const up = parents.filter((p) => p !== e.page && !isBoard(e.doc, p) && e.doc.typeOf(p) !== "page");
    e.select(up.length === parents.length ? up : []);
    return true;
  },
  "select.children": (e) => {
    const [id] = e.selection;
    if (!id || e.selection.length !== 1) return false;
    const type = e.doc.typeOf(id)!;
    if (e.editModes.forType(type) && !isContainer(e.doc, id)) return e.enterEditMode(id);
    const kids = selectableChildren(e.doc, id);
    if (kids.length === 0) return false;
    e.select(kids);
    return true;
  },
  "select.parent": (e) => {
    const parents = [...new Set(e.selection.map((id) => e.doc.tree.parentOf(id)!))].filter((p) => e.doc.typeOf(p) !== "page");
    if (parents.length === 0) return false;
    e.select(parents);
    return true;
  },
  "select.next": (e) => selectSibling(e, 1),
  "select.previous": (e) => selectSibling(e, -1),

  "arrange.group": (e) => groupSelection(e),
  "arrange.ungroup": (e) => ungroupSelection(e),
  "arrange.frame": (e) => frameSelection(e),
  "arrange.forward": (e) => reorderSelection(e, "forward"),
  "arrange.backward": (e) => reorderSelection(e, "backward"),
  "arrange.front": (e) => reorderSelection(e, "front"),
  "arrange.back": (e) => reorderSelection(e, "back"),
  "object.lock": (e) => toggleFlag(e, "locked"),
  "object.hide": (e) => toggleFlag(e, "visible"),
  "object.flipX": (e) => flipSelection(e, "x"),
  "object.flipY": (e) => flipSelection(e, "y"),

  "align.left": (e) => alignSelection(e, "x", 0),
  "align.centerX": (e) => alignSelection(e, "x", 0.5),
  "align.right": (e) => alignSelection(e, "x", 1),
  "align.top": (e) => alignSelection(e, "y", 0),
  "align.centerY": (e) => alignSelection(e, "y", 0.5),
  "align.bottom": (e) => alignSelection(e, "y", 1),
  "distribute.x": (e) => distributeSelection(e, "x"),
  "distribute.y": (e) => distributeSelection(e, "y"),

  "layout.add": (e) => addAutoLayout(e),
  "layout.remove": (e) => removeAutoLayout(e),

  "text.bold": (e) => toggleTextStyle(e, "bold"),
  "text.italic": (e) => toggleTextStyle(e, "italic"),
  "text.underline": (e) => toggleTextStyle(e, "underline"),

  "view.zoomIn": (e) => zoom(e, () => e.viewport.zoomStep(1)),
  "view.zoomOut": (e) => zoom(e, () => e.viewport.zoomStep(-1)),
  "view.zoomFit": (e) => zoomToFit(e),
  "view.zoomSelection": (e) => {
    const b = e.geometry.boundsOf(e.selection);
    if (!b) return zoomToFit(e);
    return zoom(e, () => e.viewport.fit(b, 64, 32));
  },
  "view.zoom100": (e) => zoom(e, () => e.viewport.actualSize()),
  "view.pixelGrid": (e) => {
    e.updateSettings({ pixelGrid: !e.settings.pixelGrid });
    return true;
  },
  "view.rulers": (e) => {
    e.updateSettings({ rulers: !e.settings.rulers });
    return true;
  },
  "view.snapping": (e) => {
    e.updateSettings({ snapping: !e.settings.snapping });
    return true;
  },
  "view.pixelSnap": (e) => {
    e.updateSettings({ pixelSnap: !e.settings.pixelSnap });
    return true;
  },
  "help.shortcuts": (e) => {
    e.request({ kind: "shortcuts" });
    return true;
  },
};

export function runAction(editor: Editor, action: string): boolean {
  const a = ACTIONS[action];
  return a ? a(editor) : false;
}

const NEEDS_SELECTION = /^(edit\.(duplicate|delete|rename|copy|cut)|arrange\.|object\.|align\.|select\.(parent|next|previous|children)|view\.zoomSelection|text\.)/;

/** Whether an action applies now (for enabling menu items). */
export function actionEnabled(editor: Editor, action: string): boolean {
  if (!(action in ACTIONS)) return false;
  if (action === "edit.undo") return editor.history.canUndo();
  if (action === "edit.redo") return editor.history.canRedo();
  if (NEEDS_SELECTION.test(action) && editor.selection.length === 0) return false;
  if (action === "arrange.ungroup") return editor.selection.some((id) => ["group", "frame"].includes(editor.doc.typeOf(id) ?? ""));
  if (action.startsWith("distribute.")) return editor.selection.length >= 3;
  if (action === "layout.remove") return editor.selection.some((id) => layoutDisplay(editor.doc, id) !== null);
  return true;
}

function zoom(editor: Editor, fn: () => void): boolean {
  fn();
  editor.emit("view");
  return true;
}

/** Fits the page's content in view. */
export function zoomToFit(editor: Editor): boolean {
  const ids = editor.doc.tree.childrenOf(editor.page).filter((id) => editor.doc.get<boolean>(id, "visible"));
  const b = editor.geometry.boundsOf(ids);
  if (!b) return zoom(editor, () => editor.viewport.set(1, Math.round(editor.viewport.width / 2), Math.round(editor.viewport.height / 2)));
  return zoom(editor, () => editor.viewport.fit(b, 48, 2));
}

function unlocked(editor: Editor): string[] {
  return normalizeSelection(editor.doc, editor.selection, editor.page).filter((id) => !editor.doc.get<boolean>(id, "locked"));
}

export function deleteSelection(editor: Editor): boolean {
  const ids = unlocked(editor);
  if (ids.length === 0) return false;
  editor.history.apply([{ type: "delete", ids }]);
  editor.select([]);
  return true;
}

export function duplicateSelection(editor: Editor): boolean {
  const ids = unlocked(editor);
  if (ids.length === 0) return false;
  const flow = ids.every((id) => isInFlow(editor.doc, id));
  const r = editor.history.apply([{ type: "duplicate", ids, ...(flow ? {} : { offset: { x: 10, y: 10 } }) }]);
  if (!r) return false;
  editor.select(r.results[0]!.created.slice(0, ids.length));
  return true;
}

function selectSibling(editor: Editor, step: 1 | -1): boolean {
  const [id] = editor.selection;
  if (!id) return false;
  const parent = editor.doc.tree.parentOf(id)!;
  const kids = selectableChildren(editor.doc, parent);
  if (kids.length === 0) return false;
  // Layers list the top first: "next" goes down the list (towards the back).
  const i = kids.indexOf(id);
  const next = kids[(i - step + kids.length) % kids.length]!;
  editor.select([next]);
  return true;
}

/** Moves nodes to a common parent first when they do not share one. */
function commonParent(editor: Editor, ids: readonly string[]): { parent: string; cmds: Command[] } {
  const doc = editor.doc;
  const parents = new Set(ids.map((id) => doc.tree.parentOf(id)!));
  const sorted = sortByPaintOrder(doc, ids);
  const parent = doc.tree.parentOf(sorted[sorted.length - 1]!)!;
  if (parents.size === 1) return { parent, cmds: [] };
  return { parent, cmds: [{ type: "setParent", ids: sorted.filter((id) => doc.tree.parentOf(id) !== parent), parent, keepPosition: true }] };
}

export function groupSelection(editor: Editor): boolean {
  const ids = normalizeSelection(editor.doc, editor.selection, editor.page);
  if (ids.length === 0) return false;
  const { cmds } = commonParent(editor, ids);
  const id = newId(editor.doc.random);
  const r = editor.history.apply([...cmds, { type: "group", ids, id }]);
  if (!r) return false;
  editor.select([id]);
  return true;
}

export function ungroupSelection(editor: Editor): boolean {
  const doc = editor.doc;
  const targets = editor.selection.filter((id) => ["group", "frame"].includes(doc.typeOf(id) ?? ""));
  if (targets.length === 0) return false;
  const released = targets.flatMap((id) => [...doc.tree.childrenOf(id)]);
  const r = editor.history.apply(targets.map((id) => ({ type: "ungroup" as const, id })));
  if (!r) return false;
  editor.select(released);
  return true;
}

/** Wraps the selection in a new frame that fits it (Cmd+Alt+G). */
export function frameSelection(editor: Editor, extraFrameProps: Record<string, unknown> = {}): boolean {
  const doc = editor.doc;
  const ids = normalizeSelection(doc, editor.selection, editor.page);
  if (ids.length === 0) return false;
  const { parent, cmds } = commonParent(editor, ids);
  const sorted = sortByPaintOrder(doc, ids);
  const bounds = editor.geometry.boundsOf(ids)!;
  const space = parentSpaceOf(editor, parent);
  const inv = invert(space)!;
  // The frame's box in the parent's space (axis-aligned with the parent).
  const corners = [transformPoint(inv, bounds.x, bounds.y), transformPoint(inv, bounds.x + bounds.width, bounds.y + bounds.height)];
  const x = Math.min(corners[0]!.x, corners[1]!.x);
  const y = Math.min(corners[0]!.y, corners[1]!.y);
  const frame = newId(doc.random);
  const top = sorted[sorted.length - 1]!;
  const index = doc.tree.parentOf(top) === parent ? doc.tree.indexOf(top) + 1 : undefined;
  const flow = layoutDisplay(doc, parent) !== null;
  const r = editor.history.apply([
    ...cmds,
    {
      type: "createNode",
      node: { id: frame, type: "frame", props: { name: "Frame", x: clean(x), y: clean(y), width: clean(Math.abs(corners[1]!.x - corners[0]!.x)), height: clean(Math.abs(corners[1]!.y - corners[0]!.y)), fills: [], ...(flow ? { position: "relative" } : {}), ...extraFrameProps } },
      parent,
      ...(index !== undefined ? { index } : {}),
    },
    { type: "setParent", ids: sorted, parent: frame, keepPosition: true },
    ...sorted.filter((id) => isInFlow(doc, id)).map((id) => ({ type: "updateProps" as const, id, props: { position: "absolute" } })),
  ]);
  if (!r) return false;
  editor.select([frame]);
  return true;
}

function parentSpaceOf(editor: Editor, parent: string): Mat2D {
  let p = parent;
  while (editor.doc.typeOf(p) === "group") p = editor.doc.tree.parentOf(p)!;
  return editor.doc.typeOf(p) === "page" ? [1, 0, 0, 1, 0, 0] : editor.geometry.worldMatrix(p);
}

type Order = "forward" | "backward" | "front" | "back";

export function reorderSelection(editor: Editor, order: Order): boolean {
  const doc = editor.doc;
  const ids = sortByPaintOrder(doc, normalizeSelection(doc, editor.selection, editor.page));
  if (ids.length === 0) return false;
  const byParent = new Map<string, string[]>();
  for (const id of ids) {
    const p = doc.tree.parentOf(id)!;
    byParent.set(p, [...(byParent.get(p) ?? []), id]);
  }
  const cmds: Command[] = [];
  for (const [parent, group] of byParent) {
    const n = doc.tree.childrenOf(parent).length;
    const others = n - group.length;
    if (order === "front") cmds.push({ type: "setParent", ids: group, parent, index: others, keepPosition: false });
    else if (order === "back") cmds.push({ type: "setParent", ids: group, parent, index: 0, keepPosition: false });
    else {
      // One step past the nearest sibling that is not selected.
      const kids = doc.tree.childrenOf(parent);
      const set = new Set(group);
      const indices = group.map((id) => kids.indexOf(id));
      if (order === "forward") {
        const top = Math.max(...indices);
        const next = kids.findIndex((k, i) => i > top && !set.has(k));
        if (next < 0) continue;
        // Index among the others: everything up to and including `next`, minus selected below it.
        const target = kids.slice(0, next + 1).filter((k) => !set.has(k)).length;
        cmds.push({ type: "setParent", ids: group, parent, index: target, keepPosition: false });
      } else {
        const bottom = Math.min(...indices);
        let prev = -1;
        for (let i = bottom - 1; i >= 0; i--) {
          if (!set.has(kids[i]!)) {
            prev = i;
            break;
          }
        }
        if (prev < 0) continue;
        const target = kids.slice(0, prev).filter((k) => !set.has(k)).length;
        cmds.push({ type: "setParent", ids: group, parent, index: target, keepPosition: false });
      }
    }
  }
  if (cmds.length === 0) return false;
  editor.history.apply(cmds);
  return true;
}

function toggleFlag(editor: Editor, key: "locked" | "visible"): boolean {
  const ids = normalizeSelection(editor.doc, editor.selection, editor.page);
  if (ids.length === 0) return false;
  const value = key === "locked" ? !ids.every((id) => editor.doc.get<boolean>(id, "locked")) : !ids.every((id) => editor.doc.get<boolean>(id, "visible"));
  editor.history.apply(ids.map((id) => ({ type: "updateProps" as const, id, props: { [key]: value } })));
  return true;
}

/** Sets a flag on given nodes (layers panel toggles). */
export function setFlag(editor: Editor, ids: readonly string[], key: "locked" | "visible", value: boolean): void {
  editor.history.apply(ids.map((id) => ({ type: "updateProps" as const, id, props: { [key]: value } })));
}

/** Mirrors the selection about its center (each node keeps its size; flips toggle). */
export function flipSelection(editor: Editor, axis: "x" | "y"): boolean {
  const doc = editor.doc;
  const ids = unlocked(editor);
  if (ids.length === 0) return false;
  const b = editor.geometry.boundsOf(ids)!;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const mirror: Mat2D = axis === "x" ? [-1, 0, 0, 1, 2 * cx, 0] : [1, 0, 0, -1, 0, 2 * cy];
  const cmds: Command[] = [];
  for (const id of boxedNodes(doc, ids)) {
    const c = capture(editor.geometry, id);
    if (c.inFlow) {
      cmds.push({ type: "updateProps", id, props: axis === "x" ? { flipX: !c.stored.flipX } : { flipY: !c.stored.flipY } });
      continue;
    }
    // The reflected box (a matrix with a reflection: boxFromMatrix turns it into a flip).
    const next = multiply(mirror, c.world);
    const props = placementProps(c, next, c.width, c.height) as Record<string, unknown>;
    // A mirror toggles one flip; boxFromMatrix expresses vertical mirrors as flipX plus a half turn,
    // so name the flip the user asked for when the node is unrotated.
    if (axis === "y" && c.stored.rotation === 0) {
      cmds.push({ type: "updateProps", id, props: { ...props, flipX: c.stored.flipX, flipY: !c.stored.flipY, rotation: 0 } });
      continue;
    }
    cmds.push({ type: "updateProps", id, props });
  }
  editor.history.apply(cmds);
  return true;
}

/** World bounds of each selected node, and the box they align within (the selection, or a single node's parent frame). */
function alignContext(editor: Editor): { ids: string[]; boxes: Map<string, Box>; within: Box } | null {
  const doc = editor.doc;
  const ids = unlocked(editor).filter((id) => !isInFlow(doc, id));
  if (ids.length === 0) return null;
  const boxes = new Map(ids.map((id) => [id, editor.geometry.bounds(id)]));
  if (ids.length === 1) {
    let p = doc.tree.parentOf(ids[0]!)!;
    while (doc.typeOf(p) === "group") p = doc.tree.parentOf(p)!;
    if (doc.typeOf(p) === "page") return null;
    return { ids, boxes, within: editor.geometry.bounds(p) };
  }
  return { ids, boxes, within: unionBoxes(boxes.values())! };
}

function moveBy(editor: Editor, id: string, dx: number, dy: number, out: Command[]): void {
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;
  for (const b of boxedNodes(editor.doc, [id])) {
    const c = capture(editor.geometry, b);
    if (c.inFlow) continue;
    out.push({ type: "updateProps", id: b, props: moveProps(c, dx, dy) as Record<string, unknown> });
  }
}

/** Aligns edges (0), centers (0.5) or far edges (1) on an axis. */
export function alignSelection(editor: Editor, axis: "x" | "y", at: 0 | 0.5 | 1): boolean {
  const ctx = alignContext(editor);
  if (!ctx) return false;
  const w = ctx.within;
  const target = axis === "x" ? w.x + w.width * at : w.y + w.height * at;
  const cmds: Command[] = [];
  for (const id of ctx.ids) {
    const b = ctx.boxes.get(id)!;
    const cur = axis === "x" ? b.x + b.width * at : b.y + b.height * at;
    const d = target - cur;
    moveBy(editor, id, axis === "x" ? d : 0, axis === "y" ? d : 0, cmds);
  }
  if (cmds.length) editor.history.apply(cmds);
  return true;
}

/** Spaces three or more nodes evenly between the outermost ones. */
export function distributeSelection(editor: Editor, axis: "x" | "y"): boolean {
  const ctx = alignContext(editor);
  if (!ctx || ctx.ids.length < 3) return false;
  const start = (b: Box): number => (axis === "x" ? b.x : b.y);
  const size = (b: Box): number => (axis === "x" ? b.width : b.height);
  const sorted = [...ctx.ids].sort((a, b) => start(ctx.boxes.get(a)!) + size(ctx.boxes.get(a)!) / 2 - (start(ctx.boxes.get(b)!) + size(ctx.boxes.get(b)!) / 2));
  const first = ctx.boxes.get(sorted[0]!)!;
  const last = ctx.boxes.get(sorted[sorted.length - 1]!)!;
  const span = start(last) + size(last) - start(first);
  const total = sorted.reduce((s, id) => s + size(ctx.boxes.get(id)!), 0);
  const gap = (span - total) / (sorted.length - 1);
  const cmds: Command[] = [];
  let pos = start(first);
  for (const id of sorted) {
    const b = ctx.boxes.get(id)!;
    const d = pos - start(b);
    moveBy(editor, id, axis === "x" ? d : 0, axis === "y" ? d : 0, cmds);
    pos += size(b) + gap;
  }
  if (cmds.length) editor.history.apply(cmds);
  return true;
}

/**
 * Turns the selected frame into a flex container (auto layout), with a
 * direction, gap and padding guessed from where its children are; the
 * children join the flow in their visual order. Other selections are
 * wrapped in a new flex frame.
 */
export function addAutoLayout(editor: Editor): boolean {
  const doc = editor.doc;
  const ids = normalizeSelection(doc, editor.selection, editor.page);
  if (ids.length === 0) return false;
  if (ids.length === 1 && ["frame", "component", "instance"].includes(doc.typeOf(ids[0]!)!) && layoutDisplay(doc, ids[0]!) === null) {
    const frame = ids[0]!;
    const kids = doc.tree.childrenOf(frame).filter((c) => doc.get<boolean>(c, "visible") && doc.typeOf(c) !== "group");
    const fb = editor.geometry.bounds(frame);
    const guess = guessFlow(kids.map((id) => ({ id, box: editor.geometry.bounds(id) })), fb);
    const cmds: Command[] = [
      {
        type: "updateProps",
        id: frame,
        props: {
          display: "flex",
          flexDirection: guess.direction,
          [guess.direction === "row" ? "columnGap" : "rowGap"]: guess.gap,
          padding: guess.padding,
          alignItems: "flex-start",
          justifyContent: "flex-start",
          ...(kids.length > 0 ? { widthMode: "hug", heightMode: "hug" } : {}),
        },
      },
    ];
    if (guess.order.length > 0) {
      cmds.push({ type: "setParent", ids: guess.order, parent: frame, index: 0, keepPosition: false });
      for (const id of guess.order) cmds.push({ type: "updateProps", id, props: { position: "relative" } });
    }
    editor.history.apply(cmds);
    return true;
  }
  // Wrap the selection in a new flex frame.
  const boxes = ids.map((id) => ({ id, box: editor.geometry.bounds(id) }));
  const bounds = unionBoxes(boxes.map((b) => b.box))!;
  const guess = guessFlow(boxes, bounds);
  // Creating the frame and moving the nodes into its flow are one undo step.
  return editor.history.group(() => {
    if (!frameSelection(editor, { display: "flex", flexDirection: guess.direction, [guess.direction === "row" ? "columnGap" : "rowGap"]: guess.gap, alignItems: "flex-start", widthMode: "hug", heightMode: "hug" })) return false;
    const frame = editor.selection[0]!;
    const cmds: Command[] = [{ type: "setParent", ids: guess.order, parent: frame, index: 0, keepPosition: false }];
    for (const id of guess.order) cmds.push({ type: "updateProps", id, props: { position: "relative" } });
    editor.history.apply(cmds);
    editor.select([frame]);
    return true;
  });
}

function guessFlow(items: readonly { id: string; box: Box }[], frame: Box): { direction: "row" | "column"; gap: number; padding: { top: number; right: number; bottom: number; left: number }; order: string[] } {
  if (items.length === 0) return { direction: "row", gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 }, order: [] };
  const cx = items.map((i) => i.box.x + i.box.width / 2);
  const cy = items.map((i) => i.box.y + i.box.height / 2);
  const spread = (v: number[]): number => Math.max(...v) - Math.min(...v);
  const direction = items.length === 1 ? (frame.width >= frame.height ? "row" : "column") : spread(cx) >= spread(cy) ? "row" : "column";
  const key = (b: Box): number => (direction === "row" ? b.x : b.y);
  const sorted = [...items].sort((a, b) => key(a.box) - key(b.box));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!.box;
    const b = sorted[i]!.box;
    gaps.push(direction === "row" ? b.x - (a.x + a.width) : b.y - (a.y + a.height));
  }
  const gap = gaps.length ? Math.max(0, Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)) : 0;
  const u = unionBoxes(items.map((i) => i.box))!;
  const pad = (v: number): number => Math.max(0, Math.round(v));
  return {
    direction,
    gap,
    padding: { top: pad(u.y - frame.y), right: pad(frame.x + frame.width - (u.x + u.width)), bottom: pad(frame.y + frame.height - (u.y + u.height)), left: pad(u.x - frame.x) },
    order: sorted.map((s) => s.id),
  };
}

/** Back to a plain frame: children leave the flow where they are drawn. */
export function removeAutoLayout(editor: Editor): boolean {
  const doc = editor.doc;
  const frames = editor.selection.filter((id) => layoutDisplay(doc, id) !== null);
  if (frames.length === 0) return false;
  const cmds: Command[] = [];
  for (const f of frames) {
    const box = editor.bridge.box(f);
    const kids = doc.tree.childrenOf(f).filter((c) => isInFlow(doc, c));
    const space = editor.geometry.worldMatrix(f);
    const inv = invert(space)!;
    for (const c of kids) {
      const w = editor.geometry.worldMatrix(c);
      const { width, height } = editor.geometry.size(c);
      const b = boxFromMatrix(multiply(inv, w), width, height, doc.get<boolean>(c, "flipX"), doc.get<boolean>(c, "flipY"));
      cmds.push({ type: "updateProps", id: c, props: { position: "absolute", x: clean(b.x), y: clean(b.y), width: clean(width), height: clean(height), widthMode: "fixed", heightMode: doc.typeOf(c) === "text" ? doc.get<string>(c, "heightMode") : "fixed" } });
    }
    cmds.push({ type: "updateProps", id: f, props: { display: "block", widthMode: "fixed", heightMode: "fixed", ...(box ? { width: clean(box.width), height: clean(box.height) } : {}) } });
  }
  editor.history.apply(cmds);
  return true;
}

/** Toggles bold, italic or underline on selected text nodes (whole text), or on the edited text's selection. */
export function toggleTextStyle(editor: Editor, which: "bold" | "italic" | "underline"): boolean {
  const s = textSession(editor);
  if (s) {
    if (which === "bold") s.toggleBold();
    else if (which === "italic") s.toggleItalic();
    else s.toggleUnderline();
    return true;
  }
  const doc = editor.doc;
  const texts = editor.selection.filter((id) => doc.typeOf(id) === "text");
  if (texts.length === 0) return false;
  const key = which === "bold" ? "fontWeight" : which === "italic" ? "fontStyle" : "textDecoration";
  const on = (v: unknown): boolean => (which === "bold" ? Number(v) >= 600 : which === "italic" ? v === "italic" : v === "underline");
  const all = texts.every((id) => on(doc.get(id, key)) && doc.text(id).runs.every((r) => !(key in r.style) || on(r.style[key as keyof typeof r.style])));
  const value = which === "bold" ? (all ? 400 : 700) : which === "italic" ? (all ? "normal" : "italic") : all ? "none" : "underline";
  editor.history.apply(textNodeStyleCommands(doc, texts, { [key]: value }));
  return true;
}

/**
 * Sets text style properties on whole text nodes: the node's base style,
 * with run overrides of the same keys removed so the value applies everywhere.
 */
export function textNodeStyleCommands(doc: FigDocument, ids: readonly string[], style: Record<string, unknown>): Command[] {
  const cmds: Command[] = [];
  for (const id of ids) {
    cmds.push({ type: "updateProps", id, props: style });
    const content = doc.text(id);
    const keys = Object.keys(style).filter((k) => content.runs.some((r) => k in r.style));
    if (keys.length > 0 && content.content.length > 0) cmds.push({ type: "formatText", id, index: 0, length: content.content.length, style: Object.fromEntries(keys.map((k) => [k, null])) });
  }
  return cmds;
}

// ── Pages ──────────────────────────────────────────────────────────────

export function addPage(editor: Editor, name?: string): string | null {
  const id = newId(editor.doc.random);
  const n = editor.doc.pages.length + 1;
  const r = editor.history.apply([{ type: "createNode", node: { id, type: "page", props: { name: name ?? `Page ${n}` } }, parent: "root" }]);
  if (!r) return null;
  editor.setPage(id);
  return id;
}

export function deletePage(editor: Editor, id: string): boolean {
  if (editor.doc.pages.length <= 1) return false;
  const next = editor.doc.pages.find((p) => p !== id)!;
  if (editor.page === id) editor.setPage(next);
  return editor.history.apply([{ type: "delete", ids: [id] }]) !== null;
}

export function renameNode(editor: Editor, id: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || !editor.doc.has(id)) return false;
  return editor.history.apply([{ type: "rename", id, name: trimmed }]) !== null;
}

// ── Layers panel moves ─────────────────────────────────────────────────

/**
 * Moves nodes in the layer tree (drag and drop in the layers panel): into
 * `parent` at `index` (0 = bottom, among the other children), keeping
 * their place on the canvas unless the parent lays them out.
 */
export function moveInTree(editor: Editor, ids: readonly string[], parent: string, index: number): boolean {
  const doc = editor.doc;
  const roots = normalizeSelection(doc, ids, editor.page).filter((id) => !doc.tree.isSelfOrAncestor(id, parent));
  if (roots.length === 0) return false;
  const sorted = sortByPaintOrder(doc, roots);
  const sameParent = sorted.every((id) => doc.tree.parentOf(id) === parent);
  const cmds = sameParent ? [{ type: "setParent" as const, ids: sorted, parent, index, keepPosition: false }] : reparentCommands(editor, sorted, parent, index);
  return editor.history.apply(cmds) !== null;
}

export { boxContainsPoint };
