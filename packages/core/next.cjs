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

function withInpBlame(nextConfig = {}, { enabled = 'development', runtime = true } = {}) {
  const install = installOptions(runtime);
  // Off means the config comes back as it went in, so the build carries nothing from here.
  if (!isEnabled(enabled, process.env.NODE_ENV)) return nextConfig;

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
