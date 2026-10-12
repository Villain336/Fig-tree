import { blurSteps } from "../src/frame";

/**
 * A CPU mirror of the GPU blur (both backends): halve with a 2x2 box,
 * Gaussian at the lowest level, double back up bilinearly, on a 1D signal
 * (the blur is separable and each step acts on rows and columns alike).
 * Edges are transparent (0) outside the signal.
 */
export function pyramidBlur1D(input: Float64Array, sigma: number): Float64Array {
  const { levels, sigmaLow } = blurSteps(sigma);
  const chain: Float64Array[] = [input];
  let cur = input;
  for (let l = 1; l <= levels; l++) {
    const n = Math.ceil(cur.length / 2);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = ((cur[2 * i] ?? 0) + (cur[2 * i + 1] ?? 0)) / 2;
    chain.push(out);
    cur = out;
  }
  if (sigmaLow > 0) cur = gaussian1D(cur, Math.max(sigmaLow, 1e-3), Math.max(1, Math.ceil(3 * sigmaLow)));
  for (let l = levels; l >= 1; l--) {
    const n = chain[l - 1]!.length;
    const out = new Float64Array(n);
    for (let o = 0; o < n; o++) {
      const t = (o + 0.5) * 0.5 - 0.5;
      const i = Math.floor(t);
      const f = t - i;
      out[o] = (cur[i] ?? 0) * (1 - f) + (cur[i + 1] ?? 0) * f;
    }
    cur = out;
  }
  return cur;
}

/** Truncated, normalized Gaussian (the GPU's kernel at the lowest level). */
export function gaussian1D(input: Float64Array, sigma: number, radius: number): Float64Array {
  const w: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp((-i * i) / (2 * sigma * sigma));
    w.push(v);
    sum += v;
  }
  const out = new Float64Array(input.length);
  for (let x = 0; x < input.length; x++) {
    let acc = 0;
    for (let i = -radius; i <= radius; i++) acc += w[i + radius]! * (input[x + i] ?? 0);
    out[x] = acc / sum;
  }
  return out;
}

/** Exact Gaussian blur of a signal (continuous kernel integrated over each texel, untruncated). */
export function exactBlur1D(input: Float64Array, sigma: number): Float64Array {
  const out = new Float64Array(input.length);
  const erf = (x: number): number => {
    // Abramowitz-Stegun 7.1.26
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  };
  const cdf = (x: number): number => 0.5 * (1 + erf(x / (sigma * Math.SQRT2)));
  for (let x = 0; x < input.length; x++) {
    let acc = 0;
    for (let j = 0; j < input.length; j++) {
      if (input[j] === 0) continue;
      acc += input[j]! * (cdf(j + 0.5 - x) - cdf(j - 0.5 - x));
    }
    out[x] = acc;
  }
  return out;
}
