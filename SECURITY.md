# Security

## Reporting a vulnerability

Please do not report a security problem in a public issue. Email adityareddy.dev@gmail.com, the
address in the `author` field of `packages/core/package.json`, with:

- what the problem is and what an attacker could do with it,
- the version or commit it affects,
- the steps, or a page, that reproduce it.

You will get a reply within 7 days saying whether the problem is confirmed and what happens next. A
confirmed problem is fixed in a release before it is described in public, and the report is credited
in that release's notes unless you ask for it not to be.

## Versions

Fixes go into the latest 0.x release on npm only.

## What counts

The library runs inside every page it is installed on, before the app, and its plugins change how
that app is built. Problems in scope include, for example:

- page content that gets the badge and panel, or anything else in the library, to run script;
- a report carrying something the documentation says it never reads, such as a form field's value,
  or an element's text under `labels: 'attributes'`;
- `react-inp-blame/next` or `react-inp-blame/vite` changing a build in a way their documentation does
  not describe.

A slow interaction the library misattributes is a bug, not a vulnerability: open an issue for it.
