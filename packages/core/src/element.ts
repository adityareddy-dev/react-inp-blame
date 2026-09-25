/**
 * How a report names the element an interaction landed on, as a CSS selector. It reads only what the
 * page's code wrote on the element: never its text, and never a form field's value.
 */

const ELEMENT_NODE = 1;
// The attributes tests select elements by. A selector names the one an element has.
const TEST_ATTRIBUTES = ['data-test', 'data-testid'];
// What a click on something inside it activates, by tag and by ARIA role.
const CONTROL_TAGS = ['button', 'a', 'summary', 'label', 'input', 'select', 'textarea'];
const CONTROL_ROLES = ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'checkbox', 'radio', 'switch'];
// How far above the element that control is looked for: an icon is a few levels deep (a path in a
// group in an svg in a span), and a control further away than that is a card, not a button.
const CONTROL_ANCESTORS = 5;

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

/**
 * The control a click landed inside, or the element itself when there is none close by. A click on an
 * icon button lands on the icon: the `line` or `path` of an svg, a `span`, an `img`. That is the
 * event's target and what the selector says, and it names nothing anyone would recognise, so the label
 * is the button's (and for an icon, the component a report names it by: see `namedFrom`). The selector
 * stays the element the browser reported.
 */
export function controlAround(el: Element): Element {
  let at: Element | null = el;
  for (let up = 0; at && up <= CONTROL_ANCESTORS; up++, at = at.parentElement) {
    if (CONTROL_TAGS.includes(at.tagName.toLowerCase()) || CONTROL_ROLES.includes(at.getAttribute('role') ?? '')) return at;
  }
  return el;
}

/** The control around a node, which labels it; the node itself when it is not in an element. */
export function controlOf(node: Node | null): Node | null {
  const el = node && elementOf(node);
  return el ? controlAround(el) : node;
}

// What an icon is drawn with. A click inside one is a click on the control around it.
const ICON_TAGS = ['svg', 'img', 'picture'];

/**
 * Where the components a report names a click by are read from: the control around an icon that was
 * clicked, since an icon library's `Trash2` inside the button is not what anyone clicked, and otherwise the
 * node itself, so a card inside a link or a row inside an option is still named by the card or the row.
 */
export function namedFrom(node: Node | null): Node | null {
  const el = node && elementOf(node);
  if (!el) return node;
  for (let at: Element | null = el, up = 0; at && up <= CONTROL_ANCESTORS; up++, at = at.parentElement) {
    if (ICON_TAGS.includes(at.tagName.toLowerCase())) return controlAround(el);
  }
  return node;
}
