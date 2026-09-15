/**
 * What every page needs from the badge and panel before their code is loaded: the id of the
 * element they live in, so clicks on them are not reported as the app's, and whether the page
 * asks for them. The badge and panel themselves (overlay.ts) arrive by dynamic import, only
 * when shown.
 */

/** Id of the element the badge and panel are drawn in. */
export const OVERLAY_ID = 'react-inp-blame';

/** True when the URL or localStorage asks for the overlay; the `'query'` mode of the option. */
export function overlayRequested(): boolean {
  try {
    if (/[?&#]inp-blame(?:[=&#]|$)/.test(location.search + location.hash)) return true;
    return localStorage.getItem('react-inp-blame') === 'overlay';
  } catch {
    return false;
  }
}
