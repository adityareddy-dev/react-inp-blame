import { useState } from 'react'
import { SlowList } from './SlowList'

export function App() {
  const [count, setCount] = useState(0)
  return (
    <main>
      <h1>webpack + React</h1>
      <button type="button" className="counter" onClick={() => setCount((n) => n + 1)}>
        Count is {count}
      </button>
      <SlowList count={count} />
    </main>
  )
}
