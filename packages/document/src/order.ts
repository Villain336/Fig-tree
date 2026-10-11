/**
 * Fractional order keys. Children are sorted by (key, id), where keys are
 * strings of base-62 digits read as fractions in (0, 1): "V" ≈ 0.5, "0V" ≈
 * 0.008. Plain string comparison orders them because the digit alphabet is
 * in ASCII order and no key ends in the zero digit.
 *
 * A new key between two neighbours picks a random digit in the gap and adds
 * random jitter digits, so two replicas inserting at the same spot at the
 * same time almost never produce equal keys; when they do, the node id
 * breaks the tie, and every replica still agrees on the order.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const JITTER_DIGITS = 2;
/** How far from an open end a new first digit may land (randomness against concurrent collisions). */
const OPEN_END_STEPS = 3;

export type Random = () => number;

function digit(c: string): number {
  const d = DIGITS.indexOf(c);
  if (d < 0) throw new Error(`invalid order key digit "${c}"`);
  return d;
}

/** Whether `key` is a well-formed order key. */
export function isOrderKey(key: string): boolean {
  return /^[0-9A-Za-z]{1,512}$/.test(key) && key[key.length - 1] !== "0";
}

function randomDigit(random: Random, lo: number, hi: number): number {
  // Uniform in [lo, hi).
  return lo + Math.min(hi - lo - 1, Math.floor(random() * (hi - lo)));
}

/**
 * Random trailing digits. Appends keep the leading jitter digits low: when
 * the next append outgrows this digit position, it continues from them.
 */
function jitter(random: Random, appending: boolean): string {
  let s = "";
  for (let i = 0; i < JITTER_DIGITS - 1; i++) s += DIGITS[randomDigit(random, 0, appending ? OPEN_END_STEPS + 1 : BASE)];
  return s + DIGITS[randomDigit(random, 1, BASE)];
}

/**
 * A key strictly between `a` and `b` (`null` means the start or the end of
 * the list). Throws if `a >= b`.
 */
export function keyBetween(a: string | null, b: string | null, random: Random = Math.random): string {
  if (a !== null && !isOrderKey(a)) throw new Error(`invalid order key "${a}"`);
  if (b !== null && !isOrderKey(b)) throw new Error(`invalid order key "${b}"`);
  if (a !== null && b !== null && a >= b) throw new Error(`order keys out of order: "${a}" >= "${b}"`);
  const lo = a ?? "";
  let hiOpen = b === null; // once we pass below b's digit, the upper bound is gone
  let prefix = "";
  for (let i = 0; ; i++) {
    const dl = i < lo.length ? digit(lo[i]!) : 0;
    const dh = hiOpen ? BASE : i < b!.length ? digit(b![i]!) : 0;
    if (dh - dl >= 2) {
      // Room for a digit strictly inside the gap: anything after it keeps the key in range.
      // Appends step up from the bottom of the gap and prepends down from its top,
      // so repeated appends (the common case) grow keys by about one digit per 30.
      let d: number;
      if (b === null) d = randomDigit(random, dl + 1, Math.min(dh, dl + 1 + OPEN_END_STEPS));
      else if (a === null) d = randomDigit(random, Math.max(dl + 1, dh - OPEN_END_STEPS), dh);
      else d = randomDigit(random, dl + 1, dh);
      return prefix + DIGITS[d] + jitter(random, b === null);
    }
    if (dh - dl === 1) {
      // Take the lower digit; everything below b's digit is now below b.
      prefix += DIGITS[dl];
      hiOpen = true;
      continue;
    }
    // Equal digits: keep the common prefix.
    prefix += DIGITS[dl];
  }
}

/**
 * `count` increasing keys between `a` and `b`, bisecting the range so key
 * length grows with log(count) rather than count.
 */
export function keysBetween(a: string | null, b: string | null, count: number, random: Random = Math.random): string[] {
  if (count <= 0) return [];
  if (b === null) {
    // Appending: small steps up from the end are cheaper than bisecting an open range.
    const out: string[] = [];
    for (let i = 0, prev = a; i < count; i++) out.push((prev = keyBetween(prev, null, random)));
    return out;
  }
  if (a === null) {
    const out: string[] = [];
    for (let i = 0, next: string = b; i < count; i++) out.unshift((next = keyBetween(null, next, random)));
    return out;
  }
  if (count === 1) return [keyBetween(a, b, random)];
  const mid = Math.floor(count / 2);
  const m = keyBetween(a, b, random);
  return [...keysBetween(a, m, mid, random), m, ...keysBetween(m, b, count - mid - 1, random)];
}

/** `count` evenly spaced keys in increasing order, with no randomness (used by importers). */
export function spacedKeys(count: number): string[] {
  const keys: string[] = [];
  // Enough digits for `count` distinct values, leaving gaps on both sides.
  let width = 1;
  while (BASE ** width < (count + 1) * 2) width++;
  const step = BASE ** width / (count + 1);
  for (let i = 1; i <= count; i++) {
    let v = Math.round(step * i);
    let s = "";
    for (let w = 0; w < width; w++) {
      s = DIGITS[v % BASE] + s;
      v = Math.floor(v / BASE);
    }
    keys.push(s.replace(/0+$/, "") || "1");
  }
  return keys;
}

/** Compares two (key, id) pairs: the order of siblings. */
export function compareOrder(keyA: string, idA: string, keyB: string, idB: string): number {
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}
