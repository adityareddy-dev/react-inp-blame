// src/router.tsx, the template's, with the lines that announce each navigation
import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { announceNavigation } from 'react-inp-blame'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })

  // Tells react-inp-blame each time the route changes, with the URL the address bar shows. Not on the first load, which is the document's own.
  router.subscribe('onBeforeNavigate', ({ fromLocation, hrefChanged }) => {
    if (fromLocation && hrefChanged) announceNavigation(router.history.location.href)
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
