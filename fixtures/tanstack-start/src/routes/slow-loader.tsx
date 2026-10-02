import { createFileRoute } from '@tanstack/react-router'

// A route whose loader takes 5 s, so the navigation spec can press Back before it finishes.
export const Route = createFileRoute('/slow-loader')({
  loader: () => new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  component: () => <h1>Slow loader</h1>,
})
