import type { Api } from 'react-inp-blame';

declare global {
  interface Window {
    /** next.config.ts asks the wrapper for `debugGlobal`, which is how these specs read the library. */
    __REACT_INP_BLAME__: Api;
  }
}
