import type { Random } from "./order";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const ID_LENGTH = 16;

/** Cryptographically random source in [0, 1), used by default for ids and order keys. */
export function cryptoRandom(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0]! / 2 ** 32;
}

/** A new node id: 16 base-62 digits (about 95 bits). */
export function newId(random: Random = cryptoRandom): string {
  let id = "";
  for (let i = 0; i < ID_LENGTH; i++) id += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
  return id;
}

/** Deterministic pseudo-random source (mulberry32) for tests and reproducible documents. */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
