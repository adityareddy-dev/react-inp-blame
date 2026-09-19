import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { withInpBlame } = createRequire(import.meta.url)('../next.cjs');

const GLOB = '*.{tsx,jsx}';
const CLIENT_MODULE = 'react-inp-blame/next-client';
const EVERYTHING = { runtime: true, turbopack: true, webpack: true };
const NOTHING = { runtime: false, turbopack: false, webpack: false };

/** What withInpBlame returns under `next dev` or `next build`, which set NODE_ENV before Next reads the config. */
function wrapped(nodeEnv: 'development' | 'production', config: Record<string, any>, options?: { enabled?: unknown; runtime?: unknown }): Record<string, any> {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    return withInpBlame(config, options);
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

/** What a config adds to the app: the runtime module Next.js injects on the client, the loader's Turbopack rule, and the rule its webpack() adds to a browser build. */
function added(config: Record<string, any>): typeof EVERYTHING {
  const rules: unknown[] = [];
  if (typeof config.webpack === 'function') config.webpack({ module: { rules } }, { isServer: false });
  return {
    runtime: config.instrumentationClientInject?.includes(CLIENT_MODULE) ?? false,
    turbopack: config.turbopack?.rules?.[GLOB] !== undefined,
    webpack: rules.length > 0,
  };
}

/** What next-client reads, as Next.js inlines it from `env`. */
const clientSettings = (config: Record<string, any>) => JSON.parse(config.env.REACT_INP_BLAME_NEXT);

test('by default next dev gets the runtime and the loader, and next build gets the config back untouched', () => {
  const config = { reactStrictMode: true };
  assert.deepEqual(added(wrapped('development', config)), EVERYTHING);
  assert.equal(wrapped('production', config), config);
});

test("enabled: 'production' adds them to next build only, true to both runs, false to neither", () => {
  const runs = (enabled: unknown) => [added(wrapped('development', {}, { enabled })), added(wrapped('production', {}, { enabled }))];
  assert.deepEqual(runs('production'), [NOTHING, EVERYTHING]);
  assert.deepEqual(runs(true), [EVERYTHING, EVERYTHING]);
  assert.deepEqual(runs(false), [NOTHING, NOTHING]);
  assert.throws(() => wrapped('production', {}, { enabled: 'always' }), /enabled is 'development', 'production', true or false/);
});

test('the runtime installs with the options it is given, and runtime: false keeps only the loader', () => {
  assert.deepEqual(clientSettings(wrapped('development', {})), { install: {}, basePath: '' });
  const configured = wrapped('development', { basePath: '/docs' }, { runtime: { overlay: 'query', debugGlobal: true } });
  assert.deepEqual(clientSettings(configured), { install: { overlay: 'query', debugGlobal: true }, basePath: '/docs' });

  const loaderOnly = wrapped('development', {}, { runtime: false });
  assert.deepEqual(added(loaderOnly), { ...EVERYTHING, runtime: false });
  assert.equal(loaderOnly.env, undefined);
  assert.throws(() => wrapped('development', {}, { runtime: 'query' }), /runtime is true, false or the options for install\(\)/);
});

test("the project's own Turbopack rules, webpack(), injected modules and env are kept", () => {
  const svg = { loaders: ['svg-loader'] };
  const ran: string[] = [];
  const webpack = (config: unknown) => {
    ran.push('the project webpack()');
    return config;
  };
  const project = { turbopack: { rules: { '*.svg': svg, [GLOB]: svg } }, webpack, instrumentationClientInject: ['./lib/analytics.js'], env: { API_URL: 'https://api.example' } };
  const config = wrapped('production', project, { enabled: true });
  assert.equal(config.turbopack.rules['*.svg'], svg);
  assert.equal(config.turbopack.rules[GLOB].length, 2);
  assert.equal(config.turbopack.rules[GLOB][0], svg);
  assert.deepEqual(added(config), EVERYTHING);
  assert.deepEqual(ran, ['the project webpack()']);
  assert.deepEqual(config.instrumentationClientInject, ['./lib/analytics.js', CLIENT_MODULE]);
  assert.equal(config.env.API_URL, 'https://api.example');
});

test('the options passed where the config goes are refused, and the message names the two-argument call', () => {
  assert.throws(
    () => wrapped('development', { runtime: { overlay: true } }),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message.includes('`runtime` is an option of this wrapper, not a Next.js config key') &&
      error.message.includes('withInpBlame(nextConfig, { runtime: { overlay: true } })'),
  );
  assert.throws(() => wrapped('production', { enabled: true }), /`enabled` is an option of this wrapper.*withInpBlame\(nextConfig, \{ enabled: true \}\)/s);
  // Two keys, and the example is the caller's own values rather than an invented pair.
  assert.throws(
    () => wrapped('development', { enabled: 'production', runtime: false }),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message.includes('`enabled` and `runtime` are options of this wrapper, not Next.js config keys') &&
      error.message.includes('withInpBlame(nextConfig, { enabled: "production", runtime: false })'),
  );
  // Refused whichever run it is, including the ones `enabled` would leave out: the call is wrong either way.
  assert.throws(() => wrapped('production', { runtime: true }, { enabled: false }), /not a Next\.js config key/);
  // A config that has neither key is a config, and a function config is never the options object.
  assert.deepEqual(added(wrapped('development', { reactStrictMode: true })), EVERYTHING);
});

test('an option this wrapper does not have is refused, and an install() option is sent under runtime', () => {
  assert.throws(
    () => wrapped('development', {}, { overlay: true } as never),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message.includes("`overlay` is not one of this wrapper's options, which are `enabled` and `runtime`") &&
      error.message.includes('withInpBlame(nextConfig, { runtime: { overlay: true } })'),
  );
  // The value is the caller's, whatever shape it has.
  assert.throws(() => wrapped('development', {}, { debugGlobal: '__inp' } as never), /withInpBlame\(nextConfig, \{ runtime: \{ debugGlobal: "__inp" \} \}\)/);
  // A key that is nobody's option gets the list and nothing more, since there is nowhere to send it.
  assert.throws(() => wrapped('development', {}, { enable: true } as never), (error: unknown) => error instanceof TypeError && !error.message.includes('install()'));
  // Refused before `enabled` can leave the run out, so a typo cannot hide until someone builds for production.
  assert.throws(() => wrapped('production', {}, { overlay: true } as never), /not one of this wrapper's options/);
});

test('a function config that returns the options where the config goes is refused too', async () => {
  await assert.rejects(
    () => wrappedFunction('development', () => ({ runtime: true }), 'phase-development-server', {}),
    /`runtime` is an option of this wrapper/,
  );
});

/** What withInpBlame returns for a config written as a function: Next.js calls it with the phase while NODE_ENV is still set. */
async function wrappedFunction(
  nodeEnv: 'development' | 'production',
  config: unknown,
  phase: string,
  defaultConfig: Record<string, unknown>,
  options?: { enabled?: unknown; runtime?: unknown },
): Promise<Record<string, any>> {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    const wrapper = withInpBlame(config, options);
    assert.equal(typeof wrapper, 'function', 'a config written as a function comes back as a function');
    return await wrapper(phase, { defaultConfig });
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

/** A directory shaped like a project with this Next.js in its node_modules, which is where withInpBlame reads the version. */
function projectWithNext(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inp-next-'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'next'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'next', 'package.json'), JSON.stringify({ name: 'next', version }));
  return dir;
}

/** Runs `fn` from `dir`, the working directory Next.js reads a config in. */
function inProject<T>(dir: string, fn: () => T): T {
  const saved = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(saved);
  }
}

test('a config written as a function is wrapped around what it returns, and keeps every setting', async () => {
  const project = (phase: string, { defaultConfig }: { defaultConfig: Record<string, unknown> }) => ({
    basePath: '/shop',
    output: 'standalone',
    images: { unoptimized: true },
    phaseSeen: phase,
    defaultSeen: defaultConfig,
  });
  const config = await wrappedFunction('development', project, 'phase-development-server', { reactStrictMode: true });

  assert.deepEqual(added(config), EVERYTHING);
  assert.equal(config.basePath, '/shop');
  assert.equal(config.output, 'standalone');
  assert.deepEqual(config.images, { unoptimized: true });
  // Next.js's own two arguments reach the project's function unchanged.
  assert.equal(config.phaseSeen, 'phase-development-server');
  assert.deepEqual(config.defaultSeen, { reactStrictMode: true });
  // And basePath still reaches the client module, which the App Router leaves out of the URLs it announces.
  assert.deepEqual(clientSettings(config), { install: {}, basePath: '/shop' });
});

test('an async function config is awaited', async () => {
  const config = await wrappedFunction('production', async () => ({ basePath: '/docs' }), 'phase-production-build', {}, { enabled: true });
  assert.deepEqual(added(config), EVERYTHING);
  assert.equal(config.basePath, '/docs');
});

test('a Next.js older than instrumentationClientInject is refused by name, and a canary of a later one is not', (t) => {
  const old = projectWithNext('15.5.25');
  const canary = projectWithNext('16.4.0-canary.31');
  t.after(() => {
    for (const dir of [old, canary]) fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.throws(
    () => inProject(old, () => wrapped('development', {})),
    (error: unknown) => error instanceof Error && /needs Next\.js 16\.3 or later/.test(error.message) && error.message.includes('15.5.25'),
  );
  // A prerelease of a later version passes the floor. The peer range this replaced refused it at install time.
  assert.deepEqual(added(inProject(canary, () => wrapped('development', {}))), EVERYTHING);
  // enabled: false adds nothing to the config, so there is nothing to refuse.
  const untouched = { reactStrictMode: true };
  assert.equal(inProject(old, () => wrapped('development', untouched, { enabled: false })), untouched);
});
