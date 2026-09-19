// next.config wrapper, the same shape as Sentry's withSentryConfig. In the runs `enabled` covers it adds:
// - `react-inp-blame/next-client` to `instrumentationClientInject` (Next.js 16.3 and later), which
//   Next.js imports on the client before instrumentation-client and before hydration. It installs the
//   library ahead of react-dom, and hears App Router navigations through `onRouterTransitionStart`;
// - the displayName loader, so component names survive the production minifier, under Turbopack (the
//   Next 16 default, where a `webpack()` hook never runs) and under `next build --webpack` alike.
//
//   // next.config.ts
//   import { withInpBlame } from 'react-inp-blame/next';
//   export default withInpBlame({ /* your config */ }, { enabled: true, runtime: { overlay: 'query' } });

const LOADER = require.resolve('./display-names-loader.cjs');
const GLOB = '*.{tsx,jsx}';
const CLIENT_MODULE = 'react-inp-blame/next-client';
// Read by next-client: Next.js inlines each `env` entry into the client as `process.env.<key>`.
const CLIENT_SETTINGS = 'REACT_INP_BLAME_NEXT';
// The oldest Next.js with `instrumentationClientInject`, the top-level config key the runtime is added
// to (16.3.0, PR #93785). Checked here rather than as a peer range, so that installing the package
// never fails resolution: a prerelease of a later version passes this and a semver range refuses it.
const NEXT_FLOOR = { major: 16, minor: 3 };
// This wrapper's own option names. Next.js has neither as a config key, so one of them in the first
// argument is the options object passed where the config goes: Next.js drops it with "Unrecognized
// key(s) in object", nothing installs, and the library looks broken. Caught here instead.
const OPTION_KEYS = ['enabled', 'runtime'];
// install()'s own options, which belong under `runtime`. Listed so that `{ overlay: true }` at the top
// level, which this wrapper would otherwise ignore into silence, is named for what it is.
const INSTALL_KEYS = ['overlay', 'threshold', 'labels', 'hook', 'sampleRate', 'walkBudget', 'inputWindow', 'devtoolsTrack', 'debugGlobal'];

/**
 * The Next.js the project has, read from its own node_modules. Null when there is none to read or the
 * version does not parse, in which case the floor is not enforced: a vendored or bundled copy of
 * Next.js is not this wrapper's to refuse.
 */
function projectNextVersion() {
  try {
    const { version } = require(require.resolve('next/package.json', { paths: [process.cwd()] }));
    const [major, minor] = String(version).split('.').map((part) => parseInt(part, 10));
    return Number.isNaN(major) || Number.isNaN(minor) ? null : { major, minor, version };
  } catch {
    return null;
  }
}

/** Throws when the project's Next.js is older than the config key this wrapper writes. */
function checkNextVersion() {
  const found = projectNextVersion();
  if (!found || found.major > NEXT_FLOOR.major || (found.major === NEXT_FLOOR.major && found.minor >= NEXT_FLOOR.minor)) return;
  throw new Error(
    `withInpBlame needs Next.js ${NEXT_FLOOR.major}.${NEXT_FLOOR.minor} or later, which is where instrumentationClientInject arrived, and this project has ${found.version}. ` +
      "Upgrade Next.js, or install the library from the app itself with `import 'react-inp-blame/auto'` as the first import of instrumentation-client.ts.",
  );
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

function turbopackRule() {
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
  checkNotTheOptions(nextConfig);
  checkOptionKeys(options);
  const { enabled = 'development', runtime = true } = options;
  const install = installOptions(runtime);
  // Off means the config comes back as it went in, so the build carries nothing from here.
  if (!isEnabled(enabled, process.env.NODE_ENV)) return nextConfig;
  checkNextVersion();
  // A config written as a function of the phase, the other form Next.js documents. It is called at
  // config time, so the wrapper goes around what it returns rather than around the function.
  if (typeof nextConfig === 'function') return async (phase, context) => withInpBlame(await nextConfig(phase, context), options);

  const existing = (nextConfig.turbopack && nextConfig.turbopack.rules) || {};
  const prior = existing[GLOB];
  const rules = {
    ...existing,
    [GLOB]: prior == null ? turbopackRule() : [...(Array.isArray(prior) ? prior : [prior]), turbopackRule()],
  };

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
  return {
    ...withLoader,
    // Appended, as Next.js's docs have wrappers do: injected modules run in array order.
    instrumentationClientInject: [...(nextConfig.instrumentationClientInject || []), CLIENT_MODULE],
    env: { ...nextConfig.env, [CLIENT_SETTINGS]: JSON.stringify({ install, basePath: nextConfig.basePath || '' }) },
  };
}

module.exports = { withInpBlame };
