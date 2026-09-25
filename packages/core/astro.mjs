// The Astro integration, for sites whose pages Astro writes itself, where the Vite plugins' script has no
// HTML page to go in. In the runs `enabled` covers it adds:
// - install(), in the script Astro imports before it hydrates any island, so the DevTools hook exists
//   before an island's renderer loads react-dom;
// - the displayName transform, so component names survive the production minifier.
//
//   // astro.config.mjs
//   import { defineConfig } from 'astro/config';
//   import react from '@astrojs/react';
//   import { inpBlame } from 'react-inp-blame/astro';
//   export default defineConfig({ integrations: [react(), inpBlame({ runtime: { overlay: 'query' } })] });
//
// Nothing here imports Astro: an integration is a plain object.

import { inpBlame as vitePlugins } from './vite.mjs';

const ENABLED = ['development', 'production', true, false];
const OPTION_KEYS = ['enabled', 'runtime'];
// install()'s own options, which belong under `runtime`, as for the Vite plugins.
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

/** Throws on an option this integration does not have, which would otherwise be ignored in silence. */
function checkOptionKeys(options) {
  const unknown = Object.keys(options).find((key) => !OPTION_KEYS.includes(key));
  if (unknown === undefined) return;
  const belongs = INSTALL_KEYS.includes(unknown)
    ? ` It is an option of install(), so it goes under \`runtime\`: inpBlame({ runtime: ${asWritten({ [unknown]: options[unknown] })} }).`
    : unknown === 'pages'
      ? " Astro hydrates every page's islands through the same script, so there is no page to leave out."
      : '';
  throw new TypeError(`inpBlame: \`${unknown}\` is not one of this integration's options, which are \`enabled\` and \`runtime\`.${belongs}`);
}

export function inpBlame(options = {}) {
  checkOptionKeys(options);
  const { enabled = 'development', runtime = true } = options;
  if (!ENABLED.includes(enabled)) {
    throw new TypeError(`inpBlame: enabled is 'development', 'production', true or false, not ${JSON.stringify(enabled)}.`);
  }
  const install = installOptions(runtime);
  const commands = enabled === true ? ['dev', 'build'] : enabled === 'development' ? ['dev'] : enabled === 'production' ? ['build'] : [];
  return {
    name: 'react-inp-blame',
    hooks: {
      /**
       * Astro's `command` is 'dev' for `astro dev` and 'build' for `astro build`, whose output `astro
       * preview` serves as built. 'preview' and 'sync' bundle nothing, so they get nothing either.
       */
      'astro:config:setup': ({ command, injectScript, updateConfig }) => {
        if (!commands.includes(command)) return;
        // Every island imports the before-hydration script, and waits for it to finish, before it imports
        // its component and its renderer, and the renderer is what loads react-dom. A page with no island
        // has no React to read and never loads it. The script is one module shared by every island, so
        // the call runs once per page.
        if (install) injectScript('before-hydration', `import { install } from 'react-inp-blame';\ninstall(${JSON.stringify(install)});`);
        // Only the transform: the plugins' own install script needs an HTML page that Vite serves.
        updateConfig({ vite: { plugins: vitePlugins({ enabled: true, runtime: false }) } });
      },
    },
  };
}
