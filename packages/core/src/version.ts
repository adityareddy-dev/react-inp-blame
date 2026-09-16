/** React versions, as renderers hand them to the DevTools hook's `inject()`. */

/** The oldest React major this library reads. */
export const OLDEST_REACT_MAJOR = 17;
/** The newest React major this library reads. */
export const NEWEST_REACT_MAJOR = 19;

export interface ReactVersion {
  readonly major: number;
  readonly minor: number;
  /**
   * An experimental build from npm (`0.0.0-experimental-<sha>`), whose version says nothing about the
   * React it is ahead of. It is read as the newest major, and trusted once a root of it passes the shape
   * check at its first commit.
   */
  readonly experimental: boolean;
}

/** The version's major and minor as numbers; null when there is no version to read. */
export function parseReactVersion(version: string | null): ReactVersion | null {
  if (!version) return null;
  if (version.startsWith('0.0.0-')) return { major: NEWEST_REACT_MAJOR, minor: Infinity, experimental: true };
  const [major = NaN, minor = NaN] = version.split('.').map((part) => parseInt(part, 10));
  return Number.isNaN(major) ? null : { major, minor: Number.isNaN(minor) ? 0 : minor, experimental: false };
}
