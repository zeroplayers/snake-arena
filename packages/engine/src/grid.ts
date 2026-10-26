/**
 * Uniform spatial hash over a square, rebuilt each tick. Items are indices into caller-owned
 * coordinate arrays. Each cell is a linked list, and a generation stamp marks the cells
 * touched by the current build, so a build costs O(items), not O(cells). Points outside the
 * square are clamped into the border cells, so queries stay correct.
 *
 *   for (let i = grid.first(cell); i >= 0; i = grid.next[i]) …
 */
export class Grid {
  readonly cellSize: number;
  readonly cols: number;
  private readonly origin: number;
  private readonly head: Int32Array;
  private readonly stamp: Uint32Array;
  private gen = 0;
  next: Int32Array;

  /** Covers [-halfExtent, halfExtent]² with cells of `cellSize`. */
  constructor(halfExtent: number, cellSize: number) {
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil((2 * halfExtent) / cellSize));
    this.origin = halfExtent;
    this.head = new Int32Array(this.cols * this.cols);
    this.stamp = new Uint32Array(this.cols * this.cols);
    this.next = new Int32Array(64);
  }

  col(v: number): number {
    const c = Math.floor((v + this.origin) / this.cellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  build(n: number, xs: ArrayLike<number>, ys: ArrayLike<number>): void {
    if (this.next.length < n) this.next = new Int32Array(Math.max(n, this.next.length * 2));
    this.gen = (this.gen + 1) >>> 0 || 1;
    const gen = this.gen;
    const { head, stamp, next } = this;
    for (let i = 0; i < n; i++) {
      const k = this.col(ys[i] as number) * this.cols + this.col(xs[i] as number);
      if (stamp[k] !== gen) {
        stamp[k] = gen;
        head[k] = -1;
      }
      next[i] = head[k] as number;
      head[k] = i;
    }
  }

  /** First item in cell `k`, or -1; continue with `next[i]`. */
  first(k: number): number {
    return this.stamp[k] === this.gen ? (this.head[k] as number) : -1;
  }
}
