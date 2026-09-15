import { shared } from './session.js';

/** Keys already warned about, by every copy of the library on the page. */
const warned = shared('warnings', () => new Set<string>());

/** `console.warn` with the library's prefix, at most once per page for each key. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[react-inp-blame] ${message}`);
}
