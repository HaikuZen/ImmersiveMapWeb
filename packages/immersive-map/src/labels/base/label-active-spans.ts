// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The labels of the working set a frame works on, as spans of the set's
 * indices (the Swift `LabelActiveSpans`): in each tile's run, the head of
 * labels whose zoom the camera has reached, and behind it the labels still
 * fading out since the camera left their zoom. The rest of the run waits for
 * a deeper zoom and costs the frame nothing: no projection, no collision, no
 * fade.
 *
 * A tile's labels are ordered by the zoom they show from, which makes the
 * labels a zoom shows a head of the run, found by a binary search. A label
 * leaves the spans once it is fully faded out and wants to stay so: its
 * alpha and its runtime record are then 0, which is what the shaders hide a
 * label by.
 *
 * Spans and runs are start and end pairs, end exclusive, in one flat array.
 */
export class LabelActiveSpans {
  /** The frame's spans, `spanCount` pairs, one per tile run that has any, in the set's order. */
  readonly spans: number[] = [];
  private runs: number[] = [];
  /** Per run, the end of the labels the camera's zoom shows. */
  private headEnds: number[] = [];
  /** Per run, the end of the labels still lit behind the head. Never short of the head. */
  private litEnds: number[] = [];
  /** Whether the set changed since the lit ends were found. */
  private findsLitEnds = false;

  get spanCount(): number {
    return this.spans.length / 2;
  }

  /** The total of the spans' labels. */
  get count(): number {
    let total = 0;
    for (let s = 0; s < this.spans.length; s += 2) total += this.spans[s + 1]! - this.spans[s]!;
    return total;
  }

  /**
   * Binds the spans to a new set's runs. A run that survived carries its
   * fades with it, so the next resolve looks for its lit labels behind the
   * head in the alphas it is given.
   */
  rebind(runs: readonly number[]): void {
    this.runs = [...runs];
    const runCount = runs.length / 2;
    this.headEnds = new Array<number>(runCount);
    this.litEnds = new Array<number>(runCount);
    this.spans.length = 0;
    for (let r = 0; r < runCount; r++) {
      this.headEnds[r] = runs[r * 2 + 1]!;
      this.litEnds[r] = runs[r * 2 + 1]!;
      if (runs[r * 2 + 1]! > runs[r * 2]!) this.spans.push(runs[r * 2]!, runs[r * 2 + 1]!);
    }
    this.findsLitEnds = true;
  }

  reset(): void {
    this.runs = [];
    this.headEnds = [];
    this.litEnds = [];
    this.spans.length = 0;
    this.findsLitEnds = false;
  }

  /**
   * The frame's spans for a camera zoom: each run's head of the labels whose
   * minimum zoom is at or below `cameraZoom`, stretched over the labels
   * behind it still lit. `alphas` are the labels' fades, read after a change
   * of the set to find the lit labels it carried.
   */
  resolve(minCameraZoom: Float32Array, alphas: Float32Array, cameraZoom: number): void {
    this.spans.length = 0;
    const inputCount = minCameraZoom.length;
    const runCount = this.runs.length / 2;
    for (let r = 0; r < runCount; r++) {
      const lower = Math.min(this.runs[r * 2]!, inputCount);
      const upper = Math.min(this.runs[r * 2 + 1]!, inputCount);
      let low = lower;
      let high = upper;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (minCameraZoom[middle]! <= cameraZoom) low = middle + 1;
        else high = middle;
      }
      this.headEnds[r] = low;
      if (this.findsLitEnds) {
        let lit = Math.min(upper, alphas.length);
        while (lit > low && alphas[lit - 1]! <= 0) lit--;
        this.litEnds[r] = Math.max(lit, low);
      }
      const end = Math.max(low, Math.min(this.litEnds[r]!, upper));
      if (end > lower) this.spans.push(lower, end);
    }
    this.findsLitEnds = false;
  }

  /**
   * After the frame's fades: where each run's lit labels end, the last label
   * behind the head with an alpha or a target above zero. A run whose labels
   * behind the head are all dark shrinks to its head for the next frame.
   */
  updateLitEnds(alphas: Float32Array, targets: Uint8Array): void {
    const runCount = this.runs.length / 2;
    for (let r = 0; r < runCount; r++) {
      const head = this.headEnds[r]!;
      let end = Math.min(this.litEnds[r]!, this.runs[r * 2 + 1]!, alphas.length, targets.length);
      while (end > head && alphas[end - 1]! <= 0 && targets[end - 1] === 0) end--;
      this.litEnds[r] = Math.max(end, head);
    }
  }
}
