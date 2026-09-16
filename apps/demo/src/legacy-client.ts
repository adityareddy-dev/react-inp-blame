// createRoot shim over the React 17 legacy root, used only by the React 17 matrix variant.
import type { ReactNode } from 'react';
import ReactDOM from 'react-dom';

export function createRoot(el: Element) {
  return {
    render(node: ReactNode) {
      (ReactDOM as any).render(node, el);
    },
    unmount() {
      (ReactDOM as any).unmountComponentAtNode(el);
    },
  };
}
