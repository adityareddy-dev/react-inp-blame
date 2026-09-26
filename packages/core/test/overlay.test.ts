import assert from 'node:assert/strict';
import { test } from 'node:test';
import { laterRenderOf, renderedVerb } from '../src/join.ts';
import { laterDetail, titleFor } from '../src/overlay.ts';
import type { CommitSummary, InteractionReport } from '../src/types.ts';

// Only what a row's title reads: the report's type, its target's label and the names of its entries.
function report(type: string, label: string | null, entries: string[]): InteractionReport {
  const target = label === null ? null : { label, selector: 'x' };
  return { type, target, entries: entries.map((name) => ({ name })) } as unknown as InteractionReport;
}

// Entries as Chrome records them for each key (checked on a Next.js 15.5 page): a key that types a
// character, Enter in a text field among them, also fires a keypress; Escape and Tab fire only a
// keydown; Enter on a button ends in a click.
test('a panel row reads as typing only for a key that typed into a field, and any other key as a key press', () => {
  assert.equal(titleFor(report('keydown', 'button "Close"', ['keydown'])), 'Key press on "Close"');
  assert.equal(titleFor(report('keydown', 'input "Search"', ['keydown'])), 'Key press on "Search"');
  assert.equal(titleFor(report('keyup', 'input "Search"', ['keyup'])), 'Key press on "Search"');
  assert.equal(titleFor(report('keydown', 'button "Close"', ['keydown', 'keypress'])), 'Key press on "Close"');
  assert.equal(titleFor(report('keydown', 'link "Home"', ['keydown', 'keypress'])), 'Key press on "Home"');
  assert.equal(titleFor(report('keydown', null, ['keydown'])), 'Key press');

  assert.equal(titleFor(report('keydown', 'input "Search"', ['keydown', 'keypress'])), 'Typing in "Search"');
  assert.equal(titleFor(report('keydown', 'div "edit"', ['keydown', 'keypress'])), 'Typing in "edit"');
  assert.equal(titleFor(report('keydown', null, ['keydown', 'keypress'])), 'Typing');
  assert.equal(titleFor(report('input', 'textarea "Notes"', ['input'])), 'Typing in "Notes"');
  assert.equal(titleFor(report('change', 'select "Size"', ['change'])), 'Typing in "Size"');

  assert.equal(titleFor(report('click', 'button "Close"', ['keydown', 'keypress', 'click'])), 'Click on "Close"');
  assert.equal(titleFor(report('pointerup', 'button "Close"', ['pointerdown', 'pointerup', 'click'])), 'Click on "Close"');
});

test("the panel's line for a later render says what the render was made of in the verdict's words", () => {
  const later = (rendered: number, components: [string, number, number?][], total = 0) =>
    ({ rendered, truncated: false, hasDurations: total > 0, total, components: components.map(([name, count, self]) => ({ name, count, self: self ?? null, total: self ?? null })) }) as unknown as CommitSummary;
  // Four Labels are not what a render of 59 components was made of.
  assert.equal(laterDetail(later(59, [['Label', 4], ['Button', 3]])), '59 components');
  assert.equal(laterDetail(later(801, [['LineItem', 800], ['OrderSummary', 1]])), 'LineItem ×800');
  assert.equal(laterDetail(later(637, [['TableBody', 1, 257], ['TableBodyRow', 36, 10]], 277)), "TableBody's own render");
  // Most of the time in one component, too little of it for its own render to be named, is not "Chart ×1".
  assert.equal(laterDetail(later(40, [['Chart', 1, 15], ['Bar', 10, 2]], 20)), '40 components');
  assert.equal(laterDetail(later(1, [['Toast', 1, 30]], 30)), '1 component');
  // The count inside the component the row names, where the walk counted fewer there than in the commit.
  assert.equal(laterDetail({ ...later(59, [['Label', 4]]), pathRendered: 31 }), '31 of 59 components');
  // A row's verb: a render that mounted most of what it rendered mounted, the way the verdict says.
  assert.equal(renderedVerb({ ...later(59, [['Label', 4]]), mounted: 57 }), 'mounted');
  assert.equal(renderedVerb({ ...later(59, [['Label', 4]]), mounted: 20 }), 're-rendered');
  assert.equal(renderedVerb(later(59, [['Label', 4]])), 're-rendered');
});

test('the panel names the later render the note speaks of: one INP left out before a heavier one on the release', () => {
  // A 32 ms pointerdown held past its paint, the 60 ms render its pointerup made inside its own entry, and
  // a 40 ms one its effects made after the release painted. The row and "Rendered after the paint" read it.
  const entries = [
    { name: 'pointerdown', startTime: 0, duration: 32, processingStart: 2, processingEnd: 24 },
    { name: 'pointerup', startTime: 60, duration: 24, processingStart: 61, processingEnd: 72 },
  ];
  const render = (at: number, total: number, name: string) =>
    ({ at, inputTs: 60, gestureTs: 0, startedAt: null, hasDurations: true, total, rendered: 30, components: [{ name, count: 30, self: total, total }] }) as unknown as CommitSummary;
  const release = render(70, 60, 'Canvas');
  const effect = render(400, 40, 'Toolbar');
  const r = { entries, followUps: [release, effect] } as unknown as InteractionReport;
  assert.equal(laterRenderOf(r), effect);
  // Where INP timed every one, the heaviest of them.
  assert.equal(laterRenderOf({ ...r, followUps: [release] }), release);
  assert.equal(laterRenderOf({ ...r, followUps: [] }), null);
});
