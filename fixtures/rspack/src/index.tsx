import 'react-inp-blame/auto'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { mountOverlay } from 'react-inp-blame'
import { App } from './App'

// The badge and panel, which /auto leaves off.
mountOverlay()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
