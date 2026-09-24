import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTimeline } from '../src/devtools.ts';
import { attachLaterRender, buildReport, sealReport } from '../src/join.ts';
import type { CommitSummary, RendererInfo } from '../src/types.ts';

const CHROME_147 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const CHROME_133 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0';

interface Drawn {
  via: 'measure' | 'timeStamp';
  label: string;
  track: string;
  group: string;
  color: string;
  tooltip?: string;
  properties?: [string, string][];
}

/**
 * Runs `draw` in a browser with this user agent and returns what reached DevTools, through
 * `console.timeStamp` or through a measure's `devtools` detail, and which measures were left in
 * the page's User Timing buffer afterwards.
 */
function recording(userAgent: string, draw: () => void): { drawn: Drawn[]; left: string[] } {
  const drawn: Drawn[] = [];
  const buffer: string[] = [];
  const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const timeStamp = console.timeStamp;
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent }, configurable: true, writable: true });
  console.timeStamp = ((label: string, _start: number, _end: number, track: string, group: string, color: string) => {
    drawn.push({ via: 'timeStamp', label, track, group, color });
  }) as typeof console.timeStamp;
  Object.defineProperty(performance, 'measure', {
    configurable: true,
    value: (name: string, options: { detail: { devtools: { track: string; trackGroup: string; color: string; tooltipText: string; properties: [string, string][] } } }) => {
      const { track, trackGroup, color, tooltipText, properties } = options.detail.devtools;
      drawn.push({ via: 'measure', label: name, track, group: trackGroup, color, tooltip: tooltipText, properties });
      buffer.push(name);
    },
  });
  Object.defineProperty(performance, 'clearMeasures', {
    configurable: true,
    value: (name: string) => {
      for (let i = buffer.indexOf(name); i >= 0; i = buffer.indexOf(name)) buffer.splice(i, 1);
    },
  });
  try {
    draw();
  } finally {
    if (navigator) Object.defineProperty(globalThis, 'navigator', navigator);
    console.timeStamp = timeStamp;
    delete (performance as any).measure;
    delete (performance as any).clearMeasures;
  }
  return { drawn, left: buffer };
}

const reactDom = (version: string, bundleType: number): RendererInfo => ({ id: 1, version, bundleType, rendererPackageName: 'react-dom' });

// A 200 ms click whose handlers ran from 2 to 180 ms.
const click = { name: 'click', interactionId: 7, startTime: 0, duration: 200, processingStart: 2, processingEnd: 180, target: null };

/** The click's report, as published, with these commits joined to it. */
const report = (commits: CommitSummary[]) => sealReport(buildReport([click], commits, null));

/** The context storm's commit, stamped with the click, as a production build walks it: counts, no durations. */
function commit(at: number, opts: Partial<CommitSummary> = {}): CommitSummary {
  return {
    at,
    sinceInput: at,
    inputTs: 0,
    gestureTs: 0,
    inputType: 'click',
    rendered: 801,
    hydrated: false,
    truncated: false,
    roots: ['OrderSummary'],
    hotPath: ['OrderSummary'],
    components: [{ name: 'LineItem', count: 800, self: null, total: null }],
    hasDurations: false,
    coarseClock: false,
    total: 0,
    startedAt: null,
    walkMs: 1,
    priority: undefined,
    didError: false,
    ...opts,
  };
}

/** The same commit where React measured it, as development and profiling builds do. */
const measured = (at: number, opts: Partial<CommitSummary> = {}) => commit(at, { hasDurations: true, total: 120, components: [{ name: 'LineItem', count: 800, self: 110, total: 0.2 }], ...opts });

test('beside a development build of React 19.2 or later only the interaction is drawn, because React draws every render it measured', () => {
  const r = report([measured(150, { priority: 1 })]);
  const { drawn, left } = recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 1)]).draw(r));
  assert.deepEqual(
    drawn.map(({ via, label, track, group, color }) => ({ via, label, track, group, color })),
    [{ via: 'measure', label: '200 ms click · OrderSummary', track: 'Interaction blame', group: 'react-inp-blame', color: 'warning' }],
  );
  assert.equal(drawn[0]?.tooltip, `${r.verdict} Each component's render is in React's own Components ⚛ track.`);
  assert.deepEqual(left, [], 'the measure stayed in the User Timing buffer');
});

test('a profiling build of React 19.2 or later also draws the renders it measured, so there too only the interaction is drawn', () => {
  const r = report([measured(150, { priority: 1 })]);
  const { drawn } = recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(r));
  assert.deepEqual(
    drawn.map((d) => `${d.via} ${d.track}`),
    ['measure Interaction blame'],
  );
});

test('development builds before React 19.2 draw no Components track, so the renders are drawn beside them', () => {
  const r = report([measured(150, { priority: 1 })]);
  const { drawn } = recording(CHROME_147, () => createTimeline(() => [reactDom('18.3.1', 1)]).draw(r));
  assert.deepEqual(
    drawn.map((d) => `${d.via} ${d.track}`),
    ['measure Interaction blame', 'timeStamp React renders'],
  );
});

test("where React draws no renders itself, they go to console.timeStamp in Chrome 134+, in React's colours", () => {
  // A profiling build of React 18 passes the priority: the click's blocking render, a transition it started, a render that threw.
  const profiled = report([measured(150, { priority: 1 }), measured(160, { priority: 3 }), measured(170, { priority: 1, didError: true })]);
  const { drawn: fromProfiling } = recording(CHROME_147, () => createTimeline(() => [reactDom('18.3.1', 0)]).draw(profiled));
  assert.deepEqual(
    fromProfiling.map((d) => `${d.via} ${d.group} / ${d.track}: ${d.color} ${d.label}`),
    [
      'measure react-inp-blame / Interaction blame: warning 200 ms click · OrderSummary',
      'timeStamp react-inp-blame / React renders: primary React render · OrderSummary (801 components)',
      'timeStamp react-inp-blame / React renders: tertiary React render · OrderSummary (801 components)',
      'timeStamp react-inp-blame / React renders: error React render · OrderSummary (801 components)',
    ],
  );

  // A production build of React 19 measures nothing and passes no priority, so the paint decides: the click's own render, then a later one.
  const data = buildReport([click], [commit(150)], null);
  const later = attachLaterRender(data, commit(400), null);
  assert.ok(later);
  const { drawn: fromProduction, left } = recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(sealReport(later)));
  assert.deepEqual(
    fromProduction.map((d) => `${d.via} ${d.track}: ${d.color} ${d.label}`),
    ['measure Interaction blame: warning 200 ms click · OrderSummary', 'timeStamp React renders: primary React render · OrderSummary (801 components)', 'timeStamp React renders: tertiary Later render · OrderSummary (801 components)'],
  );
  assert.deepEqual(left, []);
});

test('beside React 17, which passes the same priority with every commit, a render is coloured by where it landed', () => {
  // React 17 passes 99, immediate, with the click's own render and with the render its effect set off after the paint.
  const data = buildReport([click], [measured(150, { priority: 99 })], null);
  const later = attachLaterRender(data, measured(400, { priority: 99 }), null);
  assert.ok(later);
  const { drawn } = recording(CHROME_147, () => createTimeline(() => [reactDom('17.0.2', 1)]).draw(sealReport(later)));
  assert.deepEqual(
    drawn.filter((d) => d.track === 'React renders').map((d) => `${d.color} ${d.label}`),
    ['primary React render · OrderSummary (801 components)', 'tertiary Later render · OrderSummary (801 components)'],
  );
});

test('the interaction entry is named after the heaviest render before the paint, the one its tooltip blames', () => {
  // The click's own render touched 2 components; a layout effect then set state, and 801 re-rendered.
  const own = commit(20, { rendered: 2, roots: ['CartButton'], hotPath: ['CartButton'], components: [{ name: 'CartButton', count: 2, self: null, total: null }] });
  const r = report([own, commit(170)]);
  const { drawn } = recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(r));
  const [interaction] = drawn;
  assert.equal(interaction?.label, '200 ms click · OrderSummary');
  assert.deepEqual(
    interaction?.properties?.find(([name]) => name === 'Heaviest path'),
    ['Heaviest path', 'OrderSummary'],
  );
  assert.equal(r.explanation.blame.name, 'OrderSummary');
});

test('before Chrome 134, and in other browsers, every entry is a performance.measure, taken out of the buffer once drawn', () => {
  for (const userAgent of [CHROME_133, FIREFOX]) {
    const r = report([measured(150, { priority: 1 })]);
    // Even beside React 19.3 in development: its Components track needs the console.timeStamp these browsers lack.
    const { drawn, left } = recording(userAgent, () => createTimeline(() => [reactDom('19.3.0', 1)]).draw(r));
    assert.deepEqual(
      drawn.map((d) => `${d.via} ${d.track}: ${d.color}`),
      ['measure Interaction blame: warning', 'measure React renders: primary'],
      userAgent,
    );
    assert.deepEqual(left, [], userAgent);
  }
});

test('drawing a report again, or its next revision, adds only what is new about it', () => {
  const data = buildReport([click], [commit(150)], null);
  const first = sealReport(data);
  const later = attachLaterRender(data, commit(400), null);
  assert.ok(later);
  const { drawn } = recording(CHROME_147, () => {
    const timeline = createTimeline(() => [reactDom('19.3.0', 0)]);
    timeline.draw(first);
    timeline.draw(first);
    timeline.draw(sealReport(later));
  });
  assert.deepEqual(
    drawn.map((d) => d.label),
    ['200 ms click · OrderSummary', 'React render · OrderSummary (801 components)', 'Later render · OrderSummary (801 components)'],
  );
});
