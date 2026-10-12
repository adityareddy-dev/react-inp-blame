import { useLayoutEffect, useState } from "react";

// The page the home route links to. It takes 800 ms to commit, as a heavy route can, so the navigation spec can
// click while it does, and its button covers the page, so that click lands on it once the commit is done. The
// click takes 60 ms and sets state, which has React run any effect the commit left waiting first, inside it.
export default function Second() {
  const [clicks, setClicks] = useState(0);
  useLayoutEffect(() => {
    console.log("second page committing");
    const end = performance.now() + 800;
    while (performance.now() < end) {}
  }, []);
  return (
    <main>
      <h1>Second page</h1>
      <button
        type="button"
        data-clicks={clicks}
        style={{ position: "fixed", inset: 0 }}
        onClick={() => {
          const end = performance.now() + 60;
          while (performance.now() < end) {}
          setClicks((clicks) => clicks + 1);
        }}
      >
        Slow
      </button>
    </main>
  );
}
