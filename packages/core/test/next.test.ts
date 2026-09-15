import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { withInpBlame } = createRequire(import.meta.url)('../next.cjs');

const GLOB = '*.{tsx,jsx}';
const BOTH = { turbopack: true, webpack: true };
const NEITHER = { turbopack: false, webpack: false };

/** What withInpBlame returns under `next dev` or `next build`, which set NODE_ENV before Next reads the config. */
function wrapped(nodeEnv: 'development' | 'production', config: Record<string, any>, options?: { enabled?: unknown }): Record<string, any> {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    return withInpBlame(config, options);
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

/** Whether a config runs the loader under each bundler: its Turbopack rule, and the rule its webpack() adds to a browser build. */
function loaders(config: Record<string, any>): { turbopack: boolean; webpack: boolean } {
  const rules: unknown[] = [];
  if (typeof config.webpack === 'function') config.webpack({ module: { rules } }, { isServer: false });
  return { turbopack: config.turbopack?.rules?.[GLOB] !== undefined, webpack: rules.length > 0 };
}

test('by default the loader is added under next dev, and next build gets the config back untouched', () => {
  const config = { reactStrictMode: true };
  assert.deepEqual(loaders(wrapped('development', config)), BOTH);
  assert.equal(wrapped('production', config), config);
});

test("enabled: 'production' adds it to next build only, true to both runs, false to neither", () => {
  const runs = (enabled: unknown) => [loaders(wrapped('development', {}, { enabled })), loaders(wrapped('production', {}, { enabled }))];
  assert.deepEqual(runs('production'), [NEITHER, BOTH]);
  assert.deepEqual(runs(true), [BOTH, BOTH]);
  assert.deepEqual(runs(false), [NEITHER, NEITHER]);
  assert.throws(() => wrapped('production', {}, { enabled: 'always' }), /enabled is 'development', 'production', true or false/);
});

test("the project's own Turbopack rules and webpack() are kept", () => {
  const svg = { loaders: ['svg-loader'] };
  const ran: string[] = [];
  const webpack = (config: unknown) => {
    ran.push('the project webpack()');
    return config;
  };
  const config = wrapped('production', { turbopack: { rules: { '*.svg': svg, [GLOB]: svg } }, webpack }, { enabled: true });
  assert.equal(config.turbopack.rules['*.svg'], svg);
  assert.equal(config.turbopack.rules[GLOB].length, 2);
  assert.equal(config.turbopack.rules[GLOB][0], svg);
  assert.deepEqual(loaders(config), BOTH);
  assert.deepEqual(ran, ['the project webpack()']);
});
