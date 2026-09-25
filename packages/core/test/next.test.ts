import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { withInpBlame } = require('../next.cjs');

const GLOB = '*.{tsx,jsx}';
const CLIENT_MODULE = 'react-inp-blame/next-client';
const EVERYTHING = { runtime: true, turbopack: true, webpack: true };
const NOTHING = { runtime: false, turbopack: false, webpack: false };

/** What withInpBlame returns under `next dev` or `next build`, which set NODE_ENV before Next reads the config. */
function wrapped(nodeEnv: 'development' | 'production', config: Record<string, any>, options?: { enabled?: unknown; runtime?: unknown }): Record<string, any> {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    return withInpBlame(config, options);
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

/** What a config adds to the app: the runtime module Next.js injects on the client, the loader's Turbopack rule, and the rule its webpack() adds to a browser build. */
function added(config: Record<string, any>): typeof EVERYTHING {
  const rules: unknown[] = [];
  if (typeof config.webpack === 'function') config.webpack({ module: { rules } }, { isServer: false });
  return {
    runtime: config.instrumentationClientInject?.includes(CLIENT_MODULE) ?? false,
    turbopack: config.turbopack?.rules?.[GLOB] !== undefined,
    webpack: rules.length > 0,
  };
}

/** What next-client reads, as Next.js inlines it from `env`. */
const clientSettings = (config: Record<string, any>) => JSON.parse(config.env.REACT_INP_BLAME_NEXT);

test('by default next dev gets the runtime and the loader, and next build gets the config back untouched', () => {
  const config = { reactStrictMode: true };
  assert.deepEqual(added(wrapped('development', config)), EVERYTHING);
  assert.equal(wrapped('production', config), config);
});

test("enabled: 'production' adds them to next build only, true to both runs, false to neither", () => {
  const runs = (enabled: unknown) => [added(wrapped('development', {}, { enabled })), added(wrapped('production', {}, { enabled }))];
  assert.deepEqual(runs('production'), [NOTHING, EVERYTHING]);
  assert.deepEqual(runs(true), [EVERYTHING, EVERYTHING]);
  assert.deepEqual(runs(false), [NOTHING, NOTHING]);
  assert.throws(() => wrapped('production', {}, { enabled: 'always' }), /enabled is 'development', 'production', true or false/);
});

test('the runtime installs with the options it is given, and runtime: false keeps only the loader', () => {
  assert.deepEqual(clientSettings(wrapped('development', {})), { install: {}, basePath: '' });
  const configured = wrapped('development', { basePath: '/docs' }, { runtime: { overlay: 'query', debugGlobal: true } });
  assert.deepEqual(clientSettings(configured), { install: { overlay: 'query', debugGlobal: true }, basePath: '/docs' });

  const loaderOnly = wrapped('development', {}, { runtime: false });
  assert.deepEqual(added(loaderOnly), { ...EVERYTHING, runtime: false });
  assert.equal(loaderOnly.env, undefined);
  assert.throws(() => wrapped('development', {}, { runtime: 'query' }), /runtime is true, false or the options for install\(\)/);
});

test("the project's own Turbopack rules, webpack(), injected modules and env are kept", () => {
  const svg = { loaders: ['svg-loader'] };
  const ran: string[] = [];
  const webpack = (config: unknown) => {
    ran.push('the project webpack()');
    return config;
  };
  const project = { turbopack: { rules: { '*.svg': svg, [GLOB]: svg } }, webpack, instrumentationClientInject: ['./lib/analytics.js'], env: { API_URL: 'https://api.example' } };
  const config = wrapped('production', project, { enabled: true });
  assert.equal(config.turbopack.rules['*.svg'], svg);
  assert.equal(config.turbopack.rules[GLOB].length, 2);
  assert.equal(config.turbopack.rules[GLOB][0], svg);
  assert.deepEqual(added(config), EVERYTHING);
  assert.deepEqual(ran, ['the project webpack()']);
  assert.deepEqual(config.instrumentationClientInject, ['./lib/analytics.js', CLIENT_MODULE]);
  assert.equal(config.env.API_URL, 'https://api.example');
});

test('the options passed where the config goes are refused, and the message names the two-argument call', () => {
  assert.throws(
    () => wrapped('development', { runtime: { overlay: true } }),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message.includes('`runtime` is an option of this wrapper, not a Next.js config key') &&
      error.message.includes('withInpBlame(nextConfig, { runtime: { overlay: true } })'),
  );
  assert.throws(() => wrapped('production', { enabled: true }), /`enabled` is an option of this wrapper.*withInpBlame\(nextConfig, \{ enabled: true \}\)/s);
  // Two keys, and the example is the caller's own values rather than an invented pair.
  assert.throws(
    () => wrapped('development', { enabled: 'production', runtime: false }),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message.includes('`enabled` and `runtime` are options of this wrapper, not Next.js config keys') &&
      error.message.includes('withInpBlame(nextConfig, { enabled: "production", runtime: false })'),
  );
  // Refused whichever run it is, including the ones `enabled` would leave out: the call is wrong either way.
  assert.throws(() => wrapped('production', { runtime: true }, { enabled: false }), /not a Next\.js config key/);
  // A config that has neither key is a config, and a function config is never the options object.
  assert.deepEqual(added(wrapped('development', { reactStrictMode: true })), EVERYTHING);
});

test('an option this wrapper does not have is refused, and an install() option is sent under runtime', () => {
  assert.throws(
    () => wrapped('development', {}, { overlay: true } as never),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message.includes("`overlay` is not one of this wrapper's options, which are `enabled` and `runtime`") &&
      error.message.includes('withInpBlame(nextConfig, { runtime: { overlay: true } })'),
  );
  // The value is the caller's, whatever shape it has.
  assert.throws(() => wrapped('development', {}, { debugGlobal: '__inp' } as never), /withInpBlame\(nextConfig, \{ runtime: \{ debugGlobal: "__inp" \} \}\)/);
  // A key that is nobody's option gets the list and nothing more, since there is nowhere to send it.
  assert.throws(() => wrapped('development', {}, { enable: true } as never), (error: unknown) => error instanceof TypeError && !error.message.includes('install()'));
  // Refused before `enabled` can leave the run out, so a typo cannot hide until someone builds for production.
  assert.throws(() => wrapped('production', {}, { overlay: true } as never), /not one of this wrapper's options/);
});

test('a function config that returns the options where the config goes is refused too', async () => {
  await assert.rejects(
    () => wrappedFunction('development', () => ({ runtime: true }), 'phase-development-server', {}),
    /`runtime` is an option of this wrapper/,
  );
});

/** What withInpBlame returns for a config written as a function: Next.js calls it with the phase while NODE_ENV is still set. */
async function wrappedFunction(
  nodeEnv: 'development' | 'production',
  config: unknown,
  phase: string,
  defaultConfig: Record<string, unknown>,
  options?: { enabled?: unknown; runtime?: unknown },
): Promise<Record<string, any>> {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    const wrapper = withInpBlame(config, options);
    assert.equal(typeof wrapper, 'function', 'a config written as a function comes back as a function');
    return await wrapper(phase, { defaultConfig });
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

/** A directory shaped like a project with this Next.js in its node_modules, which is where withInpBlame reads the version. */
function projectWithNext(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inp-next-'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'next'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'next', 'package.json'), JSON.stringify({ name: 'next', version }));
  return dir;
}

/** Runs `fn` from `dir`, the working directory Next.js reads a config in. */
function inProject<T>(dir: string, fn: () => T): T {
  const saved = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(saved);
  }
}

test('a config written as a function is wrapped around what it returns, and keeps every setting', async () => {
  const project = (phase: string, { defaultConfig }: { defaultConfig: Record<string, unknown> }) => ({
    basePath: '/shop',
    output: 'standalone',
    images: { unoptimized: true },
    phaseSeen: phase,
    defaultSeen: defaultConfig,
  });
  const config = await wrappedFunction('development', project, 'phase-development-server', { reactStrictMode: true });

  assert.deepEqual(added(config), EVERYTHING);
  assert.equal(config.basePath, '/shop');
  assert.equal(config.output, 'standalone');
  assert.deepEqual(config.images, { unoptimized: true });
  // Next.js's own two arguments reach the project's function unchanged.
  assert.equal(config.phaseSeen, 'phase-development-server');
  assert.deepEqual(config.defaultSeen, { reactStrictMode: true });
  // And basePath still reaches the client module, which the App Router leaves out of the URLs it announces.
  assert.deepEqual(clientSettings(config), { install: {}, basePath: '/shop' });
});

test('an async function config is awaited', async () => {
  const config = await wrappedFunction('production', async () => ({ basePath: '/docs' }), 'phase-production-build', {}, { enabled: true });
  assert.deepEqual(added(config), EVERYTHING);
  assert.equal(config.basePath, '/docs');
});

const CLIENT_LINE = `export { onRouterTransitionStart } from '${CLIENT_MODULE}';`;

/** Drops the marks that keep each warning to one print per `next dev`, so a test sees its own. */
function forgetWarnings(): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('REACT_INP_BLAME_WARNED_')) delete process.env[key];
}

/** A project on `version` whose instrumentation-client, at `file` under it, holds `source`. */
function projectWithClientFile(version: string, file: string, source: string): string {
  const dir = projectWithNext(version);
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), source);
  return dir;
}

test('below instrumentationClientInject the loader and the options still go in, and the line for instrumentation-client is printed once', (t) => {
  const v162 = projectWithNext('16.2.12');
  const v155 = projectWithNext('15.5.26');
  t.after(() => {
    for (const dir of [v162, v155]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const warn = t.mock.method(console, 'warn', () => {});
  forgetWarnings();

  const config = inProject(v162, () => wrapped('development', {}, { runtime: { overlay: true } }));
  assert.deepEqual(added(config), { runtime: false, turbopack: true, webpack: true });
  assert.deepEqual(config.turbopack.rules[GLOB].condition, { all: ['browser', { not: 'foreign' }] });
  // The line re-exports next-client, which reads these as it does when Next.js injects it.
  assert.deepEqual(clientSettings(config), { install: { overlay: true }, basePath: '' });
  assert.equal(warn.mock.callCount(), 1);
  const message = String(warn.mock.calls[0].arguments[0]);
  assert.ok(message.includes('16.2.12') && message.includes(CLIENT_LINE), message);
  // Next.js reads the config more than once in a run, and the warning is worth one print.
  inProject(v162, () => wrapped('development', {}));
  assert.equal(warn.mock.callCount(), 1);

  // Before 16.0 a Turbopack rule has no `condition`: the same limits are builtin conditions as keys,
  // the first that matches deciding, so foreign code is turned away before the browser build is let in.
  forgetWarnings();
  const older = inProject(v155, () => wrapped('development', {}));
  assert.deepEqual(added(older), { runtime: false, turbopack: true, webpack: true });
  const rule = older.turbopack.rules[GLOB];
  assert.deepEqual(Object.keys(rule), ['foreign', 'browser']);
  assert.equal(rule.foreign, false);
  assert.deepEqual(Object.keys(rule.browser), ['loaders']);
  assert.match(rule.browser.loaders[0], /display-names-loader\.cjs$/);
  assert.ok(String(warn.mock.calls[1].arguments[0]).includes('15.5.26'));
  forgetWarnings();
});

test("on Next.js 15 the project's rules under experimental.turbo are kept, and a rule of its own on the loader's glob is left alone with a warning", (t) => {
  const v155 = projectWithNext('15.5.26');
  t.after(() => fs.rmSync(v155, { recursive: true, force: true }));
  const warn = t.mock.method(console, 'warn', () => {});
  forgetWarnings();
  const svg = { loaders: ['svg-loader'], as: '*.js' };
  const md = ['md-loader'];

  // Next.js 15 reads these under the rules in `turbopack`, which replace them as a whole.
  const legacy = inProject(v155, () => wrapped('development', { experimental: { turbo: { rules: { '*.svg': svg } } }, turbopack: { rules: { '*.md': md } } }));
  assert.equal(legacy.turbopack.rules['*.svg'], svg);
  assert.equal(legacy.turbopack.rules['*.md'], md);
  assert.deepEqual(Object.keys(legacy.turbopack.rules[GLOB]), ['foreign', 'browser']);
  assert.equal(legacy.experimental.turbo.rules['*.svg'], svg);

  // Older still, loaders keyed by extension, which Next.js 15 turns into rules when there are none.
  const svgLoaders = ['svg-loader'];
  const loaders = inProject(v155, () => wrapped('development', { experimental: { turbo: { loaders: { '.svg': svgLoaders } } } }));
  assert.equal(loaders.turbopack.rules['*.svg'], svgLoaders);
  const both = inProject(v155, () =>
    wrapped('development', { experimental: { turbo: { rules: { '*.md': md }, loaders: { '.svg': svgLoaders } } } }),
  );
  assert.deepEqual(Object.keys(both.turbopack.rules), ['*.md', GLOB]);

  // A glob holds one rule before 16.0, and a list of them fails Next.js's config check.
  forgetWarnings();
  const own = { loaders: ['own-loader'] };
  const config = inProject(v155, () => wrapped('development', { turbopack: { rules: { [GLOB]: own } } }));
  assert.equal(config.turbopack.rules[GLOB], own);
  assert.deepEqual(added(config), { runtime: false, turbopack: true, webpack: true });
  const told = warn.mock.calls.map((call) => String(call.arguments[0])).filter((message) => message.includes(GLOB));
  assert.equal(told.length, 1);
  assert.ok(told[0].includes('15.5.26') && told[0].includes('webpack'), told[0]);
  forgetWarnings();
});

test('the line in instrumentation-client quiets the warning, and from 16.3 on it stands in for the injected module', (t) => {
  const withLine = projectWithClientFile('16.2.12', 'instrumentation-client.ts', `${CLIENT_LINE}\n`);
  const inSrc = projectWithClientFile('15.3.9', 'src/instrumentation-client.js', `import './analytics';\n${CLIENT_LINE}\n`);
  const upgraded = projectWithClientFile('16.3.6', 'instrumentation-client.ts', `${CLIENT_LINE}\n`);
  const other = projectWithClientFile('16.3.6', 'instrumentation-client.ts', "import './analytics';\n");
  // Sentry's setup has the file export an onRouterTransitionStart of its own, which then calls next-client's.
  const named = projectWithClientFile(
    '16.2.12',
    'instrumentation-client.ts',
    `import * as Sentry from '@sentry/nextjs'\nimport {\n  onRouterTransitionStart as inpBlame,\n} from '${CLIENT_MODULE}'\nexport const onRouterTransitionStart = (url, type) => { inpBlame(url, type); Sentry.captureRouterTransitionStart(url, type) }\n`,
  );
  t.after(() => {
    for (const dir of [withLine, inSrc, upgraded, other, named]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const warn = t.mock.method(console, 'warn', () => {});
  forgetWarnings();

  assert.deepEqual(added(inProject(withLine, () => wrapped('development', {}))), { runtime: false, turbopack: true, webpack: true });
  assert.deepEqual(added(inProject(inSrc, () => wrapped('development', {}))), { runtime: false, turbopack: true, webpack: true });
  assert.deepEqual(added(inProject(named, () => wrapped('development', {}))), { runtime: false, turbopack: true, webpack: true });
  assert.equal(warn.mock.callCount(), 0);

  // Kept after an upgrade, the line already installs the library, and injecting a second copy would
  // announce every navigation twice.
  const kept = inProject(upgraded, () => wrapped('development', {}, { runtime: { overlay: 'query' } }));
  assert.deepEqual(added(kept), { runtime: false, turbopack: true, webpack: true });
  assert.deepEqual(clientSettings(kept), { install: { overlay: 'query' }, basePath: '' });
  assert.deepEqual(added(inProject(other, () => wrapped('development', {}))), EVERYTHING);
  assert.equal(warn.mock.callCount(), 0);
});

test('a commented-out line, a bare import of next-client and a file Next.js does not use are not the line', (t) => {
  const commented = projectWithClientFile('16.2.12', 'instrumentation-client.ts', `import './analytics'\n// ${CLIENT_LINE}\n/*\n${CLIENT_LINE}\n*/\n`);
  const bare = projectWithClientFile('16.3.6', 'instrumentation-client.ts', `import '${CLIENT_MODULE}';\n`);
  // Next.js takes src/instrumentation-client first, so a root one beside it is never loaded.
  const shadowed = projectWithClientFile('16.3.6', 'instrumentation-client.ts', `${CLIENT_LINE}\n`);
  fs.mkdirSync(path.join(shadowed, 'src'));
  fs.writeFileSync(path.join(shadowed, 'src', 'instrumentation-client.ts'), "import './analytics';\n");
  t.after(() => {
    for (const dir of [commented, bare, shadowed]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const warn = t.mock.method(console, 'warn', () => {});
  forgetWarnings();

  inProject(commented, () => wrapped('development', {}));
  assert.equal(warn.mock.callCount(), 1);
  // A bare import installs the library but exports no onRouterTransitionStart, so the injected module
  // is still what hears navigations.
  assert.deepEqual(added(inProject(bare, () => wrapped('development', {}))), EVERYTHING);
  assert.deepEqual(added(inProject(shadowed, () => wrapped('development', {}))), EVERYTHING);
  forgetWarnings();
});

test('the line is printed while Next.js imports a config written as a function, before it calls it', async (t) => {
  const v162 = projectWithNext('16.2.12');
  t.after(() => fs.rmSync(v162, { recursive: true, force: true }));
  const warn = t.mock.method(console, 'warn', () => {});
  forgetWarnings();
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    const wrapper = inProject(v162, () => withInpBlame(() => ({ basePath: '/shop' })));
    assert.equal(warn.mock.callCount(), 1);
    const config = await inProject(v162, () => wrapper('phase-development-server', { defaultConfig: {} }));
    assert.equal(clientSettings(config).basePath, '/shop');
    assert.equal(warn.mock.callCount(), 1);
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
    forgetWarnings();
  }
});

test('run from a monorepo root, the project is found through the next.config that called the wrapper', (t) => {
  const app = projectWithClientFile('15.5.26', 'instrumentation-client.ts', `${CLIENT_LINE}\n`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inp-root-'));
  t.after(() => {
    for (const dir of [app, root]) fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(app, 'next.config.cjs'), `module.exports = require(${JSON.stringify(require.resolve('../next.cjs'))}).withInpBlame({});\n`);
  const warn = t.mock.method(console, 'warn', () => {});
  forgetWarnings();
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    // `next dev apps/web` from the root: the working directory has neither Next.js nor the file.
    const config = inProject(root, () => require(path.join(app, 'next.config.cjs')));
    // Next.js 15.5, read from the app: the 15.x rule, nothing injected, and no warning, since the app's file has the line.
    assert.deepEqual(Object.keys(config.turbopack.rules[GLOB]), ['foreign', 'browser']);
    assert.deepEqual(added(config), { runtime: false, turbopack: true, webpack: true });
    assert.equal(warn.mock.callCount(), 0);
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
    forgetWarnings();
  }
});

test('a Next.js older than 14.2 gets its config back as it was, with a warning that names it', (t) => {
  const old = projectWithNext('14.1.4');
  const canary = projectWithNext('16.4.0-canary.31');
  t.after(() => {
    for (const dir of [old, canary]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const warn = t.mock.method(console, 'warn', () => {});
  forgetWarnings();

  const project = { reactStrictMode: true };
  assert.equal(inProject(old, () => wrapped('development', project)), project);
  assert.equal(warn.mock.callCount(), 1);
  const message = String(warn.mock.calls[0].arguments[0]);
  assert.ok(message.includes('14.1.4') && message.includes('14.2'), message);
  // A prerelease of a later version passes every floor. A peer range would have refused it at install time.
  assert.deepEqual(added(inProject(canary, () => wrapped('development', {}))), EVERYTHING);
  // enabled: false adds nothing to the config, so there is nothing to warn about.
  forgetWarnings();
  assert.equal(inProject(old, () => wrapped('development', project, { enabled: false })), project);
  assert.equal(warn.mock.callCount(), 1);
  forgetWarnings();
});

test('from 14.2 to 15.2 the install goes first in webpack\'s client entries, with the loader, no Turbopack key and no line to add', async (t) => {
  const next14 = projectWithNext('14.2.35');
  const next15 = projectWithNext('15.2.9');
  t.after(() => {
    for (const dir of [next14, next15]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const warn = t.mock.method(console, 'warn', () => {});
  forgetWarnings();
  for (const dir of [next14, next15]) {
    const config = inProject(dir, () => wrapped('development', { reactStrictMode: true }, { runtime: { overlay: 'query' } }));
    // 14.2 knows no top-level `turbopack` and warns about it; neither version builds with Turbopack.
    assert.equal('turbopack' in config, false);
    assert.equal('instrumentationClientInject' in config, false);
    assert.deepEqual(clientSettings(config).install, { overlay: 'query' });
    const client = { module: { rules: [] as unknown[] }, entry: async () => ({ 'main-app': ['./app-next.js'], main: { import: './main.js' }, 'pages/_app': ['./_app.js'] }) };
    config.webpack(client, { isServer: false });
    assert.equal(client.module.rules.length, 1);
    const entries = await (client.entry as () => Promise<Record<string, any>>)();
    assert.deepEqual(entries['main-app'], [CLIENT_MODULE, './app-next.js']);
    assert.deepEqual(entries.main.import, [CLIENT_MODULE, './main.js']);
    assert.deepEqual(entries['pages/_app'], ['./_app.js']);
    // Asked again, as Next.js does as pages are added, the install is not put in twice.
    const again = async () => ({ 'main-app': [CLIENT_MODULE, './app-next.js'] });
    const twice = { module: { rules: [] as unknown[] }, entry: again };
    config.webpack(twice, { isServer: false });
    assert.deepEqual((await (twice.entry as () => Promise<Record<string, any>>)())['main-app'], [CLIENT_MODULE, './app-next.js']);
    // The server build is left alone.
    const server = { module: { rules: [] as unknown[] }, entry: 'server' };
    config.webpack(server, { isServer: true });
    assert.equal(server.entry, 'server');
    // runtime: false keeps the loader and adds no install.
    const namesOnly = inProject(dir, () => wrapped('development', {}, { runtime: false }));
    const plain = { module: { rules: [] as unknown[] }, entry: 'as it was' };
    namesOnly.webpack(plain, { isServer: false });
    assert.equal(plain.entry, 'as it was');
    assert.equal(plain.module.rules.length, 1);
  }
  // No line for instrumentation-client, which these versions do not have.
  assert.equal(warn.mock.calls.filter((c) => String(c.arguments[0]).includes('instrumentation-client.ts')).length, 0);
  // Under Turbopack nothing can install, and the wrapper says so once.
  process.env.TURBOPACK = '1';
  try {
    inProject(next14, () => wrapped('development', {}));
    inProject(next14, () => wrapped('development', {}));
  } finally {
    delete process.env.TURBOPACK;
  }
  const turbo = warn.mock.calls.filter((c) => String(c.arguments[0]).includes('Turbopack'));
  assert.equal(turbo.length, 1);
  assert.match(String(turbo[0]!.arguments[0]), /14\.2\.35.*next dev without --turbo/);
  forgetWarnings();
});
