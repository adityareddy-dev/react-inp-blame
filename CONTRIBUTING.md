# Contributing

This is a small project with one maintainer. For anything bigger than a fix, open an issue first so
we can agree on the approach before you spend time on it.

## Layout

- `packages/core`: the library, the `react-inp-blame` package. Source in `src`, unit tests in `test`.
- `apps/demo`: a Vite app with a sign-in flow and six slow scenarios, checked by the Playwright specs in
  `apps/demo/e2e`.
- `apps/next-demo`: the Next.js check, `e2e/load-order.spec.ts`, run under `next dev` and two
  production builds.
- `scripts/react-matrix.mjs`: generates the React 18 and 17 copies of the demo.
- `docs/`: the design notes (`interaction-attribution-design.md`) and the plan (`road-to-acceptance.md`).

## Setup

You need Node 22.18 or later, because the unit tests run TypeScript through Node's own type
stripping (CI uses Node 22 and 24), and npm.

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
    npm run test:unit                             # node --test on packages/core/test
    npm test                                      # Vite demo on the dev server
    npm run test:prod                             # Vite demo, production build
    npm test -w apps/next-demo                    # Next.js, next dev
    npm run test:prod -w apps/next-demo           # Next.js, Turbopack production build
    npm run test:prod:webpack -w apps/next-demo   # Next.js, webpack production build

The Vite demo runs every spec in Chromium, and `cross-browser.spec.ts` in Firefox and WebKit as well.
It imports the library's source, so it needs no build. The Next.js app uses the package as built, so
run `npm run build` before its suites.

The React matrix runs the demo's attribution spec against React 18.3.1 and React 17.0.2 (legacy root):

    node scripts/react-matrix.mjs
    npm install
    npm test -w apps/demo-react18
    npm test -w apps/demo-react17

`apps/demo-react18` and `apps/demo-react17` are generated and gitignored. Change `apps/demo` and run
the script again rather than editing them. The `npm install` links the new workspaces; it should not
change `package-lock.json`.

Run the suites one at a time. Each starts its server on a fixed port (the demo on 5177 and 5178, the
React 18 copy on 5187 and 5188, the React 17 copy on 5195 and 5196, Next.js on 5199, 5198 and 5197),
and outside CI a server already listening on that port is reused. A server left over from another suite
would be tested in place of the right one, so stop it before the next suite starts.

Two things the demo's suite leaves out of a normal run:

    INP_KEEP_TRACE=1 npm test           # keeps the Chrome trace in apps/demo/traces, to open in the Performance panel
    INP_TOUR=1 npx playwright test --headed -w apps/demo   # the headed walkthrough in apps/demo/tour

## What a pull request needs

- `npm run build`, `npm run test:unit` and the Playwright suites the change can affect pass locally.
  CI runs all of them on every push and pull request and once a day, plus a job against
  `next@canary` that is allowed to fail.
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

`npm run fix-lock` is only for installs behind a private npm mirror: it rewrites the mirror's tarball
URLs in `package-lock.json` back to registry.npmjs.org.

## Security

Report vulnerabilities by email, as [SECURITY.md](SECURITY.md) describes, not in an issue.

## License

Contributions are accepted under the project's [MIT License](LICENSE).
