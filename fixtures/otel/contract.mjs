// react-inp-blame/otel through each web SDK docs/opentelemetry.md has a setup for, in Node, on the versions
// this folder's lockfile pins (or each at its latest, with scripts/otel-contract.mjs --fresh). Only what
// Node lacks is stood in for: Event Timing's PerformanceObserver and the page's visibility. Each SDK's own
// web-vitals builds the INP metric from the entries fed here, the SDK's own code turns it into a record or a
// span, and the report it is matched against is built from the same entries by the packed library's own
// join. Every route expects status matched, the report's blame.name, and none of the label's text.
//
//   node contract.mjs            # every route, each in a process of its own
//   node contract.mjs <route>    # one of them
//
// Run by scripts/otel-contract.mjs from a temp copy of fixtures/otel, which installs react-inp-blame from
// the packed tarball first.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
/** Where Node finds a package from `from`, the folder nearest it first, whatever its exports map lets out. */
function packageDir(name, from = here) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    assert.ok(dir !== path.dirname(dir), `${name} is not installed where ${from} can load it`);
  }
}
const version = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
/** A file of the packed library, by path: the join and the page slot are not exports. */
const dist = (file) => import(pathToFileURL(path.join(here, 'node_modules/react-inp-blame/dist', file)).href);

// A start time the way Chrome hands them over, float noise and all, so the trip through an HrTime counts.
const START = 5234.599999994039;
const DURATION = 240;
const INTERACTION_ID = 7;
/** The text the clicked button reads. The report's label holds it, and no attribute may. */
const PRIVATE_TEXT = 'Jane Doe';

/**
 * Event Timing, the page's visibility and the window's events, as far as web-vitals reads them. Set before
 * any SDK loads: some read `window` or `document` as their module runs.
 */
function standInForTheBrowser() {
  const events = new EventTarget();
  const observers = new Set();
  globalThis.window = globalThis;
  globalThis.addEventListener = events.addEventListener.bind(events);
  globalThis.removeEventListener = events.removeEventListener.bind(events);
  globalThis.dispatchEvent = events.dispatchEvent.bind(events);
  const location = { href: 'https://shop.example/checkout', origin: 'https://shop.example', protocol: 'https:', host: 'shop.example', hostname: 'shop.example', pathname: '/checkout', search: '', hash: '' };
  globalThis.location = location;
  globalThis.document = {
    visibilityState: 'visible',
    prerendering: false,
    readyState: 'complete',
    location,
    URL: location.href,
    title: 'Checkout',
    referrer: '',
    cookie: '',
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    createElement: () => ({ setAttribute() {}, style: {} }),
  };
  globalThis.Node ??= { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 0);
  globalThis.requestIdleCallback ??= (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
  globalThis.cancelIdleCallback ??= clearTimeout;
  globalThis.PerformanceEventTiming = class PerformanceEventTiming {};
  PerformanceEventTiming.prototype.interactionId = 0;
  globalThis.PerformanceObserver = class PerformanceObserver {
    static supportedEntryTypes = ['event', 'first-input'];
    #callback;
    #types = new Map();
    constructor(callback) {
      this.#callback = callback;
    }
    observe({ type, durationThreshold = 104 }) {
      this.#types.set(type, durationThreshold);
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
    }
    takeRecords() {
      return [];
    }
    deliver(entries) {
      const seen = entries.filter((e) => this.#types.has(e.entryType) && e.duration >= (this.#types.get(e.entryType) ?? 0));
      if (seen.length) this.#callback({ getEntries: () => seen }, this);
    }
  };
  return {
    /** Hands the entries to every observer, as the browser does after the frame that painted them. */
    feed(entries) {
      for (const po of observers) po.deliver(entries);
    },
    /** The page going into the background, when web-vitals reports INP without reportAllChanges. */
    hide() {
      document.visibilityState = 'hidden';
      dispatchEvent(new Event('visibilitychange'));
    },
  };
}

/** The Event Timing entries of one slow click: its pointerdown, then the click that took longest. */
function clickEntries() {
  const entry = (name, startTime, duration) => {
    const e = Object.create(PerformanceEventTiming.prototype);
    return Object.assign(e, { entryType: 'event', name, interactionId: INTERACTION_ID, startTime, duration, processingStart: startTime + 4, processingEnd: startTime + 226, target: null, cancelable: true });
  };
  return [entry('pointerdown', START - 60, 48), entry('click', START, DURATION)];
}

/** A report the packed library's join builds from the same entries, on the page slot as install() puts it. */
async function installReport(entries) {
  const { buildReport, sealReport } = await dist('join.js');
  const { page } = await dist('install-state.js');
  const { inertApi } = await dist('inert.js');
  const text = { nodeType: 3, nodeValue: PRIVATE_TEXT, parentNode: null, parentElement: null, nextSibling: null, firstChild: null };
  const button = { nodeType: 1, tagName: 'BUTTON', id: '', classList: { length: 0 }, parentNode: null, parentElement: null, nextSibling: null, firstChild: text, getAttribute: () => null };
  text.parentNode = text.parentElement = button;
  const input = { ts: START, type: 'click', gestureTs: START, press: undefined, target: button, owners: ['LineItemRow', 'OrderSummary', 'CheckoutPage'], handler: 'onRemove', key: null, dehydrated: null, work: { endedAt: START, unjoined: [] } };
  const commit = {
    at: START + 220,
    sinceInput: 220,
    inputTs: START,
    gestureTs: START,
    inputType: 'click',
    rendered: 801,
    hydrated: false,
    truncated: false,
    roots: ['OrderSummary'],
    hotPath: ['OrderSummary', 'LineItem'],
    components: [{ name: 'LineItem', count: 800, self: 150, total: 170 }],
    hasDurations: true,
    coarseClock: false,
    total: 180,
    startedAt: null,
    effectsStartedAt: null,
    effectsEndedAt: null,
    walkMs: 0,
    priority: 1,
    didError: false,
  };
  // Event Timing hands the library every entry, as it hands web-vitals the ones over its threshold.
  const report = sealReport(buildReport(entries, [commit], [], [input], 'text'));
  assert.ok(report.target?.label?.includes(PRIVATE_TEXT), `the report's label is ${report.target?.label}, not the button's text, so the privacy check would pass on nothing`);
  page.installed = { api: { ...inertApi('none'), reports: () => [report] }, reapply: () => {} };
  const { blame } = report.explanation;
  assert.ok(typeof blame.name === 'string' && blame.name.length > 0, `the report's blame.name is ${JSON.stringify(blame.name)}, so an equality check on it would pass on nothing`);
  return report;
}

/** Feeds the click, waits for web-vitals' idle callback, then hides the page so every onINP reports. */
async function interact(browser) {
  browser.feed(clickEntries());
  await new Promise((resolve) => setTimeout(resolve, 20));
  browser.hide();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const ours = (attributes) => Object.fromEntries(Object.entries(attributes ?? {}).filter(([name]) => name.startsWith('react_inp_blame.')));

/** What every route has to show: the blame of the report for that click, and not a word of its label. */
function assertBlamed(route, attributes, report) {
  const sent = ours(attributes);
  const status = sent['react_inp_blame.status'];
  assert.ok(status === 'matched', `${route}: react_inp_blame.status is ${status ?? 'missing'}, not matched. Did the SDK change what it stamps an INP record or span with? ${JSON.stringify(sent)}`);
  assert.equal(sent['react_inp_blame.blame.name'], report.explanation.blame.name, `${route}: blame.name is not the report's`);
  assert.equal(sent['react_inp_blame.blame.kind'], report.explanation.blame.kind, `${route}: blame.kind is not the report's`);
  for (const [name, value] of Object.entries(sent)) {
    assert.ok(!String(value).includes(PRIVATE_TEXT), `${route}: ${name} holds the label's text: ${value}`);
  }
  console.log(`${route}: matched, blame.name ${sent['react_inp_blame.blame.name']}, ${Object.keys(sent).length} attributes`);
}

/** An exporter that copies each record's attributes when export() is called, as serializing for OTLP does. */
function copyingExporter() {
  const exported = [];
  return {
    exported,
    export(records, done) {
      for (const r of records) exported.push({ name: r.attributes['browser.web_vital.name'], attributes: { ...r.attributes } });
      done({ code: 0 });
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
}

/**
 * OpenTelemetry's web vitals instrumentation, through the real LoggerProvider with `processors` in the order
 * given. `hook` is the instrumentation's applyCustomLogRecordData, for the routes without a processor slot.
 */
async function openTelemetry(browser, { from = here, order = 'first', hook } = {}) {
  const load = createRequire(path.join(from, 'package.json'));
  const url = (specifier) => pathToFileURL(load.resolve(specifier)).href;
  const { LoggerProvider, SimpleLogRecordProcessor } = await import(url('@opentelemetry/sdk-logs'));
  const { WebVitalsInstrumentation } = await import(url('@opentelemetry/browser-instrumentation/experimental/web-vitals'));
  const { InpBlameLogRecordProcessor } = await import('react-inp-blame/otel');
  const exporter = copyingExporter();
  // sdk-logs 0.219, which Elastic brings, takes the exporter itself, and 0.222 an object holding it. This is both.
  const exporting = new SimpleLogRecordProcessor(Object.assign(exporter, { exporter }));
  const processors = hook ? [exporting] : order === 'first' ? [new InpBlameLogRecordProcessor(), exporting] : [exporting, new InpBlameLogRecordProcessor()];
  const provider = new LoggerProvider({ processors });
  const instrumentation = new WebVitalsInstrumentation({ enabled: false, ...(hook ? { applyCustomLogRecordData: hook } : {}) });
  instrumentation.setLoggerProvider(provider);
  instrumentation.enable();
  const report = await installReport(clickEntries());
  await interact(browser);
  await provider.forceFlush();
  const inp = exporter.exported.filter((r) => r.name === 'inp');
  assert.equal(inp.length, 1, `the instrumentation exported ${inp.length} INP records, not 1`);
  for (const other of exporter.exported.filter((r) => r.name !== 'inp')) {
    assert.deepEqual(ours(other.attributes), {}, `a ${other.name} record got react_inp_blame attributes`);
  }
  return { attributes: inp[0].attributes, report };
}

/** The hook as docs/opentelemetry.md gives it for Elastic, for a record before the SDK has it. */
const hook = (inpBlameAttributes) => (record) => {
  record.attributes = { ...record.attributes, ...inpBlameAttributes(record) };
};

const ROUTES = {
  /** The processor first in the web SDK's LoggerProvider, as the page says to put it. */
  async 'opentelemetry-processor'(browser) {
    const { attributes, report } = await openTelemetry(browser);
    assertBlamed('OpenTelemetry, processor first', attributes, report);
  },

  /** Behind a SimpleLogRecordProcessor, the record is exported before the processor runs: the reason for the order. */
  async 'opentelemetry-processor-last'(browser) {
    const { attributes } = await openTelemetry(browser, { order: 'last' });
    assert.deepEqual(ours(attributes), {}, 'behind a SimpleLogRecordProcessor the export already held the attributes, so the page\'s reason for putting the processor first no longer holds');
    console.log('OpenTelemetry, processor last: the export went out without the attributes, as the page says');
  },

  /** The instrumentation's own applyCustomLogRecordData hook. */
  async 'opentelemetry-hook'(browser) {
    const { inpBlameAttributes } = await import('react-inp-blame/otel');
    const { attributes, report } = await openTelemetry(browser, { hook: hook(inpBlameAttributes) });
    assertBlamed('OpenTelemetry, applyCustomLogRecordData', attributes, report);
  },

  /**
   * Elastic's hook, on the browser-instrumentation and web-vitals that @elastic/opentelemetry-browser brings,
   * resolved from its own folder, since those are what its users get.
   */
  async elastic(browser) {
    const { inpBlameAttributes } = await import('react-inp-blame/otel');
    const elastic = packageDir('@elastic/opentelemetry-browser');
    const versions = ['@opentelemetry/browser-instrumentation', 'web-vitals'].map((name) => `${name} ${version(packageDir(name, elastic))}`);
    const { attributes, report } = await openTelemetry(browser, { from: elastic, hook: hook(inpBlameAttributes) });
    assertBlamed(`Elastic, applyCustomLogRecordData on ${versions.join(' and ')}`, attributes, report);
  },

  /** Honeycomb's INP span and its applyCustomAttributes, which gets the whole metric. */
  async honeycomb(browser) {
    const { inpBlameAttributes } = await import('react-inp-blame/otel');
    // Node resolves Honeycomb's .node build, which leaves web vitals out, so load the browser build's CJS.
    const hc = require(path.join(packageDir('@honeycombio/opentelemetry-web'), 'dist/cjs/index.js'));
    const { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } = require('@opentelemetry/sdk-trace-base');
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const instrumentation = new hc.WebVitalsInstrumentation({
      vitalsToTrack: ['INP'],
      inp: { applyCustomAttributes: (vital, span) => span.setAttributes(inpBlameAttributes(vital)) },
    });
    instrumentation.setTracerProvider(provider);
    const report = await installReport(clickEntries());
    await interact(browser);
    const spans = exporter.getFinishedSpans().filter((s) => s.name === 'INP');
    assert.equal(spans.length, 1, `Honeycomb ended ${spans.length} INP spans, not 1`);
    assertBlamed('Honeycomb, applyCustomAttributes', spans[0].attributes, report);
  },

  /** Grafana Faro's web vitals with attribution and the global beforeSend, with a transport that keeps what it is sent. */
  async faro(browser) {
    const { inpBlameAttributes } = await import('react-inp-blame/otel');
    // faro-core as faro-web-sdk resolves it, and the two files of theirs that are not exports, by path.
    const webSdk = packageDir('@grafana/faro-web-sdk');
    const faroCore = packageDir('@grafana/faro-core', webSdk);
    const file = (dir, name) => import(pathToFileURL(path.join(dir, name)).href);
    const { initializeFaro, BaseTransport } = await file(faroCore, 'dist/esm/index.js');
    const { mockConfig } = await file(faroCore, 'dist/esm/testUtils/mockConfig.js');
    const { WebVitalsWithAttribution } = await file(webSdk, 'dist/esm/instrumentations/webVitals/webVitalsWithAttribution.js');
    class Collecting extends BaseTransport {
      name = 'collecting';
      version = '0';
      items = [];
      send(items) {
        this.items.push(...[items].flat());
      }
      isBatched() {
        return false;
      }
    }
    const transport = new Collecting();
    const faro = initializeFaro(
      mockConfig({
        transports: [transport],
        batching: { enabled: false },
        // The beforeSend docs/opentelemetry.md gives, as a user pastes it.
        beforeSend: (item) => {
          const m = item.payload;
          if (item.type === 'measurement' && m.type === 'web-vitals' && m.values.inp !== undefined) {
            const blame = inpBlameAttributes(m.values.interaction_time);
            m.context = { ...m.context, ...Object.fromEntries(Object.entries(blame).map(([name, value]) => [name, String(value)])) };
          }
          return item;
        },
      }),
    );
    new WebVitalsWithAttribution(faro.api.pushMeasurement, {}).initialize();
    const report = await installReport(clickEntries());
    await interact(browser);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const inp = transport.items.filter((i) => i.type === 'measurement' && i.payload.values?.inp !== undefined);
    assert.equal(inp.length, 1, `Faro sent ${inp.length} INP measurements, not 1`);
    const { context } = inp[0].payload;
    for (const [name, value] of Object.entries(ours(context))) assert.equal(typeof value, 'string', `Faro's context got ${name} as a ${typeof value}`);
    assertBlamed('Grafana Faro, beforeSend', context, report);
  },
};

async function main() {
  const route = process.argv[2];
  if (route) {
    assert.ok(Object.hasOwn(ROUTES, route), `the routes are ${Object.keys(ROUTES).join(', ')}, not ${route}`);
    const browser = standInForTheBrowser();
    await ROUTES[route](browser);
    return;
  }
  // A process each: web-vitals keeps its listeners and the page's hidden state for good once it has them.
  const failed = [];
  for (const name of Object.keys(ROUTES)) {
    const { status } = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { stdio: 'inherit' });
    if (status !== 0) failed.push(name);
  }
  assert.ok(failed.length === 0, `Failed: ${failed.join(', ')}`);
}

try {
  await main();
  // Some SDKs keep timers going (Faro's session, the exporters' batching), which would hold the process open.
  process.exit(process.exitCode ?? 0);
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : error.stack);
  process.exit(1);
}
