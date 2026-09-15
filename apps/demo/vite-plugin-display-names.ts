import type { Plugin } from 'vite';
import { stamp } from 'react-inp-blame/display-names-loader';

/**
 * Stamps `displayName` on React components so attribution survives minification.
 * Minifiers rename identifiers but never string literals, so `Foo.displayName = "Foo"`
 * keeps the name in production. The matching lives in the library's loader file, shared
 * with the Next.js (Turbopack/webpack) setup; this is the thin Vite wrapper around it.
 */
export function displayNames(): Plugin {
  return {
    name: 'react-inp-display-names',
    enforce: 'post',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!/\.(tsx|jsx)$/.test(file) || file.includes('node_modules')) return;
      const out = stamp(code);
      if (out === code) return;
      return { code: out, map: null };
    },
  };
}
