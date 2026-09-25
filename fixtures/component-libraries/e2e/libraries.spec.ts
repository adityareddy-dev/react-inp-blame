import { expect, test } from '@playwright/test';
import { clickOn, open, slowReport } from './page';

// Libraries whose components used to take the name a report gave the app's own. Every case runs on the dev
// server and on a production build.

test('a list styled with styled-components is blamed on the component that renders it', async ({ page }) => {
  const problems = await open(page);
  await page.getByTestId('reprice').click();
  const r = await slowReport(page);
  expect(r.explanation.blame.kind).toBe('render');
  expect(r.explanation.blame.name).toBe('PriceList');
  expect(r.explanation.blame.detail).toMatch(/^PriceRow ×400\b/);
  expect(r.verdict).not.toMatch(/styled\.|Styled\(/);
  expect(problems).toEqual([]);
});

test('a list styled with @emotion/styled is blamed on the component that renders it', async ({ page }) => {
  const problems = await open(page);
  await page.getByTestId('retag').click();
  const r = await slowReport(page);
  expect(r.explanation.blame.kind).toBe('render');
  expect(r.explanation.blame.name).toBe('TagList');
  expect(r.explanation.blame.detail).toMatch(/^TagRow ×400\b/);
  expect(r.verdict).not.toMatch(/Styled\(|Insertion/);
  expect(problems).toEqual([]);
});

test("a list styled with @emotion/react's css prop is blamed on the component that renders it", async ({ page }) => {
  const problems = await open(page);
  await page.getByTestId('renote').click();
  const r = await slowReport(page);
  expect(r.explanation.blame.kind).toBe('render');
  expect(r.explanation.blame.name).toBe('NoteList');
  expect(r.explanation.blame.detail).toMatch(/^NoteRow ×400\b/);
  expect(r.verdict).not.toMatch(/Emotion|Styled\(|Insertion/);
  // Notes, NoteList, 400 NoteRows and a css-prop wrapper around each of the 401 elements; no Insertion.
  expect(r.commits.reduce((n, c) => n + c.rendered, 0)).toBe(803);
  expect(problems).toEqual([]);
});

test("a click on a button a styling library labelled is named by the app's component, not the label", async ({ page }) => {
  const problems = await open(page);
  await page.getByTestId('buy').click();
  const r = await slowReport(page);
  expect(r.target?.component).toBe('BuyButton');
  expect(r.target?.owners).not.toContain('ShopButtonRoot');
  expect(problems).toEqual([]);
});

test("a click on a card's photo inside a link is named by the card, and an option's icon by the option", async ({ page }) => {
  const problems = await open(page);
  await clickOn(page, '[data-testid=photo]');
  const card = await slowReport(page);
  expect(card.target?.component).toBe('ProductCard');
  expect(card.target?.owners.slice(0, 2)).toEqual(['ProductCard', 'ProductList']);
  expect(card.target?.label).toBe('link "Kettle"');

  await page.evaluate(() => window.__REACT_INP_BLAME__.clear());
  await clickOn(page, '[data-testid=person] svg path');
  const option = await slowReport(page);
  expect(option.target?.component).toBe('PersonOption');
  expect(option.target?.owners.slice(0, 2)).toEqual(['PersonOption', 'PeoplePicker']);
  expect(problems).toEqual([]);
});

test("a click on a lucide-react icon inside a button is named by the button's component", async ({ page }) => {
  const problems = await open(page);
  await clickOn(page, '[data-testid=delete] svg path');
  const r = await slowReport(page);
  expect(r.target).toMatchObject({ component: 'DeleteButton', label: 'button "Delete row"' });
  expect(r.target?.owners[0]).toBe('DeleteButton');
  // The selector is the element the browser reported.
  expect(r.target?.selector).toMatch(/^(path|svg|line)\b/);
  expect(r.verdict).toMatch(/^\d+ ms click on button "Delete row" in DeleteButton\./);
  expect(problems).toEqual([]);
});

test('a click that swaps the icon it landed on is still named by the button', async ({ page }) => {
  const problems = await open(page);
  await clickOn(page, '[data-testid=select-all] svg path');
  await expect(page.getByTestId('select-all')).toHaveAttribute('aria-checked', 'true');
  const r = await slowReport(page);
  expect(r.target).toMatchObject({ component: 'SelectAll', label: 'button "Select all"' });
  expect(r.target?.owners[0]).toBe('SelectAll');
  expect(problems).toEqual([]);
});

test("a Radix menu that opens on pointerdown is put on its onPointerDown, not the row's onClick", async ({ page }) => {
  const problems = await open(page);
  await page.getByTestId('row-actions').click();
  await expect(page.getByRole('menu')).toBeVisible();
  const r = await slowReport(page);
  // Radix composes the handler, which is named by its prop: its wrapper is called handleEvent.
  expect(r.target?.handler).toBe('onPointerDown');
  expect(r.type).toBe('click');
  expect(r.pointerType).toBe('mouse');
  expect(r.verdict).toMatch(/^\d+ ms click on button "Row actions"/);
  expect(problems).toEqual([]);
});
