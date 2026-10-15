// stats.mjs: the interval arithmetic for the accuracy report. Accuracy proportions use Wilson 95%
// intervals, and a difference between two independent proportions uses Newcombe's hybrid interval
// built from two Wilson intervals. Both are descriptive: interactions inside one app are not
// independent evidence of general accuracy, so the report also gives per-app intervals.

export const Z95 = 1.959963984540054;

/** Wilson score interval for x successes out of n. Null when n is 0. */
export function wilson(x, n, z = Z95) {
  if (!n) return null;
  if (x < 0 || x > n) throw new Error(`wilson: ${x} is not within 0..${n}`);
  const p = x / n;
  const z2n = (z * z) / n;
  const denom = 1 + z2n;
  const centre = (p + z2n / 2) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { p, lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/** Newcombe's hybrid interval for p1 - p2 from two independent proportions. */
export function newcombe(x1, n1, x2, n2, z = Z95) {
  const a = wilson(x1, n1, z);
  const b = wilson(x2, n2, z);
  if (!a || !b) return null;
  const d = a.p - b.p;
  const lower = d - Math.sqrt((a.p - a.lower) ** 2 + (b.upper - b.p) ** 2);
  const upper = d + Math.sqrt((a.upper - a.p) ** 2 + (b.p - b.lower) ** 2);
  return { difference: d, lower, upper };
}

/** Counts per grade, with the whole-verdict tally the report needs. Unknown grades throw. */
export const GRADES = ['right', 'wrong', 'misleading', 'cannot_tell', 'blank'];

export function tally(grades) {
  const counts = Object.fromEntries(GRADES.map((g) => [g, 0]));
  for (const g of grades) {
    if (!GRADES.includes(g)) throw new Error(`unknown grade: ${g}`);
    counts[g]++;
  }
  return { n: grades.length, counts, right: wilson(counts.right, grades.length) };
}
