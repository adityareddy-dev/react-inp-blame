# Contributing

This is a small project with one maintainer. For anything bigger than a fix, open an issue first so
we can agree on the approach before you spend time on it.

## Layout

- `packages/core`: the library, the `react-inp-blame` package. Source in `src`, unit tests in `test`.
- `apps/demo`: a Vite app with a sign-in flow, eight slow scenarios and a control, checked by the
  Playwright specs in `apps/demo/e2e`.
- `apps/next-demo`: the Next.js checks in `e2e/` (load order, hydration, `useReportWebVitals`, a Pages
  Router page), run
  under `next dev` and two production builds.
- `scripts/react-matrix.mjs`: generates the copies of the demo pinned to React 19.2, 19.1, 18.3, 18.2
  and 17.
- `scripts/pack-smoke.mjs`: installs the packed tarball into throwaway apps and checks it there.
- `fixtures/vite-react-ts`: the app `npm create vite` makes, with the README's Vite config and one slow
  component. `scripts/vite-app.mjs` installs the packed tarball into a copy of it and runs its specs.
- `fixtures/react-router` and `fixtures/tanstack-start`: the apps `npx create-react-router@8.4.0` and
  `npx @tanstack/cli@0.71.0 create --framework React --blank` make, each with its README setup and the
  same slow component, run by the same script with `--fixture`. `fixtures/react-router-7` is
  `npx create-react-router@7.18.4` moved to React 18.3, with a route that imports react-dom.
  `fixtures/remix` is `npx create-remix@2.17.5`'s template, on its React 18.3 and without its ESLint
  setup. `fixtures/astro` is Astro's minimal template, as `npm create astro@5.2.4 -- --template
  minimal` makes it from astro@7.3.5, after `npx astro add react`, with the slow component in one of
  two islands. `fixtures/vite-vendor-chunk` is `fixtures/vite-react-ts` on Vite 7.3, plugin-react 5 and
  React 18.3, with a `manualChunks` function sending all of `node_modules` to one vendor chunk.
  `fixtures/vite-vendor-groups` is the same app on Vite 8.3, plugin-react 6 and React 18.3, with a
  `codeSplitting` group sending all of `node_modules` to one vendor chunk and Radix's Portal, which
  imports react-dom, in the page.
  `fixtures/component-libraries` is `fixtures/vite-react-ts` with styled-components, @emotion/styled,
  lucide-react and Radix's DropdownMenu, each in the case where its own components used to be what a
  report named.
- `docs/`: the design notes (`interaction-attribution-design.md`).

## Setup

You need Node 22.18 or later, because the unit tests run TypeScript through Node's own type
stripping (CI runs them on Node 22 and 24), and npm.

    npm ci
    npx playwright install chromium firefox webkit

On Linux, add `--with-deps` to the second command so Playwright also installs the system libraries
the browsers need.

### Windows

The npm scripts assume a POSIX shell: several set an environment variable in front of the command,
such as `INP_MODE=prod playwright test`, which cmd.exe cannot run. Tell npm to run scripts with Git
Bash, for the current shell:

    # Git Bash
    export npm_config_script_shell="C:/Program Files/Git/bin/bash.exe"

    # PowerShell
    $env:npm_config_script_shell = 'C:/Program Files/Git/bin/bash.exe'

or for every shell with `npm config set script-shell "C:/Program Files/Git/bin/bash.exe"`.

## Running the checks

From the repository root:

    npm run build                                 # packages/core, with tsc
    npm run typecheck                             # the library, the Vite demo, its specs and the walkthrough
    npm run test:unit                             # node --test on packages/core/test
    npm test                                      # Vite demo on the dev server
    npm run test:prod                             # Vite demo, production build
    npm test -w apps/next-demo                    # Next.js, next dev
    npm run test:prod -w apps/next-demo           # Next.js, Turbopack production build
    npm run test:prod:webpack -w apps/next-demo   # Next.js, webpack production build
    npm run test:pack                             # the packed tarball, installed into throwaway apps
    npm run test:vite-app                         # a create-vite app with @vitejs/plugin-react, from the packed tarball

The Vite demo runs its specs in Chromium, and `cross-browser.spec.ts` in Firefox and WebKit as well.
It imports the library's source, so it needs no build. The Next.js app uses the package as built, so
run `npm run build` before its suites.

The one spec desktop Chromium leaves out is `phone.spec.ts`, which taps where the others click, on two
emulated phones with touch screens: a Pixel 7 in Chromium with the CPU slowed four times, and an
iPhone 15 in WebKit. `npm test` and `npm run test:prod` include it. To run only the phones, from
`apps/demo`:

    npx playwright test --project=android-dev --project=iphone-dev
    INP_MODE=prod npx playwright test --project=android-prod --project=iphone-prod

The React matrix runs the demo's attribution and input-delay specs against React 19.2.8, 19.1.9, 18.3.1,
18.2.0 and 17.0.2 (legacy root), on the dev server and a production build:

    node scripts/react-matrix.mjs
    npm install
    npm test -w apps/demo-react192            # or demo-react191, demo-react190, demo-react18, demo-react182, demo-react17
    npm run test:prod -w apps/demo-react192   # the same, production build

The `apps/demo-react*` folders are generated and gitignored. Change `apps/demo` and run
the script again rather than editing them. The `npm install` links the new workspaces; it should not
change `package-lock.json`.

Run the suites one at a time. Each starts its server on a fixed port (the demo on 5177 and 5178, the
create-vite fixture on 5179 and 5180, the React Router ones on 5181 and 5182 (8) and 5185 and 5186 (7),
the TanStack Start one on 5183 and 5184, the React matrix copies on two ports each from 5187 to 5196,
Next.js on 5199, 5198 and 5197, the Astro one on 5200 and 5201, the Remix one on 5202 and 5203, the vendor-chunk one on 5204 and 5205, the vendor-groups one on 5214 and 5215), and outside CI a server already listening on that port is reused. A
server left over from another suite would be tested in place of the right one, so stop it before the
next suite starts. The fixtures never reuse one, so a server still on one of their ports fails
their run.

`npm run test:pack` and `npm run test:vite-app` are the two checks that see the package as npm publishes
it; the other suites above reach it through the workspace link. `test:pack` packs `packages/core` and
installs the tarball, with one `npm install` each, into throwaway apps in the temp directory: one with no
peers, one with Next.js 15, one with the Next.js that `apps/next-demo` pins, one with Vite 5 and one with
TypeScript 5. In each it checks that every file `package.json` points at is in the package, imports and
requires every subpath, each of which has to give the names the READMEs document and no others, and
loads the browser entries again under the `react-server` condition. In the Next.js 15 app the wrapper
has to leave out `instrumentationClientInject` and print the `instrumentation-client` line, the Vite
app has to give a production build whose page installs the library, and in the TypeScript app a module
importing every subpath has to type-check under `moduleResolution` `node10`, `node16`, `nodenext`
and `bundler`. It needs the npm registry and no
port. Name fixtures to run only those; `next-canary` runs only when named, because a canary is allowed
to break. `--tarball` checks a tarball
that already exists, which is how CI runs the script on Node 20.19, the oldest Node the package supports:

    npm run test:pack -- bare next-15
    node scripts/pack-smoke.mjs --tarball path/to/react-inp-blame-<version>.tgz

An app that fails a check is left in place, and its path is printed.

To repeat CI's Node 20.19 run without installing that Node, pack a tarball and hand it to the script
under the `node` package from npm:

    npm pack -w packages/core --pack-destination <dir>
    npx -y node@20.19.0 scripts/pack-smoke.mjs --tarball <dir>/react-inp-blame-<version>.tgz

On Windows, run the second command with npm's default script shell rather than Git Bash: the POSIX
launcher of that package points at a placeholder file there, and only its `.cmd` one finds `node.exe`.

`npm run test:vite-app` starts where a user starts. `fixtures/vite-react-ts` is what
`npm create vite@9.2.1 -- --template react-ts` makes, with one slow component added and the README's Vite
config as its `vite.config.ts`. The script copies it into the temp directory, where nothing resolves
through this repo. There it installs the locked dependencies, with the packed tarball in place of the
registry's react-inp-blame, and builds the app. Its specs then check the blame on the dev server (a Fast
Refresh edit included) and on `vite preview` of the build. `--fresh` drops the lockfile first, so every
dependency comes as npm resolves it that day within the ranges in its `package.json`, which never takes a
new major. CI runs it that way too, in a job of its own that fails the daily run when it breaks but never
a push or a pull request. `--pnpm` installs the app with the pnpm on your `PATH` instead, into the
isolated `node_modules` pnpm makes by default, from the same locked versions through `pnpm import`, and
checks that the app's `node_modules` holds only what its `package.json` names. CI runs it that way in a job
of its own, for this app and for `--fixture next-14`, on the pnpm version the workflow pins. `--tarball`
works as it does for `test:pack`, and anything after `--` goes to Playwright. Through npm that is a second
`--`, after npm's own, as in the last line below. A failed run leaves the copy in place and prints its path.

    npm run test:vite-app -- --fresh
    npm run test:vite-app -- --pnpm
    node scripts/vite-app.mjs -- --project=dev
    npm run test:vite-app -- -- --project=dev

The fixture's `vite.config.ts` is the README's "Install with Vite" block, and the script fails until the
two match, so a change to one is a change to both. Its `@playwright/test` pin follows `apps/demo`'s. After
changing its `package.json`, refresh its lock with `npm install --package-lock-only` in that folder.

`--fixture react-router`, `--fixture react-router-7`, `--fixture remix`, `--fixture tanstack-start` and
`--fixture astro` run the same steps on the other apps, with no Fast Refresh edit, and their setup files are
held to the README's blocks the same way: `vite.config.ts` for all but Astro, `src/client.tsx` as well for
TanStack Start, and `astro.config.mjs` for Astro, whose type check is `astro check`. The React Router and
Remix apps drop the template's Google Fonts links, since a font request that fails would fail their specs.

Two things the demo's suite leaves out of a normal run:

    INP_KEEP_TRACE=1 npm test           # keeps the Chrome trace in apps/demo/traces, to open in the Performance panel
    INP_TOUR=1 npx -w apps/demo playwright test --headed --project=tour   # the headed walkthrough in apps/demo/tour

## What a pull request needs

- `npm run build`, `npm run typecheck`, `npm run test:unit` and the Playwright suites the change can
  affect pass locally, and `npm run test:pack` when the change touches what is published:
  `packages/core/package.json` or a file it lists. CI runs all of them on every push and pull request
  and once a day, plus a job against `next@canary` that can fail only the daily run and one that runs the
  Next.js suites on 16.2, 15.5 and 15.3. To repeat that one:
  `npm install next@15.5.26 -w apps/next-demo`, put the line `withInpBlame` prints in
  `apps/next-demo/instrumentation-client.ts`, run `npm test` and `npm run test:prod` with
  `-w apps/next-demo`, on 15.x each again with `INP_BUNDLER=turbopack`, then delete that file and put
  the pin back with `git checkout apps/next-demo/package.json apps/next-demo/tsconfig.json
  package-lock.json` and `npm ci`. Next.js 15 rewrites the demo's `tsconfig.json` when it starts.
- A test for every change in behaviour. Tests assert on a report's data (`explanation.blame`, the
  phases, the commits), never on the wording of `verdict`, `cause` or `notes`: those are display text
  and may change in any version.
- Documentation that stays true. When a change makes a sentence in `README.md`,
  `packages/core/README.md` or `docs/interaction-attribution-design.md` untrue, change the sentence
  in the same pull request. The design doc records how each number was measured; keep it that way.
- No new dependencies in `packages/core`. The library has no runtime dependencies and runs before
  hydration on every page it is installed on, so it stays that way. Elsewhere, add a development
  dependency only when the change needs one and say why; otherwise `package-lock.json` does not
  change.
- The report is a contract. Adding a field to `InteractionReport` is fine; removing one, or changing
  what one means, needs a new `schemaVersion` and a line in the pull request saying so.

## Security

Report vulnerabilities by email, as [SECURITY.md](SECURITY.md) describes, not in an issue.

## License

Contributions are accepted under the project's [MIT License](LICENSE).
