import { useEffect, useState } from "react";
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
      <button type="button" className="counter" onClick={() => setCount((count) => count + 1)}>
        Count is {count}
      </button>
      <SlowList count={count} />
    </>
  );
}
