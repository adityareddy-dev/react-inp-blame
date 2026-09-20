// Vite plugins, the counterpart of withInpBlame in next.cjs. In the runs `enabled` covers they add:
// - a module script ahead of the page's own that calls install(), so the DevTools hook exists before
//   react-dom evaluates, whatever the app's entry module imports first;
// - the displayName transform, so component names survive the production minifier.
//
//   // vite.config.ts
//   import { defineConfig } from 'vite';
//   import { inpBlame } from 'react-inp-blame/vite';
//   export default defineConfig({ plugins: [inpBlame({ enabled: true, runtime: { overlay: 'query' } })] });
//
// Nothing here imports Vite: a plugin is a plain object.

import loader from './display-names-loader.cjs';

// What the added script imports. A leading \0 is how Vite marks a module no file backs.
const INSTALL_MODULE = 'virtual:react-inp-blame/install';
const RESOLVED_INSTALL_MODULE = `\0${INSTALL_MODULE}`;
const COMPONENT_FILE = /\.[jt]sx$/;
const ENABLED = ['development', 'production', true, false];
const OPTION_KEYS = ['enabled', 'runtime', 'pages'];
// install()'s own options, which belong under `runtime`. Listed so that `{ overlay: true }` at the top
// level, which these plugins would otherwise ignore into silence, is named for what it is.
const INSTALL_KEYS = ['overlay', 'threshold', 'labels', 'hook', 'sampleRate', 'walkBudget', 'inputWindow', 'devtoolsTrack', 'debugGlobal'];

/** The file name of the chunk holding the install call, or undefined when this build has none. */
function installChunk(bundle) {
  return Object.keys(bundle).find((file) => bundle[file].type === 'chunk' && bundle[file].facadeModuleId === RESOLVED_INSTALL_MODULE);
}

/** `iife` and `umd` are one file by definition, so asking for another chunk fails the build outright. */
function singleFile(build) {
  return [build.rollupOptions?.output].flat().some((output) => output?.format === 'iife' || output?.format === 'umd');
}

/** The path Vite hands `pages` for an HTML input: the file's path below the project root. */
function pagePath(root, input) {
  const file = input.replaceAll('\\', '/');
  const within = `${String(root).replaceAll('\\', '/').replace(/\/$/, '')}/`;
  return file.startsWith(within) ? file.slice(within.length - 1) : `/${file.split('/').pop()}`;
}

/**
 * Whether this build can put the install call in a script of its own. A dev server needs no chunk
 * (module scripts already run in document order there), a server build has no page, and a library,
 * a single-file output format or the SystemJS bundle @vitejs/plugin-legacy adds either cannot be
 * split at all or gains nothing from document order.
 */
function separateScript(config, environment) {
  if (config?.command !== 'build') return false;
  if (environment?.config?.consumer === 'server') return false;
  const build = environment?.config?.build ?? config.build;
  if (!build || build.lib || build.ssr || singleFile(build)) return false;
  // @vitejs/plugin-legacy builds a second, SystemJS bundle for the browsers that ignore module
  // scripts. Document order buys nothing there, and a second entry only splits the install away from
  // the code that has to run after it, so that build is left the shape it had.
  return !config.plugins?.some((plugin) => plugin.name?.startsWith('vite:legacy'));
}

/**
 * Whether to ask for the chunk: only when a separate script is possible and some page in this build
 * wants one. A chunk emitted for a build whose every entry is a script, or whose pages are all
 * turned down by `pages`, is a file nobody loads.
 */
function buildsPages(config, environment, pages) {
  if (!separateScript(config, environment)) return false;
  const build = environment?.config?.build ?? config.build;
  const input = build.rollupOptions?.input;
  // Vite's own default, when the config names no input, is the root index.html.
  const entries = input === undefined ? [`${config.root}/index.html`] : typeof input === 'string' ? [input] : Array.isArray(input) ? input : Object.values(input);
  return entries.some((entry) => typeof entry === 'string' && entry.endsWith('.html') && pages(pagePath(config.root, entry)));
}

/** Where a page at `path` loads `file` from, following the `base` the way Vite's own tags do. */
function assetUrl(config, path, file) {
  const base = config?.base ?? '/';
  if (base !== '' && base !== '.' && base !== './') return base + file;
  // A relative base is read against the page itself, so a page in a subdirectory climbs out of it first.
  const depth = path.split('/').filter(Boolean).length - 1;
  return depth > 0 ? `${'../'.repeat(depth)}${file}` : `./${file}`;
}

/** The options install() gets: {} for `runtime: true`, the object itself, null for `runtime: false`. */
function installOptions(runtime) {
  if (runtime === true) return {};
  if (runtime === false) return null;
  if (runtime !== null && typeof runtime === 'object' && !Array.isArray(runtime)) return runtime;
  throw new TypeError(`inpBlame: runtime is true, false or the options for install(), not ${JSON.stringify(runtime)}.`);
}

/** An object literal as it would be written in a config file, so an error can quote the caller's own values. */
function asWritten(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  const keys = Object.keys(value);
  return keys.length === 0 ? '{}' : `{ ${keys.map((key) => `${key}: ${asWritten(value[key])}`).join(', ')} }`;
}

/**
 * Throws on an option these plugins do not have. An unknown key is otherwise ignored in silence,
 * which looks exactly like the library not working, and the likeliest one is an install() option
 * written a level too high.
 */
function checkOptionKeys(options) {
  const unknown = Object.keys(options).find((key) => !OPTION_KEYS.includes(key));
  if (unknown === undefined) return;
  const belongs = INSTALL_KEYS.includes(unknown)
    ? ` It is an option of install(), so it goes under \`runtime\`: inpBlame({ runtime: ${asWritten({ [unknown]: options[unknown] })} }).`
    : '';
  throw new TypeError(`inpBlame: \`${unknown}\` is not one of this plugin's options, which are \`enabled\`, \`runtime\` and \`pages\`.${belongs}`);
}

export function inpBlame(options = {}) {
  checkOptionKeys(options);
  const { enabled = 'development', runtime = true, pages = () => true } = options;
  if (!ENABLED.includes(enabled)) {
    throw new TypeError(`inpBlame: enabled is 'development', 'production', true or false, not ${JSON.stringify(enabled)}.`);
  }
  if (typeof pages !== 'function') throw new TypeError('inpBlame: pages is a function of the page path.');
  const install = installOptions(runtime);
  // Off means no plugins at all, so the build carries nothing from here.
  if (enabled === false) return [];
  // 'development' is the dev server; 'production' is `vite build`, whose output `vite preview` serves as built.
  const apply = (_config, { command }) => enabled === true || command === (enabled === 'development' ? 'serve' : 'build');

  const plugins = [];
  if (install) {
    // The build in progress, from configResolved: its `base`, and whether it is a build at all.
    let config = null;
    plugins.push({
      name: 'react-inp-blame:install',
      enforce: 'pre',
      apply,
      configResolved(resolved) {
        config = resolved;
      },
      /**
       * Asks the bundler for the install call in a chunk of its own, which the page then loads as a
       * script of its own (see `react-inp-blame:install-script`). Without the split there is nothing
       * to point a second script tag at.
       */
      buildStart() {
        if (buildsPages(config, this.environment, pages)) this.emitFile({ type: 'chunk', id: INSTALL_MODULE, name: 'react-inp-blame-install' });
      },
      resolveId: (id) => (id === INSTALL_MODULE ? RESOLVED_INSTALL_MODULE : null),
      load: (id) => (id === RESOLVED_INSTALL_MODULE ? `import { install } from 'react-inp-blame';\ninstall(${JSON.stringify(install)});\n` : null),
      transformIndexHtml: {
        // Before Vite reads the page's scripts, so this one is served and bundled like theirs. On the
        // dev server that is the whole job: nothing is bundled, and module scripts run in document
        // order. In a build it is the fallback for the outputs that get no chunk to point a script at,
        // a single-file format, a library, or the SystemJS bundle @vitejs/plugin-legacy makes for
        // browsers that ignore module scripts; where the script below is added, this one would only
        // repeat it.
        order: 'pre',
        handler: (_html, { path }) =>
          pages(path) && !buildsPages(config, null, pages)
            ? [{ tag: 'script', attrs: { type: 'module' }, children: `import '${INSTALL_MODULE}';`, injectTo: 'head-prepend' }]
            : undefined,
      },
    });
    /**
     * The production half. An import cannot be made to win here: Vite folds a page's module scripts
     * into one entry module, and a chunk that entry imports is evaluated before the entry's own body,
     * so the bundler decides whether react-dom or install() goes first. Two pages sharing a chunk is
     * enough to settle it the wrong way.
     *
     * A separate `<script type="module">` is not the bundler's to reorder. A module script with no
     * `async` is deferred, and at "the end" of parsing the HTML Standard runs the deferred scripts in
     * the order their elements were reached, waiting for each one's whole module graph before it runs
     * and running it to completion before starting the next. So the install script placed first in
     * head has installed before the page's entry begins (HTML Standard, "The script element" §4.12.1
     * and "The end" §13.2.7). Nothing in the install graph uses top-level await, which is the one
     * thing that would end that script before its work was done.
     */
    plugins.push({
      name: 'react-inp-blame:install-script',
      apply: (resolved, env) => env.command === 'build' && apply(resolved, env),
      transformIndexHtml: {
        // After the bundle exists, so the chunk this points at has its final name.
        order: 'post',
        handler: (_html, { path, bundle }) => {
          const file = pages(path) && bundle && installChunk(bundle);
          return file ? [{ tag: 'script', attrs: { type: 'module', crossorigin: true, src: assetUrl(config, path, file) }, injectTo: 'head-prepend' }] : undefined;
        },
      },
      generateBundle: {
        // After the HTML has been written, so what the pages load is known.
        order: 'post',
        handler(_options, bundle) {
          const file = installChunk(bundle);
          if (!file) return;
          // Loaded means a page's HTML names it or another entry imports it. The chunk's own subtree
          // does not count: the overlay is split out of it and imports it back, which would keep a file
          // alive that nothing outside it ever reaches.
          const loaded = Object.values(bundle).some((output) =>
            output.type === 'asset' ? String(output.source).includes(file) : output.isEntry && output.fileName !== file && output.imports?.includes(file),
          );
          if (!loaded) delete bundle[file];
        },
      },
    });
  }
  plugins.push({
    name: 'react-inp-blame:display-names',
    // Once Vite has compiled the JSX and TypeScript.
    enforce: 'post',
    apply,
    transform(code, id) {
      const file = id.split('?')[0];
      if (!COMPONENT_FILE.test(file) || file.includes('node_modules')) return null;
      const stamped = loader.stamp(code);
      return stamped === code ? null : { code: stamped, map: null };
    },
  });
  return plugins;
}
