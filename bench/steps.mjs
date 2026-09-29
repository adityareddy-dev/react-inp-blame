// Each scripted step's slowest interaction and its blame: per app and pass, the slowest
// interaction (from the harness's own observer), what the library blamed for it in config B (and
// in F, labelled apart, for tt-virtual-fix), and the library's own accounting for each
// configuration it was in. Reads one results JSON.
//   node steps.mjs results/<file>.json [app,app] [--verdicts]
import { readFileSync } from 'node:fs';

const [file, appArg, ...rest] = process.argv.slice(2);
const showVerdicts = rest.includes('--verdicts') || appArg === '--verdicts';
const data = JSON.parse(readFileSync(file, 'utf8'));
const wanted = appArg && appArg !== '--verdicts' ? new Set(appArg.split(',')) : null;
const runs = data.runs.filter((r) => !r.warmup && (!wanted || wanted.has(r.app)));

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (x) => (x == null ? '-' : Math.round(x * 10) / 10);
const inStep = (t, s) => t >= s.pageStart && t <= s.pageEnd;

const groups = new Map();
for (const r of runs) {
  const k = `${r.app}|${r.throttle}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

for (const [k, rs] of groups) {
  const [app, throttle] = k.split('|');
  const configs = [...new Set(rs.map((r) => r.config))].sort();
  console.log(`\n## ${app} x${throttle}  (${configs.map((c) => `${c}: ${rs.filter((r) => r.config === c).length} runs`).join(', ')})`);
  const stepNames = rs[0].steps.map((s) => s.name);
  const rows = [];
  for (const name of stepNames) {
    const row = { name };
    for (const c of configs) {
      const per = rs
        .filter((r) => r.config === c)
        .map((r) => {
          const s = r.steps.find((x) => x.name === name);
          if (!s) return null;
          const ds = r.interactions.filter((i) => inStep(i.startTime, s)).map((i) => i.duration);
          return ds.length ? Math.max(...ds) : 0;
        });
      row[c] = median(per);
    }
    // What config B's library said about the slowest report in the step, run by run, and F's apart.
    const blames = new Map(configs.filter((c) => c === 'B' || c === 'F').map((c) => [c, new Map()]));
    const verdicts = new Map();
    for (const r of rs.filter((x) => blames.has(x.config))) {
      const tally = blames.get(r.config);
      const s = r.steps.find((x) => x.name === name);
      const reps = (r.lib?.reports ?? []).filter((p) => inStep(p.start, s));
      if (!reps.length) {
        tally.set('(no report)', (tally.get('(no report)') ?? 0) + 1);
        continue;
      }
      const top = reps.reduce((a, b) => (b.duration > a.duration ? b : a));
      const b = top.blame;
      const key = b ? `${b.kind} ${b.name ?? ''} ${b.detail ?? ''} [${b.confidence ?? ''}]`.replace(/\s+/g, ' ') : 'null';
      tally.set(key, (tally.get(key) ?? 0) + 1);
      const v = `${top.duration} ms: ${top.where} | ${top.cause}`;
      if (!verdicts.has(`${r.config}: ${key}`)) verdicts.set(`${r.config}: ${key}`, v);
    }
    row.blames = blames;
    row.verdicts = verdicts;
    rows.push(row);
  }
  for (const row of rows.sort((a, b) => (b.A ?? b.B ?? 0) - (a.A ?? a.B ?? 0))) {
    const blamed = [...row.blames].map(([c, tally]) => `${c}: ${[...tally].sort((a, b) => b[1] - a[1]).map(([b, n]) => `${n}x ${b}`).join('; ')}`);
    console.log(`- ${row.name}: ${configs.map((c) => `${c} ${r1(row[c])}`).join(', ')} | ${blamed.join('; ')}`);
    if (showVerdicts) for (const [b, v] of row.verdicts) console.log(`    [${b}] ${v}`);
  }
  // One line per configuration. B, C and F are different builds, and a median across them is none of theirs.
  for (const c of configs) {
    const libRuns = rs.filter((r) => r.config === c && r.lib?.stats);
    if (!libRuns.length) continue;
    const st = (f) => r1(median(libRuns.map((r) => f(r.lib.stats))));
    console.log(
      `  ${c} stats (median over ${libRuns.length} runs): walks ${st((s) => s.walks)}, walkTotalMs ${st((s) => s.walkTotalMs)}, reportTotalMs ${st((s) => s.reportTotalMs)}, installMs ${st((s) => s.installMs)}, overheadTotalMs ${r1(median(libRuns.map((r) => r.lib.overheadTotalMs)))}, reports ${r1(median(libRuns.map((r) => r.lib.reportCount)))}, react ${[...new Set(libRuns.map((r) => r.lib.stats.react))].join('/')}`,
    );
  }
  for (const c of configs) {
    const rr = rs.filter((r) => r.config === c);
    console.log(`  ${c}: INP median ${r1(median(rr.map((r) => r.inp)))}, total ${r1(median(rr.map((r) => r.totalInteractionMs)))}, pageErrors ${rr.reduce((n, r) => n + (r.pageErrors?.length ?? 0), 0)}`);
  }
}
if (data.failures?.length) console.log(`\nfailures: ${data.failures.length}`, JSON.stringify(data.failures.slice(0, 3)));
