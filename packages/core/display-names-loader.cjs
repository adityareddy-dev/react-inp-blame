// Webpack-style loader that stamps `displayName` on React components so their names survive
// minification. Minifiers rename identifiers but never string literals, so appending
// `Foo.displayName = "Foo"` keeps the name in a production build. Works under Turbopack
// (next.config `turbopack.rules`) and webpack (`module.rules`); it needs nothing beyond the
// source string, so no bundler-specific API is touched.
//
// It runs on the untranspiled .tsx/.jsx source, ahead of the TypeScript/JSX transform, so the
// patterns are deliberately plain: top-level `function Foo(`, `export default function Foo(`,
// and `const Foo = memo(` / `forwardRef(`. Anything more exotic is a job for a real parser.

const FUNCTION = /^(?:export\s+(?:default\s+)?)?function\s+([A-Z]\w*)\s*\(/gm;
const WRAPPED = /^(?:export\s+)?const\s+([A-Z]\w*)\s*=\s*(?:\/\*[^*]*\*\/\s*)*(?:React\.)?(?:memo|forwardRef)\(/gm;

function componentNames(code) {
  const names = new Set();
  for (const m of code.matchAll(FUNCTION)) names.add(m[1]);
  for (const m of code.matchAll(WRAPPED)) names.add(m[1]);
  return [...names];
}

/** Returns the source with a displayName assignment per component, or the source untouched. */
function stamp(code) {
  const names = componentNames(code);
  if (!names.length) return code;
  const tail = names.map((n) => `\ntry { ${n}.displayName = ${JSON.stringify(n)}; } catch (e) {}`).join('');
  return code + tail;
}

function loader(source) {
  const file = (this && this.resourcePath) || '';
  if (file.includes('node_modules')) return source;
  const code = typeof source === 'string' ? source : String(source);
  if (process.env.INP_DEBUG_NAMES) {
    console.log('[display-names]', file.split('/').pop(), componentNames(code).join(', ') || '(none)');
  }
  return stamp(code);
}

module.exports = loader;
module.exports.stamp = stamp;
module.exports.componentNames = componentNames;
