/**
 * How a report names the element an interaction landed on, as a CSS selector. It reads only what the
 * page's code wrote on the element: never its text, and never a form field's value.
 */

const ELEMENT_NODE = 1;
// The attributes tests select elements by. A selector names the one an element has.
const TEST_ATTRIBUTES = ['data-test', 'data-testid'];

/** The element itself, or the one holding it when the node is a text node. */
export function elementOf(node: Node): Element | null {
  return node.nodeType === ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** 'button#save[data-test="save"]': the tag, the id, then the test attribute the element has, or else two of its classes. */
export function selector(node: Node): string | null {
  const el = elementOf(node);
  if (!el) return null;
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  for (const name of TEST_ATTRIBUTES) {
    const value = el.getAttribute(name);
    // Quoted, so that a value with spaces or brackets is still one selector.
    if (value) return `${s}[${name}="${value.replace(/["\\]/g, '\\$&')}"]`;
  }
  if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).slice(0, 2).join('.');
  return s;
}
