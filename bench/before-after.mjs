// The sort before and after: the virtualized table's sort before (B) and after (F) the plain comparator,
// both with the library in.
// Per pass and step, the median of each run's slowest interaction in that step, and F − B paired by run index
// with a percentile bootstrap of the median difference (10,000 resamples), as report.mjs does against A.
//   node before-after.mjs results/<file>.json
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const runs = data.runs.filter((r) => !r.warmup && r.app === 'tt-virtual-fix');

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
};
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}
function boot(diffs) {
  const rand = rng(12345);
  const meds = [];
  for (let k = 0; k < 10000; k++) meds.push(median(diffs.map(() => diffs[(rand() * diffs.length) | 0])));
  return { point: median(diffs), lo: quantile(meds, 0.025), hi: quantile(meds, 0.975) };
}
const inStep = (t, s) => t >= s.pageStart && t <= s.pageEnd;
const slowest = (r, name) => {
  const s = r.steps.find((x) => x.name === name);
  const ds = r.interactions.filter((i) => inStep(i.startTime, s)).map((i) => i.duration);
  return ds.length ? Math.max(...ds) : 0;
};
const f1 = (x) => (Math.round(x * 10) / 10).toString();

for (const throttle of [...new Set(runs.map((r) => r.throttle))]) {
  const B = runs.filter((r) => r.config === 'B' && r.throttle === throttle).sort((a, b) => a.runIndex - b.runIndex);
  const F = runs.filter((r) => r.config === 'F' && r.throttle === throttle).sort((a, b) => a.runIndex - b.runIndex);
  if (!B.length || !F.length) {
    console.log(`\n## x${throttle}, no ${B.length ? 'F' : 'B'} runs, so nothing to compare`);
    continue;
  }
  // Joined on runIndex, as report.mjs pairs. A failed run is missing from runs, so pairing by
  // position would shift every later pair by one.
  const byIndex = new Map(F.map((r) => [r.runIndex, r]));
  const pairs = B.filter((r) => byIndex.has(r.runIndex)).map((r) => [r, byIndex.get(r.runIndex)]);
  const alone = [['B', B.length - pairs.length], ['F', F.length - pairs.length]].filter(([, k]) => k);
  console.log(`\n## x${throttle}, ${pairs.length} paired runs${alone.length ? `, left out for want of a partner: ${alone.map(([c, k]) => `${c} ${k}`).join(', ')}` : ''}`);
  const metrics = [
    ['INP', (r) => r.inp],
    ...B[0].steps.map((s) => [s.name, (r) => slowest(r, s.name)]),
  ];
  for (const [name, get] of metrics) {
    const b = pairs.map(([r]) => get(r));
    const f = pairs.map(([, r]) => get(r));
    const d = boot(f.map((x, i) => x - b[i]));
    console.log(`- ${name}: B ${f1(median(b))}, F ${f1(median(f))}, F − B ${d.point > 0 ? '+' : ''}${f1(d.point)} [${f1(d.lo)}, ${f1(d.hi)}]`);
  }
  // The verdict each build's library gave the first sort, run 1 and the most common blame.
  for (const [label, rs] of [['B', B], ['F', F]]) {
    const tally = new Map();
    let example = null;
    for (const r of rs) {
      const s = r.steps.find((x) => x.name === 'sort-lastName-asc');
      const reps = (r.lib?.reports ?? []).filter((p) => inStep(p.start, s));
      if (!reps.length) continue;
      const top = reps.reduce((a, b) => (b.duration > a.duration ? b : a));
      const key = `${top.blame?.kind} ${top.blame?.name} ${top.blame?.detail} ${top.blame?.ms != null ? Math.round(top.blame.ms) : '-'}`;
      tally.set(key.replace(/ \d+$/, ''), (tally.get(key.replace(/ \d+$/, '')) ?? 0) + 1);
      example ??= `${top.duration} ms: ${top.cause}`;
    }
    console.log(`  ${label} sort-lastName-asc blame: ${[...tally].map(([k, v]) => `${v}x ${k}`).join('; ')}`);
    console.log(`    e.g. ${example}`);
  }
}
