import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import type { Route } from "./+types/home";
import { SlowList } from "../slow-list";
import { Welcome } from "../welcome/welcome";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}

export default function Home() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    // For the specs: from here on the counter's clicks reach React, rather than being queued for hydration.
    document.body.dataset.hydrated = "";
  }, []);
  return (
    <>
      <Welcome />
      {/* flushSync brings react-dom into a route module, as a dialog or a portal would. On React 18 that
          module connects to the DevTools hook as it loads, which is before the client entry. */}
      <button type="button" className="counter" onClick={() => flushSync(() => setCount((count) => count + 1))}>
        Count is {count}
      </button>
      {/* The slow handler is this route's own, and a route module's default export is the component the
          click names. React Router wraps that export in a component of its own. */}
      <button
        type="button"
        onClick={() => {
          const end = performance.now() + 150;
          while (performance.now() < end) {}
        }}
      >
        Save
      </button>
      <SlowList count={count} />
    </>
  );
}
