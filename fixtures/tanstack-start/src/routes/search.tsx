import { useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'

// A route whose validateSearch fills in a tab the URL lacks. The navigation spec opens it straight away, and
// TanStack Start's server answers with a redirect to the URL with the tab: still the document's navigation.
export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>) => ({ ...search, tab: typeof search.tab === 'string' ? search.tab : 'all' }),
  component: Search,
})

function Search() {
  const { tab } = Route.useSearch()
  useEffect(() => {
    document.body.dataset.hydrated = ''
  }, [])
  return (
    <main>
      <h1>Search, {tab}</h1>
      <button
        type="button"
        onClick={() => {
          const end = performance.now() + 60
          while (performance.now() < end) {}
        }}
      >
        Slow
      </button>
    </main>
  )
}
