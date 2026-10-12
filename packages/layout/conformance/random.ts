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
