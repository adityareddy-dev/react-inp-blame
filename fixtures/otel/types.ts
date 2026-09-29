// What the page's blocks do not show, checked against each package's own types.
import type { Metric } from 'web-vitals';
import { onINP } from 'web-vitals/attribution';
import type { Metric as AttributionMetric } from 'web-vitals/attribution';
import { HoneycombWebSDK } from '@honeycombio/opentelemetry-web';
import { attributeINP } from 'react-inp-blame/web-vitals';
import { InpBlameLogRecordProcessor, inpBlameAttributes, type InpBlameAttributes } from 'react-inp-blame/otel';
import type { LogRecordProcessor } from '@opentelemetry/sdk-logs';

// attributeINP takes web-vitals' plain Metric, whose entries are PerformanceEntry[], as Honeycomb's hook hands it over.
export const plain = (metric: Metric) => attributeINP(metric);
export const withAttribution = (metric: AttributionMetric) => attributeINP(metric);
onINP((metric) => attributeINP(metric));
new HoneycombWebSDK({
  webVitalsInstrumentationConfig: {
    inp: {
      applyCustomAttributes: (vital, span) => {
        const { react } = attributeINP(vital);
        span.setAttributes({ ...inpBlameAttributes(vital), 'react.blame.name': react?.blame.name ?? undefined });
      },
    },
  },
});

// The processor is one OpenTelemetry's own LoggerProvider takes, and the attributes are what setAttributes takes.
export const processor: LogRecordProcessor = new InpBlameLogRecordProcessor();
export const time: InpBlameAttributes = inpBlameAttributes(1234.5);
