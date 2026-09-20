import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inpBlame } from '../vite.mjs';

const INSTALL = 'react-inp-blame:install';
const SCRIPT = 'react-inp-blame:install-script';
const NAMES = 'react-inp-blame:display-names';
const INSTALL_MODULE = 'virtual:react-inp-blame/install';

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
  // The script that points at the built chunk is a build's alone; the dev server has nothing bundled.
  assert.deepEqual(runs('production'), [[], [INSTALL, SCRIPT, NAMES]]);
  assert.deepEqual(runs(true), [
    [INSTALL, NAMES],
    [INSTALL, SCRIPT, NAMES],
  ]);
  assert.deepEqual(inpBlame({ enabled: false }), []);
  assert.throws(() => inpBlame({ enabled: 'always' as never }), /enabled is 'development', 'production', true or false/);
});

test("the runtime is a module script ahead of the page's own, and installs with the options it is given", () => {
  const plugins = pluginsFor('serve', { enabled: true, runtime: { overlay: 'query', debugGlobal: true } });
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

/** A resolved config of a `vite build`, as configResolved hands it to the plugins. */
function resolved(overrides: Record<string, any> = {}): Record<string, any> {
  return { command: 'build', base: '/', root: '/app', plugins: [], build: { rollupOptions: { input: '/app/index.html' } }, ...overrides };
}

/** A rollup plugin context that records what the plugin emitted, for `consumer` builds. */
function buildContext(consumer: 'client' | 'server') {
  const emitted: Record<string, unknown>[] = [];
  return {
    emitted,
    environment: { config: { consumer } },
    emitFile(file: Record<string, unknown>) {
      emitted.push(file);
      return `ref-${emitted.length}`;
    },
  };
}

/** The plugins of a build whose config is `overrides`, with configResolved already called. */
function buildPlugins(options: Options, overrides?: Record<string, any>): Plugin[] {
  const plugins = pluginsFor('build', { enabled: true, ...options });
  for (const plugin of plugins) plugin.configResolved?.(resolved(overrides));
  return plugins;
}

/** A bundle holding the install chunk the plugin asked for, plus the page's own entry. */
const bundled = () => ({
  'assets/install-abc.js': { type: 'chunk', fileName: 'assets/install-abc.js', facadeModuleId: `\0${INSTALL_MODULE}`, isEntry: true, imports: [] },
  'assets/main-def.js': { type: 'chunk', fileName: 'assets/main-def.js', facadeModuleId: '/app/src/main.tsx', isEntry: true, imports: [] },
});

test("a built page loads the install call as a script of its own, ahead of the page's entry script", () => {
  const plugins = buildPlugins({});
  const install = plugins.find((p) => p.name === INSTALL)!;
  const script = plugins.find((p) => p.name === SCRIPT)!;

  // The chunk is only asked for. Vite folds a page's module scripts into one entry module, and a
  // module's imports are evaluated before its body, so an install() the bundler is free to place
  // runs after react-dom, and React looks for the hook once, while react-dom evaluates.
  const ctx = buildContext('client');
  install.buildStart.call(ctx);
  assert.deepEqual(ctx.emitted, [{ type: 'chunk', id: INSTALL_MODULE, name: 'react-inp-blame-install' }]);

  // Document order between two module scripts is the one thing the bundler cannot rearrange, so the
  // tag goes first in head and the inline import that would only repeat it is left out.
  assert.equal(install.transformIndexHtml.handler('<!doctype html>', { path: '/index.html' }), undefined);
  assert.equal(script.transformIndexHtml.order, 'post');
  assert.deepEqual(script.transformIndexHtml.handler('<!doctype html>', { path: '/index.html', bundle: bundled() }), [
    { tag: 'script', attrs: { type: 'module', crossorigin: true, src: '/assets/install-abc.js' }, injectTo: 'head-prepend' },
  ]);

  // A page the caller turned down gets neither form.
  const turnedDown = buildPlugins({ pages: (path: string) => path !== '/second.html' });
  assert.equal(turnedDown.find((p) => p.name === SCRIPT)!.transformIndexHtml.handler('', { path: '/second.html', bundle: bundled() }), undefined);
  assert.equal(turnedDown.find((p) => p.name === INSTALL)!.transformIndexHtml.handler('', { path: '/second.html' }), undefined);
});

test('the script follows base, and climbs out of a subdirectory when base is relative', () => {
  const src = (overrides: Record<string, any>, path: string) =>
    buildPlugins({}, overrides)
      .find((p) => p.name === SCRIPT)!
      .transformIndexHtml.handler('', { path, bundle: bundled() })[0].attrs.src;
  assert.equal(src({ base: '/sub/' }, '/deep/page.html'), '/sub/assets/install-abc.js');
  // A relative base is read against the page, not the site root, so the depth of the page decides.
  assert.equal(src({ base: './' }, '/index.html'), './assets/install-abc.js');
  assert.equal(src({ base: './' }, '/deep/page.html'), '../assets/install-abc.js');
  assert.equal(src({ base: '' }, '/a/b/page.html'), '../../assets/install-abc.js');
});

test('the chunk is dropped when no page loads it, and kept when one does', () => {
  const script = buildPlugins({}).find((p) => p.name === SCRIPT)!;
  const ctx = buildContext('client');

  // The page's HTML naming the file is what keeps it. Nothing else does: the overlay chunk imports
  // the install chunk back, which would otherwise keep alive a file nothing outside it reaches.
  const kept: Record<string, unknown> = { ...bundled(), 'index.html': { type: 'asset', source: '<script src="/assets/install-abc.js"></script>' } };
  script.generateBundle.handler.call(ctx, {}, kept);
  assert.ok('assets/install-abc.js' in kept);

  const dropped: Record<string, unknown> = { ...bundled(), 'assets/overlay-ghi.js': { type: 'chunk', isEntry: false, imports: ['assets/install-abc.js'] } };
  script.generateBundle.handler.call(ctx, {}, dropped);
  assert.deepEqual(Object.keys(dropped), ['assets/main-def.js', 'assets/overlay-ghi.js']);
});

test('a build with no page to carry a second script asks for no chunk and keeps the inline import', () => {
  // Each of these either has no page, or produces one file by definition, or is a bundle where
  // document order buys nothing. Asking for a chunk there is a stray file or a build error.
  const cases: Record<string, Record<string, any>> = {
    'a library build': { build: { lib: { entry: '/app/src/lib.ts' } } },
    'an ssr build': { build: { ssr: true, rollupOptions: { input: '/app/index.html' } } },
    'a single-file output format': { build: { rollupOptions: { input: '/app/index.html', output: { format: 'iife' } } } },
    'the SystemJS bundle of @vitejs/plugin-legacy': { plugins: [{ name: 'vite:legacy-post-process' }] },
    'an entry that is a script, not a page': { build: { rollupOptions: { input: '/app/src/main.ts' } } },
    'every page turned down by pages': { build: { rollupOptions: { input: '/app/index.html' } } },
  };
  for (const [what, overrides] of Object.entries(cases)) {
    const options = what.startsWith('every page') ? { pages: () => false } : {};
    const install = buildPlugins(options, overrides).find((p) => p.name === INSTALL)!;
    const ctx = buildContext('client');
    install.buildStart.call(ctx);
    assert.deepEqual(ctx.emitted, [], what);
    const tags = install.transformIndexHtml.handler('<!doctype html>', { path: '/index.html' });
    if (what.startsWith('every page')) assert.equal(tags, undefined, what);
    else assert.deepEqual(tags?.map((tag: Plugin) => tag.children), [`import '${INSTALL_MODULE}';`], what);
  }

  // A server environment of a build that does have pages: the config says nothing, the environment does.
  const install = buildPlugins({}).find((p) => p.name === INSTALL)!;
  const server = buildContext('server');
  install.buildStart.call(server);
  assert.deepEqual(server.emitted, []);
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

test('an option these plugins do not have is refused, and an install() option is sent under runtime', () => {
  assert.throws(
    () => inpBlame({ overlay: true } as never),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message.includes("`overlay` is not one of this plugin's options, which are `enabled`, `runtime` and `pages`") &&
      error.message.includes('inpBlame({ runtime: { overlay: true } })'),
  );
  // The value is the caller's, whatever shape it has.
  assert.throws(() => inpBlame({ overlay: { position: 'bottom-left' } } as never), /inpBlame\(\{ runtime: \{ overlay: \{ position: "bottom-left" \} \} \}\)/);
  // A key that is nobody's option gets the list and nothing more, since there is nowhere to send it.
  assert.throws(() => inpBlame({ page: () => true } as never), (error: unknown) => error instanceof TypeError && !error.message.includes('install()'));
  // Refused even where the plugins would add nothing, so a typo cannot hide behind enabled: false.
  assert.throws(() => inpBlame({ enabled: false, overlay: true } as never), /not one of this plugin's options/);
});
