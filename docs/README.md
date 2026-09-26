# react-inp-blame docs

The [README](../README.md) is the five-minute version: setup for Next.js and Vite, what you will see, how it
compares and what it costs. These pages have the rest.

- [Install](install.md): every setup in full. Next.js, Vite, React Router, Remix, TanStack Start and Astro.
- [With web-vitals](web-vitals.md): the React side added to web-vitals' INP attribution, and sending it to
  Sentry or GA4.
- [API](api.md): `onInteraction`, `install()` and its options, every field of a report, what a label may hold,
  and the badge and panel.
- [How it works](how-it-works.md): clicks before hydration, the INP estimate, what it reads from React, and
  its own time per interaction.
- [Known limits](known-limits.md): what it can't see, and where it has to guess.
- [Troubleshooting](troubleshooting.md): every warning it prints, and what to do about it.
- [Benchmarks](benchmarks/README.md): what it costs, and what it blames, on real open-source apps.
- [Design notes](interaction-attribution-design.md): why it works the way it does.

## Terms

Terms this page uses: **INP** (Interaction to Next Paint) is the Core Web Vital for responsiveness: how
long a click, tap or key press took to reach the next frame drawn, at the page's slowest, with the worst
few left out once a page has had many. **Event
Timing** is the browser API INP is built on. **Long Animation Frames** is a second, Chromium-only API that
says which scripts ran in a slow frame and how much style and layout work they forced. React's **fiber tree** is the
internal tree React keeps of your rendered components; the library reads it through the hook React
exposes for developer tools. A **soft navigation** is a route change the framework makes in the page,
with no new document.
