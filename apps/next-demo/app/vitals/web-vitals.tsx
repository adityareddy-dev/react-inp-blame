'use client';

import { useEffect } from 'react';
import { useReportWebVitals } from 'next/web-vitals';
import { attributeINP } from 'react-inp-blame/web-vitals';

type Reported = Parameters<Parameters<typeof useReportWebVitals>[0]>[0];

declare global {
  interface Window {
    /** Every INP metric `useReportWebVitals` handed over, with the attribution `attributeINP` gave it. */
    __INP_METRICS__?: unknown[];
  }
}

// Outside the component, as Next.js asks: a new function each render would subscribe again.
function report(metric: Reported): void {
  if (metric.name !== 'INP') return;
  (window.__INP_METRICS__ ??= []).push({ ...metric, attribution: attributeINP(metric) });
}

/**
 * The Next.js snippet in docs/web-vitals.md, sending to `window.__INP_METRICS__` instead of an endpoint.
 * `data-vitals` on the body tells e2e/web-vitals.spec.ts that web-vitals is listening.
 */
export function WebVitals() {
  useReportWebVitals(report);
  useEffect(() => {
    document.body.dataset.vitals = '';
    return () => {
      delete document.body.dataset.vitals;
    };
  }, []);
  return null;
}
