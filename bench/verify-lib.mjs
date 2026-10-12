// verify-lib.mjs: every app's installed react-inp-blame is byte for byte the npm release.
//
//   node verify-lib.mjs                     # table, every app
//   node verify-lib.mjs --json              # what bench.mjs records
//   node verify-lib.mjs --app tt-virtual,shadcn-v4   # these apps only; bench.mjs passes the run's
//
// Packs the release from the registry once (npm-lib/), then hashes every file of each app's
// installed copy against it. A file that differs, or is missing, fails the check.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apps } from './apps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = process.env.BENCH_NPM_LIB ?? 'react-inp-blame@0.12.0';
const OUT = path.join(HERE, 'npm-lib');

function pack() {
  const version = SPEC.split('@').pop();
  const dir = path.join(OUT, version);
  if (!fs.existsSync(path.join(dir, 'package', 'package.json'))) {
    fs.mkdirSync(dir, { recursive: true });
    const [info] = JSON.parse(execSync(`npm pack ${SPEC} --json --pack-destination "${dir}"`, { cwd: HERE }).toString());
    execSync(`tar -xzf "${info.filename}"`, { cwd: dir });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(info, null, 2));
  }
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
  return { root: path.join(dir, 'package'), info };
}

function hashes(root) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(d, e.name))).digest('hex');
    }
  };
  walk(root, '');
  return out;
}

function installed(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const p = path.join(d, 'node_modules', 'react-inp-blame');
    if (fs.existsSync(path.join(p, 'package.json'))) return fs.realpathSync(p);
    if (d === HERE || path.dirname(d) === d) return null;
  }
}

const { root, info } = pack();
const want = hashes(root);
// The apps a run is over. Checking every app made a run over some of them record a failed check
// whenever the others were on another version.
const appArg = process.argv.includes('--app') ? process.argv[process.argv.indexOf('--app') + 1] : null;
const ids = appArg ? appArg.split(',') : Object.keys(apps);
for (const id of ids) if (!apps[id]) throw new Error(`no such app: ${id}`);

const result = { spec: SPEC, integrity: info.integrity, shasum: info.shasum, files: Object.keys(want).length, apps: {} };
for (const id of ids) {
  const p = installed(apps[id].dir);
  if (!p) {
    result.apps[id] = { installed: null, match: false };
    continue;
  }
  const got = hashes(p);
  const bad = Object.keys(want).filter((f) => got[f] !== want[f]);
  const extra = Object.keys(got).filter((f) => !(f in want));
  result.apps[id] = {
    installed: path.relative(HERE, p),
    version: JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')).version,
    match: bad.length === 0,
    differs: bad.slice(0, 10),
    extra: extra.slice(0, 10),
  };
}
if (process.argv.includes('--json')) console.log(JSON.stringify(result));
else {
  console.log(`${SPEC} ${info.integrity} (${result.files} files)`);
  for (const [id, r] of Object.entries(result.apps)) {
    console.log(`${id.padEnd(16)} ${r.version ?? '-'}  ${r.match ? 'matches npm' : 'DIFFERS ' + JSON.stringify(r.differs ?? [])}`);
  }
}
if (Object.values(result.apps).some((r) => !r.match)) process.exitCode = 1;
