const warned = new Set<string>();

/** `console.warn` with the library's prefix, at most once per page for each key. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[react-inp-blame] ${message}`);
}
