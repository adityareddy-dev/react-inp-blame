import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
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
  const { key } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    // For the specs: from here on the counter's clicks reach React, rather than being queued for hydration.
    document.body.dataset.hydrated = "";
  }, []);
  useEffect(() => {
    // For the navigation spec: the route has committed this location.
    document.body.dataset.location = key;
  }, [key]);
  return (
    <>
      <Welcome />
      <button type="button" className="counter" onClick={() => setCount((count) => count + 1)}>
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
      {/* The route change the navigation spec follows. The click takes 60 ms, so it is reported. */}
      <Link
        to="/second"
        onClick={() => {
          const end = performance.now() + 60;
          while (performance.now() < end) {}
        }}
      >
        Second page
      </Link>
      {/* A navigation to the page it is on, as a link to it makes. React Router gives it a new key too, though
          the URL stays the same. */}
      <button
        type="button"
        onClick={() => {
          const end = performance.now() + 60;
          while (performance.now() < end) {}
          navigate(window.location.pathname + window.location.search);
        }}
      >
        This page
      </button>
      <SlowList count={count} />
    </>
  );
}
