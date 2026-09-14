/** Busy-wait for `ms` milliseconds. Stands in for real render work. */
export function burn(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}
