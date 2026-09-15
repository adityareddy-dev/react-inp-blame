/**
 * Wraps a Next.js config so component names survive the production minifier, under Turbopack
 * and webpack. Pair it with `import 'react-inp-blame/auto'` in instrumentation-client.ts.
 */
export function withInpBlame<T extends Record<string, any>>(nextConfig?: T): T;
