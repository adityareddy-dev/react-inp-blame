// next.config wrapper, the same shape as Sentry's withSentryConfig. In the runs `enabled` covers it adds:
// - `react-inp-blame/next-client` to `instrumentationClientInject` (Next.js 16.3 and later), which
//   Next.js imports on the client before instrumentation-client and before hydration. It installs the
//   library ahead of react-dom, and hears App Router navigations through `onRouterTransitionStart`.
//   From 15.3 to 16.2 the app's own instrumentation-client re-exports that module instead, and the
//   wrapper prints the line to add until it does;
// - the displayName loader, so component names survive the production minifier, under Turbopack (the
//   Next 16 default, where a `webpack()` hook never runs) and under `next build --webpack` alike.
//
//   // next.config.ts
//   import { withInpBlame } from 'react-inp-blame/next';
//   export default withInpBlame({ /* your config */ }, { enabled: true, runtime: { overlay: 'query' } });

const fs = require('node:fs');
const path = require('node:path');

const LOADER = require.resolve('./display-names-loader.cjs');
const GLOB = '*.{tsx,jsx}';
const CLIENT_MODULE = 'react-inp-blame/next-client';
// Read by next-client: Next.js inlines each `env` entry into the client as `process.env.<key>`.
const CLIENT_SETTINGS = 'REACT_INP_BLAME_NEXT';
// The line that installs the library from the app's instrumentation-client where Next.js cannot add it.
const CLIENT_LINE = `export { onRouterTransitionStart } from '${CLIENT_MODULE}';`;
// Where each thing this wrapper writes arrived in Next.js. Checked here rather than as a peer range, so
// that installing the package never fails resolution: a prerelease of a later version passes these and
// a semver range refuses it.
// instrumentation-client, its onRouterTransitionStart, and the top-level `turbopack` key.
const NEXT_CLIENT_FILE = { major: 15, minor: 3 };
// `condition` on a Turbopack rule, which keeps the loader to the browser and out of node_modules. Before
// it, the same is written as builtin conditions, and `experimental.turbo` still holds rules.
const NEXT_RULE_CONDITION = { major: 16, minor: 0 };
// `instrumentationClientInject` (PR #93785).
const NEXT_INJECT = { major: 16, minor: 3 };
// This wrapper's own option names. Next.js has neither as a config key, so one of them in the first
// argument is the options object passed where the config goes: Next.js drops it with "Unrecognized
// key(s) in object", nothing installs, and the library looks broken. Caught here instead.
const OPTION_KEYS = ['enabled', 'runtime'];
// install()'s own options, which belong under `runtime`. Listed so that `{ overlay: true }` at the top
// level, which this wrapper would otherwise ignore into silence, is named for what it is.
const INSTALL_KEYS = ['overlay', 'threshold', 'labels', 'hook', 'sampleRate', 'walkBudget', 'inputWindow', 'devtoolsTrack', 'debugGlobal'];

/**
 * Where the project may be: the working directory, where `next dev` and `next build` usually run, and
 * the folder of the next.config that called the wrapper, for `next dev apps/web` run from a monorepo
 * root, which does not change directory.
 */
function projectDirs() {
  const dirs = [process.cwd()];
  const prepare = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_, calls) => calls;
    for (const call of new Error().stack) {
      const file = call.getFileName();
      if (!file || file === __filename || file.startsWith('node:')) continue;
      const found = file.startsWith('file:') ? require('node:url').fileURLToPath(file) : file;
      if (path.isAbsolute(found) && !found.split(path.sep).includes('node_modules')) dirs.push(path.dirname(found));
      break;
    }
  } catch {
    // The working directory alone, then.
  } finally {
    Error.prepareStackTrace = prepare;
  }
  return [...new Set(dirs)];
}

/**
 * The Next.js the project has, read from its own node_modules. Null when there is none to read or the
 * version does not parse, in which case the floor is not enforced: a vendored or bundled copy of
 * Next.js is not this wrapper's to refuse.
 */
function projectNextVersion(dirs) {
  try {
    const { version } = require(require.resolve('next/package.json', { paths: dirs }));
    const [major, minor] = String(version).split('.').map((part) => parseInt(part, 10));
    return Number.isNaN(major) || Number.isNaN(minor) ? null : { major, minor, version };
  } catch {
    return null;
  }
}

/** Whether the project's Next.js is `floor` or later; true when its version is unknown. */
function atLeast(found, floor) {
  return !found || found.major > floor.major || (found.major === floor.major && found.minor >= floor.minor);
}

/**
 * Whether the project's instrumentation-client imports or re-exports next-client, read where Next.js
 * looks for the file, src/ first. A commented-out line does not count, and neither does a bare
 * `import 'react-inp-blame/next-client'`, which installs the library but hears no navigation.
 */
function clientFileLoadsModule(dirs) {
  return dirs.some((dir) => {
    const source = clientFileSource(dir);
    if (source === null) return false;
    // Only comments that open a line are dropped, so a string holding `//` or `/*` is left alone.
    const code = source.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');
    // No quote between the keyword and `from`, so the match cannot start at an earlier import.
    return /^\s*(?:import|export)\b[^;'"`]*\bfrom\s*['"]react-inp-blame\/next-client['"]/m.test(code);
  });
}

/** The instrumentation-client Next.js would use in `dir`, or null when it has none. */
function clientFileSource(dir) {
  for (const sub of ['src', '']) {
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs']) {
      try {
        return fs.readFileSync(path.join(dir, sub, `instrumentation-client.${ext}`), 'utf8');
      } catch {
        // Not this one.
      }
    }
  }
  return null;
}

// Next.js reads its config more than once, and in the worker processes it starts as well, which inherit
// the environment as it was when the config file was imported. A warning marked then prints once per
// `next dev` or `next build`; one from inside a function config, marked later, can print once per process.
function warnOnce(key, message) {
  const mark = `REACT_INP_BLAME_WARNED_${key}`;
  if (process.env[mark]) return;
  process.env[mark] = '1';
  console.warn(`withInpBlame: ${message}`);
}

/** An object literal as it would be written in a config file, so an error can quote the caller's own values. */
function asWritten(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  const keys = Object.keys(value);
  return keys.length === 0 ? '{}' : `{ ${keys.map((key) => `${key}: ${asWritten(value[key])}`).join(', ')} }`;
}

/** The caller's own `{ enabled, runtime }`, or whichever of them this is about, as a literal. */
const theseKeys = (source, keys) => asWritten(Object.fromEntries(keys.map((key) => [key, source[key]])));

/** Throws when the first argument is this wrapper's options rather than a Next.js config. */
function checkNotTheOptions(nextConfig) {
  if (nextConfig === null || typeof nextConfig !== 'object') return;
  const misplaced = OPTION_KEYS.filter((key) => Object.hasOwn(nextConfig, key));
  if (misplaced.length === 0) return;
  const names = misplaced.map((key) => `\`${key}\``).join(' and ');
  const subject = misplaced.length === 1 ? `${names} is an option of this wrapper, not a Next.js config key` : `${names} are options of this wrapper, not Next.js config keys`;
  throw new TypeError(
    `withInpBlame: ${subject}, and the options are the second argument. Write withInpBlame(nextConfig, ${theseKeys(nextConfig, misplaced)}).`,
  );
}

/**
 * Throws on an option this wrapper does not have. An unknown key is otherwise ignored in silence,
 * which looks exactly like the library not working, and the likeliest one is an install() option
 * written a level too high.
 */
function checkOptionKeys(options) {
  const unknown = Object.keys(options).find((key) => !OPTION_KEYS.includes(key));
  if (unknown === undefined) return;
  const belongs = INSTALL_KEYS.includes(unknown)
    ? ` It is an option of install(), so it goes under \`runtime\`: withInpBlame(nextConfig, { runtime: ${theseKeys(options, [unknown])} }).`
    : '';
  throw new TypeError(`withInpBlame: \`${unknown}\` is not one of this wrapper's options, which are \`enabled\` and \`runtime\`.${belongs}`);
}

/**
 * The loader's Turbopack rule: for the browser build, never for foreign code (node_modules). Before
 * 16.0 a rule has no `condition` and takes builtin conditions as keys instead, the first key that
 * matches deciding, so `foreign` comes first.
 */
function turbopackRule(found) {
  if (!atLeast(found, NEXT_RULE_CONDITION)) return { foreign: false, browser: { loaders: [LOADER] } };
  return { condition: { all: ['browser', { not: 'foreign' }] }, loaders: [LOADER] };
}

/**
 * Whether `enabled` covers this run of Next. Next sets NODE_ENV before it reads the config:
 * 'development' for `next dev`, 'production' for `next build` and `next start`.
 */
function isEnabled(enabled, nodeEnv) {
  if (enabled === true || enabled === false) return enabled;
  if (enabled === 'development') return nodeEnv !== 'production';
  if (enabled === 'production') return nodeEnv === 'production';
  throw new TypeError(`withInpBlame: enabled is 'development', 'production', true or false, not ${JSON.stringify(enabled)}.`);
}

/** The options install() gets: {} for `runtime: true`, the object itself, null for `runtime: false`. */
function installOptions(runtime) {
  if (runtime === true) return {};
  if (runtime === false) return null;
  if (runtime !== null && typeof runtime === 'object' && !Array.isArray(runtime)) return runtime;
  throw new TypeError(`withInpBlame: runtime is true, false or the options for install(), not ${JSON.stringify(runtime)}.`);
}

function withInpBlame(nextConfig = {}, options = {}) {
  return wrap(nextConfig, options, projectDirs());
}

function wrap(nextConfig, options, dirs) {
  checkNotTheOptions(nextConfig);
  checkOptionKeys(options);
  const { enabled = 'development', runtime = true } = options;
  const install = installOptions(runtime);
  // Off means the config comes back as it went in, so the build carries nothing from here.
  if (!isEnabled(enabled, process.env.NODE_ENV)) return nextConfig;
  const found = projectNextVersion(dirs);
  if (!atLeast(found, NEXT_CLIENT_FILE)) {
    warnOnce(
      'VERSION',
      `Next.js ${found.version} has no instrumentation-client, which arrived in 15.3, so nothing can install the library ahead of React, and your config was left as it was. Upgrade Next.js to 15.3 or later.`,
    );
    return nextConfig;
  }
  const clientLine = clientFileLoadsModule(dirs);
  // Printed before a function config is called, while Next.js is still importing the config file: an
  // environment change made then reaches the processes it starts, so they do not print it again.
  if (install && !atLeast(found, NEXT_INJECT) && !clientLine) {
    warnOnce(
      'CLIENT_LINE',
      `Next.js ${found.version} cannot load the library before React by itself, which needs instrumentationClientInject (16.3 and later). ` +
        `Add this line to instrumentation-client.ts, beside next.config or in src/, and it installs with the options given here:\n\n  ${CLIENT_LINE}\n`,
    );
  }
  // A config written as a function of the phase, the other form Next.js documents. It is called at
  // config time, so the wrapper goes around what it returns rather than around the function.
  if (typeof nextConfig === 'function') return async (phase, context) => wrap(await nextConfig(phase, context), options, dirs);

  const legacy = !atLeast(found, NEXT_RULE_CONDITION) && nextConfig.experimental && nextConfig.experimental.turbo;
  // Next.js 15 reads rules from `experimental.turbo` too, under the ones in `turbopack`, which replace
  // them as a whole; the `turbopack` written here would drop them unless they are carried over.
  const existing = { ...((legacy && legacy.rules) || {}), ...((nextConfig.turbopack && nextConfig.turbopack.rules) || {}) };
  const prior = existing[GLOB];
  let rule = turbopackRule(found);
  if (prior != null && atLeast(found, NEXT_RULE_CONDITION)) rule = [...(Array.isArray(prior) ? prior : [prior]), rule];
  else if (prior != null) {
    // Before 16.0 a glob holds one rule, not a list of them.
    rule = prior;
    warnOnce(
      'RULE',
      `Next.js ${found.version} takes one Turbopack rule for '${GLOB}', and your config has one, so under Turbopack the loader that keeps component names through the production minifier was left out. webpack builds still get it.`,
    );
  }
  const rules = { ...existing, [GLOB]: rule };

  const webpack = (config, context) => {
    if (!context.isServer) {
      config.module.rules.push({
        test: /\.[jt]sx$/,
        exclude: /node_modules/,
        enforce: 'pre',
        use: [{ loader: LOADER }],
      });
    }
    return typeof nextConfig.webpack === 'function' ? nextConfig.webpack(config, context) : config;
  };

  const withLoader = { ...nextConfig, turbopack: { ...(nextConfig.turbopack || {}), rules }, webpack };
  if (!install) return withLoader;
  const withSettings = { ...withLoader, env: { ...nextConfig.env, [CLIENT_SETTINGS]: JSON.stringify({ install, basePath: nextConfig.basePath || '' }) } };
  // Below 16.3 the line in instrumentation-client installs the library. Kept after an upgrade, it still
  // does, and a second copy from instrumentationClientInject would hear every navigation twice.
  if (!atLeast(found, NEXT_INJECT) || clientLine) return withSettings;
  return {
    ...withSettings,
    // Appended, as Next.js's docs have wrappers do: injected modules run in array order.
    instrumentationClientInject: [...(nextConfig.instrumentationClientInject || []), CLIENT_MODULE],
  };
}

module.exports = { withInpBlame };
