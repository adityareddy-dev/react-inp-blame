import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inpBlame } from '../vite.mjs';

const INSTALL = 'react-inp-blame:install';
const SCRIPT = 'react-inp-blame:install-script';
const NAMES = 'react-inp-blame:display-names';
const ENTRY = 'react-inp-blame:entry';
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
  return runtime.load(runtime.resolveId(imported).id);
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
      error.message.includes("`overlay` is not one of this plugin's options, which are `enabled`, `runtime`, `pages` and `entry`") &&
      error.message.includes('inpBlame({ runtime: { overlay: true } })'),
  );
  // The value is the caller's, whatever shape it has.
  assert.throws(() => inpBlame({ overlay: { position: 'bottom-left' } } as never), /inpBlame\(\{ runtime: \{ overlay: \{ position: "bottom-left" \} \} \}\)/);
  // A key that is nobody's option gets the list and nothing more, since there is nowhere to send it.
  assert.throws(() => inpBlame({ page: () => true } as never), (error: unknown) => error instanceof TypeError && !error.message.includes('install()'));
  // Refused even where the plugins would add nothing, so a typo cannot hide behind enabled: false.
  assert.throws(() => inpBlame({ enabled: false, overlay: true } as never), /not one of this plugin's options/);
});

/** The install plugin as a run of Vite at `root` sets it up: its config resolved and its build started. */
function entryRuntime(command: 'serve' | 'build', options: Options, root = '/app') {
  const plugins = pluginsFor(command, { enabled: true, ...options });
  const runtime = plugins.find((p) => p.name === INSTALL)!;
  const entryPlugin = plugins.find((p) => p.name === ENTRY);
  const emitted: unknown[] = [];
  const errors: string[] = [];
  const context = {
    environment: { config: { consumer: 'client', build: {} } },
    emitFile: (file: unknown) => emitted.push(file),
    error: (message: string) => errors.push(message),
  };
  runtime.configResolved({ command, root, base: '/', build: {}, plugins: [] });
  runtime.buildStart.call(context);
  const transform = (code: string, id: string, ssr = false) => entryPlugin!.transform.call(context, code, id, { ssr });
  const finish = () => runtime.generateBundle.call(context);
  return { runtime, entryPlugin, emitted, errors, transform, finish };
}

test('entry puts the install first in that module, on its first line, in the browser only', () => {
  const { transform, entryPlugin } = entryRuntime('serve', { entry: 'app/root.tsx' });
  // After the JSX is compiled, so the compiler's own import of react/jsx-runtime cannot come above it.
  assert.equal(entryPlugin!.enforce, 'post');
  assert.equal(entryRuntime('serve', {}).entryPlugin, undefined);
  const code = 'import { Outlet } from "react-router";\nexport default function App() {}\n';
  const out = transform(code, '/app/app/root.tsx?v=1');
  assert.equal(out.code, `import '${INSTALL_MODULE}';${code}`);
  assert.equal(out.code.split('\n').length, code.split('\n').length);
  // Server rendering never runs it, and other modules are left alone.
  assert.equal(transform(code, '/app/app/root.tsx', true), null);
  assert.equal(transform(code, '/app/app/routes/home.tsx'), null);
  // A leading ./ is the same path, and an absolute path is taken as it is.
  assert.ok(entryRuntime('serve', { entry: './app/root.tsx' }).transform(code, '/app/app/root.tsx'));
  assert.ok(entryRuntime('serve', { entry: '/app/app/root.tsx' }).transform(code, '/app/app/root.tsx'));
  assert.ok(entryRuntime('serve', { entry: 'C:\\site\\app\\root.tsx' }, 'C:/site').transform(code, 'C:/site/app/root.tsx'));
  // A directive prologue stays first, on the same line.
  assert.equal(transform("'use client';\nexport {}", '/app/app/root.tsx').code, `'use client';import '${INSTALL_MODULE}';\nexport {}`);
});

test('entry gives the install a chunk of its own, not an entry, and fails a build where the path matched nothing', () => {
  const found = entryRuntime('build', { entry: 'app/root.tsx' });
  // No emitted chunk: that would be a second entry, which TanStack Start refuses.
  assert.deepEqual(found.emitted, []);
  found.transform('export {}', '/app/app/root.tsx');
  found.finish();
  assert.deepEqual(found.errors, []);

  // The install module gets the chunk, and the app's own manualChunks function decides the rest.
  const theirs = (id: string) => (id.includes('node_modules/react/') ? 'react' : undefined);
  const { manualChunks } = found.runtime.outputOptions.call({ warn: () => {} }, { manualChunks: theirs });
  assert.equal(manualChunks(`\0${INSTALL_MODULE}`, {}), 'react-inp-blame-install');
  assert.equal(manualChunks('/app/node_modules/react/index.js', {}), 'react');
  assert.equal(manualChunks('/app/app/root.tsx', {}), undefined);
  assert.equal(found.runtime.outputOptions.call({}, {}).manualChunks(`\0${INSTALL_MODULE}`, {}), 'react-inp-blame-install');
  // An object cannot be added to, so it is left as it is, with a warning.
  const warnings: string[] = [];
  assert.equal(found.runtime.outputOptions.call({ warn: (w: string) => warnings.push(w) }, { manualChunks: { vendor: ['react'] } }), null);
  assert.match(warnings[0]!, /beside a manualChunks object/);
  // Without entry the output is left alone, and so is one that cannot be split, which would fail the build.
  assert.equal(entryRuntime('build', {}).runtime.outputOptions.call({}, {}), null);
  for (const output of [{ inlineDynamicImports: true }, { preserveModules: true }, { codeSplitting: false }, { format: 'iife' }, { format: 'umd' }]) {
    assert.equal(found.runtime.outputOptions.call({}, output), null, JSON.stringify(output));
  }

  const typo = entryRuntime('build', { entry: 'app/roots.tsx' });
  typo.transform('export {}', '/app/app/root.tsx');
  typo.finish();
  assert.equal(typo.errors.length, 1);
  assert.match(typo.errors[0]!, /entry is 'app\/roots\.tsx', and this build has no module at \/app\/app\/roots\.tsx/);

  // With entry the HTML pages get no script: the module's import is the install.
  const plugins = pluginsFor('serve', { entry: 'app/root.tsx' });
  assert.equal(tagsFor(plugins, '/index.html'), undefined);
});

test('entry leaves a server build alone: no chunk, no import, no error', () => {
  const plugins = pluginsFor('build', { enabled: true, entry: 'app/root.tsx' });
  const runtime = plugins.find((p) => p.name === INSTALL)!;
  const errors: string[] = [];
  const context = { environment: { name: 'ssr', config: { consumer: 'server', build: { ssr: true } } }, error: (m: string) => errors.push(m), warn: () => {} };
  runtime.configResolved({ command: 'build', root: '/app', base: '/', build: { ssr: true }, plugins: [] });
  runtime.buildStart.call(context);
  assert.equal(runtime.outputOptions.call(context, {}), null);
  assert.equal(plugins.find((p) => p.name === ENTRY)!.transform.call(context, 'export {}', '/app/app/root.tsx', { ssr: true }), null);
  runtime.generateBundle.call(context);
  assert.deepEqual(errors, []);
});

test('the install module is marked as having side effects, and entry is a path with the install in it', () => {
  const runtime = pluginsFor('serve', { entry: 'app/root.tsx' }).find((p) => p.name === INSTALL)!;
  // An app whose package.json says "sideEffects": false would otherwise lose it from the build.
  assert.deepEqual(runtime.resolveId(INSTALL_MODULE), { id: `\0${INSTALL_MODULE}`, moduleSideEffects: true });
  assert.throws(() => inpBlame({ entry: '' }), /entry is the path of a module from the project root/);
  assert.throws(() => inpBlame({ entry: ['app/root.tsx'] as never }), /entry is the path of a module/);
  assert.throws(() => inpBlame({ entry: 'app/root.tsx', runtime: false }), /runtime: false leaves the install out/);
});
