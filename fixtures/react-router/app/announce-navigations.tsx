// app/announce-navigations.tsx
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { announceNavigation } from "react-inp-blame";

// Tells react-inp-blame each time React Router changes the route. Render it once, in the root route's App.
export function AnnounceNavigations() {
  const { key } = useLocation();
  const last = useRef(key);
  useEffect(() => {
    if (key === last.current) return; // the first page is the document's own navigation
    last.current = key;
    announceNavigation(window.location.href);
  }, [key]);
  return null;
}
