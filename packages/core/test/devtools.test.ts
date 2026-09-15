import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTimeline } from '../src/devtools.ts';
import { attachLaterRender, buildReport } from '../src/join.ts';
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
    value: (name: string, options: { detail: { devtools: Record<string, string> } }) => {
      const { track, trackGroup, color, tooltipText } = options.detail.devtools;
      drawn.push({ via: 'measure', label: name, track, group: trackGroup, color, tooltip: tooltipText });
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

/** The context storm's commit, stamped with the click, without durations. */
function commit(at: number, opts: Partial<CommitSummary> = {}): CommitSummary {
  return {
    at,
    sinceInput: at,
    inputTs: 0,
    gestureTs: 0,
    inputType: 'click',
    rendered: 801,
    truncated: false,
    roots: ['OrderSummary'],
    hotPath: ['OrderSummary'],
    components: [{ name: 'LineItem', count: 800, self: null, total: null }],
    hasDurations: false,
    total: 0,
    walkMs: 1,
    priority: undefined,
    didError: false,
    ...opts,
  };
}

test("beside a development build of React 19.2 or later only the interaction is drawn, because React draws every render itself", () => {
  const r = buildReport([click], [commit(150, { priority: 1 })], null);
  const { drawn, left } = recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 1)]).draw(r));
  assert.deepEqual(
    drawn.map(({ via, label, track, group, color }) => ({ via, label, track, group, color })),
    [{ via: 'measure', label: '200 ms click · OrderSummary', track: 'Interaction blame', group: 'react-inp-blame', color: 'warning' }],
  );
  assert.equal(drawn[0].tooltip, `${r.verdict} Each component's render is in React's own Components ⚛ track.`);
  assert.deepEqual(left, [], 'the measure stayed in the User Timing buffer');
});

test('development builds before React 19.2 draw no Components track, so the renders are drawn beside them', () => {
  const r = buildReport([click], [commit(150, { priority: 1 })], null);
  const { drawn } = recording(CHROME_147, () => createTimeline(() => [reactDom('18.3.1', 1)]).draw(r));
  assert.deepEqual(
    drawn.map((d) => `${d.via} ${d.track}`),
    ['measure Interaction blame', 'timeStamp React renders'],
  );
});

test("in production and profiling builds the renders go to console.timeStamp in Chrome 134+, in React's colours", () => {
  const renderers = [reactDom('19.3.0', 0)];
  // A profiling build passes the priority: the click's blocking render, a transition it started, a render that threw.
  const profiled = buildReport([click], [commit(150, { priority: 1 }), commit(160, { priority: 3 }), commit(170, { priority: 1, didError: true })], null);
  // A production build passes none, so the paint decides: the click's own render, then a later one.
  const production = buildReport([click], [commit(150)], null);
  attachLaterRender(production, commit(400), null);

  const { drawn, left } = recording(CHROME_147, () => {
    const timeline = createTimeline(() => renderers);
    timeline.draw(profiled);
    timeline.draw(production);
  });
  assert.deepEqual(
    drawn.map((d) => `${d.via} ${d.group} / ${d.track}: ${d.color} ${d.label}`),
    [
      'measure react-inp-blame / Interaction blame: warning 200 ms click · OrderSummary',
      'timeStamp react-inp-blame / React renders: primary React render · OrderSummary (801 components)',
      'timeStamp react-inp-blame / React renders: tertiary React render · OrderSummary (801 components)',
      'timeStamp react-inp-blame / React renders: error React render · OrderSummary (801 components)',
      'measure react-inp-blame / Interaction blame: warning 200 ms click · OrderSummary',
      'timeStamp react-inp-blame / React renders: primary React render · OrderSummary (801 components)',
      'timeStamp react-inp-blame / React renders: tertiary Later render · OrderSummary (801 components)',
    ],
  );
  assert.deepEqual(left, []);
});

test('before Chrome 134, and in other browsers, every entry is a performance.measure, taken out of the buffer once drawn', () => {
  for (const userAgent of [CHROME_133, FIREFOX]) {
    const r = buildReport([click], [commit(150, { priority: 1 })], null);
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

test('drawing a report again adds only what is new about it', () => {
  const r = buildReport([click], [commit(150)], null);
  const { drawn } = recording(CHROME_147, () => {
    const timeline = createTimeline(() => [reactDom('19.3.0', 0)]);
    timeline.draw(r);
    timeline.draw(r);
    attachLaterRender(r, commit(400), null);
    timeline.draw(r);
  });
  assert.deepEqual(
    drawn.map((d) => d.label),
    ['200 ms click · OrderSummary', 'React render · OrderSummary (801 components)', 'Later render · OrderSummary (801 components)'],
  );
});
