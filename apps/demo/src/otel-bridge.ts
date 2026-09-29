// `e2e/otel.spec.ts` runs `react-inp-blame/otel` in the page, on the record and the span an OpenTelemetry
// setup would hand it. The entry imports nothing from OpenTelemetry, so the demo needs none of its packages:
// the spec builds each shape the way its SDK does, and this puts the entry on the window for it, as
// web-vitals-bridge.ts does for its own. main.tsx loads it only on `?otel`, so no other spec's page changes.
import { InpBlameLogRecordProcessor, inpBlameAttributes } from 'react-inp-blame/otel';

declare global {
  interface Window {
    // Optional: the spec's init script runs before this module, and web-vitals reports only once the page hides.
    __REACT_INP_BLAME_OTEL__?: { inpBlameAttributes: typeof inpBlameAttributes; InpBlameLogRecordProcessor: typeof InpBlameLogRecordProcessor };
  }
}

window.__REACT_INP_BLAME_OTEL__ = { inpBlameAttributes, InpBlameLogRecordProcessor };
