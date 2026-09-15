// next.config wrapper. Adds the displayName loader so component names survive the production
// minifier, under Turbopack (the Next 16 default, where a `webpack()` hook never runs) and
// under `next build --webpack` alike. The runtime half is one import in
// instrumentation-client.ts, the same shape as Sentry's withSentryConfig + Sentry.init.
//
//   // next.config.ts
//   import { withInpBlame } from 'react-inp-blame/next';
//   export default withInpBlame({ /* your config */ }, { enabled: true });
//
//   // instrumentation-client.ts
//   import 'react-inp-blame/auto';

const LOADER = require.resolve('./display-names-loader.cjs');
const GLOB = '*.{tsx,jsx}';

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

function withInpBlame(nextConfig = {}, { enabled = 'development' } = {}) {
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

  return { ...nextConfig, turbopack: { ...(nextConfig.turbopack || {}), rules }, webpack };
}

module.exports = { withInpBlame };
