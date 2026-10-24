# Versions, browser support and the 1.x promise

The tables are in the [README](../README.md#versions). This page has the notes that go with them.

## Browser support notes

Without `interactionId` nothing installs and `stats().mode` is `'unsupported'`. One warning says why: always in
a development build, and in a production build on the pages `sampleRate` takes. A production page the sample
leaves out prints nothing, so a tool that forwards console warnings gets no event from it. Without Long
Animation Frames, `frames` and `laterFrames` are `null` and the explanation leaves out the forced-layout and
script sentences. On a page without cross-origin isolation, Playwright's Firefox 148 and WebKit 26.4 step
`performance.now()` in whole milliseconds, too coarse to time a quick component: when eight or more of a
commit's components are timed, every one reads a whole millisecond and they average under 4 ms, the report
leaves their times out and blame built on render times is `'inferred'`.


## Version notes

The peer dependencies are all `*` and optional, on purpose. npm refuses to install beside a prerelease that a
range leaves out, even for an optional peer, and `next@canary` or a React canary is a prerelease of a version no
range written today can name. So a real range would stop those installs with an ERESOLVE error, where the library
itself says what is wrong: the Next.js wrapper checks the version at build time, and `install()` checks each
react-dom as it registers.


## Under Jest

The package is ES modules only, and Jest's default runtime loads everything as CommonJS, so a
test that reaches it fails with "Cannot use import statement outside a module" (from Jest 30.5, "Must use import
to load ES Module") unless Jest compiles it first. With `next/jest`, add `transpilePackages: ['react-inp-blame']`
to your Next.js config. Anywhere else, install `@babel/preset-env@7`, since Jest is on Babel 7, and add these two
keys to the Jest config:

```js
transform: {
  '\\.[jt]sx?$': ['babel-jest', { presets: [['@babel/preset-env', { targets: { node: 'current' } }]] }],
},
transformIgnorePatterns: ['/node_modules/(?!(.pnpm/)?react-inp-blame[@/])'],
```

The pattern lets Jest hand the package to babel-jest in npm's `node_modules` and in pnpm's, and the presets have
babel-jest turn `import` and `export` into `require`, which it does not do on its own. `'\\.[jt]sx?$'` is the key
Jest gives babel-jest where a config sets no `transform`, so your own files still go to it. The presets go here
rather than in a Babel config file: Babel never reads a `.babelrc` or a `babel` key in `package.json` for a file
in `node_modules`, and Next.js builds the app with any Babel config file it finds, in place of its own compiler,
so one that holds only these presets breaks `next build`. Where the Jest config already has a
`transformIgnorePatterns`, put `react-inp-blame` inside its `(?!...)` rather than adding a second pattern, since
Jest leaves a file uncompiled when any one of them matches. Where the config or its preset already sets a
`transform`, give the presets to its babel-jest entry, or where no entry takes `.js` files, as under ts-jest, add
the one above with `'\\.jsx?$'` as its key: Jest runs a file through the first entry whose key matches, so one
for `.ts` files as well would take them from ts-jest. Jest 30.5's error also offers Node 24.9 or later, but there
Jest loads the package as it is only from Jest 30.4 and only when run with
`NODE_OPTIONS=--experimental-vm-modules`; on Node 20 and 22, or an older Jest, not even then. CI checks all of it
on Jest 30, ts-jest 29, the Next.js `apps/next-demo` pins and Node 20.19, except a pnpm install, the `babel` key
and the flag on Node 24.19 and on older Jest, which were checked by hand.


## What 1.x promises

From 1.0.0 the package follows semantic versioning. That covers every export and the
options it takes, and the shape of a report. Only a major release removes or renames an export, an entry point,
an option or a report field, changes what a field holds or what an option does, changes a default, adds a value
to one of the [fixed sets of strings](api.md#fixed-sets-of-strings), or drops a version the table in the README
lists, except a Node line past its end of life. `schemaVersion` stays where 1.0.0 has it for all of 1.x, on a
report and on the `react` object that `react-inp-blame/web-vitals`' `attributeINP` adds.

A minor release can add exports, options, report fields and entry points. It can also change how a report reads
an interaction: which kind, name and detail its blame gets, which components a report and `generateTarget` name,
and any display text. That is how the verdict gets better. Display text is `headline`, `where`, `cause`, `notes`,
the phases' `label` and `hint`, `verdict`, `blame.detail`, the words of `target.label`, console warnings, the
Performance panel's entries, and the badge and panel. Show it, never parse it. What each kind means stays the
same through 1.x ([Blame](api.md#interactionreport)), and so does what each `labels` value may read. Each
release's notes list its blame changes under a heading of their own, so a dashboard that groups by kind or name
knows what moved.

A patch release fixes bugs and security problems. It changes a blame only to undo a regression from the release
before, and its notes list that too.

Minor releases come at most once every two weeks. Anything deprecated keeps working through at least one minor,
marked `@deprecated` and, where it runs, with a warning in development builds. Only a major removes it. From
1.0.0, security fixes go into the latest minor, and into the minor before it for 90 days after the latest came
out ([SECURITY.md](../SECURITY.md#versions)). Once 2.0.0 is out, the last 1.x minor counts as the one before it.

`react-inp-blame/otel` is experimental. Its export names and the attribute names it sends can change in any minor,
1.x included, until OpenTelemetry names these fields, and the CHANGELOG says so when they do. `api.debug` can
change in any release. So can bundle size and the library's own time.


## Support window

1.x supports what the table in the README lists at 1.0.0. A new major of React, Next.js, Vite or Astro
comes in a minor, once CI runs it. The build plugins run on Node 20.19 and later at 1.0.0. A minor can drop a
Node line once it is past its end of life upstream, and the CHANGELOG says so under Changed. A patch never drops
one. Dropping anything else the table lists waits for 2.0.0. The canaries run in CI every day but are not
supported: a canary can break the library, and the fix comes in an ordinary release.

Load one copy of the library per page. Two copies from different releases may refuse to share it, and the second
says so in the console ([another-copy](../README.md#another-copy)).

CI keeps a copy of the type declarations each entry point publishes, `/otel`'s included, and fails when a build's
differ from it. No change to the surface goes out unseen, and the pull request that makes one says why.


## What 1.0 means

1.0.0 keeps 0.26.0's runtime and starts the API promise in [What 1.x promises](../README.md#versions).
The API and the meanings of its report fields are stable through 1.x, apart from the documented experimental and debugging exceptions.
A minor release can improve how blame is selected and how a report reads. It cannot change what an existing field means.

The blame can still be wrong. A stable report format does not establish attribution accuracy.
Read the [known limits](known-limits.md) before trusting a name.
