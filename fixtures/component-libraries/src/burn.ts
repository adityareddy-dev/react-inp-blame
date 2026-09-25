/** Keeps the main thread busy for `ms`, so each part of the page has a slow interaction to report. */
export function burn(ms: number) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // busy
  }
}
