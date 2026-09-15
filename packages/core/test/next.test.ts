import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
