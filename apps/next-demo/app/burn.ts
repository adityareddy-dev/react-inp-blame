/** Keeps the main thread busy for `ms`, the way slow application code does. */
export function burn(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}
