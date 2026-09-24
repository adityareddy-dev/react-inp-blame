import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inertApi } from '../src/inert.ts';
import { page } from '../src/install-state.ts';
import { buildReport, sealReport } from '../src/join.ts';
import type { CommitSummary, InteractionReport } from '../src/types.ts';
import { attributeINP, generateTarget } from '../src/web-vitals.ts';

// React stores a fiber on a DOM node under a key with the fiber's own random suffix.
const FIBER_KEY = '__reactFiber$r1nd0m';

/** A component fiber as React links them: `return` is the component that rendered this one. */
function component(name: string, parent: Record<string, unknown> | null = null): Record<string, unknown> {
  const fn = Object.defineProperty(function () {}, 'name', { value: name });
  return { tag: 0, flags: 1, mode: 0, elementType: fn, type: fn, memoizedProps: null, memoizedState: null, return: parent, child: null, sibling: null, alternate: null };
}

/** The chain of components enclosing an element, outermost named first, as fibers. */
function owners(...names: string[]): Record<string, unknown> {
  let fiber: Record<string, unknown> | null = null;
  for (const name of names) fiber = component(name, fiber);
  return fiber!;
}

interface ElementOptions {
  attributes?: Record<string, string>;
  classes?: string[];
  id?: string;
  fiber?: Record<string, unknown> | null;
  parentNode?: unknown;
}

/**
 * A DOM element as this entry reads one. Its `textContent` throws: what goes into
 * `interactionTarget` is built from attributes, never from what the element says.
 */
function element(tag: string, { attributes = {}, classes = [], id = '', fiber = null, parentNode = null }: ElementOptions = {}): Record<string, unknown> {
  const el: Record<string, unknown> = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id,
    classList: classes,
    parentNode,
    parentElement: parentNode,
    getAttribute: (name: string) => attributes[name] ?? null,
  };
  if (fiber) el[FIBER_KEY] = fiber;
  Object.defineProperty(el, 'textContent', {
    get() {
      throw new Error('the target description read the whole textContent');
    },
  });
  return el;
}

const textNode = (value: string, parentNode: unknown): Record<string, unknown> => ({ nodeType: 3, nodeValue: value, parentNode, parentElement: parentNode, firstChild: null });

const asNode = (x: unknown): Node => x as Node;

test('the target names the components enclosing the element, outermost first, then the element itself', () => {
  const tile = element('button', { attributes: {}, classes: ['tile'], fiber: owners('ProfilePage', 'PhotoTile') });
  assert.equal(generateTarget(asNode(tile)), 'ProfilePage > PhotoTile (button.tile)');
});

test('a node with no fiber of its own is placed by the nearest element that has one', () => {
  // React puts a fiber on every element it renders, so in a page this is the text inside the button.
  const tile = element('button', { classes: ['tile'], fiber: owners('ProfilePage', 'PhotoTile') });
  assert.equal(generateTarget(asNode(textNode('Open', tile))), 'ProfilePage > PhotoTile (button.tile)');
  // An element the app created outside React is described as itself, under the components above it.
  assert.equal(generateTarget(asNode(element('span', { parentNode: tile }))), 'ProfilePage > PhotoTile (span)');
});

test('the element is described from its attributes, never from the text it shows', () => {
  const save = element('button', { attributes: { 'data-test': 'save' }, id: 'save', classes: ['primary', 'lg'], fiber: owners('Toolbar') });
  assert.equal(generateTarget(asNode(save)), 'Toolbar (button#save[data-test="save"])');
});

test('web-vitals falls back to its own selector when there is no fiber to read', () => {
  // The signature says the node can be null, and web-vitals calls it with whatever an entry carried.
  assert.equal(generateTarget(null), undefined);
  // A page with no React on it, and an element React never rendered.
  assert.equal(generateTarget(asNode(element('div'))), undefined);
  assert.equal(generateTarget(asNode(textNode('plain', null))), undefined);
  // A fiber whose components have no name left worth printing: an anonymous default export, minified away.
  const anonymous = { tag: 0, flags: 1, mode: 0, elementType: null, type: null, memoizedProps: null, memoizedState: null, return: null, child: null, sibling: null, alternate: null };
  assert.equal(generateTarget(asNode(element('button', { fiber: anonymous }))), undefined);
});

test('a node this library cannot read gives up rather than breaking the page metric', () => {
  const throwing = (property: string): Node => {
    const node = element('button', { fiber: owners('Page') });
    Object.defineProperty(node, property, {
      get() {
        throw new Error(`reading ${property} across a document boundary`);
      },
    });
    return asNode(node);
  };
  // A node from another document or a detached tree can throw on any of these.
  for (const property of ['nodeType', 'tagName', 'classList']) {
    assert.equal(generateTarget(throwing(property)), undefined, property);
  }
  const hostile = element('button', { fiber: owners('Page') });
  hostile.getAttribute = () => {
    throw new Error('attribute access refused');
  };
  assert.equal(generateTarget(asNode(hostile)), undefined);

  // The climb to the nearest fiber is where a node from another document usually gives way.
  const detached = element('span');
  Object.defineProperty(detached, 'parentNode', {
    get() {
      throw new Error('reading parentNode across a document boundary');
    },
  });
  assert.equal(generateTarget(asNode(detached)), undefined);
});

test('a deep tree and a long id are capped, keeping the components nearest the element', () => {
  const deep = element('button', { classes: ['tile'], fiber: owners('App', 'Shell', 'Sidebar', 'Filters', 'DateRange', 'Preset') });
  // At most four components, the four nearest the element.
  assert.equal(generateTarget(asNode(deep)), 'Sidebar > Filters > DateRange > Preset (button.tile)');

  const long = element('button', { id: 'x'.repeat(400), fiber: owners('A'.repeat(60), 'B'.repeat(60)) });
  const target = generateTarget(asNode(long));
  assert.ok(target && target.length <= 120, `${target?.length} characters`);
  // The outermost component went first, so the nearest one and the element are both still there.
  assert.ok(target?.startsWith('BBB'), target);
  // The element is shortened to fit rather than cut off the end, so its brackets are never left open.
  assert.ok(target?.includes(' (button#xxx'), target);
  assert.ok(target?.endsWith(')'), target);

  // A component path that fills the cap on its own leaves no room, and the element is dropped whole.
  const wide = element('button', { classes: ['tile'], fiber: owners('C'.repeat(119)) });
  const only = generateTarget(asNode(wide));
  assert.ok(only && only.length <= 120, `${only?.length} characters`);
  assert.equal(only?.includes('('), false, only);
});

// Event Timing entries of one slow click, as the observer hands them over: a click at 100 ms that
// took 240 ms, its handlers running from 104 to 330.
const CLICK = [{ name: 'click', interactionId: 7, startTime: 100, duration: 240, processingStart: 104, processingEnd: 330, target: null }];

function commit(opts: Partial<CommitSummary> = {}): CommitSummary {
  return {
    at: 320,
    sinceInput: 220,
    inputTs: 100,
    gestureTs: 100,
    inputType: 'click',
    rendered: 801,
    hydrated: false,
    truncated: false,
    roots: ['OrderSummary'],
    hotPath: ['OrderSummary', 'LineItem'],
    components: Array.from({ length: 8 }, (_, i) => ({ name: `Part${i}`, count: 100 - i, self: 20 - i, total: 20 - i })),
    hasDurations: true,
    coarseClock: false,
    total: 180,
    startedAt: null,
    walkMs: 0,
    priority: 1,
    didError: false,
    ...opts,
  };
}

const reportOf = (...args: Parameters<typeof buildReport>): InteractionReport => sealReport(buildReport(...args));

/** Puts `reports` behind the page's installation for the length of one test, as install() would. */
function installed(reports: InteractionReport[]): () => void {
  page.installed = { api: { ...inertApi('none'), reports: () => reports }, reapply: () => {} };
  return () => {
    page.installed = null;
  };
}

/** The metric web-vitals' attribution build hands a callback, in the fields this entry reads. */
const metricWithAttribution = { entries: CLICK, attribution: { interactionTarget: 'OrderSummary > LineItem (button.primary)', inputDelay: 4, processingDuration: 226, presentationDelay: 10 } };

test('the attribution keeps every field web-vitals measured and adds one of its own', (t) => {
  const report = reportOf(CLICK, [commit()], []);
  t.after(installed([report]));

  const attribution = attributeINP(metricWithAttribution);
  assert.equal(attribution.interactionTarget, 'OrderSummary > LineItem (button.primary)');
  assert.equal(attribution.processingDuration, 226);
  assert.equal(attribution.react?.interactionId, 7);
  assert.equal(attribution.react?.schemaVersion, 1);
  assert.deepEqual(attribution.react?.hotPath, ['OrderSummary', 'LineItem']);
  assert.deepEqual(attribution.react?.blame, report.explanation.blame);
  assert.equal(attribution.react?.blame.confidence, 'measured');
  // The heaviest commit's components, capped; the whole list stays on the report.
  assert.deepEqual(
    attribution.react?.components.map((c) => c.name),
    ['Part0', 'Part1', 'Part2', 'Part3', 'Part4'],
  );
  assert.deepEqual(attribution.react?.commits, { count: 1, rendered: 801, ms: 180 });
  assert.deepEqual(attribution.react?.followUps, { count: 0, rendered: 0, ms: null });
});

test('a metric from the build without attribution, as Next.js reports it, still gets the React side', (t) => {
  t.after(installed([reportOf(CLICK, [commit()], [])]));
  // useReportWebVitals imports the non-attribution build, so `attribution` is undefined there.
  const attribution = attributeINP({ entries: CLICK });
  assert.deepEqual(Object.keys(attribution), ['react']);
  assert.equal(attribution.react?.hotPath[0], 'OrderSummary');
});

test('what a caller forwards to analytics is frozen, like the report behind it', (t) => {
  t.after(installed([reportOf(CLICK, [commit()], [])]));
  const { react } = attributeINP(metricWithAttribution);
  assert.ok(react);
  assert.equal(Object.isFrozen(react), true);
  assert.equal(Object.isFrozen(react.components), true);
  assert.equal(Object.isFrozen(react.commits), true);
});

test('a production build measures no render, so the summary says so rather than reporting 0 ms', (t) => {
  t.after(installed([reportOf(CLICK, [commit({ hasDurations: false, total: 0 })], [])]));
  const { react } = attributeINP(metricWithAttribution);
  assert.equal(react?.commits.ms, null);
  assert.equal(react?.commits.rendered, 801);
  assert.equal(react?.blame.confidence, 'inferred');
});

test('the join is on the interactionId, which names one report among several', (t) => {
  const other = [{ name: 'keydown', interactionId: 21, startTime: 900, duration: 56, processingStart: 902, processingEnd: 940, target: null }];
  t.after(installed([reportOf(other, [commit({ at: 930, inputTs: 900, hotPath: ['SearchBox'] })], []), reportOf(CLICK, [commit()], [])]));

  assert.equal(attributeINP({ entries: other }).react?.interactionId, 21);
  assert.equal(attributeINP({ entries: CLICK }).react?.interactionId, 7);
  // web-vitals keeps no entry without an id, so an entry without one matches nothing rather than guessing.
  assert.equal(attributeINP({ entries: [{}] }).react, null);
});

test('react is null rather than a guess: nothing installed, and no report for that interaction', (t) => {
  assert.equal(page.installed, null);
  assert.equal(attributeINP(metricWithAttribution).react, null);

  // An interaction the page kept no report for: under the reporting threshold, or pushed out of the 50 kept.
  t.after(installed([reportOf(CLICK, [commit()], [])]));
  assert.equal(attributeINP({ entries: [{ interactionId: 4242 }] }).react, null);
});

test('a metric this library cannot read gives react null rather than throwing in the page callback', (t) => {
  t.after(installed([reportOf(CLICK, [commit()], [])]));
  const broken = (metric: unknown) => attributeINP(metric as Parameters<typeof attributeINP>[0]);

  // Fields this entry reads, missing or of the wrong shape.
  assert.equal(broken({}).react, null);
  assert.equal(broken({ entries: null }).react, null);
  assert.equal(broken({ entries: 'click' }).react, null);
  assert.equal(broken({ entries: [null, undefined] }).react, null);
  assert.equal(broken(null).react, null);

  // A metric whose getters throw: the attribution it did give up is kept, and react is null.
  const hostile = { attribution: { inputDelay: 4 } };
  Object.defineProperty(hostile, 'entries', {
    get() {
      throw new Error('entries read from a detached observer');
    },
  });
  const result = broken(hostile) as { inputDelay?: number; react: unknown };
  assert.equal(result.react, null);
  assert.equal(result.inputDelay, 4);
});
