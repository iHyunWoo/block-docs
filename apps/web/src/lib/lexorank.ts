// ========================================
// Minimal LexoRank — midpoint string generator.
//
// Not a full Jira-style LexoRank (which uses bucket prefixes). We only need
// "give me a string strictly between a and b" for client-side optimistic
// block inserts. Server is still authoritative for position on accepted ops.
// ========================================

const MIN_CHAR = "a".charCodeAt(0); // inclusive lower bound (exclusive use)
const MAX_CHAR = "z".charCodeAt(0); // inclusive upper bound
const MID_CHAR = Math.floor((MIN_CHAR + MAX_CHAR) / 2);

const MIN_STR = "a";
const MAX_STR = "z";

function code(ch: string | undefined, fallback: number): number {
  return ch === undefined ? fallback : ch.charCodeAt(0);
}

/**
 * Produce a string strictly between `prev` and `next`.
 * - prev == null  → treated as "a" (exclusive lower sentinel)
 * - next == null  → treated as "z" (inclusive upper sentinel, we extend if needed)
 */
export function midpoint(prev: string | null, next: string | null): string {
  const a = prev ?? "";
  const b = next ?? "";

  // Compare character by character.
  const result: number[] = [];
  let i = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ac = code(a[i], MIN_CHAR);
    const bc = code(b[i], MAX_CHAR + 1);
    if (ac === bc) {
      result.push(ac);
      i++;
      continue;
    }
    // ac < bc (we assume prev < next); find midpoint char.
    if (bc - ac > 1) {
      const mid = Math.floor((ac + bc) / 2);
      result.push(mid);
      return String.fromCharCode(...result);
    }
    // Gap is 1, e.g. 'm' and 'n'. Keep ac and extend.
    result.push(ac);
    i++;
    // Continue expanding prev's tail to find room.
    while (true) {
      const nextA = code(a[i], MIN_CHAR);
      if (nextA < MAX_CHAR) {
        // Pick something between nextA and MAX_CHAR.
        const mid = Math.floor((nextA + MAX_CHAR + 1) / 2);
        result.push(mid);
        return String.fromCharCode(...result);
      }
      // nextA is already at MAX_CHAR ('z'); keep appending 'z' and try the next position.
      result.push(nextA);
      i++;
      if (i > 40) {
        // Give up and tack on a middle char (callers should rebalance soon).
        result.push(MID_CHAR);
        return String.fromCharCode(...result);
      }
    }
  }
}

export const LEXO_MIN = MIN_STR;
export const LEXO_MAX = MAX_STR;
