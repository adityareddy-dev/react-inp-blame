import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['react-inp-blame'],
  turbopack: {
    rules: {
      // Keep component names in production: the loader appends `Foo.displayName = "Foo"` to
      // every component file on the client side, so the minifier can rename the function and
      // the report still says "Sidebar". Restricted to app code; node_modules is left alone.
      '*.{tsx,jsx}': {
        condition: { all: ['browser', { not: 'foreign' }] },
        loaders: ['react-inp-blame/display-names-loader'],
      },
    },
  },
};

export default nextConfig;
