import assert from 'node:assert/strict';
import { test } from 'node:test';
import { titleFor } from '../src/overlay.ts';
import type { InteractionReport } from '../src/types.ts';

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
