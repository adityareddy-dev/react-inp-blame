import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const dir = path.resolve(HERE, '../clones/actual');
const state = path.resolve(HERE, '../state/actual');
const yarn = '.yarn/releases/yarn-4.17.1.cjs';
export const source = {
  commit: '6fa81d2f49b7562ec813dca72f2ebdb5ed3dc91e',
  license: 'MIT (LICENSE.txt); core and plugins-service manifests declare ISC',
  licenseSha256: '71e4b3053e4622e1f5fc5d8aa5336350de32ead39247924c596d659b89b47b6f',
  lockfile: 'yarn.lock',
  lockfileSha256: '49adfd4db21e82bf2a5e6273ec8878e0ef97ba52aa78a4a92d1ad1f63542a375',
  packageManager: 'yarn@4.17.1',
};
export const library = {
  spec: 'react-inp-blame@1.0.0',
  integrity: 'sha512-wEQcaqyjZaZ6rnIC7vqkK3eSX4Zl9Y1wBlIFjg1LlfwcsLmsU5li0gBtzxlXhEwiSFnRSU/arBduorTMltkgJg==',
};
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function verifySource() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  if (head !== source.commit) throw new Error(`Actual source changed: ${head}`);
  for (const [file, expected] of [['LICENSE.txt', source.licenseSha256], [source.lockfile, source.lockfileSha256]]) {
    if (sha(path.join(dir, file)) !== expected) throw new Error(`Actual ${file} changed`);
  }
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'packages', 'bin', 'package.json', 'yarn.lock', '.yarnrc.yml', '.yarn'], { cwd: dir });
}

export function install(run) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    run('git', ['clone', '--no-checkout', 'https://github.com/actualbudget/actual.git', dir]);
    run('git', ['checkout', '--detach', source.commit], { cwd: dir });
  }
  verifySource();
  run(process.execPath, [yarn, 'workspaces', 'focus', '@actual-app/web'], {
    cwd: dir, env: { ...process.env, YARN_ENABLE_IMMUTABLE_INSTALLS: 'true' },
  });
  verifySource();
}

export function prepare(run) {
  verifySource();
  if (process.env.BENCH_NPM_LIB && process.env.BENCH_NPM_LIB !== library.spec) {
    throw new Error(`Actual is pinned to ${library.spec}`);
  }
  if (process.env.BENCH_TARBALL) throw new Error('Actual pilot uses the pinned npm release, not a local tarball');
  fs.mkdirSync(state, { recursive: true });
  const packed = path.resolve(HERE, '../npm-lib/1.0.0/react-inp-blame-1.0.0.tgz');
  if (!fs.existsSync(packed)) {
    fs.mkdirSync(path.dirname(packed), { recursive: true });
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', library.spec, '--pack-destination', path.dirname(packed)]);
  }
  const integrity = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(packed)).digest('base64');
  if (integrity !== library.integrity) throw new Error('Actual library tarball integrity mismatch');
  // Extract afresh so a changed cached extraction cannot become the installed copy.
  const extracted = fs.mkdtempSync(path.join(state, 'npm-'));
  run('tar', ['-xzf', packed, '-C', extracted]);
  fs.cpSync(path.join(extracted, 'package'), path.join(dir, 'node_modules/react-inp-blame'), { recursive: true });
  if (!fs.existsSync(path.join(dir, 'packages/plugins-service/dist/plugin-sw.js'))) {
    run(process.execPath, [yarn, 'workspace', 'plugins-service', 'build'], { cwd: dir });
  }
  fs.copyFileSync(path.join(HERE, 'actual-vite.mts'), path.join(dir, 'packages/desktop-client/vite.bench.mts'));
}

export function build(run, env) {
  verifySource();
  const config = env.BENCH_CONFIG === '' ? 'A' : env.BENCH_CONFIG?.toUpperCase();
  if (!['A', 'B', 'C'].includes(config) || env.BENCH_OUTDIR !== `dist-${config.toLowerCase()}`) {
    throw new Error('Actual requires A/B/C with their reserved dist-a/b/c outputs');
  }
  run(process.execPath, [yarn, 'workspace', '@actual-app/web', 'exec', 'vite', 'build', '--mode=browser',
    '--config', 'vite.bench.mts', '--outDir', path.join(dir, env.BENCH_OUTDIR), '--emptyOutDir'], {
    cwd: dir, env: { ...env, NODE_ENV: 'production' },
  });
}
