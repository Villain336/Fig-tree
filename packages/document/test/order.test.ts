import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareOrder, isOrderKey, keyBetween, keysBetween, seededRandom, spacedKeys } from "../src";

describe("order keys", () => {
  it("generates keys strictly between any two keys", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(), fc.boolean()), { minLength: 1, maxLength: 300 }), fc.integer(), (ops, seed) => {
        const random = seededRandom(seed);
        const keys: string[] = [];
        for (const [pos, end] of ops) {
          const i = end ? keys.length : pos % (keys.length + 1);
          const k = keyBetween(keys[i - 1] ?? null, keys[i] ?? null, random);
          expect(isOrderKey(k)).toBe(true);
          if (i > 0) expect(k > keys[i - 1]!).toBe(true);
          if (i < keys.length) expect(k < keys[i]!).toBe(true);
          keys.splice(i, 0, k);
        }
      }),
    );
  });

  it("stays short under repeated appends and repeated inserts at the front", () => {
    const random = seededRandom(3);
    let last: string | null = null;
    for (let i = 0; i < 1000; i++) last = keyBetween(last, null, random);
    expect(last!.length).toBeLessThan(40);
    let first: string | null = null;
    for (let i = 0; i < 1000; i++) first = keyBetween(null, first, random);
    expect(first!.length).toBeLessThan(400);
  });

  it("rejects malformed or out-of-order bounds", () => {
    expect(() => keyBetween("b", "a")).toThrow(/out of order/);
    expect(() => keyBetween("a", "a")).toThrow(/out of order/);
    expect(() => keyBetween("a0", null)).toThrow(/invalid/);
    expect(() => keyBetween("a!", null)).toThrow(/invalid/);
  });

  it("spaces import keys evenly and in order", () => {
    for (const n of [0, 1, 2, 61, 62, 1000, 5000]) {
      const keys = spacedKeys(n);
      expect(keys.length).toBe(n);
      keys.forEach((k, i) => {
        expect(isOrderKey(k)).toBe(true);
        if (i > 0) expect(k > keys[i - 1]!).toBe(true);
      });
    }
  });

  it("breaks key ties by id", () => {
    expect(compareOrder("V", "a", "V", "b")).toBeLessThan(0);
    expect(compareOrder("V", "b", "W", "a")).toBeLessThan(0);
  });
});

describe("keysBetween", () => {
  it("returns increasing keys inside the bounds, short even for large batches", () => {
    const random = seededRandom(9);
    for (const [a, b] of [[null, null], ["V", null], [null, "V"], ["V", "W"], ["V", "V1"]] as const) {
      const keys = keysBetween(a, b, 1000, random);
      expect(keys.length).toBe(1000);
      keys.forEach((k, i) => {
        if (i > 0) expect(k > keys[i - 1]!).toBe(true);
        if (a) expect(k > a).toBe(true);
        if (b) expect(k < b).toBe(true);
      });
      expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(60);
    }
  });
});
