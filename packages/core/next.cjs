// next.config wrapper, the same shape as Sentry's withSentryConfig. In the runs `enabled` covers it adds:
// - `react-inp-blame/next-client` to `instrumentationClientInject` (Next.js 16.3 and later), which
//   Next.js imports on the client before instrumentation-client and before hydration. It installs the
//   library ahead of react-dom, and hears App Router navigations through `onRouterTransitionStart`.
//   From 15.3 to 16.2 the app's own instrumentation-client re-exports that module instead, and the
//   wrapper prints the line to add until it does; from 14.2 to 15.2 the module goes first in webpack's
//   client entries;
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
// The README, where each warning below has a section of its own under Troubleshooting.
const HELP = 'https://github.com/adityareddy-dev/react-inp-blame#';
// Where each thing this wrapper writes arrived in Next.js. Checked here rather than as a peer range, so
// that installing the package never fails resolution: a prerelease of a later version passes these and
// a semver range refuses it.
// instrumentation-client, its onRouterTransitionStart, and the top-level `turbopack` key.
const NEXT_CLIENT_FILE = { major: 15, minor: 3 };
// The oldest Next.js the wrapper installs in. Before instrumentation-client it puts the install in front of
// webpack's client entries instead, which Turbopack does not run, and navigations are not announced.
const NEXT_ENTRY = { major: 14, minor: 2 };
// webpack's client entries in Next.js before 15.3: the App Router's and the Pages Router's.
const CLIENT_ENTRIES = ['main-app', 'main'];
// From 15.3 the Pages Router's dev entry, next-dev.js under webpack and next-dev-turbopack.js under
// Turbopack, loads react-dom before it loads instrumentation-client, where the production entry loads it
// first. So on `next dev` the install goes first in the Pages Router's entry: in webpack's `main`, and
// under Turbopack through a loader that puts it at the top of next-dev-turbopack.js.
const PAGES_ENTRIES = ['main'];
const DEV_ENTRY_LOADER = require.resolve('./next-dev-entry-loader.cjs');
const DEV_ENTRY_GLOB = 'next-dev-turbopack.js';
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
function warnOnce(key, message, anchor) {
  const mark = `REACT_INP_BLAME_WARNED_${key}`;
  if (process.env[mark]) return;
  process.env[mark] = '1';
  console.warn(`withInpBlame: ${message}${/\s$/.test(message) ? '' : ' '}See ${HELP}${anchor}`);
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
 * webpack's `entry` with the install first in each client entry, as a function, which is how Next.js gives
 * it (it adds pages as they are asked for, and calls it again). Entries are a module or a list of them, or
 * an object whose `import` is; any other entry is left as it was. Next.js also keeps a `main.js` list, which
 * a config (Sentry's, for one) prepends to and which Next.js makes the Pages Router's `main` of when it is
 * not empty, so the install goes first there too.
 */
function installFirst(entry, names = CLIENT_ENTRIES) {
  return async () => {
    const entries = typeof entry === 'function' ? await entry() : entry;
    for (const name of names) {
      const value = entries[name];
      if (typeof value === 'string' || Array.isArray(value)) {
        const modules = [value].flat();
        if (!modules.includes(CLIENT_MODULE)) entries[name] = [CLIENT_MODULE, ...modules];
      } else if (value && (typeof value.import === 'string' || Array.isArray(value.import))) {
        const modules = [value.import].flat();
        if (!modules.includes(CLIENT_MODULE)) value.import = [CLIENT_MODULE, ...modules];
      }
    }
    const legacyMain = entries['main.js'];
    if (Array.isArray(legacyMain) && !legacyMain.includes(CLIENT_MODULE)) entries['main.js'] = [CLIENT_MODULE, ...legacyMain];
    return entries;
  };
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
 * The Turbopack rule that puts the install at the top of the Pages Router's dev entry. That file is in
 * node_modules, so unlike the names loader's rule this one does not keep out foreign code; the loader
 * itself leaves any file but Next.js's own entry as it was.
 */
function devEntryRule(found) {
  if (!atLeast(found, NEXT_RULE_CONDITION)) return { browser: { loaders: [DEV_ENTRY_LOADER] } };
  return { condition: 'browser', loaders: [DEV_ENTRY_LOADER] };
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

/**
 * The Next.js command this process runs, such as 'build' or 'start', read from its arguments, which is
 * where `next build` and `next start` differ when Next.js reads the config: both set NODE_ENV to
 * 'production'. Undefined in the worker processes Next.js starts, which have other arguments.
 */
function nextCommand() {
  const bin = process.argv[1] || '';
  if (!/[\\/]next(?:[\\/]dist[\\/]bin[\\/]next)?(?:\.js)?$/.test(bin)) return undefined;
  return process.argv.slice(2).find((arg) => !arg.startsWith('-'));
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
  if (!isEnabled(enabled, process.env.NODE_ENV)) {
    // Left at its default, that looks exactly like the library failing: `next build` prints nothing and
    // `next start` shows no badge. So the build says so, and not for an `enabled` the app wrote itself.
    if (options.enabled === undefined && nextCommand() === 'build') {
      warnOnce(
        'LEFT_OUT',
        "react-inp-blame is left out of this production build (enabled defaults to 'development'). Pass enabled: true to include it, or write enabled: 'development' to keep it out without this line.",
        'left-out-of-a-production-build',
      );
    }
    return nextConfig;
  }
  const found = projectNextVersion(dirs);
  if (!atLeast(found, NEXT_ENTRY)) {
    warnOnce('VERSION', `Next.js ${found.version} is older than 14.2, the oldest this wrapper installs in, so your config was left as it was. Upgrade Next.js to 14.2 or later.`, 'next-too-old');
    return nextConfig;
  }
  // Before 15.3 there is no instrumentation-client, and the install goes in front of webpack's entries.
  const byEntry = !atLeast(found, NEXT_CLIENT_FILE);
  if (byEntry && install && process.env.TURBOPACK) {
    warnOnce(
      'TURBOPACK',
      `Next.js ${found.version} has no instrumentation-client, and under Turbopack it runs no webpack() hook, so nothing installs the library. Run next dev without --turbo, or upgrade Next.js to 15.3 or later.`,
      'next-turbopack',
    );
  }
  const clientLine = clientFileLoadsModule(dirs);
  // Printed before a function config is called, while Next.js is still importing the config file: an
  // environment change made then reaches the processes it starts, so they do not print it again.
  if (install && !byEntry && !atLeast(found, NEXT_INJECT) && !clientLine) {
    warnOnce(
      'CLIENT_LINE',
      `Next.js ${found.version} cannot load the library before React by itself, which needs instrumentationClientInject (16.3 and later). ` +
        `Add this line to instrumentation-client.ts, beside next.config or in src/, and it installs with the options given here:\n\n  ${CLIENT_LINE}\n\n`,
      'next-client-line',
    );
  }
  // A config written as a function of the phase, the other form Next.js documents. It is called at
  // config time, so the wrapper goes around what it returns rather than around the function.
  if (typeof nextConfig === 'function') return async (phase, context) => wrap(await nextConfig(phase, context), options, dirs);

  const legacy = !atLeast(found, NEXT_RULE_CONDITION) && nextConfig.experimental && nextConfig.experimental.turbo;
  // Next.js 15 reads rules from `experimental.turbo` too, under the ones in `turbopack`, which replace
  // them as a whole; the `turbopack` written here would drop them unless they are carried over. Older
  // configs have `loaders` keyed by extension there instead, which Next.js 15 turns into rules the same
  // way when there are no `rules`.
  const legacyLoaders = legacy && !legacy.rules && legacy.loaders;
  const legacyRules = legacyLoaders
    ? Object.fromEntries(Object.entries(legacyLoaders).map(([extension, loaders]) => [`*${extension}`, loaders]))
    : legacy && legacy.rules;
  const existing = { ...(legacyRules || {}), ...((nextConfig.turbopack && nextConfig.turbopack.rules) || {}) };
  const prior = existing[GLOB];
  let rule = turbopackRule(found);
  if (prior != null && atLeast(found, NEXT_RULE_CONDITION)) rule = [...(Array.isArray(prior) ? prior : [prior]), rule];
  else if (prior != null) {
    // Before 16.0 a glob holds one rule, not a list of them.
    rule = prior;
    warnOnce(
      'RULE',
      `Next.js ${found.version} takes one Turbopack rule for '${GLOB}', and your config has one, so under Turbopack the loader that keeps component names through the production minifier was left out. webpack builds still get it.`,
      'next-turbopack-rule',
    );
  }
  const rules = { ...existing, [GLOB]: rule };
  // Next.js sets TURBOPACK before it reads the config, under `next dev --turbopack` and wherever Turbopack
  // is the default, as it is from 16.0. The rule only matters on the dev server, so a build never gets it.
  if (install && !byEntry && process.env.TURBOPACK && process.env.NODE_ENV !== 'production' && existing[DEV_ENTRY_GLOB] == null) {
    rules[DEV_ENTRY_GLOB] = devEntryRule(found);
  }

  const webpack = (config, context) => {
    if (!context.isServer) {
      config.module.rules.push({
        test: /\.[jt]sx$/,
        exclude: /node_modules/,
        enforce: 'pre',
        use: [{ loader: LOADER }],
      });
      // webpack runs a module when it is first required, so the install, first in the entry, runs before
      // the entry's next module loads react-dom. From 15.3 only the Pages Router's dev entry needs it.
      if (byEntry && install) config.entry = installFirst(config.entry);
      else if (install && context.dev) config.entry = installFirst(config.entry, PAGES_ENTRIES);
    }
    return typeof nextConfig.webpack === 'function' ? nextConfig.webpack(config, context) : config;
  };

  // Before 15.3 Next.js has no top-level `turbopack` key and warns about it, and builds with webpack only.
  const withLoader = byEntry ? { ...nextConfig, webpack } : { ...nextConfig, turbopack: { ...(nextConfig.turbopack || {}), rules }, webpack };
  if (!install) return withLoader;
  const withSettings = { ...withLoader, env: { ...nextConfig.env, [CLIENT_SETTINGS]: JSON.stringify({ install, basePath: nextConfig.basePath || '' }) } };
  // Below 16.3 the line in instrumentation-client installs the library (before 15.3, webpack's entries do).
  // Kept after an upgrade, it still does, and a second copy from instrumentationClientInject would hear
  // every navigation twice.
  if (!atLeast(found, NEXT_INJECT) || clientLine) return withSettings;
  return {
    ...withSettings,
    // Appended, as Next.js's docs have wrappers do: injected modules run in array order.
    instrumentationClientInject: [...(nextConfig.instrumentationClientInject || []), CLIENT_MODULE],
  };
}

module.exports = { withInpBlame };
