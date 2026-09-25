import { shared } from './session.js';

/** Keys already warned about, by every copy of the library on the page. */
const warned = shared('warnings', () => new Set<string>());

/** Each warning ends with a link to its own section of the README's troubleshooting, by `anchor`. */
const HELP = 'https://github.com/adityareddy-dev/react-inp-blame#';

/** `console.warn` with the library's prefix and a link to the README, at most once per page for each key. */
export function warnOnce(key: string, message: string, anchor = key): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[react-inp-blame] ${message} See ${HELP}${anchor}`);
}
