import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inpBlame } from '../vite.mjs';

const INSTALL = 'react-inp-blame:install';
const NAMES = 'react-inp-blame:display-names';

type Options = Parameters<typeof inpBlame>[0];
type Plugin = Record<string, any>;

/** The plugins a run of Vite uses: those whose `apply` accepts its command. */
function pluginsFor(command: 'serve' | 'build', options?: Options): Plugin[] {
  return (inpBlame(options) as Plugin[]).filter((p) => p.apply({}, { command, mode: command === 'serve' ? 'development' : 'production' }));
}

const names = (plugins: Plugin[]) => plugins.map((p) => p.name);

/** The tags the runtime adds to the page at `path`, if it adds any. */
function tagsFor(plugins: Plugin[], path: string): Plugin[] | undefined {
  return plugins.find((p) => p.name === INSTALL)?.transformIndexHtml.handler('<!doctype html>', { path, filename: `/app${path}` });
}

/** The code the page's added script ends up running: the module it imports, resolved and loaded the way Vite does. */
function scriptCode(plugins: Plugin[]): string {
  const [tag] = tagsFor(plugins, '/index.html')!;
  const [, imported] = /^import '(.+)';$/.exec(tag.children)!;
  const runtime = plugins.find((p) => p.name === INSTALL)!;
  return runtime.load(runtime.resolveId(imported));
}

test('by default the dev server gets the runtime and the displayName transform, and vite build gets nothing', () => {
  assert.deepEqual(names(pluginsFor('serve')), [INSTALL, NAMES]);
  assert.deepEqual(names(pluginsFor('build')), []);
});

test("enabled: 'production' applies them to vite build only, true to both runs, and false adds no plugins", () => {
  const runs = (enabled: Options['enabled']) => [names(pluginsFor('serve', { enabled })), names(pluginsFor('build', { enabled }))];
  assert.deepEqual(runs('production'), [[], [INSTALL, NAMES]]);
  assert.deepEqual(runs(true), [
    [INSTALL, NAMES],
    [INSTALL, NAMES],
  ]);
  assert.deepEqual(inpBlame({ enabled: false }), []);
  assert.throws(() => inpBlame({ enabled: 'always' as never }), /enabled is 'development', 'production', true or false/);
});

test("the runtime is a module script ahead of the page's own, and installs with the options it is given", () => {
  const plugins = pluginsFor('build', { enabled: true, runtime: { overlay: 'query', debugGlobal: true } });
  const runtime = plugins.find((p) => p.name === INSTALL)!;
  // Pre-ordered, so Vite serves and bundles the script like the ones the page was written with.
  assert.equal(runtime.transformIndexHtml.order, 'pre');
  assert.deepEqual(
    tagsFor(plugins, '/index.html')!.map(({ tag, attrs, injectTo }) => ({ tag, attrs, injectTo })),
    [{ tag: 'script', attrs: { type: 'module' }, injectTo: 'head-prepend' }],
  );
  const code = scriptCode(plugins);
  assert.match(code, /import \{ install \} from 'react-inp-blame';/);
  assert.ok(code.includes('install({"overlay":"query","debugGlobal":true});'), code);
});

test('pages picks the pages that get the runtime, and runtime: false keeps only the transform', () => {
  const plugins = pluginsFor('serve', { pages: (path) => path !== '/devtools-hook.html' });
  assert.equal(tagsFor(plugins, '/devtools-hook.html'), undefined);
  assert.equal(tagsFor(plugins, '/index.html')!.length, 1);
  assert.match(scriptCode(pluginsFor('serve')), /install\(\{\}\);/);

  assert.deepEqual(names(pluginsFor('serve', { runtime: false })), [NAMES]);
  assert.throws(() => inpBlame({ runtime: 'query' as never }), /runtime is true, false or the options for install\(\)/);
});

test("the transform stamps displayName on the app's component files, and leaves node_modules and other files alone", () => {
  const [transform] = pluginsFor('build', { enabled: true, runtime: false });
  const source = 'export function Cart() {\n  return null;\n}\n';
  assert.match(transform.transform(source, '/app/src/Cart.tsx?v=3').code, /Cart\.displayName = "Cart"/);
  assert.equal(transform.transform(source, '/app/node_modules/ui/Cart.jsx'), null);
  assert.equal(transform.transform(source, '/app/src/cart.ts'), null);
});
