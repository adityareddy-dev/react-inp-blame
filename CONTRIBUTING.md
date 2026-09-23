# Contributing

This is a small project with one maintainer. For anything bigger than a fix, open an issue first so
we can agree on the approach before you spend time on it.

## Layout

- `packages/core`: the library, the `react-inp-blame` package. Source in `src`, unit tests in `test`.
- `apps/demo`: a Vite app with a sign-in flow, seven slow scenarios and a control, checked by the
  Playwright specs in `apps/demo/e2e`.
- `apps/next-demo`: the Next.js checks in `e2e/` (load order, hydration, `useReportWebVitals`), run
  under `next dev` and two production builds.
- `scripts/react-matrix.mjs`: generates the copies of the demo pinned to React 19.2, 19.1, 18.3, 18.2
  and 17.
- `scripts/pack-smoke.mjs`: installs the packed tarball into throwaway apps and checks it there.
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

The Vite demo runs every spec in Chromium, and `cross-browser.spec.ts` in Firefox and WebKit as well.
It imports the library's source, so it needs no build. The Next.js app uses the package as built, so
run `npm run build` before its suites.

The React matrix runs the demo's attribution and input-delay specs against React 19.2.8, 19.1.9, 18.3.1,
18.2.0 and 17.0.2 (legacy root), on the dev server and a production build:

    node scripts/react-matrix.mjs
    npm install
    npm test -w apps/demo-react192            # or demo-react191, demo-react18, demo-react182, demo-react17
    npm run test:prod -w apps/demo-react192   # the same, production build

The `apps/demo-react*` folders are generated and gitignored. Change `apps/demo` and run
the script again rather than editing them. The `npm install` links the new workspaces; it should not
change `package-lock.json`.

Run the suites one at a time. Each starts its server on a fixed port (the demo on 5177 and 5178, the
React matrix copies on two ports each from 5187 to 5196, Next.js on 5199, 5198 and 5197), and outside
CI a server already listening on that port is reused. A server left over from another suite would be
tested in place of the right one, so stop it before the next suite starts.

`npm run test:pack` is the one check that sees the package as npm publishes it; the suites above reach
it through the workspace link. It packs `packages/core` and installs the tarball, with one `npm install`
each, into throwaway apps in the temp directory: one with no peers, one with Next.js 15, one with the
Next.js that `apps/next-demo` pins and one with Vite 5. In each it checks that every file `package.json`
points at is in the package, imports and requires every subpath, and loads the browser entries again
under the `react-server` condition. The Next.js 15 app has to get the wrapper's version error rather
than a failed install, and the Vite app a production build whose page installs the library. It needs
the npm registry and no port. Name fixtures to run only those; `next-canary` runs only when named,
because a canary is allowed to break. `--tarball` checks a tarball that already exists, which is how CI
runs the script on Node 20.19, the oldest Node the package supports:

    npm run test:pack -- bare next-15
    node scripts/pack-smoke.mjs --tarball path/to/react-inp-blame-<version>.tgz

An app that fails a check is left in place, and its path is printed.

To repeat CI's Node 20.19 run without installing that Node, pack a tarball and hand it to the script
under the `node` package from npm:

    npm pack -w packages/core --pack-destination <dir>
    npx -y node@20.19.0 scripts/pack-smoke.mjs --tarball <dir>/react-inp-blame-<version>.tgz

On Windows, run the second command with npm's default script shell rather than Git Bash: the POSIX
launcher of that package points at a placeholder file there, and only its `.cmd` one finds `node.exe`.

Two things the demo's suite leaves out of a normal run:

    INP_KEEP_TRACE=1 npm test           # keeps the Chrome trace in apps/demo/traces, to open in the Performance panel
    INP_TOUR=1 npx -w apps/demo playwright test --headed --project=tour   # the headed walkthrough in apps/demo/tour

## What a pull request needs

- `npm run build`, `npm run typecheck`, `npm run test:unit` and the Playwright suites the change can
  affect pass locally, and `npm run test:pack` when the change touches what is published:
  `packages/core/package.json` or a file it lists. CI runs all of them on every push and pull request
  and once a day, plus a job against `next@canary` that is allowed to fail.
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
