# Compared with other tools

|                                                         | react-inp-blame                                                                   | Sentry `reactComponentAnnotation` | react-scan                         | web-vitals attribution | React 19.2 Performance tracks        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------- | ---------------------- | ------------------------------------ |
| Runs in a production build                              | optional¹                                                                         | yes                               | not its main entry²                | yes                    | no: development and profiling builds |
| Names the rendered subtree, not just the target's owner | yes                                                                               | no³                               | yes                                | no: a CSS selector     | yes, in development⁴                 |
| Follow-up renders after the paint                       | yes                                                                               | no                                | not told apart⁵                    | no                     | drawn, not joined to the interaction |
| Forced-layout split                                     | yes, from Long Animation Frames, and it can be the verdict rather than a footnote | no                                | no: reads no Long Animation Frames | partly⁶                | no                                   |
| Plain-language verdict                                  | yes                                                                               | no                                | no                                 | no                     | no                                   |
| Zero dependencies                                       | yes                                                                               | no                                | no (11 in 0.5.7)                   | yes                    | part of React                        |
| Needs a build step for names                            | in production builds: the plugins add it                                          | yes                               | not in development⁷                | no names               | not in development                   |

1. Both build plugins default to development-only. Set `enabled: true` or `enabled: 'production'` to include the library in a production build. Production React does not supply render times, so those reports have less timing evidence.
2. Its main entry does not start when every React renderer on the page is a production build, unless `dangerouslyForceRunInProduction` is set, which its README calls "not recommended". Two other entries in 0.5.7 run there anyway: `react-scan/all-environments` skips that check, and `react-scan/lite`, a headless one, attaches to every renderer whatever its build.
3. Its build step puts `data-sentry-component` on the outermost element each component returns. Since 11.0.0 the SDK, with span streaming (its default), names an INP span after the first of those on the target or its four nearest ancestors, or `Click` or `Key press` when there is none, and keeps the DOM path in `browser.web_vital.inp.target`.
4. Profiling builds list only components under a `<Profiler>`, or every component with the React Developer Tools extension enabled.
5. It keeps every fiber render from the pointerup or keydown as one set, until the interaction's Event Timing entry arrives or a second after the frame that follows the input.
6. `totalStyleAndLayoutDuration`, and `longestScript.entry`, which carries `forcedStyleAndLayoutDuration`.
7. It ships bundler plugins under `react-scan/react-component-name/*`; what they match was not checked.

Checked on 2026-09-26 against aidenybai/react-scan at 0fb3186 (0.5.7 on npm), getsentry/sentry-javascript at
bd3ce5f (11.0.0), reactjs/react.dev at 44b0b5f and web-vitals 6.2.2's types. In development, React's Components track is the
better source of per-component durations, and react-scan's notifications already tie a slow interaction to the components
that rendered for it. Its `all-environments` entry starts the same tracking in a production build. What this library adds
is Long Animation Frames' forced layout inside that join, in either build, and the sentence.
