// run.mjs: the whole benchmark in one command.
//
//   node run.mjs --runs 15 --app tt-virtual     # one app
//   node run.mjs --runs 3 --app tt-virtual      # smoke run
//   node run.mjs --dry-run                      # check the apps and configurations, then exit
//
// README.md has the commands for the published runs. An app asked for a configuration it doesn't
// have (cal-diy has only A and B, tt-virtual-fix only B and F) is refused before anything builds.
//
// Installs app dependencies if they are missing, builds each app once per configuration it has
// from the same source, runs bench.mjs, then writes report.md next to the results JSON.
//
// It rebuilds every time. A build takes from under a second per configuration for the TanStack
// examples to minutes for the Next.js apps, and a stale dist would silently invalidate the whole
// comparison, which is a far worse trade than the wait.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apps, checkConfigs } from './apps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with ${r.status}`);
}

// --no-build skips install, prepare and build, for builds made already; BENCH_ORDER limits which
// configurations are built, as it limits which are run. --dry-run stops after the check below.
const noBuild = process.argv.includes('--no-build');
const dryRun = process.argv.includes('--dry-run');
const argv = process.argv.slice(2).filter((a) => a !== '--no-build');
const appArg = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : null;
const appIds = appArg ? appArg.split(',') : Object.keys(apps);
const CONFIGS = (process.env.BENCH_ORDER ?? 'A,B,C').split(',');
checkConfigs(appIds, CONFIGS);
if (dryRun) {
  // Written synchronously, since process.exit would cut an asynchronous write short.
  fs.writeSync(1, `${JSON.stringify({ apps: appIds, configs: CONFIGS, build: !noBuild })}
`);
  process.exit(0);
}

for (const id of noBuild ? [] : appIds) {
  const app = apps[id];
  if (!fs.existsSync(path.join(app.dir, 'node_modules'))) {
    console.log(`\n== install ${id}`);
    if (app.install) app.install(run);
    else run(NPM, ['install', '--no-audit', '--no-fund'], { cwd: app.dir });
  }
  // An app whose build needs something generated first (shadcn-ui/ui generates its whole
  // component registry from source) does that once, before the three configuration builds.
  if (app.prepare) {
    console.log(`\n== prepare ${id}`);
    app.prepare(run);
  }
  for (const [config, dist] of Object.entries(app.dists).filter(([c]) => CONFIGS.includes(c))) {
    console.log(`\n== build ${id} ${config} -> ${dist}`);
    const env = {
      ...process.env,
      BENCH_CONFIG: config === 'A' ? '' : config.toLowerCase(),
      BENCH_OUTDIR: dist,
    };
    if (app.build) app.build(run, env);
    else run(NPX, ['vite', 'build'], { cwd: app.dir, env });
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const results = path.join(HERE, 'results', `${stamp}.json`);
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });

console.log(`\n== bench`);
// bench.mjs exits non-zero if any run failed its assertions, and that is worth keeping: a step
// that did not happen must never pass quietly. But it still writes every run that did succeed,
// and throwing here would discard them, so report first and carry the failure to the end.
const benchFailed = spawnSync(
  process.execPath,
  [path.join(HERE, 'bench.mjs'), ...argv, '--out', results],
  { stdio: 'inherit', shell: false },
).status !== 0;
if (!fs.existsSync(results)) throw new Error('bench.mjs wrote no results file');

console.log(`\n== report`);
const md = path.join(HERE, 'results', `${stamp}.md`);
const r = spawnSync(process.execPath, [path.join(HERE, 'report.mjs'), results], { encoding: 'utf8' });
if (r.status !== 0) throw new Error(r.stderr || 'report.mjs failed');
fs.writeFileSync(md, r.stdout);
fs.writeFileSync(path.join(HERE, 'report.md'), r.stdout);
console.log(`\nresults: ${results}\nreport:  ${md}\n         ${path.join(HERE, 'report.md')}`);

if (benchFailed) {
  console.error('\nSome runs failed their assertions. The report above covers only the runs that');
  console.error('succeeded; check the "Failures" section in it before reading any number.');
  process.exitCode = 1;
}
