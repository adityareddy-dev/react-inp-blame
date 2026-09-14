import type { Plugin } from 'vite';

/**
 * Stamps `displayName` on React components so attribution survives minification.
 * Minifiers rename identifiers but never string literals, so `Foo.displayName = "Foo"`
 * keeps the name in production. The same idea belongs in a Babel/SWC transform for
 * Next.js; this regex version is enough for the demo and proves the point.
 */
export function displayNames(): Plugin {
  return {
    name: 'react-inp-display-names',
    enforce: 'post',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!/\.(tsx|jsx)$/.test(file) || file.includes('node_modules')) return;
      const names = new Set<string>();
      for (const m of code.matchAll(/^(?:export\s+)?function\s+([A-Z]\w*)\s*\(/gm)) names.add(m[1]);
      for (const m of code.matchAll(/^(?:export\s+)?const\s+([A-Z]\w*)\s*=\s*(?:\/\*[^*]*\*\/\s*)*(?:React\.)?(?:memo|forwardRef)\(/gm)) names.add(m[1]);
      if (process.env.INP_DEBUG_NAMES) console.log('[display-names]', file.split('/').pop(), [...names].join(', ') || '(none)');
      if (!names.size) return;
      const tail = [...names].map((n) => `\ntry { ${n}.displayName = ${JSON.stringify(n)}; } catch (e) {}`).join('');
      return { code: code + tail, map: null };
    },
  };
}
