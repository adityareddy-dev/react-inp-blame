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
    plugins.push({
      name: 'react-inp-blame:install',
      enforce: 'pre',
      apply,
      resolveId: (id) => (id === INSTALL_MODULE ? RESOLVED_INSTALL_MODULE : null),
      load: (id) => (id === RESOLVED_INSTALL_MODULE ? `import { install } from 'react-inp-blame';\ninstall(${JSON.stringify(install)});\n` : null),
      transformIndexHtml: {
        // Before Vite reads the page's scripts, so this one is served and bundled like theirs. Module
        // scripts run in document order, and it goes first.
        order: 'pre',
        handler: (_html, { path }) =>
          pages(path) ? [{ tag: 'script', attrs: { type: 'module' }, children: `import '${INSTALL_MODULE}';`, injectTo: 'head-prepend' }] : undefined,
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
