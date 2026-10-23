/** Minimum lower bounds with stable input-order selection among ready matches. */
export class ProjectionReady {
  private readonly width: number;
  private readonly minimum: number[];

  constructor(count: number) {
    let width = 1;
    while (width < count) width *= 2;
    this.width = width;
    this.minimum = Array<number>(width * 2).fill(Infinity);
  }

  get earliest() {
    return this.minimum[1]!;
  }

  set(index: number, readyAt: number) {
    let node = this.width + index;
    this.minimum[node] = readyAt;
    while (node > 1) {
      node = Math.floor(node / 2);
      this.minimum[node] = Math.min(this.minimum[node * 2]!, this.minimum[node * 2 + 1]!);
    }
  }

  firstAt(time: number): number | null {
    if (!Number.isFinite(this.earliest) || this.earliest > time) return null;
    let node = 1;
    while (node < this.width) node = this.minimum[node * 2]! <= time ? node * 2 : node * 2 + 1;
    return node - this.width;
  }
}
