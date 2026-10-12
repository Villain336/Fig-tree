import type { CaseNode, LayoutCase } from "./case";

/**
 * Seeded random layout trees. The same seed always gives the same case, so
 * fixtures stay valid; changing a generator changes the case hashes and the
 * suite asks for `npm run conformance:update`.
 */

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Gen {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = rng(seed);
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  /** Picks with weights: [[value, weight], …]. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of items) total += w;
    let r = this.next() * total;
    for (const [v, w] of items) {
      r -= w;
      if (r < 0) return v;
    }
    return items[items.length - 1]![0];
  }
}

function words(g: Gen): [number, number][] {
  const n = g.int(1, 6);
  const h = g.int(6, 20);
  return Array.from({ length: n }, () => [g.int(8, 50), g.chance(0.3) ? g.int(6, 24) : h] as [number, number]);
}

function size(g: Gen, lo: number, hi: number, pct: boolean): string | null {
  return g.weighted<string | null>([
    [null, 5],
    [`${g.int(lo, hi)}px`, 4],
    [pct ? `${g.int(10, 100)}%` : `${g.int(lo, hi)}px`, 1],
  ]);
}

// ── Flex ─────────────────────────────────────────────────────────────────

function flexItem(g: Gen, depth: number, containerPositioned: boolean): CaseNode {
  const decls: string[] = [];
  const kind = g.weighted<"box" | "text" | "flex">([
    ["box", 5],
    ["text", 3],
    ["flex", depth < 2 ? 2 : 0],
  ]);
  if (containerPositioned && g.chance(0.08)) {
    decls.push("position:absolute");
    if (g.chance(0.5)) decls.push(`left:${g.int(0, 40)}px`);
    if (g.chance(0.3)) decls.push(`bottom:${g.int(0, 40)}px`);
    if (g.chance(0.3)) decls.push(`align-self:${g.pick(["center", "flex-end", "flex-start"])}`);
  }
  const w = size(g, 10, 160, true);
  const h = size(g, 10, 120, true);
  if (w && (kind !== "text" || g.chance(0.5))) decls.push(`width:${w}`);
  if (h && (kind !== "text" || g.chance(0.3))) decls.push(`height:${h}`);
  if (kind === "box" && !w && !h && g.chance(0.6)) decls.push(`height:${g.int(10, 60)}px`);
  if (g.chance(0.4)) decls.push(`flex-grow:${g.pick([0, 1, 1, 2, 3, 0.5])}`);
  if (g.chance(0.3)) decls.push(`flex-shrink:${g.pick([0, 1, 2, 3, 0.5])}`);
  if (g.chance(0.3)) decls.push(`flex-basis:${g.pick(["auto", "0px", "content", `${g.int(10, 150)}px`, `${g.int(5, 60)}%`])}`);
  if (g.chance(0.15)) decls.push(`min-width:${g.pick(["0", `${g.int(10, 120)}px`])}`);
  if (g.chance(0.15)) decls.push(`max-width:${g.int(20, 200)}px`);
  if (g.chance(0.1)) decls.push(`min-height:${g.int(10, 80)}px`);
  if (g.chance(0.1)) decls.push(`max-height:${g.int(10, 80)}px`);
  if (g.chance(0.25)) decls.push(`margin:${g.int(0, 12)}px ${g.pick(["auto", `${g.int(0, 12)}px`, `${g.int(0, 12)}px`])} ${g.int(0, 12)}px ${g.int(-5, 12)}px`);
  if (g.chance(0.2)) decls.push(`padding:${g.int(0, 10)}px ${g.int(0, 10)}px`);
  if (g.chance(0.15)) decls.push(`border:${g.int(1, 5)}px solid`);
  if (g.chance(0.1)) decls.push("box-sizing:border-box");
  if (g.chance(0.2)) decls.push(`align-self:${g.pick(["flex-start", "flex-end", "center", "stretch", "baseline", "start", "end"])}`);
  if (g.chance(0.1)) decls.push(`order:${g.int(-2, 2)}`);
  if (g.chance(0.05)) decls.push("overflow:hidden");
  if (kind === "text") return { style: decls.join(";"), text: words(g) };
  if (kind === "flex") return flexContainer(g, depth + 1, decls);
  return { style: decls.join(";") };
}

function flexContainer(g: Gen, depth: number, base: string[]): CaseNode {
  const decls = [...base, "display:flex"];
  const positioned = g.chance(0.3);
  if (positioned && !decls.includes("position:absolute")) decls.push("position:relative");
  decls.push(`flex-direction:${g.weighted([["row", 4], ["column", 3], ["row-reverse", 1], ["column-reverse", 1]] as const)}`);
  decls.push(`flex-wrap:${g.weighted([["nowrap", 4], ["wrap", 3], ["wrap-reverse", 1]] as const)}`);
  if (g.chance(0.5)) decls.push(`justify-content:${g.pick(["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly", "start", "end"])}`);
  if (g.chance(0.5)) decls.push(`align-items:${g.pick(["stretch", "flex-start", "flex-end", "center", "baseline", "start", "end"])}`);
  if (g.chance(0.3)) decls.push(`align-content:${g.pick(["stretch", "flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"])}`);
  if (g.chance(0.4)) decls.push(`gap:${g.int(0, 15)}px ${g.int(0, 15)}px`);
  if (g.chance(0.25)) decls.push(`padding:${g.int(0, 15)}px`);
  if (depth === 0) {
    decls.push(`width:${g.int(120, 500)}px`);
    if (g.chance(0.6)) decls.push(`height:${g.int(60, 400)}px`);
  }
  const n = g.int(depth === 0 ? 2 : 1, depth === 0 ? 7 : 4);
  const children = Array.from({ length: n }, () => flexItem(g, depth, positioned));
  return { style: decls.join(";"), children };
}

export function randomFlexCases(count: number, seed0 = 1000): LayoutCase[] {
  return Array.from({ length: count }, (_, i) => {
    const g = new Gen(seed0 + i);
    return { name: `flex/random-${seed0 + i}`, area: "flex", kind: "random", root: flexContainer(g, 0, []) };
  });
}

// ── Grid ─────────────────────────────────────────────────────────────────

function trackSize(g: Gen, definite: boolean): string {
  return g.weighted<string>([
    [`${g.int(20, 120)}px`, 4],
    [`${g.pick([0.5, 1, 1, 2, 3])}fr`, 4],
    ["auto", 3],
    ["min-content", 1],
    ["max-content", 1],
    [`${g.int(10, 40)}%`, definite ? 1 : 0.3],
    [`minmax(${g.int(10, 80)}px, ${g.pick(["1fr", "2fr", "auto", "max-content", `${g.int(80, 160)}px`])})`, 2],
    [`minmax(${g.pick(["auto", "min-content", "0px"])}, ${g.pick(["1fr", "auto", `${g.int(30, 120)}px`])})`, 2],
    [`fit-content(${g.int(20, 120)}px)`, 1],
  ]);
}

function trackList(g: Gen, n: number, definite: boolean): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    if (g.chance(0.1) && n > 1) {
      parts.push(`repeat(${g.int(2, 3)}, ${trackSize(g, definite)})`);
      continue;
    }
    parts.push(trackSize(g, definite));
  }
  return parts.join(" ");
}

function gridLine(g: Gen): string {
  return g.weighted<string>([
    [`${g.int(1, 4)}`, 3],
    [`${g.int(-3, -1)}`, 1],
    [`span ${g.int(1, 3)}`, 2],
    [`${g.int(1, 3)} / span ${g.int(1, 3)}`, 2],
    [`${g.int(1, 3)} / ${g.int(2, 5)}`, 2],
  ]);
}

function gridItem(g: Gen, depth: number, positioned: boolean, areas: string[]): CaseNode {
  const decls: string[] = [];
  const kind = g.weighted<"box" | "text" | "grid" | "flex">([
    ["box", 5],
    ["text", 4],
    ["grid", depth < 1 ? 1 : 0],
    ["flex", depth < 1 ? 1 : 0],
  ]);
  if (positioned && g.chance(0.08)) {
    decls.push("position:absolute");
    if (g.chance(0.5)) decls.push(`inset:${g.int(0, 20)}px`);
  }
  if (areas.length && g.chance(0.3)) decls.push(`grid-area:${g.pick(areas)}`);
  else {
    if (g.chance(0.3)) decls.push(`grid-column:${gridLine(g)}`);
    if (g.chance(0.25)) decls.push(`grid-row:${gridLine(g)}`);
  }
  const w = size(g, 10, 140, true);
  const h = size(g, 10, 90, true);
  if (w && (kind !== "text" || g.chance(0.4))) decls.push(`width:${w}`);
  if (h && (kind !== "text" || g.chance(0.3))) decls.push(`height:${h}`);
  if (g.chance(0.1)) decls.push(`min-width:${g.pick(["0", `${g.int(10, 100)}px`])}`);
  if (g.chance(0.1)) decls.push(`max-width:${g.int(20, 160)}px`);
  if (g.chance(0.08)) decls.push(`min-height:${g.int(10, 60)}px`);
  if (g.chance(0.08)) decls.push(`max-height:${g.int(10, 60)}px`);
  if (g.chance(0.2)) decls.push(`margin:${g.int(0, 10)}px ${g.pick(["auto", `${g.int(0, 10)}px`])} ${g.int(0, 10)}px ${g.int(-4, 10)}px`);
  if (g.chance(0.2)) decls.push(`padding:${g.int(0, 8)}px ${g.int(0, 8)}px`);
  if (g.chance(0.15)) decls.push(`border:${g.int(1, 4)}px solid`);
  if (g.chance(0.1)) decls.push("box-sizing:border-box");
  if (g.chance(0.2)) decls.push(`justify-self:${g.pick(["start", "end", "center", "stretch"])}`);
  if (g.chance(0.2)) decls.push(`align-self:${g.pick(["start", "end", "center", "stretch", "baseline"])}`);
  if (g.chance(0.08)) decls.push(`order:${g.int(-2, 2)}`);
  if (g.chance(0.05)) decls.push("overflow:hidden");
  if (kind === "text") return { style: decls.join(";"), text: words(g) };
  if (kind === "grid") return gridContainer(g, depth + 1, decls);
  if (kind === "flex") {
    const n = g.int(1, 3);
    decls.push("display:flex", `flex-wrap:${g.pick(["nowrap", "wrap"])}`, `gap:${g.int(0, 8)}px`);
    return { style: decls.join(";"), children: Array.from({ length: n }, () => ({ style: g.chance(0.5) ? `width:${g.int(10, 60)}px;height:${g.int(5, 30)}px` : "", text: g.chance(0.5) ? words(g) : undefined }) as CaseNode) };
  }
  return { style: decls.join(";") };
}

function gridContainer(g: Gen, depth: number, base: string[]): CaseNode {
  const decls = [...base, "display:grid"];
  const positioned = depth === 0 && g.chance(0.3);
  if (positioned) decls.push("position:relative");
  const definiteW = depth === 0 || g.chance(0.3);
  if (depth === 0) decls.push(`width:${g.int(150, 500)}px`);
  const definiteH = depth === 0 && g.chance(0.4);
  if (definiteH) decls.push(`height:${g.int(80, 400)}px`);
  let areas: string[] = [];
  const cols = g.int(1, 4);
  if (depth === 0 && g.chance(0.12)) {
    // Named areas over a small explicit grid.
    const rows = g.int(1, 3);
    const names = ["a", "b", "c", "d"];
    const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (g.chance(0.2) ? "." : names[Math.min(names.length - 1, Math.floor((r * cols + c) / 2))]!)));
    // Keep only rectangular areas: drop names whose cells are not a rectangle.
    const valid = names.filter((n) => {
      const cells: [number, number][] = [];
      grid.forEach((row, r) => row.forEach((v, c) => v === n && cells.push([r, c])));
      if (!cells.length) return false;
      const r0 = Math.min(...cells.map((x) => x[0])), r1 = Math.max(...cells.map((x) => x[0]));
      const c0 = Math.min(...cells.map((x) => x[1])), c1 = Math.max(...cells.map((x) => x[1]));
      return cells.length === (r1 - r0 + 1) * (c1 - c0 + 1);
    });
    const cleaned = grid.map((row) => row.map((v) => (valid.includes(v) ? v : ".")));
    decls.push(`grid-template-areas:${cleaned.map((row) => `"${row.join(" ")}"`).join(" ")}`);
    areas = valid;
  }
  decls.push(`grid-template-columns:${trackList(g, cols, definiteW)}`);
  if (g.chance(0.6)) decls.push(`grid-template-rows:${trackList(g, g.int(1, 3), definiteH)}`);
  if (g.chance(0.3)) decls.push(`grid-auto-rows:${trackSize(g, definiteH)}`);
  if (g.chance(0.15)) decls.push(`grid-auto-columns:${trackSize(g, definiteW)}`);
  if (g.chance(0.3)) decls.push(`grid-auto-flow:${g.pick(["row", "column", "row dense", "column dense"])}`);
  if (g.chance(0.5)) decls.push(`gap:${g.int(0, 15)}px ${g.int(0, 15)}px`);
  if (g.chance(0.3)) decls.push(`justify-content:${g.pick(["start", "end", "center", "space-between", "space-around", "space-evenly", "stretch"])}`);
  if (g.chance(0.3)) decls.push(`align-content:${g.pick(["start", "end", "center", "space-between", "space-around", "space-evenly", "stretch"])}`);
  if (g.chance(0.3)) decls.push(`justify-items:${g.pick(["start", "end", "center", "stretch"])}`);
  if (g.chance(0.3)) decls.push(`align-items:${g.pick(["start", "end", "center", "stretch", "baseline"])}`);
  if (g.chance(0.25)) decls.push(`padding:${g.int(0, 12)}px`);
  if (g.chance(0.1)) decls.push(`border:${g.int(1, 4)}px solid`);
  const n = g.int(depth === 0 ? 2 : 1, depth === 0 ? 8 : 4);
  const children = Array.from({ length: n }, () => gridItem(g, depth, positioned, areas));
  return { style: decls.join(";"), children };
}

export function randomGridCases(count: number, seed0 = 2000): LayoutCase[] {
  return Array.from({ length: count }, (_, i) => {
    const g = new Gen(seed0 + i);
    return { name: `grid/random-${seed0 + i}`, area: "grid", kind: "random", root: gridContainer(g, 0, []) };
  });
}
