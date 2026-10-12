import { it } from "vitest";
import { exactBlur1D, pyramidBlur1D } from "/home/user/fig-tree/packages/renderer/test/blur-reference";
it("calibrate", () => {
  for (const sigma of [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 30, 40, 60, 100]) {
    const n = Math.ceil(sigma * 12) + 41;
    const inp = new Float64Array(n);
    // A box from n/3 to 2n/3 (two edges) plus an offset odd alignment.
    for (let i = Math.floor(n / 3) + 1; i < Math.floor((2 * n) / 3); i++) inp[i] = 1;
    const a = pyramidBlur1D(inp, sigma), b = exactBlur1D(inp, sigma);
    let max = 0, sum = 0;
    for (let i = 0; i < n; i++) { const d = Math.abs(a[i]! - b[i]!); max = Math.max(max, d); sum += d; }
    console.log(`sigma ${sigma}: max ${(max * 255).toFixed(2)}/255 mean ${((sum / n) * 255).toFixed(3)}/255`);
  }
});
