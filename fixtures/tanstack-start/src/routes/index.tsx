import { useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { SlowList } from '../slow-list'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const [count, setCount] = useState(0)
  useEffect(() => {
    // For the specs: from here on the counter's clicks reach React, rather than being queued for hydration.
    document.body.dataset.hydrated = ''
  }, [])
  return (
    <main>
      <h1>Welcome to TanStack Start</h1>
      <p>
        Edit <code>src/routes/index.tsx</code> to get started.
      </p>
      <button type="button" className="counter" onClick={() => setCount((count) => count + 1)}>
        Count is {count}
      </button>
      {/* The route change the navigation spec follows. The click takes 60 ms, so it is reported. */}
      <Link
        to="/second"
        onClick={() => {
          const end = performance.now() + 60
          while (performance.now() < end) {}
        }}
      >
        Second page
      </Link>
      <SlowList count={count} />
    </main>
  )
}
