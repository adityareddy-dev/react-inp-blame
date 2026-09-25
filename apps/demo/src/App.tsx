import { useEffect, useState } from 'react';
import { Ambient } from './Ambient';
import { Lab, labScenarios } from './Lab';
import { SignInDemo } from './signin/SignInDemo';

function useHash(): string {
  const [h, setH] = useState(() => location.hash.slice(1));
  useEffect(() => {
    const on = () => setH(location.hash.slice(1));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return h;
}

/** `/` is the sign-in demo; `#lab/<scenario>` (or a bare scenario key) is the anti-pattern lab. */
export function App() {
  const hash = useHash();
  const key = hash.replace(/^lab\/?/, '');
  if (hash === 'ambient') return <Ambient />;
  if (hash.startsWith('lab') || key in labScenarios) return <Lab scenario={key || 'context-storm'} />;
  return <SignInDemo />;
}
