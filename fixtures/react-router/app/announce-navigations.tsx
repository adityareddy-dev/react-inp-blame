// app/announce-navigations.tsx
import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation } from "react-router";
import { announceNavigation } from "react-inp-blame";

// A layout effect runs as the new route commits, before a click that waited behind that commit. On the server,
// where React 18 warns about useLayoutEffect, it is useEffect, which never runs there either.
const useCommitEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

// Tells react-inp-blame each time React Router changes the URL. Render it once, before the Outlet in the root
// route's App, so that it announces before the new route's own layout effects run.
export function AnnounceNavigations() {
  const { key } = useLocation();
  const last = useRef<string | null>(null);
  useCommitEffect(() => {
    const href = window.location.href;
    // The first page is the document's own navigation, and a link to the page it is on changes no URL.
    if (last.current !== null && href !== last.current) announceNavigation(href);
    last.current = href;
  }, [key]);
  return null;
}
