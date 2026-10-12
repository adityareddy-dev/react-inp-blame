import { createFileRoute, redirect } from '@tanstack/react-router'

// A route whose beforeLoad sends the page back where the navigation spec's link was, query included, as
// TanStack Router writes it.
export const Route = createFileRoute('/bounce')({
  beforeLoad: () => {
    throw redirect({ href: '/?inp-blame=' })
  },
})
