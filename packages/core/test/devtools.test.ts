import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTimeline } from '../src/devtools.ts';
import type { InputRecord } from '../src/hook.ts';
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
  start: number;
  end: number;
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
  console.timeStamp = ((label: string, start: number, end: number, track: string, group: string, color: string) => {
    drawn.push({ via: 'timeStamp', label, track, group, color, start, end });
  }) as typeof console.timeStamp;
  Object.defineProperty(performance, 'measure', {
    configurable: true,
    value: (name: string, options: { start: number; end: number; detail: { devtools: { track: string; trackGroup: string; color: string; tooltipText: string; properties: [string, string][] } } }) => {
      const { track, trackGroup, color, tooltipText, properties } = options.detail.devtools;
      drawn.push({ via: 'measure', label: name, track, group: trackGroup, color, start: options.start, end: options.end, tooltip: tooltipText, properties });
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
    effectsStartedAt: null,
    effectsEndedAt: null,
    walkMs: 1,
    priority: undefined,
    didError: false,
    ...opts,
  };
}

/** The same commit where React measured it, as development and profiling builds do. */
const measured = (at: number, opts: Partial<CommitSummary> = {}) => commit(at, { hasDurations: true, total: 120, components: [{ name: 'LineItem', count: 800, self: 110, total: 0.2 }], ...opts });

/** A Summary row of the interaction entry. */
const row = (d: Drawn | undefined, name: string) => d?.properties?.find(([n]) => n === name)?.[1];

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
    [
      'measure Interaction blame: warning 200 ms click · OrderSummary',
      'timeStamp React renders: primary React render · OrderSummary (801 components, time not measured)',
      'timeStamp React renders: tertiary Later render · OrderSummary (801 components, time not measured)',
    ],
  );
  assert.deepEqual(left, []);
});

test('a render the build did not time is drawn with no length where it committed, and its name says the time was not measured', () => {
  // Drawn half a millisecond long, it hovered in the Performance panel as "0.50 ms React render · OrderSummary (801
  // components)" beside a tooltip that put about 170 ms on the render. With no length, a console.timeStamp entry is
  // hovered by its name alone and a measure by its tooltip, so both say it.
  const data = buildReport([click], [commit(150)], null);
  const later = attachLaterRender(data, commit(400), null);
  assert.ok(later);
  const r = sealReport(later);
  for (const userAgent of [CHROME_147, CHROME_133]) {
    const { drawn } = recording(userAgent, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(r));
    assert.deepEqual(
      drawn.filter((d) => d.track === 'React renders').map(({ label, start, end }) => ({ label, start, end })),
      [
        { label: 'React render · OrderSummary (801 components, time not measured)', start: 150, end: 150 },
        { label: 'Later render · OrderSummary (801 components, time not measured)', start: 400, end: 400 },
      ],
      userAgent,
    );
  }
  const { drawn: measures } = recording(CHROME_133, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(r));
  assert.equal(measures.find((d) => d.track === 'React renders')?.tooltip, '801 components rendered, time not measured; heaviest path OrderSummary');
  // One React timed is drawn across the time it took.
  const { drawn } = recording(CHROME_147, () => createTimeline(() => [reactDom('18.3.1', 0)]).draw(report([measured(150, { priority: 1 })])));
  assert.deepEqual(
    drawn.filter((d) => d.track === 'React renders').map(({ label, start, end }) => ({ label, start, end })),
    [{ label: 'React render · OrderSummary (801 components)', start: 30, end: 150 }],
  );
  const { drawn: timed } = recording(CHROME_133, () => createTimeline(() => [reactDom('18.3.1', 0)]).draw(report([measured(150, { priority: 1 })])));
  assert.equal(timed.find((d) => d.track === 'React renders')?.tooltip, '801 components rendered; heaviest path OrderSummary');
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

test('a render a key press set off before its slower keyup is drawn as a later render, from where it began', () => {
  // The keydown painted at 24 and its render landed at 150, before the key came up at 300. Where both entries
  // were in the report the first time it was drawn, the render was the keyup's own, drawn from 300 back to 150.
  const key = (ts: number, type: string): InputRecord => ({ ts, type, gestureTs: 0, press: 'KeyA', target: null, owners: [], handler: null, dehydrated: null, work: { endedAt: ts, unjoined: [] } });
  const entries = [
    { ...click, name: 'keydown', startTime: 0, duration: 24, processingStart: 1, processingEnd: 10 },
    { ...click, name: 'keyup', startTime: 300, duration: 48, processingStart: 301, processingEnd: 340 },
  ];
  const r = sealReport(buildReport(entries, [commit(150, { inputType: 'keydown' })], null, [key(0, 'keydown'), key(300, 'keyup')]));
  assert.deepEqual(r.followUps.map((c) => c.at), [150]);
  const { drawn } = recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(r));
  assert.deepEqual(
    drawn.filter((d) => d.track === 'React renders').map(({ label, start, end, color }) => ({ label, start, end, color })),
    [{ label: 'Later render · OrderSummary (801 components, time not measured)', start: 150, end: 150, color: 'tertiary' }],
  );
  // Drawn as a measure, its tooltip said it rendered after the screen updated, and the interaction's count
  // said it was one of the renders after the paint, which read as after the keyup's.
  const { drawn: measures } = recording(CHROME_133, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(r));
  assert.equal(measures.find((d) => d.track === 'React renders')?.tooltip, '801 components rendered after the press painted, time not measured; heaviest path OrderSummary');
  assert.deepEqual(measures[0]?.properties?.find(([name]) => name.includes('after') || name.startsWith('Later')), ['Later React renders', '1']);
  // A render after the paint the report is about still says so.
  const clicked = buildReport([click], [commit(150)], null);
  const after = attachLaterRender(clicked, commit(400), null);
  assert.ok(after);
  const { drawn: late } = recording(CHROME_133, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(sealReport(after)));
  assert.equal(late.find((d) => d.label.startsWith('Later render'))?.tooltip, '801 components rendered after the screen updated, time not measured; heaviest path OrderSummary');
  // One the report put before the paint is the interaction's own render, drawn so, though it committed after
  // the paint as the rounded duration has it: the handlers ran to 205, past a 200 ms duration.
  const rounded = sealReport(buildReport([{ ...click, processingEnd: 205 }], [commit(203)], null));
  assert.deepEqual(rounded.commits.map((c) => c.at), [203]);
  const { drawn: own } = recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(rounded));
  assert.deepEqual(
    own.filter((d) => d.track === 'React renders').map(({ label, start, end, color }) => ({ label, start, end, color })),
    [{ label: 'React render · OrderSummary (801 components, time not measured)', start: 203, end: 203, color: 'primary' }],
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

test('a render whose walk could not tell where it started is named after no component, though its path still shows the one the roots sit under', () => {
  // A production walk cut at its budget under an App that did not render, and beside a Toaster it never reached.
  const cut = { rendered: 5000, truncated: true, pathStart: 'unknown-root' as const, components: [{ name: 'Row', count: 4998, self: null, total: null }] };
  for (const [opts, path] of [
    [{ roots: ['Orders', 'Metrics'], hotPath: ['App'] }, ['Heaviest path', 'App']],
    [{ roots: ['App'], hotPath: [] }, undefined],
  ] as const) {
    const r = report([commit(150, { ...cut, ...opts })]);
    const { drawn } = recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(r));
    assert.deepEqual(
      drawn.map((d) => d.label),
      ['200 ms click', 'React render · root (at least 5000 components, time not measured)'],
    );
    assert.deepEqual(drawn[0]?.properties?.find(([name]) => name === 'Heaviest path'), path);
    assert.equal(r.explanation.blame.name, 'the app');
  }
});

test("the interaction entry takes the start a layout blame is named after, where that start is the heaviest render's", () => {
  // Closing a Sheet on the shadcn/ui docs, production build: 56 components from Dialog down, 15 of them inside
  // DismissableLayer, and 87 ms of layout forced in BODY.onclick. The tooltip blamed Dialog and the entry read DismissableLayer.
  const close = { ...click, duration: 160, processingStart: 3.2, processingEnd: 105 };
  const hotPath = ['Dialog', 'DialogProvider', 'SheetContent', 'Presence', 'Portal', 'DialogContent', 'FocusScope', 'DismissableLayer'];
  const sheet = commit(60, { rendered: 56, mounted: 0, roots: ['Dialog'], hotPath, startRendered: 56, pathRendered: 15, components: [{ name: 'Presence', count: 4, self: null, total: null }] });
  const frames = [{ start: 0, duration: 160, blocking: 110, forcedLayout: 87, scripts: [{ invoker: 'BODY.onclick', name: '', source: 'app.js', start: 3.2, duration: 101.8, forcedLayout: 87 }], styleAndLayoutStart: null }];
  const label = (r: ReturnType<typeof report>) => recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(r)).drawn[0]?.label;
  const layout = sealReport(buildReport([close], [sheet], frames));
  assert.deepEqual([layout.explanation.blame.kind, layout.explanation.blame.name], ['layout', 'Dialog']);
  assert.equal(label(layout), '160 ms click · Dialog');
  // A render blame on the same commit is named after where the render went, and so is the entry.
  const render = sealReport(buildReport([close], [sheet], null));
  assert.deepEqual([render.explanation.blame.kind, render.explanation.blame.name], ['render', 'DismissableLayer']);
  assert.equal(label(render), '160 ms click · DismissableLayer');
});

test("the interaction's count of renders before the paint is the tooltip's, and says how many were too small to count", () => {
  // Shaped like opening the shadcn/ui Sheet: six commits before the paint, three with work in them, and an empty
  // one and two small ones beside them. The tooltip said React rendered 3 times and the Summary said 6.
  const small = (at: number, rendered: number) => commit(at, { rendered, roots: rendered ? ['Presence'] : [], hotPath: rendered ? ['Presence'] : [], components: rendered ? [{ name: 'Presence', count: rendered, self: null, total: null }] : [] });
  const r = report([commit(20), small(30, 0), commit(60), small(70, 2), commit(100), small(110, 3)]);
  assert.match(r.verdict, / React rendered 3 times before the screen updated,/);
  const { drawn } = recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(r));
  const count = (d: Drawn | undefined) => d?.properties?.find(([name]) => name === 'React renders before the paint')?.[1];
  assert.equal(count(drawn[0]), '3, and 3 too small to count');
  // Every one of them is still drawn.
  assert.equal(drawn.filter((d) => d.track === 'React renders').length, 6);
  // Where every render counts, the count is the number alone.
  const { drawn: counted } = recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(report([commit(20), commit(60)])));
  assert.equal(count(counted[0]), '2');
});

test('a small render whose useEffect took the time is the render the tooltip blames, and is counted', () => {
  // Chart renders in 3 ms and its useEffect draws for 300 ms. The tooltip blamed Chart for 304 ms, and the Summary
  // said "0, and 1 too small to count".
  const tap: InputRecord[] = [{ ts: 0, type: 'click', gestureTs: 0, press: undefined, target: null, owners: ['Chart'], handler: 'onClick', key: null, dehydrated: null, work: { endedAt: 0, unjoined: [] } }];
  const chart = { rendered: 1, roots: ['Chart'], hotPath: ['Chart'], effectsStartedAt: 10, effectsEndedAt: 310, priority: 1 };
  const small = { ...chart, startedAt: 6, total: 3, components: [{ name: 'Chart', count: 1, self: 3, total: 3 }] };
  const handled = { ...click, duration: 330, processingStart: 3, processingEnd: 320 };
  const builds: [string, CommitSummary, RendererInfo][] = [
    ['development', measured(10, small), reactDom('18.3.1', 1)],
    ['production', commit(10, { ...chart, components: [{ name: 'Chart', count: 1, self: null, total: null }] }), reactDom('19.3.0', 0)],
  ];
  for (const [build, c, dom] of builds) {
    const r = sealReport(buildReport([handled], [c], null, tap));
    assert.equal(r.explanation.blame.kind, 'render', build);
    assert.equal(r.explanation.blame.name, 'Chart', build);
    const { drawn } = recording(CHROME_147, () => createTimeline(() => [dom]).draw(r));
    assert.equal(row(drawn[0], 'React renders before the paint'), '1', build);
  }
  // Where the useEffect set state and React rendered that, it is two renders, in the note and in the Summary.
  const updated = sealReport(buildReport([handled], [measured(10, { ...small, effectsEndedAt: 110 }), measured(315, { startedAt: 115, total: 200, priority: 1 })], null, tap));
  assert.match(updated.verdict, / React rendered 2 times before the screen updated,/);
  const { drawn: twice } = recording(CHROME_147, () => createTimeline(() => [reactDom('18.3.1', 1)]).draw(updated));
  assert.equal(row(twice[0], 'React renders before the paint'), '2');
  // Effects spread over two small commits, neither enough alone: both are counted, as the tooltip's time "across 2
  // commits" counts them. The Summary said "1, and 1 too small to count" beside that.
  const spread = sealReport(
    buildReport([{ ...handled, duration: 80, processingEnd: 60 }], [measured(10, { ...small, effectsEndedAt: 30 }), measured(35, { ...small, startedAt: 31, effectsStartedAt: 35, effectsEndedAt: 55 })], null, tap),
  );
  assert.equal(spread.explanation.blame.kind, 'render');
  assert.match(spread.verdict, / React spent 6 ms rendering across 2 commits, 3 ms of it re-rendering Chart\. /);
  const { drawn: spreadDrawn } = recording(CHROME_147, () => createTimeline(() => [reactDom('18.3.1', 1)]).draw(spread));
  assert.equal(row(spreadDrawn[0], 'React renders before the paint'), '2');
});

test('the small render a layout blame names is counted, as the tooltip blames it', () => {
  // A production commit of 4 components from Popover, inside the root's click listener that forced 100 ms of layout
  // over 178 ms of handlers. The tooltip blamed Popover, and the Summary said "0, and 1 too small to count".
  const popover = commit(60, { rendered: 4, roots: ['Popover'], hotPath: ['Popover'], components: [{ name: 'PopoverContent', count: 4, self: null, total: null }] });
  const frames = [{ start: 0, duration: 200, blocking: 150, forcedLayout: 100, scripts: [{ invoker: 'DIV#root.onclick', name: '', source: 'app.js', start: 2, duration: 178, forcedLayout: 100 }], styleAndLayoutStart: null }];
  const r = sealReport(buildReport([click], [popover], frames));
  assert.deepEqual([r.explanation.blame.kind, r.explanation.blame.name], ['layout', 'Popover']);
  const { drawn } = recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(r));
  assert.equal(row(drawn[0], 'React renders before the paint'), '1');
});

test("the count of renders before the paint leaves out what the tooltip's count leaves out, and says what", () => {
  // A click on server-rendered HTML React had not hydrated yet, as on the Next.js App Router, that then rendered
  // twice. The tooltip said React rendered 2 times and the Summary 3.
  const hydration = measured(50, { total: 90, hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' } });
  const r = report([hydration, measured(100, { total: 30 }), measured(150, { total: 30 })]);
  assert.match(r.verdict, / React rendered 2 times before the screen updated,/);
  const { drawn } = recording(CHROME_147, () => createTimeline(() => [reactDom('18.3.1', 1)]).draw(r));
  assert.equal(row(drawn[0], 'React renders before the paint'), '2, and a hydration');
  // A development build times every render, so a 1 ms one counts in the note and here as it does in the sentences'
  // render time. Only a commit that rendered nothing is too small to count.
  const tiny = report([hydration, measured(100, { total: 30 }), measured(150, { total: 30 }), measured(160, { total: 1, rendered: 2 })]);
  assert.match(tiny.verdict, / React rendered 3 times before the screen updated,/);
  const { drawn: withTiny } = recording(CHROME_147, () => createTimeline(() => [reactDom('18.3.1', 1)]).draw(tiny));
  assert.equal(row(withTiny[0], 'React renders before the paint'), '3, and a hydration');
  const empty = report([hydration, measured(100, { total: 30 }), measured(150, { total: 30 }), measured(160, { total: 0, rendered: 0, roots: [], hotPath: [], components: [] })]);
  assert.match(empty.verdict, / React rendered 2 times before the screen updated,/);
  const { drawn: withSmall } = recording(CHROME_147, () => createTimeline(() => [reactDom('18.3.1', 1)]).draw(empty));
  assert.equal(row(withSmall[0], 'React renders before the paint'), '2, a hydration, and 1 too small to count');
  // A render a script after the handlers forced is the screen update's, not a second render of the click's.
  const script = (invoker: string, start: number, duration: number) => ({ invoker, name: '', source: 'app.js', start, duration, forcedLayout: 0 });
  const frames = [{ start: 0, duration: 368, blocking: 318, forcedLayout: 0, scripts: [script('INPUT.onclick', 2, 169), script('DIV.onscroll', 175, 174)], styleAndLayoutStart: null }];
  const tap: InputRecord[] = [{ ts: 0, type: 'click', gestureTs: 0, press: undefined, target: null, owners: [], handler: null, key: null, dehydrated: null, work: { endedAt: 0, unjoined: [] } }];
  const scrolled = sealReport(buildReport([{ ...click, duration: 368, processingStart: 2, processingEnd: 171 }], [measured(165, { total: 160, priority: 1 }), measured(340, { total: 150, priority: 1 })], frames, tap));
  assert.doesNotMatch(scrolled.verdict, /React rendered 2 times/);
  const { drawn: forced } = recording(CHROME_147, () => createTimeline(() => [reactDom('18.3.1', 1)]).draw(scrolled));
  assert.equal(row(forced[0], 'React renders before the paint'), '1, and 1 forced by a script');
});

test('the note, the sentences that count renders across commits and the Summary give the same count', () => {
  // Each of these read one count of renders in the verdict and another beside it, in the verdict or in the Summary.
  const at = (n: number) => `React rendered ${n} times`;
  const handler = (name: string): InputRecord[] => [{ ts: 0, type: 'click', gestureTs: 0, press: undefined, target: null, owners: ['Chart'], handler: name, key: null, dehydrated: null, work: { endedAt: 0, unjoined: [] } }];
  const chart = { rendered: 1, roots: ['Chart'], hotPath: ['Chart'], effectsStartedAt: 10, effectsEndedAt: 310, priority: 1 };
  const small = { ...chart, startedAt: 6, total: 3, components: [{ name: 'Chart', count: 1, self: 3, total: 3 }] };
  const handled = { ...click, duration: 330, processingStart: 3, processingEnd: 320 };
  const hydrated = { hydrated: true, hydratedTarget: { scope: 'boundary' as const, owner: 'ProductPage' } };
  const few = { rendered: 5, roots: ['List'], hotPath: ['List'], components: [{ name: 'Row', count: 5, self: null, total: null }], effectsStartedAt: 330.2, effectsEndedAt: 365 };
  const cases: [string, ReturnType<typeof report>, RendererInfo, number, string][] = [
    // Renders of 30, 20 and 3 ms in 80 ms of handlers: "across 3 commits" beside "React rendered 2 times".
    [
      'three renders',
      sealReport(buildReport([{ ...click, duration: 103, processingStart: 3, processingEnd: 83 }], [measured(40, { startedAt: 10, total: 30 }), measured(60, { startedAt: 45, total: 20 }), measured(70, { startedAt: 67, total: 3 })], null)),
      reactDom('18.3.1', 1),
      3,
      '3',
    ],
    // A hydration the handler's sentence counts among its commits is counted by the note and the Summary too.
    [
      'a hydration the sentence counted',
      sealReport(buildReport([{ ...click, duration: 216, processingStart: 2, processingEnd: 200 }], [measured(60, { total: 30, ...hydrated }), measured(120, { total: 30 }), measured(190, { total: 30 })], [], handler('handleSave'))),
      reactDom('18.3.1', 1),
      3,
      '3',
    ],
    // A 3 ms render whose useEffect set state, and the render that made.
    ['an effect that set state', sealReport(buildReport([handled], [measured(10, { ...small, effectsEndedAt: 110 }), measured(315, { startedAt: 115, total: 200, priority: 1 })], null, handler('onClick'))), reactDom('18.3.1', 1), 2, '2'],
    // Effects spread over two small commits: "across 2 commits" beside "1, and 1 too small to count".
    [
      'effects over two small commits',
      sealReport(
        buildReport([{ ...handled, duration: 80, processingEnd: 60 }], [measured(10, { ...small, effectsEndedAt: 30 }), measured(35, { ...small, startedAt: 31, effectsStartedAt: 35, effectsEndedAt: 55 })], null, handler('onClick')),
      ),
      reactDom('18.3.1', 1),
      2,
      '2',
    ],
    // A production build's 5 rows whose effects took 35 ms, then 800 rows after the handlers.
    [
      'few rows with long effects',
      sealReport(buildReport([{ ...click, duration: 500, processingStart: 300, processingEnd: 400 }], [commit(330, few), commit(450, { roots: ['List'], hotPath: ['List'] })], null, handler('handleSave'))),
      reactDom('19.3.0', 0),
      2,
      '2',
    ],
  ];
  for (const [name, r, dom, n, summary] of cases) {
    const note = r.verdict.match(/React rendered (\d+) times/);
    if (note) assert.equal(note[1], String(n), `${name}: ${r.verdict}`);
    const across = r.verdict.match(/rendering (?:in all )?across (\d+) commits/);
    if (across) assert.equal(across[1], String(n), `${name}: ${r.verdict}`);
    assert.ok(note || across, `${name} gives no count: ${r.verdict}`);
    const { drawn } = recording(CHROME_147, () => createTimeline(() => [dom]).draw(r));
    assert.equal(row(drawn[0], 'React renders before the paint'), summary, name);
  }
  assert.match(cases[0][1].verdict, new RegExp(`${at(3)} before the screen updated`));
  assert.match(cases[4][1].verdict, new RegExp(`${at(2)} before the screen updated`));
});

test("the Summary's handling time says what the tooltip's time to handle the click counts differently", () => {
  // Opening the shadcn/ui Sheet, the tooltip said 401 ms "of the 474 ms spent handling the click" and the Summary
  // said "Handlers and React rendering 469 ms", with react-inp-blame's own 5 ms two rows further down.
  const forcing = { invoker: 'DIV#root.onclick', name: '', source: 'app.js', start: 0, duration: 118, forcedLayout: 110 };
  const frames = [{ start: 0, duration: 130, blocking: 80, forcedLayout: 110, scripts: [forcing], styleAndLayoutStart: null }];
  const r = sealReport(buildReport([{ ...click, processingStart: 0, processingEnd: 120 }], [commit(90, { walkMs: 20 })], frames));
  assert.match(r.verdict, / Of the 120 ms it took to handle the click, the browser spent 110 ms recalculating styles and layout, leaving 10 ms for /);
  const { drawn } = recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(r));
  assert.equal(row(drawn[0], 'Handlers and React rendering'), '100 ms, not counting react-inp-blame itself');
  assert.equal(row(drawn[0], 'react-inp-blame itself'), '20 ms');
  // With none of the library's time in it, or under half a millisecond, which the verdict does not name, the row is
  // the time alone, and the library's own row is left out.
  for (const walkMs of [0, 0.3]) {
    const { drawn: clean } = recording(CHROME_147, () => createTimeline(() => [reactDom('19.3.0', 0)]).draw(report([commit(150, { walkMs })])));
    assert.equal(row(clean[0], 'Handlers and React rendering'), '178 ms', `${walkMs}`);
    assert.equal(row(clean[0], 'react-inp-blame itself'), undefined, `${walkMs}`);
  }
  // A keydown and a keyup painted together: the tooltip's window also leaves out the 30 ms between the keydown's
  // handlers and the keyup's, which the working time holds. The Summary said "146 ms, not counting react-inp-blame
  // itself", and 146 ms and the 2 ms read did not make the tooltip's 118.
  const keyup = { invoker: 'DIV#root.onkeyup', name: '', source: 'app.js', start: 40, duration: 112, forcedLayout: 100 };
  const keydown = { invoker: 'DIV#root.onkeydown', name: '', source: 'app.js', start: 2, duration: 8, forcedLayout: 0 };
  const keys = sealReport(
    buildReport(
      [
        { ...click, name: 'keydown', startTime: 0, duration: 160, processingStart: 2, processingEnd: 10 },
        { ...click, name: 'keyup', startTime: 30, duration: 130, processingStart: 40, processingEnd: 150 },
      ],
      [measured(148, { total: 2, rendered: 3, walkMs: 2, roots: ['List'], hotPath: ['List'], components: [{ name: 'Row', count: 3, self: 2, total: 2 }] })],
      [{ start: 0, duration: 160, blocking: 110, forcedLayout: 100, scripts: [keydown, keyup], styleAndLayoutStart: null }],
    ),
  );
  assert.match(keys.verdict, / Of the 118 ms it took to handle the key press, /);
  const { drawn: pressed } = recording(CHROME_147, () => createTimeline(() => [reactDom('18.3.1', 1)]).draw(keys));
  assert.equal(row(pressed[0], 'Handlers and React rendering'), "146 ms, 30 ms of it between the keydown's handlers and the keyup's, not counting react-inp-blame itself");
  assert.equal(row(pressed[0], 'react-inp-blame itself'), '2 ms');
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
    ['200 ms click · OrderSummary', 'React render · OrderSummary (801 components, time not measured)', 'Later render · OrderSummary (801 components, time not measured)'],
  );
});
