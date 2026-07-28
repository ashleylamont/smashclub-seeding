/**
 * A faithful port of CPython difflib.SequenceMatcher's ratio() for strings
 * (no isjunk, autojunk semantics preserved). The legacy pipeline's fuzzy
 * scores come from difflib, and those scores rank merge candidates in the
 * review queue, so score parity matters.
 */

interface MatchingBlock {
  a: number;
  b: number;
  size: number;
}

export class SequenceMatcher {
  private readonly a: string;
  private readonly b: string;
  private readonly b2j = new Map<string, number[]>();
  /** Elements dropped by autojunk (b length >= 200 and element too popular). */
  private readonly bJunk = new Set<string>();

  constructor(a: string, b: string, autojunk = true) {
    this.a = a;
    this.b = b;
    for (let i = 0; i < b.length; i++) {
      const ch = b[i]!;
      const indices = this.b2j.get(ch);
      if (indices) {
        indices.push(i);
      } else {
        this.b2j.set(ch, [i]);
      }
    }
    if (autojunk && b.length >= 200) {
      const ntest = Math.floor(b.length / 100) + 1;
      for (const [ch, indices] of this.b2j) {
        if (indices.length > ntest) {
          this.bJunk.add(ch);
          this.b2j.delete(ch);
        }
      }
    }
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): MatchingBlock {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;

    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newJ2len = new Map<number, number>();
      const indices = b2j.get(a[i]!) ?? [];
      for (const j of indices) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newJ2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newJ2len;
    }

    // Extend the match over adjacent equal non-junk elements, then over
    // adjacent equal junk elements (matters only when autojunk kicked in).
    while (besti > alo && bestj > blo && !this.bJunk.has(b[bestj - 1]!) && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      !this.bJunk.has(b[bestj + bestsize]!) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    while (besti > alo && bestj > blo && this.bJunk.has(b[bestj - 1]!) && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      this.bJunk.has(b[bestj + bestsize]!) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }

    return { a: besti, b: bestj, size: bestsize };
  }

  getMatchingBlocks(): MatchingBlock[] {
    const la = this.a.length;
    const lb = this.b.length;
    const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
    const blocks: MatchingBlock[] = [];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const match = this.findLongestMatch(alo, ahi, blo, bhi);
      if (match.size > 0) {
        blocks.push(match);
        if (alo < match.a && blo < match.b) {
          queue.push([alo, match.a, blo, match.b]);
        }
        if (match.a + match.size < ahi && match.b + match.size < bhi) {
          queue.push([match.a + match.size, ahi, match.b + match.size, bhi]);
        }
      }
    }
    blocks.sort((x, y) => x.a - y.a || x.b - y.b);

    // Merge adjacent blocks.
    const merged: MatchingBlock[] = [];
    for (const block of blocks) {
      const last = merged[merged.length - 1];
      if (last && last.a + last.size === block.a && last.b + last.size === block.b) {
        last.size += block.size;
      } else {
        merged.push({ ...block });
      }
    }
    return merged;
  }

  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((sum, block) => sum + block.size, 0);
    const total = this.a.length + this.b.length;
    return total ? (2 * matches) / total : 1;
  }
}

/** difflib.SequenceMatcher(None, a, b).ratio() */
export function similarityRatio(a: string, b: string): number {
  return new SequenceMatcher(a, b).ratio();
}
