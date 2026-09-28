/**
 * How a report names the element an interaction landed on, as a CSS selector. It reads only what the
 * page's code wrote on the element: never its text, and never a form field's value.
 */

const ELEMENT_NODE = 1;
// The attributes tests select elements by. A selector names the one an element has.
const TEST_ATTRIBUTES = ['data-test', 'data-testid'];
// What a click on something inside it activates, by tag and by ARIA role.
export const CONTROL_TAGS = ['button', 'a', 'summary', 'label', 'input', 'select', 'textarea'];
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
  // The attribute rather than the property: on a form with a field named "id", `id` is that field.
  const id = el.getAttribute('id');
  if (id) s += '#' + ident(id);
  for (const name of TEST_ATTRIBUTES) {
    const value = el.getAttribute(name);
    // Quoted, so that a value with spaces or brackets is still one selector.
    if (value) return `${s}[${name}="${value.replace(/["\\]/g, '\\$&')}"]`;
  }
  if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).slice(0, 2).map(ident).join('.');
  return s;
}

/**
 * An id or a class written the way `CSS.escape` writes it, so that React 18's `:r1:` and Tailwind's
 * `md:flex` or `w-1/2` are still one selector: a character CSS would read as syntax gets a backslash, a
 * control character or a digit the name starts with is written as its code point, and anything past
 * ASCII is left as it is, so React 19.1's `«r1»` reads the same. Done here rather than by `CSS.escape`,
 * so the string the tests check is the one every page gets.
 */
function ident(name: string): string {
  return name.replace(/^(-?)(\d)|^-$|[^\w\x80-\uffff-]/g, (c: string, dash: string, digit?: string) => {
    if (digit) return dash + codePoint(digit);
    if (c === '\0') return '\ufffd';
    return c < ' ' || c === '\x7f' ? codePoint(c) : '\\' + c;
  });
}

/** A character as a CSS escape of its code point, with the space that ends one. */
const codePoint = (c: string): string => `\\${c.charCodeAt(0).toString(16)} `;

/**
 * The control a click landed inside, or the element itself when there is none close by. A click on an
 * icon button lands on the icon: the `line` or `path` of an svg, a `span`, an `img`. That is the
 * event's target and what the selector says, and it names nothing anyone would recognise, so the label
 * is the button's (an icon's components are read by `namingFiber` in fiber.ts). The selector
 * stays the element the browser reported.
 */
export function controlAround(el: Element): Element {
  let at: Element | null = el;
  for (let up = 0; at && up <= CONTROL_ANCESTORS; up++, at = at.parentElement) {
    if (isControl(at)) return at;
  }
  return el;
}

/** A button, a link, a form control or an element with a control's role. */
export function isControl(el: Element): boolean {
  return CONTROL_TAGS.includes(el.tagName.toLowerCase()) || CONTROL_ROLES.includes(el.getAttribute('role') ?? '');
}

/** The control around a node, which labels it; the node itself when it is not in an element. */
export function controlOf(node: Node | null): Node | null {
  const el = node && elementOf(node);
  return el ? controlAround(el) : node;
}

// What an icon is drawn with.
const ICON_TAGS = ['svg', 'img', 'picture'];

/**
 * The icon a node is part of: the `<svg>` around a `path` a click landed on, or an `<img>` or `<picture>`,
 * up to a few levels up; null for anything else. Whether it names the click is decided from the fiber tree
 * (`namingFiber`), since an `<img>` can as well be a card's photo as a button's icon.
 */
export function iconAround(node: Node): Element | null {
  for (let at = elementOf(node), up = 0; at && up <= CONTROL_ANCESTORS; up++, at = at.parentElement) {
    if (ICON_TAGS.includes(at.tagName.toLowerCase())) return at;
  }
  return null;
}
