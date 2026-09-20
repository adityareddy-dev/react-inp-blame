import { Panel } from './panel';
import { PanelSection } from './section';

// Rendered per request, so the boundary below really streams under `next dev` and `next start` alike
// rather than being baked into a static page at build time.
export const dynamic = 'force-dynamic';

// How long the server holds the boundary's content back. Long enough that the shell reaches the
// browser and hydrates first, which is what leaves the boundary waiting instead of being hydrated
// with everything around it.
const STREAM_DELAY_MS = 300;

/**
 * The case an App Router app hits and no tool explains: a click that lands on server-rendered HTML
 * React has not hydrated yet. The shell arrives and hydrates, the Suspense boundary's content arrives
 * later from the stream, and React hydrates it on a low-priority task of its own.
 * e2e/hydration.spec.ts clicks the button inside it in between.
 */
export default function HydrationPage() {
  return (
    <main>
      <h1>Hydration check</h1>
      <PanelSection>
        <StreamedPanel />
      </PanelSection>
    </main>
  );
}

async function StreamedPanel() {
  await new Promise((resolve) => setTimeout(resolve, STREAM_DELAY_MS));
  return <Panel />;
}
