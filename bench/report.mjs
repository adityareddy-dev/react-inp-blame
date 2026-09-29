// report.mjs: turns a bench.mjs results JSON into markdown.
//
//   node report.mjs results/<file>.json > report.md
//   node report.mjs                       # newest file in results/
//
// Deltas are PAIRED: runs are interleaved A, B, C, A, B, C, ..., so run i of B is compared with
// run i of A and the difference is bootstrapped. Pairing cancels drift that hit all three configs
// at the same moment. A 95% confidence interval that contains zero is reported as inside the noise.

import fs from 'node:fs';
import path from 'node:path';

const BOOTSTRAP = 10000;
const SEED = 0x5eed1234;

// ---------------------------------------------------------------- stats

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Deterministic PRNG, so the same JSON always yields the same intervals. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** Percentile bootstrap of the median of the paired differences. */
function bootstrapMedianDelta(pairs) {
  if (pairs.length < 2) return null;
  const diffs = pairs.map(([a, b]) => b - a);
  const rand = rng(SEED);
  const meds = new Array(BOOTSTRAP);
  for (let k = 0; k < BOOTSTRAP; k++) {
    const sample = new Array(diffs.length);
    for (let i = 0; i < diffs.length; i++) sample[i] = diffs[(rand() * diffs.length) | 0];
    meds[k] = median(sample);
  }
  return {
    n: diffs.length,
    point: median(diffs),
    lo: quantile(meds, 0.025),
    hi: quantile(meds, 0.975),
  };
}

const fmt = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : x.toFixed(d));

// Below this many paired runs a percentile bootstrap is not worth believing. With three runs the
// resampled medians can collapse onto a single value and hand back a zero-width interval that
// looks decisive and is not. Never claim significance there.
const MIN_N = 8;

function deltaCell(d, unit = 'ms') {
  if (!d) return 'n/a';
  const sign = d.point > 0 ? '+' : '';
  const body = `${sign}${fmt(d.point)} ${unit} [${fmt(d.lo)}, ${fmt(d.hi)}]`;
  if (d.n < MIN_N) return `${body}, n=${d.n}, too few runs to call`;
  const inside = d.lo <= 0 && d.hi >= 0;
  return inside ? `${body}, **inside the noise**` : `**${body}**`;
}

// ---------------------------------------------------------------- selection

const METRICS = [
  { key: 'inp', label: 'INP (ms)', get: (r) => r.inp },
  { key: 'total', label: 'Total interaction time (ms)', get: (r) => r.totalInteractionMs },
  { key: 'captured', label: 'Interactions captured (>16 ms)', get: (r) => r.interactions.length },
  {
    key: 'firstInput',
    label: 'First input duration (ms)',
    get: (r) => (r.firstInput ? r.firstInput.duration : null),
  },
  { key: 'loafBlocking', label: 'LoAF blocking (ms)', get: (r) => r.loafBlockingMs },
  { key: 'loafCount', label: 'LoAF count', get: (r) => r.loafCount },
  { key: 'ready', label: 'Load to ready (ms)', get: (r) => r.readyMs },
  {
    key: 'heap',
    label: 'JS heap used (MB)',
    get: (r) => (r.heap ? r.heap.usedJSHeapSize / 1e6 : null),
  },
];

function pick(runs, app, config, throttle) {
  return runs
    .filter((r) => r.app === app && r.config === config && r.throttle === throttle && !r.warmup)
    .sort((a, b) => a.runIndex - b.runIndex);
}

function paired(runs, app, throttle, metric, base, other) {
  const a = new Map(pick(runs, app, base, throttle).map((r) => [r.runIndex, metric.get(r)]));
  const b = new Map(pick(runs, app, other, throttle).map((r) => [r.runIndex, metric.get(r)]));
  const out = [];
  for (const [i, av] of a) {
    const bv = b.get(i);
    if (av !== null && av !== undefined && bv !== null && bv !== undefined) out.push([av, bv]);
  }
  return out;
}

// ---------------------------------------------------------------- blame summary

function blameSummary(runs, app, config, throttle) {
  const rows = pick(runs, app, config, throttle);
  const groups = new Map();
  for (const r of rows) {
    if (!r.lib || !r.lib.reports) continue;
    const top = [...r.lib.reports].sort((x, y) => y.duration - x.duration).slice(0, 3);
    for (const rep of top) {
      const key = JSON.stringify([
        rep.type,
        rep.target?.label ?? null,
        rep.blame?.kind ?? null,
        rep.blame?.name ?? null,
      ]);
      if (!groups.has(key)) {
        groups.set(key, {
          type: rep.type,
          label: rep.target?.label ?? null,
          selector: rep.target?.selector ?? null,
          targetComponent: rep.target?.component ?? null,
          handler: rep.target?.handler ?? null,
          owners: rep.target?.owners ?? null,
          kind: rep.blame?.kind ?? null,
          name: rep.blame?.name ?? null,
          detail: rep.blame?.detail ?? null,
          confidences: new Set(),
          durations: [],
          blameMs: [],
          verdicts: new Set(),
          n: 0,
        });
      }
      const g = groups.get(key);
      g.n++;
      g.durations.push(rep.duration);
      if (rep.blame?.ms != null) g.blameMs.push(rep.blame.ms);
      if (rep.blame?.confidence) g.confidences.add(rep.blame.confidence);
      if (rep.verdict) g.verdicts.add(rep.verdict);
    }
  }
  return [...groups.values()].sort((a, b) => median(b.durations) - median(a.durations));
}

function libCost(runs, app, config, throttle) {
  const rows = pick(runs, app, config, throttle).filter((r) => r.lib && r.lib.stats);
  if (!rows.length) return null;
  return {
    n: rows.length,
    installMs: median(rows.map((r) => r.lib.stats.installMs)),
    walkTotalMs: median(rows.map((r) => r.lib.stats.walkTotalMs)),
    reportTotalMs: median(rows.map((r) => r.lib.stats.reportTotalMs)),
    walks: median(rows.map((r) => r.lib.stats.walks)),
    overheadTotalMs: median(rows.map((r) => r.lib.overheadTotalMs)),
    reportCount: median(rows.map((r) => r.lib.reportCount)),
    modes: [...new Set(rows.map((r) => r.lib.stats.mode))].join(', '),
  };
}

// ---------------------------------------------------------------- render

function main() {
  const file =
    process.argv[2] ??
    path
      .join('results', fs.readdirSync('results').filter((f) => f.endsWith('.json')).sort().pop());
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { runs, versions, failures } = data;
  const out = [];
  const p = (s = '') => out.push(s);

  p(`# react-inp-blame benchmark`);
  p();
  // The file name only: the full path has the user folder in it, and this report gets pasted around.
  p(`Source: \`${path.basename(file)}\``);
  p(`Started ${data.started}, finished ${data.finished}. \`--runs ${data.args.runs}\`, throttle passes ${data.args.throttles.join(', ')}x.`);
  p();
  p(`## Configurations`);
  p();
  p(`| | |`);
  p(`| --- | --- |`);
  p(`| **A** | baseline, library absent from the bundle |`);
  p(`| **B** | library installed, \`inpBlame({ enabled: true, runtime: { debugGlobal: true } })\` |`);
  p(`| **C** | as B plus \`overlay: true\` |`);
  if (runs.some((r) => r.config === 'F')) p(`| **F** | as B with the app's own fix on top, \`tt-virtual-fix\` only |`);
  p();
  p(`\`debugGlobal: true\` is there, in every build but A, only so the harness can read \`stats()\` and \`reports()\` out of the page. It assigns one global at install and is not a measurement option.`);
  p();

  p(`## Versions`);
  p();
  p(`| | |`);
  p(`| --- | --- |`);
  p(`| Node | ${versions.node} |`);
  p(`| Chromium | ${versions.chromium} |`);
  p(`| Playwright | ${versions.playwright} |`);
  p(`| OS | ${versions.os} |`);
  if (versions.tarball) p(`| Library tarball | \`${path.basename(versions.tarball.path)}\`, sha256 \`${versions.tarball.sha256}\`, ${versions.tarball.bytes} bytes |`);
  if (versions.npm) p(`| Library from npm | \`${String(versions.npm).replace(/\s+/g, ' ').slice(0, 200)}\` |`);
  for (const [id, v] of Object.entries(versions.apps)) {
    // Only the packages this app actually has: a Vite app has no `next`, a Next app has no `vite`.
    const pkgs = ['react', 'react-dom', 'vite', 'next', '@tanstack/react-table', 'react-inp-blame']
      .filter((name) => v[name])
      .map((name) => `${name} ${v[name]}`);
    p(`| ${id} | commit \`${v.commit}\`, ${pkgs.join(', ')} |`);
  }
  p();
  p(`**Machine load caveat.** These numbers are only as quiet as the machine that produced them. Every configuration of an app is interleaved run by run, so drift hits A, B and C equally and the paired deltas survive a noisy machine, but the absolute medians do not. Do not quote an absolute figure from a run made on a busy machine.`);
  p();

  if (failures?.length) {
    p(`## Failures`);
    p();
    for (const f of failures) p(`- \`${f.app}\` ${f.config} x${f.throttle} run ${f.runIndex}: ${f.error}`);
    p();
  }

  const appIds = [...new Set(runs.map((r) => r.app))];
  const throttles = [...new Set(runs.map((r) => r.throttle))].sort((a, b) => a - b);

  for (const app of appIds) {
    p(`---`);
    p();
    p(`## ${app}`);
    p();
    const bundles = versions.apps[app]?.bundleBytes;
    if (bundles) {
      p(`Bundle, JS bytes on disk: ${Object.entries(bundles).map(([c, b]) => (c === 'A' || !bundles.A ? `${c} ${b.totalJsBytes}` : `${c} ${b.totalJsBytes} (+${b.totalJsBytes - bundles.A.totalJsBytes})`)).join(', ')}.`);
      p();
    }

    for (const throttle of throttles) {
      p(`### ${throttle === 1 ? 'Unthrottled' : `${throttle}x CPU throttling`}`);
      p();
      // The configurations this app actually ran: cal-diy has no C, and tt-virtual-fix has B and F only.
      const configs = ['A', 'B', 'C', 'F'].filter((c) => pick(runs, app, c, throttle).length);
      const n = configs.length ? pick(runs, app, configs[0], throttle).length : 0;
      p(`${n} runs per configuration (${configs.join(', ')}).`);
      p();
      if (configs.includes('A')) {
        p(`| Metric | A median | A p90 | B median | B p90 | C median | C p90 | B − A (95% CI) | C − A (95% CI) |`);
        p(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |`);
        for (const m of METRICS) {
          const vals = {};
          for (const c of ['A', 'B', 'C']) {
            vals[c] = pick(runs, app, c, throttle).map(m.get).filter((x) => x !== null && x !== undefined);
          }
          if (!vals.A.length) continue;
          const dB = bootstrapMedianDelta(paired(runs, app, throttle, m, 'A', 'B'));
          const dC = bootstrapMedianDelta(paired(runs, app, throttle, m, 'A', 'C'));
          const unit = m.key === 'heap' ? 'MB' : m.key.startsWith('loafCount') || m.key === 'captured' ? '' : 'ms';
          p(
            `| ${m.label} | ${fmt(median(vals.A))} | ${fmt(quantile(vals.A, 0.9))} | ${fmt(median(vals.B))} | ${fmt(quantile(vals.B, 0.9))} | ${fmt(median(vals.C))} | ${fmt(quantile(vals.C, 0.9))} | ${deltaCell(dB, unit)} | ${deltaCell(dC, unit)} |`,
          );
        }
        p();
        p(`Deltas are paired by run index and bootstrapped (${BOOTSTRAP} resamples of the per-run difference, percentile interval). "Interactions captured" counts only interactions whose longest Event Timing entry reached the 16 ms \`durationThreshold\`, so it moves when the library pushes a short interaction over that line; read it alongside total interaction time rather than instead of it. JS heap is a single \`performance.memory\` sample taken at the end of a run with no forced collection, so it reflects when the garbage collector happened to run and should not be read as a memory verdict.`);
        p();
      } else {
        p(`No configuration A, so no baseline to pair against and no A/B/C table. For \`tt-virtual-fix\`, \`node before-after.mjs results/${path.basename(file)}\` compares F with B.`);
        p();
      }

      // What the library says it cost itself.
      p(`#### What the library reports about its own cost`);
      p();
      // Every configuration with the library in: B and C, or B and F for tt-virtual-fix.
      const withLib = configs.some((c) => c !== 'A') ? configs.filter((c) => c !== 'A') : ['B'];
      p(`| | ${withLib.join(' | ')} |`);
      p(`| --- |${withLib.map(() => ' ---: |').join('')}`);
      const costs = withLib.map((c) => libCost(runs, app, c, throttle));
      if (!costs.some(Boolean)) {
        p(`| (no data) |${withLib.map(() => ' |').join('')}`);
      } else {
        const row = (label, f, d = 2) => p(`| ${label} | ${costs.map((c) => (c ? fmt(f(c), d) : 'n/a')).join(' | ')} |`);
        p(`| hook mode | ${costs.map((c) => c?.modes ?? 'n/a').join(' | ')} |`);
        row('`stats().installMs`', (c) => c.installMs);
        row('`stats().walkTotalMs`', (c) => c.walkTotalMs);
        row('`stats().reportTotalMs`', (c) => c.reportTotalMs);
        row('`stats().walks`', (c) => c.walks, 0);
        row('sum of report `overheadMs`', (c) => c.overheadTotalMs);
        row('reports published', (c) => c.reportCount, 0);
      }
      p();
      p(`All medians over the runs in this cell. \`installMs\`, \`walkTotalMs\` and \`reportTotalMs\` are the library's own accounting${configs.includes('A') ? '; the A/B/C table above is the independent measurement' : ''}.`);
      p();

      // Cross-check: does the library's own inp() agree with the independent computation?
      const agree = [];
      for (const c of withLib) {
        for (const r of pick(runs, app, c, throttle)) {
          if (!r.lib || !r.lib.inp) continue;
          agree.push({ ok: r.lib.inp.value === r.inp, mine: r.inp, theirs: r.lib.inp.value, config: c });
        }
      }
      if (agree.length) {
        const ok = agree.filter((a) => a.ok).length;
        p(`\`inp()\` agrees with this harness's independent INP computation in **${ok} of ${agree.length}** runs.`);
        const bad = agree.filter((a) => !a.ok).slice(0, 5);
        if (bad.length) {
          p();
          for (const b of bad) p(`- ${b.config}: harness ${b.mine} ms, \`inp()\` ${b.theirs} ms`);
        }
        p();
      }

      // What it blamed.
      p(`#### What it blamed (top 3 interactions per run, configuration B)`);
      p();
      const bl = blameSummary(runs, app, 'B', throttle);
      if (!bl.length) {
        p(`No reports. Every interaction stayed under the library's default 40 ms \`threshold\` and set off no heavy later render.`);
      } else {
        p(`| seen | interaction | target | blame kind | blamed | detail | blame ms (median) | confidence |`);
        p(`| ---: | --- | --- | --- | --- | --- | ---: | --- |`);
        for (const g of bl) {
          p(
            `| ${g.n} | ${g.type} ${fmt(median(g.durations), 0)} ms | ${g.label ?? g.selector ?? '?'} (component \`${g.targetComponent ?? '-'}\`, handler \`${g.handler ?? '-'}\`) | ${g.kind} | \`${g.name ?? '-'}\` | ${g.detail ?? '-'} | ${fmt(median(g.blameMs), 0)} | ${[...g.confidences].join('/')} |`,
          );
        }
        p();
        p(`Owner chains seen: ${[...new Set(bl.map((g) => (g.owners ?? []).join(' > ')))].map((s) => `\`${s}\``).join(', ')}`);
        p();
        p(`One verdict verbatim, per distinct interaction:`);
        p();
        for (const g of bl) {
          p(`- ${[...g.verdicts][0]}`);
        }
      }
      p();

      // Console noise.
      const noisy = configs.flatMap((c) =>
        pick(runs, app, c, throttle).flatMap((r) => [
          ...r.console.map((m) => `${c}: [${m.type}] ${m.text}`),
          ...r.pageErrors.map((m) => `${c}: [pageerror] ${m}`),
        ]),
      );
      const uniq = [...new Set(noisy)];
      p(`#### Console`);
      p();
      p(uniq.length ? uniq.map((s) => `- \`${s}\``).join('\n') : `Nothing: no errors or warnings in any configuration.`);
      p();
    }
  }

  process.stdout.write(out.join('\n') + '\n');
}

main();
