import { shared } from './session.js';

/** Keys already warned about, by every copy of the library on the page. */
const warned = shared('warnings', () => new Set<string>());

/** Each warning ends with a link to its own section of the README's troubleshooting, by `anchor`. */
const HELP = 'https://github.com/adityareddy-dev/react-inp-blame#';

/**
 * `console.warn` with the library's prefix and a link to the README, at most once per page for each key.
 * What `logged` holds goes to the console after the message, so an error there shows with its stack.
 */
export function warnOnce(key: string, message: string, anchor = key, ...logged: unknown[]): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[react-inp-blame] ${message} See ${HELP}${anchor}`, ...logged);
}

/** `error` as a warning quotes it. A thrown value with no string form, such as an object with no prototype, still gives one. */
export function errorText(error: unknown): string {
  try {
    return String(error);
  } catch {
    return 'a value that cannot be printed';
  }
}

/**
 * Says once that the library caught an error of its own, quoting the first and logging it after the
 * message. It is kept from the page's error handlers, where error monitoring would count it as the app's,
 * so this is the only place it shows. Later errors are not shown at all.
 */
export function dropped(error: unknown): void {
  warnOnce(
    'library-error',
    `an error inside the library (${errorText(error)}) was kept from the page. Only the step it threw in was skipped, so a report may be missing or blame nothing, and later interactions are reported as usual. Please open an issue with this message and the error logged with it.`,
    'library-error',
    error,
  );
}

/**
 * `fn` as a callback for the browser or a router to call: an error it throws goes to `dropped` rather
 * than to the page. Only for the library's own code; an error of the page's own, such as one a report
 * listener throws, is the page's to hear.
 */
export function guarded<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      fn(...args);
    } catch (error) {
      dropped(error);
    }
  };
}
