// `e2e/web-vitals.spec.ts` runs web-vitals in the page beside the library, and the options it passes
// to onINP have to come from `react-inp-blame/web-vitals`. A script injected before the page's own
// cannot import that entry, and a production build only holds what the app imported, so the demo puts
// it on the window the way `install({ debugGlobal: true })` puts the API there.
import { attributeINP, generateTarget } from 'react-inp-blame/web-vitals';

declare global {
  interface Window {
    // Optional: an init script runs before this module, so a spec reading it early finds nothing there.
    __REACT_INP_BLAME_WEB_VITALS__?: { generateTarget: typeof generateTarget; attributeINP: typeof attributeINP };
  }
}

window.__REACT_INP_BLAME_WEB_VITALS__ = { generateTarget, attributeINP };
