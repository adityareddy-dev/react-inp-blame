import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inpBlame } from '../astro.mjs';

type Options = Parameters<typeof inpBlame>[0];
type Command = 'dev' | 'build' | 'preview' | 'sync';

/** What the integration asks of Astro in a run of `command`: the scripts it injects and the Vite plugins it adds. */
function setup(command: Command, options?: Options, warnings: string[] = []) {
  const scripts: { stage: string; content: string }[] = [];
  const plugins: Record<string, any>[] = [];
  const integration = inpBlame(options) as Record<string, any>;
  integration.hooks['astro:config:setup']({
    command,
    injectScript: (stage: string, content: string) => scripts.push({ stage, content }),
    updateConfig: (config: { vite?: { plugins?: Record<string, any>[] } }) => plugins.push(...(config.vite?.plugins ?? [])),
    logger: { warn: (message: string) => warnings.push(message) },
  });
  return { name: integration.name, scripts, plugins: plugins.map((p) => p.name) };
}

test('by default astro dev gets the install and the displayName transform, and astro build gets nothing', () => {
  const dev = setup('dev');
  assert.equal(dev.name, 'react-inp-blame');
  assert.deepEqual(dev.scripts, [{ stage: 'before-hydration', content: "import { install } from 'react-inp-blame';\ninstall({});" }]);
  assert.deepEqual(dev.plugins, ['react-inp-blame:display-names']);
  assert.deepEqual(setup('build'), { name: 'react-inp-blame', scripts: [], plugins: [] });
});

test('astro build says the default leaves the library out, and an enabled written out, dev and preview do not', () => {
  const warnings: string[] = [];
  setup('dev', undefined, warnings);
  setup('preview', undefined, warnings);
  setup('build', { enabled: 'development' }, warnings);
  setup('build', { enabled: false }, warnings);
  assert.deepEqual(warnings, []);
  setup('build', undefined, warnings);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /^left out of this production build \(enabled defaults to 'development'\)\. Pass enabled: true to include it.*#left-out-of-a-production-build$/);
});

test("enabled: 'production' is astro build alone, true is both, false neither, and preview and sync get nothing", () => {
  const runs = (enabled: Options['enabled']) => (['dev', 'build'] as const).map((command) => setup(command, { enabled }).plugins.length > 0);
  assert.deepEqual(runs('production'), [false, true]);
  assert.deepEqual(runs(true), [true, true]);
  assert.deepEqual(runs(false), [false, false]);
  for (const command of ['preview', 'sync'] as const) assert.deepEqual(setup(command, { enabled: true }).plugins, []);
  assert.throws(() => inpBlame({ enabled: 'always' as never }), /enabled is 'development', 'production', true or false/);
});

test('the install runs with the options it is given, and runtime: false keeps only the transform', () => {
  const { scripts } = setup('dev', { runtime: { overlay: 'query', debugGlobal: true } });
  assert.equal(scripts[0].content, 'import { install } from \'react-inp-blame\';\ninstall({"overlay":"query","debugGlobal":true});');
  assert.deepEqual(setup('build', { enabled: true, runtime: false }), { name: 'react-inp-blame', scripts: [], plugins: ['react-inp-blame:display-names'] });
  assert.throws(() => inpBlame({ runtime: 'query' as never }), /runtime is true, false or the options for install\(\)/);
});

test('an option the integration does not have is refused, and an install() option is sent under runtime', () => {
  assert.throws(
    () => inpBlame({ overlay: true } as never),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message.includes("`overlay` is not one of this integration's options, which are `enabled` and `runtime`") &&
      error.message.includes('inpBlame({ runtime: { overlay: true } })'),
  );
  // The Vite plugins' `pages` has no counterpart: every island goes through the same script.
  assert.throws(() => inpBlame({ pages: () => true } as never), /no page to leave out/);
  assert.throws(() => inpBlame({ enabled: false, overlay: true } as never), /not one of this integration's options/);
});
