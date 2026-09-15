// The source imports its own modules by the names they are published under (`./hook.js`), which
// is what Node needs from the built package. The unit tests run that source as it is, so a relative
// `.js` import from a `.ts` file resolves to the `.ts` file beside it. Loaded with `--import`.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromTypeScript = context.parentURL !== undefined && new URL(context.parentURL).pathname.endsWith('.ts');
    if (fromTypeScript && specifier.startsWith('.') && specifier.endsWith('.js')) {
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // A real .js file, then.
      }
    }
    return nextResolve(specifier, context);
  },
});
