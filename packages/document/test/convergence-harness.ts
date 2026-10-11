import { describe, expect, it } from "vitest";
import {
  CommandError,
  FigDocument,
  REMOTE,
  ROOT_ID,
  canContain,
  isContainer,
  seededRandom,
  type Actor,
  type Command,
  type Random,
} from "../src";
import { serializeFigtreeJson, toFigtreeJson } from "../src/format/json";

/** Checks tree invariants without vitest overhead; returns a description of the first violation. */
export function treeViolation(doc: FigDocument): string | null {
  const tree = doc.tree;
  const seen = new Set<string>();
  const stack: [string, number][] = [[ROOT_ID, 0]];
  while (stack.length) {
    const [id, depth] = stack.pop()!;
    if (depth > 10_000) return `depth overflow at ${id}`;
    for (const c of tree.childrenOf(id)) {
      if (seen.has(c)) return `${c} reachable twice`;
      seen.add(c);
      if (tree.parentOf(c) !== id) return `${c} parent mismatch`;
      const pt = id === ROOT_ID ? null : doc.typeOf(id)!;
      if (!canContain(pt, doc.typeOf(c)!)) return `${doc.typeOf(c)} ${c} under ${pt}`;
      stack.push([c, depth + 1]);
    }
  }
  if (seen.size !== tree.size) return `${tree.size - seen.size} nodes unreachable from the root`;
  return null;
}

interface Replica {
  readonly doc: FigDocument;
  readonly actor: Actor;
}

export interface RunStats {
  applied: number;
  rejected: number;
  delivered: number;
  repairs: number;
  maxNodes: number;
  finalNodes: number;
  byType: Record<string, number>;
}

/**
 * A network of replicas exchanging Yjs updates. Connections are interleaved
 * at random; within one connection updates usually arrive in order (like a
 * socket), but a fraction arrive out of order to exercise Yjs's buffering of
 * updates whose dependencies are missing.
 */
export class Network {
  readonly replicas: Replica[] = [];
  private queue: { from: number; to: number; update: Uint8Array }[] = [];
  /** Probability that a delivery skips ahead of older updates on its connection. */
  static OUT_OF_ORDER = 0.05;

  constructor(count: number, seed: number) {
    const base = FigDocument.create({ random: seededRandom(seed), clientId: 1 });
    const state = base.encodeState();
    for (let i = 0; i < count; i++) {
      const doc = i === 0 ? base : FigDocument.fromUpdate(state, { random: seededRandom(seed * 31 + i), clientId: i + 1 });
      const r = { doc, actor: doc.actor(`user-${i}`) };
      doc.ydoc.on("updateV2", (update: Uint8Array, origin: unknown) => {
        if (origin === REMOTE) return;
        for (let j = 0; j < count; j++) if (j !== i) this.queue.push({ from: i, to: j, update });
      });
      this.replicas.push(r);
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Delivers one random queued update. Returns the receiving replica. */
  deliverOne(random: Random): number {
    let k = Math.floor(random() * this.queue.length);
    if (random() >= Network.OUT_OF_ORDER) {
      // In order on this connection: take its oldest pending update.
      const { from, to } = this.queue[k]!;
      k = this.queue.findIndex((m) => m.from === from && m.to === to);
    }
    const [msg] = this.queue.splice(k, 1);
    this.replicas[msg!.to]!.doc.applyUpdate(msg!.update);
    return msg!.to;
  }

  /** Delivers everything, in random order. */
  syncAll(random: Random): number {
    let n = 0;
    while (this.queue.length) {
      this.deliverOne(random);
      n++;
    }
    return n;
  }

  snapshots(): string[] {
    return this.replicas.map((r) => serializeFigtreeJson(toFigtreeJson(r.doc)));
  }
}

const PALETTE = [
  { r: 1, g: 0, b: 0, a: 1 },
  { r: 0, g: 0.5, b: 1, a: 1 },
  { r: 0.1, g: 0.8, b: 0.3, a: 0.5 },
];

function pick<T>(random: Random, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)]!;
}

/** A random command against the replica's current state (it may still be rejected). */
export function randomCommand(doc: FigDocument, random: Random): Command {
  const tree = doc.tree;
  const all = [...tree.ids()];
  const layers = all.filter((id) => doc.typeOf(id) !== "page");
  const containers = all.filter((id) => isContainer(doc.typeOf(id)!));
  const texts = layers.filter((id) => doc.typeOf(id) === "text");
  const r = random();
  const anyLayer = (): string => pick(random, layers);
  if (layers.length < 5 || r < 0.3) {
    if (random() < 0.03) return { type: "createNode", node: { type: "page" }, parent: ROOT_ID, index: Math.floor(random() * 3) };
    const type = pick(random, ["frame", "frame", "group", "rectangle", "ellipse", "text", "vector"] as const);
    const parent = pick(random, containers);
    return {
      type: "createNode",
      node: type === "text" ? { type, text: { content: "abc", runs: [] } } : { type, props: { x: Math.floor(random() * 500) } },
      parent,
      index: Math.floor(random() * (tree.childrenOf(parent).length + 1)),
    };
  }
  if (r < 0.52) {
    const id = anyLayer();
    const type = doc.typeOf(id)!;
    const roll = random();
    if (roll < 0.3) return { type: "updateProps", id, props: { x: Math.floor(random() * 1000), y: Math.floor(random() * 1000) } };
    if (roll < 0.45) return { type: "updateProps", id, props: { opacity: Math.round(random() * 100) / 100 } };
    if (roll < 0.6) return { type: "rename", id, name: `n${Math.floor(random() * 100)}` };
    if (roll < 0.75 && type !== "group") return { type: "updateProps", id, props: { fills: [{ type: "solid", color: pick(random, PALETTE) }] } };
    if (roll < 0.85) return { type: "updateProps", id, props: { visible: random() < 0.5 } };
    return { type: "updateProps", id, props: { opacity: null } };
  }
  if (r < 0.67) {
    const ids = random() < 0.7 ? [anyLayer()] : [anyLayer(), anyLayer()];
    const parent = pick(random, containers.filter((c) => doc.typeOf(c) !== "page" || random() < 0.5));
    return { type: "setParent", ids, parent, index: Math.floor(random() * 5), keepPosition: random() < 0.5 };
  }
  if (r < 0.77) {
    const id = random() < 0.1 ? pick(random, tree.pages) : anyLayer();
    return { type: "reorder", id, index: Math.floor(random() * 6) };
  }
  if (r < 0.87) {
    if (random() < 0.05 && tree.pages.length > 1) return { type: "delete", ids: [pick(random, tree.pages)] };
    return { type: "delete", ids: [anyLayer()] };
  }
  if (r < 0.94 && texts.length > 0) {
    const id = pick(random, texts);
    const len = doc.text(id).content.length;
    const roll = random();
    if (roll < 0.5 || len === 0) return { type: "insertText", id, index: Math.floor(random() * (len + 1)), text: pick(random, ["x", "yz", " "]) };
    const index = Math.floor(random() * len);
    const length = 1 + Math.floor(random() * Math.min(3, len - index));
    if (roll < 0.75) return { type: "deleteText", id, index, length };
    return { type: "formatText", id, index, length, style: { fontWeight: random() < 0.5 ? 700 : null } };
  }
  const roll = random();
  if (roll < 0.4) return { type: "duplicate", ids: [anyLayer()], offset: { x: 10, y: 10 } };
  if (roll < 0.8) {
    const a = anyLayer();
    const sibs = tree.childrenOf(tree.parentOf(a)!).filter((s) => s !== a);
    return { type: "group", ids: sibs.length && random() < 0.5 ? [a, pick(random, sibs)] : [a] };
  }
  const groups = layers.filter((id) => doc.typeOf(id) === "group" || doc.typeOf(id) === "frame");
  return { type: "ungroup", id: groups.length ? pick(random, groups) : anyLayer() };
}

/**
 * Runs `commands` applied commands spread over the replicas, interleaved
 * with random partial delivery, checking tree invariants as it goes.
 */
export function runConvergence(seed: number, replicas: number, commands: number): { stats: RunStats; snapshots: string[]; violations: string[]; network: Network } {
  const random = seededRandom(seed ^ 0x5eed);
  const net = new Network(replicas, seed);
  const stats: RunStats = { applied: 0, rejected: 0, delivered: 0, repairs: 0, maxNodes: 0, finalNodes: 0, byType: {} };
  const violations: string[] = [];
  let step = 0;
  while (stats.applied < commands) {
    step++;
    const target = Math.floor(random() * replicas);
    if (random() < 0.55 || net.pending === 0) {
      const replica = net.replicas[target]!;
      const cmd = randomCommand(replica.doc, random);
      try {
        replica.doc.apply([cmd], replica.actor);
        stats.applied++;
        stats.byType[cmd.type] = (stats.byType[cmd.type] ?? 0) + 1;
      } catch (e) {
        if (!(e instanceof CommandError)) throw e;
        stats.rejected++;
      }
    } else {
      // Bursty delivery: sometimes a replica stays offline for a while.
      const n = 1 + Math.floor(random() * Math.min(net.pending, 6));
      for (let i = 0; i < n; i++) {
        net.deliverOne(random);
        stats.delivered++;
      }
    }
    if (step % 40 === 0) {
      for (const r of net.replicas) {
        const v = treeViolation(r.doc);
        if (v) violations.push(`step ${step}: ${v}`);
        stats.repairs += r.doc.tree.repaired.size;
        stats.maxNodes = Math.max(stats.maxNodes, r.doc.tree.size);
      }
    }
  }
  stats.delivered += net.syncAll(random);
  for (const r of net.replicas) {
    const v = treeViolation(r.doc);
    if (v) violations.push(`final: ${v}`);
  }
  stats.finalNodes = net.replicas[0]!.doc.tree.size;
  return { stats, snapshots: net.snapshots(), violations, network: net };
}

/**
 * Registers one test per seed. Each run: `replicas` replicas, at least
 * `commands` applied commands, random partial delivery, then full sync.
 */
export function convergenceSuite(seeds: readonly number[], replicas = 3, commands = 2000): void {
  {
    describe(`convergence: ${replicas} replicas x ${commands} commands`, () => {
      for (const seed of seeds) {
        it(`seed ${seed}`, () => {
          const { stats, snapshots, violations, network } = runConvergence(seed, replicas, commands);
          expect(violations).toEqual([]);
          expect(stats.applied).toBeGreaterThanOrEqual(commands);
          // Every replica holds identical bytes of document.json…
          for (const s of snapshots) expect(s).toBe(snapshots[0]);
          // …and identical Yjs state.
          const vectors = network.replicas.map((r) => Array.from(r.doc.stateVector()).join(","));
          for (const v of vectors) expect(v).toBe(vectors[0]);
        }, 120_000);
      }
    });
  }
}
