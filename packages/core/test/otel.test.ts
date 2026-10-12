import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InputRecord } from '../src/hook.ts';
import { inertApi } from '../src/inert.ts';
import { page, unexplainedReports } from '../src/install-state.ts';
import { buildReport, sealReport } from '../src/join.ts';
import { InpBlameLogRecordProcessor, inpBlameAttributes, type InpBlameAttributes, type InpLogRecordLike } from '../src/otel.ts';
import type { CommitSummary, FrameSummary, InteractionReport } from '../src/types.ts';
import { attributeINP } from '../src/web-vitals.ts';

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
    effectsStartedAt: null,
    effectsEndedAt: null,
    walkMs: 0,
    priority: 1,
    didError: false,
    ...opts,
  };
}

const reportOf = (...args: Parameters<typeof buildReport>): InteractionReport => sealReport(buildReport(...args));

/** Puts `reports` behind the page's installation for the length of one test, as install() would. */
function installed(reports: InteractionReport[] | (() => InteractionReport[])): () => void {
  page.installed = { api: { ...inertApi('none'), reports: typeof reports === 'function' ? reports : () => reports }, reapply: () => {} };
  return () => {
    page.installed = null;
  };
}

/** An input the hook's ring holds for the click, naming the components around what was clicked, nearest first. */
function input(ts: number, extra: Partial<InputRecord> = {}): InputRecord {
  return { ts, type: 'click', gestureTs: ts, press: undefined, target: null, owners: [], handler: null, key: null, dehydrated: null, work: { endedAt: ts, unjoined: [] }, ...extra };
}

/** A detached button as a report's target reads one, with no text or attributes to label it by. */
const button = (): Node => ({ nodeType: 1, tagName: 'BUTTON', id: '', classList: { length: 0 }, parentNode: null, parentElement: null, nextSibling: null, firstChild: null, getAttribute: () => null }) as unknown as Node;

/** The click's report, with the components around the button, nearest first. */
const clicked = (owners: string[], opts: Partial<CommitSummary> = {}) => reportOf(CLICK, [commit(opts)], [], [input(100, { target: button(), owners, handler: 'onClick' })]);

const origin = performance.timeOrigin;
/** The SDK's HrTime for a time on the page's clock, as LogRecordImpl stores it. */
function hrTime(ms: number): [number, number] {
  const epoch = origin + ms;
  const seconds = Math.trunc(epoch / 1e3);
  return [seconds, Math.round((epoch - seconds * 1e3) * 1e6)];
}

/** The browser.web_vital record OpenTelemetry's web vitals instrumentation emits for INP. */
const record = (time: Partial<InpLogRecordLike>, value = 240, name = 'inp'): InpLogRecordLike => ({
  attributes: { 'browser.web_vital.name': name, 'browser.web_vital.value': value, 'browser.web_vital.rating': 'needs-improvement' },
  ...time,
});

/** A web-vitals INP metric whose entries getter throws. */
const unreadable = {
  name: 'INP',
  value: 200,
  get entries(): object[] {
    throw new Error('a getter that throws');
  },
};

const statusOf = (attributes: InpBlameAttributes) => attributes['react_inp_blame.status'];

test('a record is matched on its time and value, read back from the HrTime the SDK stores', (t) => {
  t.after(installed([clicked(['LineItem', 'OrderSummary', 'Page'])]));
  const attributes = inpBlameAttributes(record({ hrTime: hrTime(100) }));
  assert.equal(statusOf(attributes), 'matched');
  assert.equal(attributes['react_inp_blame.blame.kind'], 'render');
  assert.equal(attributes['react_inp_blame.blame.name'], attributeINP({ entries: CLICK }).react?.blame.name);
  assert.equal(attributes['react_inp_blame.target.components'], 'Page > OrderSummary > LineItem');
  assert.equal(attributes['react_inp_blame.handler'], 'onClick');
  assert.equal(Object.isFrozen(attributes), true);
});

test('a record is matched through any entry of a report, where the headline is another', (t) => {
  // The pointerdown painted in the same frame at the same duration; the click is the headline.
  const entries = [{ ...CLICK[0], name: 'pointerdown', startTime: 96, duration: 244 }, { ...CLICK[0], startTime: 100, duration: 240 }];
  const report = reportOf(entries, [commit()], []);
  t.after(installed([report]));
  assert.equal(report.start, 96);
  assert.equal(statusOf(inpBlameAttributes(record({ timestamp: 100 }))), 'matched');
});

test('a time under 1 ms off matches, over 1 ms off does not, and never with another duration', (t) => {
  t.after(installed([clicked([])]));
  assert.equal(statusOf(inpBlameAttributes(record({ timestamp: 100.9 }))), 'matched');
  assert.equal(statusOf(inpBlameAttributes(record({ timestamp: 99.1 }))), 'matched');
  assert.equal(statusOf(inpBlameAttributes(record({ timestamp: 101.1 }))), 'no-report');
  assert.equal(statusOf(inpBlameAttributes(record({ timestamp: 98.9 }))), 'no-report');
  assert.equal(statusOf(inpBlameAttributes(record({ timestamp: 100 }, 248))), 'no-report');
  assert.deepEqual(inpBlameAttributes(record({ timestamp: 101.1 })), { 'react_inp_blame.status': 'no-report' });
});

test('every shape a time comes in is read back to the page clock', (t) => {
  t.after(installed([clicked([])]));
  const matched = (time: Partial<InpLogRecordLike>) => statusOf(inpBlameAttributes(record(time)));
  assert.equal(matched({ hrTime: hrTime(100) }), 'matched');
  // Embrace stamps timeOrigin + interactionTime as an HrTime of its own.
  assert.equal(matched({ timestamp: hrTime(100) }), 'matched');
  assert.equal(matched({ timestamp: 100 }), 'matched');
  assert.equal(matched({ timestamp: origin + 100 }), 'matched');
  assert.equal(matched({ timestamp: new Date(origin + 100.4) }), 'matched');
  assert.equal(matched({}), 'no-report');
  assert.equal(matched({ timestamp: 'soon' }), 'no-report');
});

test("a number is Faro's interaction_time and matches on time alone", (t) => {
  t.after(installed([clicked([])]));
  assert.equal(statusOf(inpBlameAttributes(100)), 'matched');
  assert.equal(statusOf(inpBlameAttributes(origin + 100.5)), 'matched');
  assert.equal(statusOf(inpBlameAttributes(102)), 'no-report');
});

test('a metric joins on its entries\' interactionId, and the newest report wins for an id', (t) => {
  const older = clicked(['Older'], { hotPath: ['Older'] });
  const newer = clicked(['Newer'], { hotPath: ['Newer'] });
  t.after(installed([older, newer]));
  const attributes = inpBlameAttributes({ name: 'INP', entries: CLICK });
  assert.equal(statusOf(attributes), 'matched');
  assert.equal(attributes['react_inp_blame.hot_path'], 'Newer');
  assert.equal(attributes['react_inp_blame.target.components'], 'Newer');
  // No time is read off a metric: its id is the join.
  assert.equal(statusOf(inpBlameAttributes({ name: 'INP', entries: [] })), 'no-report');
  assert.equal(statusOf(inpBlameAttributes({ name: 'INP', entries: [{ startTime: 100, duration: 240 }] })), 'no-report');
  assert.equal(statusOf(inpBlameAttributes({ entries: [{ interactionId: 4242 }] })), 'no-report');
});

test('anything that is not INP gets nothing', (t) => {
  t.after(installed([clicked([])]));
  assert.deepEqual(inpBlameAttributes(record({ timestamp: 100 }, 240, 'lcp')), {});
  assert.deepEqual(inpBlameAttributes({ name: 'LCP', entries: CLICK }), {});
  assert.deepEqual(inpBlameAttributes('100' as unknown as number), {});
  assert.deepEqual(inpBlameAttributes({}), {});
  assert.deepEqual(inpBlameAttributes(null), {});
  assert.deepEqual(inpBlameAttributes(undefined), {});
  // The instrumentation lowercases the name, and a hook can see it either way.
  assert.equal(statusOf(inpBlameAttributes(record({ timestamp: 100 }, 240, 'INP'))), 'matched');
});

test('a page the library is not on says so, and so does one that lost the sampleRate roll', (t) => {
  assert.equal(page.installed, null);
  assert.deepEqual(inpBlameAttributes(record({ timestamp: 100 })), { 'react_inp_blame.status': 'not-installed' });
  // An INP metric whose entries can't be read is INP's, and nothing reads them here.
  assert.deepEqual(inpBlameAttributes(unreadable), { 'react_inp_blame.status': 'not-installed' });
  page.sampledOut = inertApi('sampled-out');
  t.after(() => {
    page.sampledOut = null;
  });
  assert.deepEqual(inpBlameAttributes(record({ timestamp: 100 })), { 'react_inp_blame.status': 'sampled-out' });
  assert.deepEqual(inpBlameAttributes(record({ timestamp: 100 }, 240, 'cls')), {});
});

test("a report the library could not explain, and reports() throwing, are the library's error", (t) => {
  const report = clicked([]);
  unexplainedReports.add(report);
  const restore = installed([report]);
  assert.deepEqual(inpBlameAttributes(record({ timestamp: 100 })), { 'react_inp_blame.status': 'library-error' });
  restore();
  t.after(
    installed(() => {
      throw new Error('reports() broke');
    }),
  );
  assert.deepEqual(inpBlameAttributes(record({ timestamp: 100 })), { 'react_inp_blame.status': 'library-error' });
});

test('a source whose getters throw never throws out of inpBlameAttributes or the processor', (t) => {
  t.after(installed([clicked([])]));
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('a getter that throws');
      },
    },
  );
  assert.deepEqual(inpBlameAttributes(hostile as InpLogRecordLike), {});
  // Known to be INP before the time is read: the library's error, not silence.
  const late = record({});
  Object.defineProperty(late, 'hrTime', {
    get() {
      throw new Error('a getter that throws');
    },
  });
  assert.deepEqual(inpBlameAttributes(late), { 'react_inp_blame.status': 'library-error' });
  // A metric named INP whose entries can't be read: INP's, so the library's error too.
  assert.deepEqual(inpBlameAttributes(unreadable), { 'react_inp_blame.status': 'library-error' });
  const processor = new InpBlameLogRecordProcessor();
  assert.doesNotThrow(() => processor.onEmit(hostile as InpLogRecordLike));
  const refusing = {
    ...record({ timestamp: 100 }),
    setAttributes() {
      throw new Error('the record was already emitted');
    },
  };
  assert.doesNotThrow(() => processor.onEmit(refusing));
});

test('the processor uses setAttributes where the record has it, and assigns to attributes where not', async (t) => {
  t.after(installed([clicked([])]));
  const processor = new InpBlameLogRecordProcessor();
  const set: unknown[] = [];
  const sdk = { ...record({ hrTime: hrTime(100) }), setAttributes: (attributes: InpBlameAttributes) => set.push(attributes) };
  processor.onEmit(sdk);
  assert.equal(set.length, 1);
  assert.equal(statusOf(set[0] as InpBlameAttributes), 'matched');
  assert.equal(sdk.attributes?.['react_inp_blame.status'], undefined);

  const plain = record({ timestamp: 100 });
  processor.onEmit(plain);
  assert.equal(plain.attributes?.['react_inp_blame.status'], 'matched');
  // Another web vital's record is left as it was.
  const lcp = record({ timestamp: 100 }, 240, 'lcp');
  processor.onEmit(lcp);
  assert.deepEqual(Object.keys(lcp.attributes ?? {}), ['browser.web_vital.name', 'browser.web_vital.value', 'browser.web_vital.rating']);
  processor.onEmit({ ...record({ hrTime: hrTime(100) }, 240, 'lcp'), setAttributes: (attributes: InpBlameAttributes) => set.push(attributes) });
  assert.equal(set.length, 1);
  await processor.forceFlush();
  await processor.shutdown();
});

test('every attribute name, pinned, so a rename shows up in review', (t) => {
  t.after(installed([reportOf(CLICK, [commit(), commit({ at: 500, sinceInput: 400, total: 30 })], [], [input(100, { target: button(), owners: ['LineItem', 'OrderSummary'], handler: 'onClick' })], 'attributes', [], undefined, 'reading', undefined, 'development')]));
  const attributes = inpBlameAttributes(record({ timestamp: 100 }));
  assert.deepEqual(Object.keys(attributes).sort(), [
    'react_inp_blame.blame.confidence',
    'react_inp_blame.blame.detail',
    'react_inp_blame.blame.kind',
    'react_inp_blame.blame.ms',
    'react_inp_blame.blame.name',
    'react_inp_blame.commits.count',
    'react_inp_blame.commits.ms',
    'react_inp_blame.commits.rendered',
    'react_inp_blame.follow_ups.count',
    'react_inp_blame.follow_ups.ms',
    'react_inp_blame.handler',
    'react_inp_blame.hot_path',
    'react_inp_blame.react_build',
    'react_inp_blame.react_status',
    'react_inp_blame.status',
    'react_inp_blame.target.components',
  ]);
  assert.equal(attributes['react_inp_blame.react_build'], 'development');
  assert.equal(attributes['react_inp_blame.react_status'], 'reading');
  assert.equal(attributes['react_inp_blame.commits.count'], 1);
  assert.equal(attributes['react_inp_blame.commits.ms'], 180);
  assert.equal(attributes['react_inp_blame.follow_ups.count'], 1);
  for (const value of Object.values(attributes)) assert.ok(typeof value === 'string' || typeof value === 'number');
});

test('what is null or empty is left out, and a production render blame sends no durations', (t) => {
  t.after(installed([reportOf(CLICK, [commit({ hasDurations: false, total: 0, hotPath: [] })], [])]));
  const attributes = inpBlameAttributes(record({ timestamp: 100 }));
  assert.equal(attributes['react_inp_blame.blame.kind'], 'render');
  assert.equal(attributes['react_inp_blame.blame.confidence'], 'inferred');
  for (const name of ['blame.ms', 'commits.ms', 'follow_ups.ms', 'handler', 'target.components', 'hot_path', 'react_build']) {
    assert.equal(`react_inp_blame.${name}` in attributes, false, name);
  }
  assert.equal(attributes['react_inp_blame.commits.rendered'], 801);
  for (const value of Object.values(attributes)) assert.notEqual(value, 'null');
});

test('target.components skips unreadable names, keeps the four nearest, reads outermost first, and drops outermost names past 120 characters', (t) => {
  const components = (owners: string[]) => {
    const restore = installed([clicked(owners)]);
    try {
      return inpBlameAttributes(record({ timestamp: 100 }))['react_inp_blame.target.components'];
    } finally {
      restore();
    }
  };
  assert.equal(components(['Row', 'Xe', 'Table', 'styled.div', 'Panel', 'Page', 'App']), 'Page > Panel > Table > Row');
  // Where no name is readable, the nearest are still better than nothing.
  assert.equal(components(['Xe', 'Qt']), 'Qt > Xe');
  const long = (c: string) => `${c.repeat(40)}`;
  assert.equal(components([long('C'), long('B'), long('A')]), `${long('B')} > ${long('C')}`);
  assert.equal(components([long('C').repeat(4)]), long('C').repeat(3));
  t.after(() => {
    page.installed = null;
  });
});

test('a label, a selector, a sentence and the URL never go out, even where labels read text', (t) => {
  const text = { nodeType: 3, nodeValue: 'Jane Doe', parentNode: null, parentElement: null, nextSibling: null, firstChild: null };
  const button = { nodeType: 1, tagName: 'BUTTON', id: 'profile', classList: { length: 0 }, parentNode: null, parentElement: null, nextSibling: null, firstChild: text, getAttribute: () => null };
  text.parentNode = button as never;
  const url = 'https://shop.example/account?email=jane@example.com';
  const report = reportOf(
    [{ ...CLICK[0], target: button as unknown as Node }],
    [commit()],
    [],
    [input(100, { target: button as unknown as Node, owners: ['ProfileCard'], handler: 'onClick' })],
    'text',
    [{ url, type: 'navigate', start: 0, router: null }],
  );
  assert.equal(report.target?.label, 'button "Jane Doe"');
  assert.equal(report.navigationURL, url);
  t.after(installed([report]));
  const attributes = inpBlameAttributes(record({ timestamp: 100 }));
  assert.equal(statusOf(attributes), 'matched');
  for (const value of Object.values(attributes)) {
    assert.doesNotMatch(String(value), /Jane|jane@|#profile|button|\?email/);
  }
});

test('a script blame keeps the listener\'s element id in blame.name, as react-inp-blame/web-vitals gives it', (t) => {
  const frames: FrameSummary[] = [
    { start: 100, duration: 240, blocking: 190, forcedLayout: 0, styleAndLayoutStart: null, scripts: [{ invoker: 'DIV#user-42.onclick', name: '', source: 'app.js', start: 105, duration: 220, forcedLayout: 0 }] },
  ];
  const report = reportOf(CLICK, [], frames);
  t.after(installed([report]));
  const attributes = inpBlameAttributes(record({ timestamp: 100 }));
  assert.equal(attributes['react_inp_blame.blame.name'], 'DIV#user-42.onclick');
  assert.equal(attributes['react_inp_blame.blame.name'], attributeINP({ entries: CLICK }).react?.blame.name);
});
