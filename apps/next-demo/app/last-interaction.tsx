'use client';

import { useEffect } from 'react';
import { onInteraction } from 'react-inp-blame';

/**
 * Hears reports the way an application does, through its own import of the library. It writes the
 * last report's interactionId to `document.body` rather than to React state, so hearing a report
 * renders nothing. e2e/load-order.spec.ts compares it with the debug global's: the module Next.js
 * injected and this component share one installation. `data-subscribed` on the body tells the tests
 * that the page has hydrated and is listening.
 */
export function LastInteraction() {
  useEffect(() => {
    const body = document.body;
    const unsubscribe = onInteraction((report) => {
      body.dataset.lastInteraction = String(report.interactionId);
    });
    body.dataset.subscribed = '';
    return () => {
      unsubscribe();
      delete body.dataset.subscribed;
    };
  }, []);
  return null;
}
