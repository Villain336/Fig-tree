/// <reference types="@webgpu/types" />

export const STAGES = ["bin", "tiles", "coverage", "composite"] as const;
export type Stage = (typeof STAGES)[number];

/** GPU milliseconds per pipeline stage (summed over passes) for one frame. */
export type StageTimings = Record<Stage, number> & { readonly total: number };

const MAX_QUERIES = 64;

/**
 * Optional per-stage GPU timing via timestamp queries. Measures at most one
 * frame in flight; frames encoded while a readback is pending go untimed.
 */
export class GpuTimer {
  private readonly querySet: GPUQuerySet;
  private readonly resolve: GPUBuffer;
  private readonly readback: GPUBuffer;
  private busy = false;
  private timing = false;
  private used: { stage: Stage; index: number }[] = [];
  last: StageTimings | null = null;

  constructor(device: GPUDevice) {
    this.querySet = device.createQuerySet({ type: "timestamp", count: MAX_QUERIES });
    this.resolve = device.createBuffer({ size: MAX_QUERIES * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.readback = device.createBuffer({ size: MAX_QUERIES * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }

  beginFrame(): void {
    this.timing = !this.busy;
    this.used = [];
  }

  /** Descriptor for a compute pass of `stage`, with timestamp writes when this frame is timed. */
  pass(label: string, stage: Stage): GPUComputePassDescriptor {
    const index = this.used.length * 2;
    if (!this.timing || index + 2 > MAX_QUERIES) return { label };
    this.used.push({ stage, index });
    return { label, timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 } };
  }

  endFrame(enc: GPUCommandEncoder): void {
    if (!this.timing || this.used.length === 0) return;
    const count = this.used.length * 2;
    enc.resolveQuerySet(this.querySet, 0, count, this.resolve, 0);
    enc.copyBufferToBuffer(this.resolve, 0, this.readback, 0, count * 8);
  }

  /** Call after submitting the frame passed to `endFrame`. */
  collect(): void {
    if (!this.timing || this.used.length === 0) return;
    const used = this.used;
    this.busy = true;
    this.readback.mapAsync(GPUMapMode.READ, 0, used.length * 16).then(
      () => {
        const ns = new BigInt64Array(this.readback.getMappedRange(0, used.length * 16));
        const t = { bin: 0, tiles: 0, coverage: 0, composite: 0 };
        for (const u of used) t[u.stage] += Number(ns[u.index + 1]! - ns[u.index]!) / 1e6;
        this.readback.unmap();
        this.last = { ...t, total: t.bin + t.tiles + t.coverage + t.composite };
        this.busy = false;
      },
      () => {
        this.busy = false;
      },
    );
  }
}
